//! `quadflow context …` and `quadflow docs …` (agent-providers.md §7.2).

use super::output::Out;
use super::Ctx;
use crate::context::writer::{self, ContextSyncReport};
use crate::context::{ContextModuleInfo, ContextRegistry, BASE_MODULE};
use crate::domains::project_config;
use crate::error::CoreError;
use crate::plugins::cli::{self as plugin_cli, PluginCliCommandInfo};
use clap::Subcommand;
use std::io::Write as _;
use serde::Serialize;

#[derive(Subcommand, Debug)]
pub enum ContextAction {
    /// List context modules and whether each is enabled for this project.
    List,
    /// Include a module's reference in the project's agent context files.
    Enable {
        /// Module id (see `quadflow context list`).
        module: String,
    },
    /// Remove a module from the agent context files.
    Disable { module: String },
    /// Disable every module (the base `quadflow` module stays).
    Reset,
    /// Manage which context files (e.g. AGENTS.md) carry the managed region.
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },
    /// Rewrite the managed region of every context file.
    Sync {
        /// Truncate a dangling start marker instead of failing.
        #[arg(long)]
        repair: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum FilesAction {
    List,
    /// Add a project-root file, e.g. `AGENTS.md`.
    Add { name: String },
    Remove { name: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModuleRow {
    #[serde(flatten)]
    info: ContextModuleInfo,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListOut {
    modules: Vec<ModuleRow>,
    files: Vec<String>,
}

/// Core + active plugins' context modules (plugin-system.md §9.3) and the
/// plugin CLI commands. A broken plugin setup degrades to the core modules
/// with a warning on stderr.
fn registry(ctx: &Ctx, out: &mut Out) -> (ContextRegistry, Vec<PluginCliCommandInfo>) {
    match plugin_cli::load_registry(ctx) {
        Ok((_, _, plugins)) => (ContextRegistry::with_plugins(&plugins), plugin_cli::commands(&plugins)),
        Err(e) => {
            let _ = writeln!(out.io.stderr, "warning: plugin context docs are unavailable: {}", e.message);
            (ContextRegistry::builtin(), Vec::new())
        }
    }
}

fn human_sync(w: &mut dyn std::io::Write, r: &ContextSyncReport) -> std::io::Result<()> {
    if r.files.is_empty() {
        writeln!(w, "No context files configured; add one with `quadflow context files add <NAME>.md`.")?;
    }
    for f in &r.files {
        let what = if f.created { "created" } else if f.changed { "updated" } else { "unchanged" };
        writeln!(w, "  {what:>9}  {}", f.file)?;
    }
    for m in &r.unknown_modules {
        writeln!(w, "  warning: module {m:?} is enabled but not available (plugin disabled?)")?;
    }
    Ok(())
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: ContextAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let (reg, _) = registry(ctx, out);
    let actor = &ctx.actor;
    match action {
        ContextAction::List => {
            let ac = match project_config::read(&store) {
                Ok(c) => c.agent_context,
                Err(e) => return out.err(&e),
            };
            let data = ListOut {
                modules: reg
                    .list()
                    .iter()
                    .map(|m| ModuleRow { enabled: m.info.implicit || ac.modules.contains(&m.info.id), info: m.info.clone() })
                    .collect(),
                files: ac.files.clone(),
            };
            out.ok(&data, &[], |w| {
                for m in &data.modules {
                    let mark = if m.info.id == BASE_MODULE { "[*]" } else if m.enabled { "[x]" } else { "[ ]" };
                    writeln!(w, "  {mark} {:<10} {}", m.info.id, m.info.title)?;
                }
                if data.files.is_empty() {
                    writeln!(w, "\nNo context files configured (`quadflow context files add AGENTS.md`).")
                } else {
                    writeln!(w, "\nContext files: {}", data.files.join(", "))
                }
            })
        }
        ContextAction::Enable { module } => {
            out.result(writer::enable_module(&store, &reg, actor, &module), |w, r| {
                writeln!(w, "Enabled {module}.")?;
                human_sync(w, r)
            })
        }
        ContextAction::Disable { module } => {
            out.result(writer::disable_module(&store, &reg, actor, &module), |w, r| {
                writeln!(w, "Disabled {module}.")?;
                human_sync(w, r)
            })
        }
        ContextAction::Reset => out.result(
            writer::update_config(&store, &reg, actor, |ac| {
                ac.modules.clear();
                Ok(())
            })
            .map(|(_, r)| r),
            |w, r| {
                writeln!(w, "All context modules disabled.")?;
                human_sync(w, r)
            },
        ),
        ContextAction::Files { action } => match action {
            FilesAction::List => out.result(project_config::read(&store).map(|c| c.agent_context.files), |w, f| {
                for x in f {
                    writeln!(w, "{x}")?;
                }
                Ok(())
            }),
            FilesAction::Add { name } => out.result(
                writer::update_config(&store, &reg, actor, |ac| {
                    writer::validate_file_name(&name)?;
                    if !ac.files.iter().any(|f| f.eq_ignore_ascii_case(&name)) {
                        ac.files.push(name.clone());
                    }
                    Ok(())
                })
                .map(|(_, r)| r),
                human_sync,
            ),
            FilesAction::Remove { name } => out.result(
                writer::update_config(&store, &reg, actor, |ac| {
                    let before = ac.files.len();
                    ac.files.retain(|f| !f.eq_ignore_ascii_case(&name));
                    if before == ac.files.len() {
                        return Err(CoreError::not_found(format!("context file {name:?} is not configured")));
                    }
                    Ok(())
                })
                .map(|(_, r)| r),
                |w, _| writeln!(w, "Removed {name} from the managed context files (the file itself is kept)."),
            ),
        },
        ContextAction::Sync { repair } => out.result(writer::sync(&store, &reg, actor, repair), human_sync),
    }
}

/// `quadflow docs [<module>] [--list]`.
pub fn docs(ctx: &Ctx, out: &mut Out, module: Option<String>, list: bool) -> i32 {
    let (reg, commands) = registry(ctx, out);
    if list {
        let mods: Vec<ContextModuleInfo> = reg.list().iter().map(|m| m.info.clone()).collect();
        return out.ok(&mods, &[], |w| {
            writeln!(w, "Available context modules:")?;
            for m in &mods {
                let from = if m.source == "core" { String::new() } else { format!("  [plugin: {}]", m.source) };
                writeln!(w, "  {:<10} {}{from}", m.id, m.title)?;
            }
            if !commands.is_empty() {
                writeln!(w, "\nPlugin commands:")?;
                for c in &commands {
                    writeln!(w, "  {:<10} {}  [plugin: {}]", c.name, c.summary, c.plugin_id)?;
                }
            }
            Ok(())
        });
    }
    match module {
        Some(m) => match reg.get(&m) {
            Some(doc) => {
                let md = doc.markdown.clone();
                out.ok(&md, &[], |w| write!(w, "{md}"))
            }
            None => out.err(&writer::unknown_module(&reg, &m)),
        },
        None => out.err(&CoreError::invalid_input("usage: quadflow docs <module> | quadflow docs --list")),
    }
}
