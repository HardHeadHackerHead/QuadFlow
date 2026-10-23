//! `quadflow` CLI (data-layer.md §11).
//!
//! `run(args, io, env)` is injectable for in-process tests. Global flags:
//! `--json` (one envelope document on stdout) and `--project <path>`.
//! Exit codes: 0 ok · 1 error · 2 usage/invalid argument · 3 not found ·
//! 4 conflict/lock timeout · 5 project not found.
//!
//! Shared registration point (§13): one `Commands` variant + one dispatch arm
//! per domain.

pub mod chat;
pub mod context;
pub mod discovery;
pub mod ideas;
pub mod import_v1;
pub mod issues;
pub mod missions;
pub mod output;
pub mod plans;
pub mod plugins;
pub mod project;
pub mod scripts;
pub mod ship;

use crate::error::CoreError;
use crate::events::EventBus;
use crate::model::Actor;
use crate::paths::{resolve_cli_project, Profile, ProjectRoot, ENV_PROFILE, ENV_PROJECT_DIR};
use crate::store::ProjectStore;
use clap::{Parser, Subcommand};
use output::Out;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;

/// Injectable stdio.
pub struct Io<'a> {
    pub stdout: Box<dyn Write + 'a>,
    pub stderr: Box<dyn Write + 'a>,
}

impl Io<'static> {
    pub fn std() -> Self {
        Self { stdout: Box::new(std::io::stdout()), stderr: Box::new(std::io::stderr()) }
    }
}

/// Injectable process environment.
#[derive(Clone, Debug, Default)]
pub struct CliEnv {
    pub cwd: PathBuf,
    pub vars: BTreeMap<String, String>,
}

impl CliEnv {
    pub fn from_process() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            vars: std::env::vars().collect(),
        }
    }

    pub fn var(&self, k: &str) -> Option<&str> {
        self.vars.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }

    pub fn profile(&self) -> Profile {
        Profile::resolve(self.var(ENV_PROFILE), cfg!(debug_assertions))
    }
}

/// Per-invocation context shared by command handlers.
pub struct Ctx<'e> {
    pub env: &'e CliEnv,
    pub profile: Profile,
    pub project_flag: Option<PathBuf>,
    pub actor: Actor,
}

impl Ctx<'_> {
    /// `--project` → `QUADFLOW_PROJECT_DIR` → walk up from cwd (§3.2).
    pub fn project_root(&self) -> crate::Result<ProjectRoot> {
        let flag = self.project_flag.as_ref().map(|p| self.env.cwd.join(p));
        resolve_cli_project(flag.as_deref(), self.env.var(ENV_PROJECT_DIR), &self.env.cwd, self.profile)
    }

    pub fn project_store(&self) -> crate::Result<ProjectStore> {
        ProjectStore::open(self.project_root()?, EventBus::new())
    }

    /// App paths for this invocation (`QUADFLOW_DATA_DIR` from the injected env wins).
    pub fn app_paths(&self) -> crate::Result<crate::paths::AppPaths> {
        let override_dir = self.env.var(crate::paths::ENV_DATA_DIR).map(PathBuf::from);
        crate::paths::AppPaths::resolve_with(self.profile, override_dir, dirs::data_dir())
    }

    /// The app DB (machine state: terminal environments, settings, …).
    pub fn app_db(&self) -> crate::Result<std::sync::Arc<crate::store::AppDb>> {
        Ok(std::sync::Arc::new(crate::store::AppDb::open(&self.app_paths()?, EventBus::new())?))
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "quadflow",
    // Help/usage always say `quadflow`, whatever the executable is called
    // (`QuadFlow.exe`, `quadflow-tauri.exe` in dev builds, the PATH shim, …).
    bin_name = "quadflow",
    version,
    about = "QuadFlow CLI — Ideas, Issues, Plans, and project management",
    long_about = "Manage QuadFlow data from the command line. Run `quadflow` \
                  with no arguments to launch the GUI. Use `quadflow docs \
                  --list` to see documentation for each subcommand group."
)]
struct Cli {
    /// Output one machine-parseable JSON document: {"ok":true,"data":…} or {"ok":false,"error":…}.
    #[arg(long, global = true)]
    json: bool,

    /// Project root to operate on (default: walk up from the current directory).
    #[arg(long, global = true, value_name = "PATH")]
    project: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Launch the QuadFlow GUI (same as running `quadflow` with no args).
    Gui,

    /// Make the current directory (or --project) a QuadFlow project.
    Init {
        /// Display name (default: folder name).
        #[arg(long)]
        name: Option<String>,
        /// Issue reference prefix, 2-8 uppercase letters/digits (default: derived from the folder name).
        #[arg(long)]
        code: Option<String>,
    },

    /// Check the project store for problems.
    Doctor {
        /// Repair what can be repaired (gitignore, temp files, duplicate issue numbers).
        #[arg(long)]
        fix: bool,
    },

