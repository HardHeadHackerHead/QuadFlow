//! `quadflow plugins list|info|enable|disable|validate|install|update|rollback|
//! uninstall|browse|sources …` (plugin-system.md §12.3, §15.3).

use super::output::Out;
use super::Ctx;
use crate::error::{CoreError, Result};
use crate::events::EventBus;
use crate::paths::{AppPaths, ENV_DATA_DIR};
use crate::plugins::registry::{validate_plugin_dir, LoadOptions, PluginInfo, PluginOrigin, PluginRegistry};
use crate::plugins::ValidationReport;
use crate::domains::app::secrets::Secrets;
use crate::plugins::sources::{self, PluginInstallPlan, PluginSourceInfo, SourceOptions};
use crate::store::AppDb;
use clap::{Subcommand, ValueEnum};
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;

#[derive(Subcommand, Debug)]
pub enum PluginsAction {
    /// List plugins (bundled, installed, dev) with their status.
    List {
        /// Include plugins that don't support this platform.
        #[arg(long)]
        all: bool,
    },
    /// Show one plugin: manifest summary, permissions, problems.
    Info { id: String },
    /// Enable a plugin.
    Enable { id: String },
    /// Disable a plugin (its tools stay configured but hidden).
    Disable { id: String },
    /// Validate a plugin folder (manifest schema + referenced files).
    Validate {
        /// Plugin directory containing quadflow-plugin.json.
        dir: PathBuf,
        /// Validate as if loaded from this origin (affects the bare-id rule).
        #[arg(long, value_enum, default_value_t = OriginArg::Dev)]
        origin: OriginArg,
    },
    /// Install a plugin from a source (asks for permission consent).
    Install {
        id: String,
        /// Source id or URL (default: the first enabled source offering the plugin).
        #[arg(long)]
        source: Option<String>,
        /// Exact version (default: highest compatible).
        #[arg(long)]
        version: Option<String>,
        /// Approve the requested permissions without asking.
        #[arg(long)]
        yes: bool,
    },
    /// Update one plugin, or every plugin with an update (refreshes sources first).
    Update {
        id: Option<String>,
        /// Approve added permissions without asking.
        #[arg(long)]
        yes: bool,
        /// Only list available updates.
        #[arg(long)]
        check: bool,
    },
    /// Switch an installed plugin back to its previous version.
    Rollback { id: String },
    /// Uninstall a plugin: files, storage, settings, secrets and tool configs.
    Uninstall {
        id: String,
        /// Also delete its private data folder.
        #[arg(long)]
        delete_data: bool,
    },
    /// List plugins offered by enabled sources (cached; `sources refresh` to update).
    Browse {
        #[arg(long)]
        source: Option<String>,
    },
    /// Manage plugin sources.
    Sources {
        #[command(subcommand)]
        action: SourcesAction,
    },
    /// Unpacked (dev) plugin folders — what Settings → Plugins → "Load unpacked…" edits.
    Dev {
        #[command(subcommand)]
        action: DevAction,
    },
    /// Approve every permission a plugin declares (what "Approve" in Settings → Plugins does).
    Grant {
        id: String,
        /// Approve without asking.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum DevAction {
    /// List the folders in `plugins.devPaths`.
    List,
    /// Load an unpacked plugin folder (it must contain quadflow-plugin.json).
    Add { dir: PathBuf },
    /// Stop loading an unpacked plugin folder.
    Remove { dir: PathBuf },
}

#[derive(Subcommand, Debug)]
pub enum SourcesAction {
    /// List sources with their last refresh status.
    List,
    /// Add a source: `github:OWNER/REPO[#REF][:PATH]` or an https URL of an index.json.
    Add { url: String },
    /// Remove a source (not the built-in one).
    Remove { id: String },
    /// Fetch one or all enabled sources.
    Refresh { id: Option<String> },
    /// Enable a source.
    Enable { id: String },
    /// Disable a source (the built-in one too).
    Disable { id: String },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum OriginArg {
    Bundled,
    Installed,
    Dev,
}

/// `plugins validate` result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResult {
    pub dir: String,
    pub valid: bool,
    pub id: Option<String>,
    pub version: Option<String>,
    /// Why this host would not activate a valid plugin (platform / apiVersion), if anything.
    pub compatibility: Option<String>,
    #[serde(flatten)]
    pub report: ValidationReport,
}

fn app_paths(ctx: &Ctx) -> Result<AppPaths> {
    AppPaths::resolve_with(ctx.profile, ctx.env.var(ENV_DATA_DIR).map(PathBuf::from), dirs::data_dir())
}

fn load_opts(ctx: &Ctx) -> LoadOptions {
    LoadOptions::from_env(|k| ctx.env.var(k).map(str::to_string))
}

fn open(ctx: &Ctx) -> Result<(AppDb, PluginRegistry)> {
    let paths = app_paths(ctx)?;
    let db = AppDb::open(&paths, EventBus::new())?;
    let reg = PluginRegistry::load_with(&paths, &db, &load_opts(ctx))?;
    Ok((db, reg))
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: PluginsAction) -> i32 {
    match action {
        PluginsAction::Install { id, source, version, yes } => install(ctx, out, &id, source.as_deref(), version.as_deref(), yes),
        PluginsAction::Update { id, yes, check } => update(ctx, out, id.as_deref(), yes, check),
        PluginsAction::Rollback { id } => {
            let r = env(ctx).and_then(|e| sources::rollback(&e.db, &e.paths, &e.opts, &id));
            out.result(r, |w, p| writeln!(w, "Rolled back {} to {}: {}", p.id, p.version.as_deref().unwrap_or("-"), p.status.label()))
        }
        PluginsAction::Uninstall { id, delete_data } => {
            let r = env(ctx).and_then(|e| {
                let secrets = Secrets::from_env(ctx.profile, |k| ctx.env.var(k).map(str::to_string))?;
                sources::uninstall(&e.db, &e.paths, &secrets, &e.opts, &id, delete_data)
            });
            out.result(r, |w, r| {
                if r.reverted_to_bundled {
                    writeln!(w, "Removed the installed copy of {}; the bundled version is active again.", r.plugin_id)
                } else {
                    writeln!(
                        w,
                        "Uninstalled {} ({} tool configs, {} storage entries, {} settings, {} secrets removed{})",
                        r.plugin_id,
                        r.removed_tool_configs,
                        r.removed_kv_entries,
                        r.removed_settings,
                        r.removed_secrets,
                        if r.deleted_data_dir { ", data folder deleted" } else { "" }
                    )
                }
            })
        }
        PluginsAction::Browse { source } => {
            let r = env(ctx).and_then(|e| sources::browse(&e.db, &e.paths, &e.opts, source.as_deref()));
            out.result(r, |w, list| {
                if list.is_empty() {
                    return writeln!(w, "No plugins available (run `quadflow plugins sources refresh`).");
                }
                for a in list {
                    let state = match (&a.installed_version, &a.latest_compatible) {
                        (Some(v), _) => format!("installed {v}"),
                        (None, Some(_)) => String::new(),
                        (None, None) => format!("incompatible: {}", a.incompatible_reason.as_deref().unwrap_or("-")),
                    };
                    writeln!(
                        w,
                        "{:<28} {:<10} {:<16} {}  {}",
                        a.entry.id,
                        a.latest_compatible.as_deref().unwrap_or("-"),
                        a.source_name,
                        a.entry.description,
                        state
                    )?;
                }
                Ok(())
            })
        }
        PluginsAction::Sources { action } => sources_cmd(ctx, out, action),
        PluginsAction::Dev { action } => dev_cmd(ctx, out, action),
        PluginsAction::Grant { id, yes } => grant_cmd(ctx, out, &id, yes),
        PluginsAction::List { all } => {
            let r = open(ctx).map(|(_, reg)| reg.list(all));
            out.result(r, |w, list| {
                if list.is_empty() {
                    return writeln!(w, "No plugins.");
                }
                for p in list {
                    writeln!(
                        w,
                        "{:<28} {:<10} {:<9} {}",
                        p.id,
                        p.version.as_deref().unwrap_or("-"),
                        p.origin_str(),
                        p.status.label()
                    )?;
                }
                Ok(())
            })
        }
        PluginsAction::Info { id } => {
            let r = open(ctx).and_then(|(_, reg)| Ok(reg.require(&id)?.info()));
            out.result(r, |w, p| print_info(w, p))
        }
        PluginsAction::Enable { id } => set_enabled(ctx, out, &id, true),
        PluginsAction::Disable { id } => set_enabled(ctx, out, &id, false),
        PluginsAction::Validate { dir, origin } => {
            let dir = ctx.env.cwd.join(dir);
            let opts = load_opts(ctx);
            let origin = match origin {
                OriginArg::Bundled => PluginOrigin::Bundled,
                OriginArg::Installed => PluginOrigin::Installed,
                OriginArg::Dev => PluginOrigin::Dev,
            };
            let report = validate_plugin_dir(&dir, origin, false, &opts);
            let compatibility = report.manifest.as_ref().and_then(|m| {
                if !opts.platform.is_some_and(|p| m.supports(p)) {
                    Some("does not support this platform".to_string())
                } else {
                    m.api_compat(&opts.host_api).err()
                }
            });
            let res = ValidateResult {
                dir: dir.display().to_string(),
                valid: report.is_valid(),
                id: report.manifest.as_ref().map(|m| m.id.clone()).or(report.raw_id.clone()),
                version: report.manifest.as_ref().map(|m| m.version.clone()),
                compatibility,
                report,
            };
            if !res.valid {
                let e = CoreError::invalid_input(format!(
                    "{} is not a valid plugin: {}",
                    res.dir,
                    res.report.summary()
                ))
                .with_details(serde_json::to_value(&res.report.errors).unwrap_or_default());
                if out.json {
                    return out.err(&e);
                }
                let _ = writeln!(out.io.stderr, "{}: invalid", res.dir);
                for i in &res.report.errors {
                    let _ = writeln!(out.io.stderr, "  error   {i}");
                }
                return e.exit_code();
            }
            out.ok(&res, &[], |w| {
                writeln!(w, "{}: valid ({} {})", res.dir, res.id.as_deref().unwrap_or("?"), res.version.as_deref().unwrap_or("?"))?;
                for i in &res.report.warnings {
                    writeln!(w, "  warning {i}")?;
                }
                if let Some(c) = &res.compatibility {
                    writeln!(w, "  note: this QuadFlow would not activate it: {c}")?;
                }
                Ok(())
            })
        }
    }
}

fn set_enabled(ctx: &Ctx, out: &mut Out, id: &str, enabled: bool) -> i32 {
    let r = (|| {
        let (db, reg) = open(ctx)?;
        reg.set_enabled(&db, id, enabled)?;
        let paths = app_paths(ctx)?;
        let reg = PluginRegistry::load_with(&paths, &db, &load_opts(ctx))?;
        Ok(reg.require(id)?.info())
    })();
    out.result(r, |w, p| writeln!(w, "{} {}: {}", if enabled { "Enabled" } else { "Disabled" }, p.id, p.status.label()))
}

fn print_info(w: &mut dyn Write, p: &PluginInfo) -> std::io::Result<()> {
    writeln!(w, "{} ({})", p.name, p.id)?;
    writeln!(w, "  version:    {}", p.version.as_deref().unwrap_or("-"))?;
    writeln!(w, "  origin:     {} ({:?})", p.origin_str(), p.isolation)?;
    writeln!(w, "  status:     {}", p.status.label())?;
    writeln!(w, "  root:       {}", p.root)?;
    if let Some(api) = &p.api_version {
        writeln!(w, "  apiVersion: {api}")?;
    }
    if !p.platforms.is_empty() {
        let pl: Vec<&str> = p.platforms.iter().map(|x| x.as_str()).collect();
        writeln!(w, "  platforms:  {}", pl.join(", "))?;
    }
    if let Some(d) = &p.description {
        writeln!(w, "  {d}")?;
    }
    if !p.permissions.is_empty() {
        writeln!(w, "  permissions:")?;
        for perm in &p.permissions {
            writeln!(
                w,
                "    [{}] {:<28} {:<8} {}",
                if perm.granted { "x" } else { " " },
                perm.permission.as_str(),
                format!("{:?}", perm.risk).to_lowercase(),
                perm.description
            )?;
        }
    }
    for e in &p.errors {
        writeln!(w, "  error:   {e}")?;
    }
    for e in &p.warnings {
        writeln!(w, "  warning: {e}")?;
    }
    for s in &p.shadowed {
        writeln!(w, "  shadows: {} {} at {}", s.origin.as_str(), s.version.as_deref().unwrap_or("-"), s.root)?;
    }
    Ok(())
}

impl PluginInfo {
    fn origin_str(&self) -> &'static str {
        self.origin.as_str()
    }
}