    /// Print documentation for a context module to stdout.
    Docs {
        /// Module name (e.g. ideas, issues). Omit with --list to see all.
        module: Option<String>,
        /// List all available modules.
        #[arg(long)]
        list: bool,
    },

    /// Manage the context modules written into this project's agent context files.
    Context {
        #[command(subcommand)]
        action: context::ContextAction,
    },

    /// Plugins: list, inspect, enable/disable, validate, install/update/uninstall, sources.
    Plugins {
        #[command(subcommand)]
        action: plugins::PluginsAction,
    },

    /// Ideas: capture, tag, merge, suggest, archive.
    Ideas {
        #[command(subcommand)]
        action: ideas::IdeasAction,
    },
    /// Issues: track, label, comment, claim, close.
    Issues {
        #[command(subcommand)]
        action: issues::IssuesAction,
    },
    /// Labels: the project's issue label catalog.
    Labels {
        #[command(subcommand)]
        action: issues::LabelsAction,
    },
    /// Epics: group issues into larger bodies of work.
    Epics {
        #[command(subcommand)]
        action: issues::EpicsAction,
    },
    /// Plans: create, decompose into steps, promote to issues.
    Plans {
        #[command(subcommand)]
        action: plans::PlansAction,
    },
    /// Discovery: big-picture projects with goals, research, requirements and open questions.
    Discovery {
        #[command(subcommand)]
        action: discovery::DiscoveryAction,
    },
    /// Scripts: saved build/test recipes with env and setup.
    Scripts {
        #[command(subcommand)]
        action: scripts::ScriptsAction,
    },
    /// Ship: full release pipeline — bump, build, sign, bundle, upload.
    Ship {
        #[command(subcommand)]
        action: ship::ShipAction,
    },
    /// Chat: conversations with OpenAI-compatible LLM endpoints.
    Chat {
        #[command(subcommand)]
        action: chat::ChatAction,
    },
    /// Missions: multi-agent coordination and team work.
    Missions {
        #[command(subcommand)]
        action: missions::MissionsAction,
    },
    /// Bring projects and settings over from QuadFlow 1.x (one-time import; `--dry-run` previews).
    #[command(name = "import-v1")]
    ImportV1(import_v1::ImportV1Args),
    /// A plugin command (`contributes.cliCommands`, plugin-system.md §9).
    #[command(external_subcommand)]
    External(Vec<OsString>),
}

impl Commands {
    /// Commands that open the project at `--project` / `QUADFLOW_PROJECT_DIR` / cwd.
    fn uses_project(&self) -> bool {
        matches!(
            self,
            Commands::Init { .. }
                | Commands::Doctor { .. }
                | Commands::Context { .. }
                | Commands::Ideas { .. }
                | Commands::Issues { .. }
                | Commands::Labels { .. }
                | Commands::Epics { .. }
                | Commands::Plans { .. }
                | Commands::Discovery { .. }
                | Commands::Scripts { .. }
                | Commands::Ship { .. }
                | Commands::Missions { .. }
        )
    }
}

/// A project whose `.quadflow/` is in the QuadFlow 1.x format: move it aside and
/// start fresh (release) or report it (dev) — before the command runs.
fn legacy_project_check(ctx: &Ctx, out: &mut Out) {
    use crate::import_v1::legacy;
    let explicit = match (&ctx.project_flag, ctx.env.var(ENV_PROJECT_DIR)) {
        (Some(p), _) => Some(ctx.env.cwd.join(p)),
        (None, Some(d)) => Some(PathBuf::from(d)),
        (None, None) => None,
    };
    let dir = match explicit {
        Some(d) => d,
        None => {
            // Walking up: only the folder the command runs in is changed. A 1.x
            // folder further up (e.g. the home directory) is only pointed out.
            let Some(found) = crate::paths::find_project_root_with(&ctx.env.cwd, Profile::Release) else { return };
            let here = dunce::canonicalize(&ctx.env.cwd).unwrap_or_else(|_| ctx.env.cwd.clone());
            if found.path != here {
                if legacy::is_v1_dir(&found.path.join(legacy::V1_PROJECT_DIR)) {
                    let _ = writeln!(
                        out.io.stderr,
                        "warning: {} has data from QuadFlow 1.x, which this version can't read; run quadflow in that folder (or pass --project) to move it aside",
                        found.path.display()
                    );
                }
                return;
            }
            found.path
        }
    };
    match legacy::check_project(&dir, ctx.profile, &EventBus::new()) {
        Ok(Some(n)) => {
            let _ = writeln!(out.io.stderr, "warning: {}", n.message);
            if let Some(b) = &n.backup_dir {
                let _ = writeln!(out.io.stderr, "warning: backup: {b}");
            }
            out.notices.push(crate::model::CorruptEntry { path: n.backup_dir.unwrap_or(n.root), message: n.message });
        }
        Ok(None) => {}
        Err(e) => {
            let _ = writeln!(out.io.stderr, "warning: {} has QuadFlow 1.x data that could not be moved aside: {}", dir.display(), e.message);
        }
    }
}

/// Is this `quadflow [globals] [-h|--help|help]` (help for the root command)?
fn is_root_help(args: &[OsString]) -> bool {
    let rest: Vec<String> = args.iter().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let (rest, _, _) = crate::plugins::cli::split_global_flags(&rest);
    matches!(rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice(), [] | ["-h"] | ["--help"] | ["help"])
}

/// Root help including the active plugins' commands (§9.1).
fn root_help(args: &[OsString], ctx: &Ctx) -> String {
    use clap::CommandFactory;
    let mut cmd = Cli::command();
    for c in crate::plugins::cli::commands_best_effort(ctx) {
        cmd = cmd.subcommand(clap::Command::new(c.name.clone()).about(format!("{} [plugin: {}]", c.summary, c.plugin_id)));
    }
    match cmd.clone().try_get_matches_from(args) {
        Err(e) => e.render().to_string(),
        Ok(_) => cmd.render_help().to_string(),
    }
}

/// Entry point. `args` is the full argv (program name at [0]). Returns the exit code.
pub fn run(args: Vec<OsString>, io: &mut Io, env: &CliEnv) -> i32 {
    let json_requested = args.iter().skip(1).any(|a| a == "--json");
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(e) => {
            use clap::error::ErrorKind;
            if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
                let text = if e.kind() == ErrorKind::DisplayHelp && is_root_help(&args) {
                    let ctx = Ctx {
                        env,
                        profile: env.profile(),
                        project_flag: None,
                        actor: Actor::from_cli_env(|k| env.var(k).map(str::to_string)),
                    };
                    root_help(&args, &ctx)
                } else {
                    e.render().to_string()
                };
                let _ = write!(io.stdout, "{text}");
                return 0;
            }
            let mut out = Out::new(io, json_requested);
            if json_requested {
                return out.err(&CoreError::invalid_input(e.render().to_string().trim().to_string()));
            }
            let _ = write!(out.io.stderr, "{}", e.render());
            return output::EXIT_USAGE;
        }
    };
    let json = cli.json;
    let ctx = Ctx {
        env,
        profile: env.profile(),
        project_flag: cli.project.clone(),
        actor: Actor::from_cli_env(|k| env.var(k).map(str::to_string)),
    };
    let mut out = Out::new(io, json);
    if cli.command.uses_project() {
        legacy_project_check(&ctx, &mut out);
    }
    match cli.command {
        Commands::Gui => {
            let _ = writeln!(
                out.io.stderr,
                "quadflow: GUI launch must be handled by the main binary. Run `quadflow` with no arguments instead."
            );
            output::EXIT_USAGE
        }
        Commands::Init { name, code } => project::init(&ctx, &mut out, name, code),
        Commands::Doctor { fix } => project::doctor(&ctx, &mut out, fix),
        Commands::Docs { module, list } => context::docs(&ctx, &mut out, module, list),
        Commands::Plugins { action } => plugins::handle(&ctx, &mut out, action),
        Commands::Context { action } => context::handle(&ctx, &mut out, action),
        Commands::Ideas { action } => ideas::handle(&ctx, &mut out, action),
        Commands::Issues { action } => issues::handle_issues(&ctx, &mut out, action),
        Commands::Labels { action } => issues::handle_labels(&ctx, &mut out, action),
        Commands::Epics { action } => issues::handle_epics(&ctx, &mut out, action),
        Commands::Plans { action } => plans::handle(&ctx, &mut out, action),
        Commands::Discovery { action } => discovery::handle(&ctx, &mut out, action),
        Commands::Scripts { action } => scripts::handle(&ctx, &mut out, action),
        Commands::Ship { action } => ship::handle(&ctx, &mut out, action),
        Commands::Chat { action } => chat::handle(&ctx, &mut out, action),
        Commands::Missions { action } => missions::handle(&ctx, &mut out, action),
        Commands::ImportV1(args) => import_v1::handle(&ctx, &mut out, args),
        Commands::External(raw) => crate::plugins::cli::run_external(&ctx, &mut out, raw),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Every core subcommand must be reserved, so no plugin can take (or shadow) it.
    #[test]
    fn every_core_subcommand_is_reserved() {
        for sc in Cli::command().get_subcommands() {
            let name = sc.get_name();
            assert!(
                crate::plugins::RESERVED_CLI_NAMES.contains(&name),
                "core subcommand {name:?} is missing from plugins::RESERVED_CLI_NAMES"
            );
        }
    }

    #[test]
    fn root_help_detection() {
        let a = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(is_root_help(&a(&["quadflow", "--help"])));
        assert!(is_root_help(&a(&["quadflow", "--json", "-h"])));
        assert!(is_root_help(&a(&["quadflow", "help"])));
        assert!(!is_root_help(&a(&["quadflow", "ideas", "--help"])));
        assert!(!is_root_help(&a(&["quadflow", "help", "ideas"])));
    }
}