// ---------------------------------------------------------------------------
// sources / install (PL-9)
// ---------------------------------------------------------------------------

/// Treat stdin as non-interactive even when it is a terminal (tests, scripts).
pub const ENV_NONINTERACTIVE: &str = "QUADFLOW_NONINTERACTIVE";

struct SrcEnv {
    paths: AppPaths,
    db: AppDb,
    opts: SourceOptions,
}

fn env(ctx: &Ctx) -> Result<SrcEnv> {
    let paths = app_paths(ctx)?;
    let db = AppDb::open(&paths, EventBus::new())?;
    let opts = SourceOptions::from_env(ctx.profile, |k| ctx.env.var(k).map(str::to_string));
    Ok(SrcEnv { paths, db, opts })
}

fn interactive(ctx: &Ctx, out: &Out) -> bool {
    use std::io::IsTerminal;
    !out.json && ctx.env.var(ENV_NONINTERACTIVE).is_none() && std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

fn describe_plan(w: &mut dyn Write, plan: &PluginInstallPlan) -> std::io::Result<()> {
    let verb = match plan.kind {
        sources::PluginInstallKind::Install => "Install",
        sources::PluginInstallKind::Update => "Update",
    };
    match &plan.from_version {
        Some(f) => writeln!(w, "{verb} {} ({}) {f} -> {} from {}", plan.name, plan.plugin_id, plan.version, plan.source_name)?,
        None => writeln!(w, "{verb} {} ({}) {} from {}", plan.name, plan.plugin_id, plan.version, plan.source_name)?,
    }
    writeln!(w, "  isolation: {:?}", plan.isolation)?;
    if plan.permissions.is_empty() {
        writeln!(w, "  requests no permissions")?;
    } else {
        writeln!(w, "  permissions:")?;
        for p in &plan.permissions {
            let mark = if plan.added_permissions.contains(&p.permission) { "+" } else { " " };
            writeln!(w, "   {mark} {:<28} {:<8} {}", p.permission.as_str(), format!("{:?}", p.risk).to_lowercase(), p.description)?;
        }
    }
    for p in &plan.removed_permissions {
        writeln!(w, "   - {} (no longer requested; revoked)", p.as_str())?;
    }
    if plan.requires_trust {
        writeln!(w, "  WARNING: this plugin requests critical permissions. Only continue if you trust it.")?;
    }
    if let Some(n) = &plan.notes {
        writeln!(w, "  notes: {n}")?;
    }
    Ok(())
}

/// Ask for consent. `--yes` approves; a TTY prompts; otherwise a usage error (exit 2).
fn consent(ctx: &Ctx, out: &mut Out, plan: &PluginInstallPlan, yes: bool) -> Result<bool> {
    if yes || !plan.needs_consent {
        return Ok(true);
    }
    if !interactive(ctx, out) {
        return Err(CoreError::invalid_input(format!(
            "{} {} needs your approval for its permissions; re-run with --yes to approve",
            plan.plugin_id, plan.version
        ))
        .with_details(serde_json::json!({ "plan": plan, "hint": "pass --yes to approve the listed permissions" })));
    }
    let _ = describe_plan(&mut *out.io.stderr, plan);
    let _ = write!(out.io.stderr, "Continue? [y/N] ");
    let _ = out.io.stderr.flush();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).map_err(|e| CoreError::internal(format!("read stdin: {e}")))?;
    Ok(matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes"))
}

fn install(ctx: &Ctx, out: &mut Out, id: &str, source: Option<&str>, version: Option<&str>, yes: bool) -> i32 {
    let r = (|| {
        let e = env(ctx)?;
        let plan = sources::plan_install(&e.db, &e.paths, &e.opts, source, id, version)?;
        if !consent(ctx, out, &plan, yes)? {
            return Err(CoreError::conflict("installation cancelled"));
        }
        let all: Vec<String> = plan.permissions.iter().map(|p| p.permission.to_string()).collect();
        sources::confirm(&e.db, &e.paths, &e.opts, &plan, &all)
    })();
    out.result(r, |w, p| writeln!(w, "Installed {} {}: {}", p.id, p.version.as_deref().unwrap_or("-"), p.status.label()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRun {
    updated: Vec<PluginInfo>,
    /// Updates that need consent and were not approved.
    pending: Vec<sources::PluginUpdateInfo>,
}

fn update(ctx: &Ctx, out: &mut Out, id: Option<&str>, yes: bool, check: bool) -> i32 {
    if check {
        let r = env(ctx).and_then(|e| {
            sources::refresh(&e.db, &e.paths, &e.opts, None)?;
            let ups = sources::check_updates(&e.db, &e.paths, &e.opts)?;
            Ok(ups.into_iter().filter(|u| id.is_none_or(|i| i == u.plugin_id)).collect::<Vec<_>>())
        });
        return out.result(r, |w, ups| {
            if ups.is_empty() {
                return writeln!(w, "All plugins are up to date.");
            }
            for u in ups {
                let extra = if u.needs_consent {
                    let added: Vec<&str> = u.added_permissions.iter().map(|p| p.as_str()).collect();
                    format!("  (needs approval: + {})", added.join(", "))
                } else {
                    String::new()
                };
                writeln!(w, "{:<28} {} -> {}{extra}", u.plugin_id, u.current_version, u.version)?;
            }
            Ok(())
        });
    }
    let r = (|| {
        let e = env(ctx)?;
        sources::refresh(&e.db, &e.paths, &e.opts, None)?;
        let ups = sources::check_updates(&e.db, &e.paths, &e.opts)?;
        let ids: Vec<String> = match id {
            Some(i) => vec![i.to_string()],
            None => ups.iter().map(|u| u.plugin_id.clone()).collect(),
        };
        let mut run = UpdateRun { updated: vec![], pending: vec![] };
        for pid in ids {
            let plan = sources::plan_update(&e.db, &e.paths, &e.opts, &pid)?;
            let approved = match consent(ctx, out, &plan, yes) {
                Ok(a) => a,
                // One plugin: surface the usage error. All: report it as pending.
                Err(err) if id.is_some() => return Err(err),
                Err(_) => false,
            };
            if !approved {
                run.pending.extend(ups.iter().find(|u| u.plugin_id == pid).cloned());
                continue;
            }
            let added: Vec<String> = plan.added_permissions.iter().map(|p| p.to_string()).collect();
            run.updated.push(sources::confirm(&e.db, &e.paths, &e.opts, &plan, &added)?);
        }
        Ok(run)
    })();
    out.result(r, |w, run| {
        if run.updated.is_empty() && run.pending.is_empty() {
            return writeln!(w, "All plugins are up to date.");
        }
        for p in &run.updated {
            writeln!(w, "Updated {} to {}: {}", p.id, p.version.as_deref().unwrap_or("-"), p.status.label())?;
        }
        for u in &run.pending {
            let added: Vec<&str> = u.added_permissions.iter().map(|p| p.as_str()).collect();
            writeln!(
                w,
                "Update needs approval: {} {} (+ {}); run `quadflow plugins update {} --yes`",
                u.plugin_id,
                u.version,
                added.join(", "),
                u.plugin_id
            )?;
        }
        Ok(())
    })
}

fn print_sources(w: &mut dyn Write, list: &[PluginSourceInfo]) -> std::io::Result<()> {
    for s in list {
        let state = match (&s.last_error, s.last_checked_at, s.plugin_count) {
            (Some(e), _, _) => format!("error: {e}"),
            (None, None, _) => "never refreshed".to_string(),
            (None, Some(_), n) => format!("{} plugins", n.unwrap_or(0)),
        };
        writeln!(
            w,
            "{:<28} {}{}{}  {}",
            s.id,
            s.url,
            if s.builtin { " [built-in]" } else { "" },
            if s.enabled { "" } else { " [disabled]" },
            state
        )?;
    }
    Ok(())
}

/// `plugins grant`: approve all declared permissions (`--yes`, or a `[y/N]` prompt on a TTY).
fn grant_cmd(ctx: &Ctx, out: &mut Out, id: &str, yes: bool) -> i32 {
    let r = (|| {
        let (db, reg) = open(ctx)?;
        let info = reg.require(id)?.info();
        let all: Vec<String> = info.permissions.iter().map(|p| p.permission.to_string()).collect();
        if !yes {
            if !interactive(ctx, out) {
                return Err(CoreError::invalid_input(format!("{id} needs your approval for its permissions; re-run with --yes to approve"))
                    .with_details(serde_json::json!({ "permissions": all, "hint": "pass --yes to approve the listed permissions" })));
            }
            let _ = writeln!(out.io.stderr, "{} ({}) {} asks for:", info.name, info.id, info.version.as_deref().unwrap_or("-"));
            for p in &info.permissions {
                let _ = writeln!(out.io.stderr, "  {:<28} {}", p.permission, p.description);
            }
            let _ = write!(out.io.stderr, "Approve? [y/N] ");
            let _ = out.io.stderr.flush();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).map_err(|e| CoreError::internal(format!("read stdin: {e}")))?;
            if !matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
                return Err(CoreError::conflict("not approved"));
            }
        }
        reg.grant(&db, id, &all)?;
        let reg = PluginRegistry::load_with(&app_paths(ctx)?, &db, &load_opts(ctx))?;
        Ok(reg.require(id)?.info())
    })();
    out.result(r, |w, p| writeln!(w, "Approved {}: {}", p.id, p.status.label()))
}

/// `plugins dev add` result.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevAddResult {
    dir: String,
    /// The dev copy as loaded (`None` if the folder's manifest has no readable id).
    plugin: Option<PluginInfo>,
}

fn dev_cmd(ctx: &Ctx, out: &mut Out, action: DevAction) -> i32 {
    use crate::plugins::dev;
    match action {
        DevAction::List => {
            let r = env(ctx).and_then(|e| dev::dev_paths(&e.db));
            out.result(r, |w, l| {
                if l.is_empty() {
                    return writeln!(w, "No unpacked plugin folders.");
                }
                l.iter().try_for_each(|p| writeln!(w, "{p}"))
            })
        }
        DevAction::Add { dir } => {
            let r = env(ctx).and_then(|e| {
                let dir = dev::add_dev_path(&e.db, &ctx.env.cwd.join(dir))?;
                let reg = PluginRegistry::load_with(&e.paths, &e.db, &load_opts(ctx))?;
                let canon = |p: &std::path::Path| dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
                let plugin = reg
                    .all()
                    .find(|p| p.origin == PluginOrigin::Dev && canon(&p.root) == dir)
                    .map(|p| p.info());
                Ok(DevAddResult { dir: dir.display().to_string(), plugin })
            });
            out.result(r, |w, v| {
                writeln!(w, "Loading unpacked plugin from {}", v.dir)?;
                match &v.plugin {
                    Some(p) => writeln!(w, "  {} {}  {}", p.id, p.version.as_deref().unwrap_or("-"), p.status.label()),
                    None => writeln!(w, "  (no valid manifest yet; `quadflow plugins validate {}`)", v.dir),
                }
            })
        }
        DevAction::Remove { dir } => {
            let r = env(ctx).and_then(|e| {
                let dir = ctx.env.cwd.join(dir);
                let removed = dev::remove_dev_path(&e.db, &dir)?;
                Ok(serde_json::json!({ "dir": dir.display().to_string(), "removed": removed }))
            });
            out.result(r, |w, v| {
                let dir = v["dir"].as_str().unwrap_or("");
                if v["removed"].as_bool() == Some(true) {
                    writeln!(w, "Stopped loading {dir}")
                } else {
                    writeln!(w, "{dir} was not loaded")
                }
            })
        }
    }
}

fn sources_cmd(ctx: &Ctx, out: &mut Out, action: SourcesAction) -> i32 {
    match action {
        SourcesAction::List => {
            let r = env(ctx).and_then(|e| sources::list(&e.db, &e.paths, &e.opts));
            out.result(r, |w, l| print_sources(w, l))
        }
        SourcesAction::Add { url } => {
            let r = env(ctx).and_then(|e| sources::add(&e.db, &e.paths, &e.opts, &url));
            out.result(r, |w, s| print_sources(w, std::slice::from_ref(s)))
        }
        SourcesAction::Remove { id } => {
            let r = env(ctx).and_then(|e| sources::remove(&e.db, &e.paths, &id).map(|_| serde_json::json!({ "removed": id })));
            out.result(r, |w, v| writeln!(w, "Removed source {}", v["removed"].as_str().unwrap_or("")))
        }
        SourcesAction::Refresh { id } => {
            let r = env(ctx).and_then(|e| sources::refresh(&e.db, &e.paths, &e.opts, id.as_deref()));
            out.result(r, |w, l| print_sources(w, l))
        }
        SourcesAction::Enable { id } => {
            let r = env(ctx).and_then(|e| sources::set_enabled(&e.db, &e.paths, &e.opts, &id, true));
            out.result(r, |w, s| print_sources(w, std::slice::from_ref(s)))
        }
        SourcesAction::Disable { id } => {
            let r = env(ctx).and_then(|e| sources::set_enabled(&e.db, &e.paths, &e.opts, &id, false));
            out.result(r, |w, s| print_sources(w, std::slice::from_ref(s)))
        }
    }
}
