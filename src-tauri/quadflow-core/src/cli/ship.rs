//! `quadflow ship …` (data-layer.md §6.7, §11). Thin wrapper over
//! `domains::ship`; every subcommand honours `--json`. A run that does not
//! complete (`failed` / `aborted`) and an invalid config exit non-zero, in
//! JSON mode too (`{"ok":false,"error":{…,"details":{"run":…}}}`).

use super::output::Out;
use super::Ctx;
use crate::domains::ship::{
    self, ShipBumpType, ShipCheckLevel, ShipConfig, ShipInitOptions, ShipLineEvent, ShipLineStream, ShipPhaseEvent,
    ShipPhaseResult, ShipPhaseStatus, ShipRun, ShipRunMode, ShipRunOptions, ShipRunStatus, ShipSink,
};
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::io::Write;
use std::sync::mpsc;

#[derive(Subcommand, Debug)]
pub enum ShipAction {
    /// Write .quadflow/ship/config.json from a template (default: minimal).
    Init(InitArgs),
    /// Show, validate, save or delete the ship config.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// List templates; with --id, preview the config a template would write.
    Templates(TemplatesArgs),
    /// Installed tools, project kind, version files, signing keys, gh repos.
    Detect,
    /// Versions (and whether they agree), branch, dirty tree, last run.
    Status,
    /// Evaluate the readiness checks (all, or one with --check).
    Readiness(ReadinessArgs),
    /// Run a failing check's fix command, then re-check it.
    Fix(FixArgs),
    /// Bump every version file (nothing else).
    Bump(BumpArgs),
    /// Run the pipeline: patch | minor | major | deploy (re-ship the current version).
    Run(RunArgs),
    /// Abort a run (default: the newest in-progress run).
    Abort(AbortArgs),
    /// Run history, newest first.
    #[command(visible_alias = "runs")]
    List,
    /// One run, by run id or version (newest run of that version).
    Get(GetArgs),
    /// Restore orphan *.ship-bak files left by a crashed run.
    RestoreBackups,
    /// Where the config lives, whether it parses, phase/check/run counts.
    Diagnostics,
}

#[derive(Subcommand, Debug)]
pub enum ConfigAction {
    /// Print the config.
    Show,
    /// Lint the config and check version-file sync (invalid → non-zero exit).
    Validate {
        /// Lint this ShipConfig JSON file instead of the stored config.
        #[arg(long)]
        file: Option<std::path::PathBuf>,
    },
    /// Replace the config with a JSON file.
    Save {
        /// Path to a ShipConfig JSON file.
        #[arg(long)]
        file: std::path::PathBuf,
    },
    /// Move the config to ship/config.json.bak.
    Delete,
}

#[derive(Args, Debug)]
pub struct InitArgs {
    /// Template id (`quadflow ship templates`).
    #[arg(long)]
    template: Option<String>,
    /// Template param, repeatable: --param key=value.
    #[arg(long = "param", value_name = "KEY=VALUE")]
    params: Vec<String>,
    /// Overwrite an existing config.
    #[arg(long)]
    force: bool,
}

#[derive(Args, Debug)]
pub struct TemplatesArgs {
    /// Template id to preview.
    #[arg(long)]
    id: Option<String>,
    /// Template param for the preview, repeatable: --param key=value.
    #[arg(long = "param", value_name = "KEY=VALUE", requires = "id")]
    params: Vec<String>,
}

#[derive(Args, Debug)]
pub struct ReadinessArgs {
    /// Evaluate only this check id.
    #[arg(long)]
    check: Option<String>,
}

#[derive(Args, Debug)]
pub struct FixArgs {
    /// Check id (from `quadflow ship readiness`).
    check: String,
}

#[derive(Args, Debug)]
pub struct BumpArgs {
    #[arg(value_enum)]
    bump: ShipBumpType,
    /// Compute the new version without writing.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Args, Debug)]
pub struct RunArgs {
    #[arg(value_enum)]
    mode: ShipRunMode,
    /// Resolve and print the plan; execute and persist nothing.
    #[arg(long)]
    dry_run: bool,
    /// Skip build phases and shell phases with skipFlag "skip-build".
    #[arg(long)]
    skip_build: bool,
    /// Skip build phases and reuse the existing artifacts.
    #[arg(long)]
    reuse_build: bool,
    /// Same as mode `deploy`: keep the current version.
    #[arg(long)]
    no_bump: bool,
    /// Force --draft on every gh_release phase.
    #[arg(long)]
    draft: bool,
    /// Run this ShipConfig JSON file instead of .quadflow/ship/config.json
    /// (e.g. a release config tracked in the repo). Run records still go to
    /// the project's .quadflow/local/ship/runs/.
    #[arg(long, value_name = "FILE")]
    config: Option<std::path::PathBuf>,
}

#[derive(Args, Debug)]
pub struct AbortArgs {
    /// Run id (default: the newest in-progress run).
    run: Option<String>,
}

#[derive(Args, Debug)]
pub struct GetArgs {
    /// Run id, or a version like 1.2.3 / v1.2.3.
    run: String,
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: ShipAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    match exec(ctx, out, &store, action) {
        Ok(code) => code,
        Err(e) => out.err(&e),
    }
}

fn mark(s: ShipPhaseStatus) -> &'static str {
    match s {
        ShipPhaseStatus::Passed => "PASS",
        ShipPhaseStatus::Failed => "FAIL",
        ShipPhaseStatus::Skipped => "SKIP",
        ShipPhaseStatus::Running => "RUN ",
        ShipPhaseStatus::Pending => "PEND",
    }
}

fn status_str(s: ShipRunStatus) -> &'static str {
    match s {
        ShipRunStatus::InProgress => "in_progress",
        ShipRunStatus::Completed => "completed",
        ShipRunStatus::Failed => "failed",
        ShipRunStatus::Aborted => "aborted",
        ShipRunStatus::DryRun => "dry_run",
    }
}

fn phase_line(w: &mut dyn Write, p: &ShipPhaseResult, indent: usize) -> std::io::Result<()> {
    let pad = " ".repeat(indent);
    let dur = p.duration_ms.map(|d| format!(" ({d}ms)")).unwrap_or_default();
    writeln!(w, "{pad}[{}] {} · {}{dur}", mark(p.status), p.name, p.kind)?;
    if let Some(c) = &p.command {
        writeln!(w, "{pad}       $ {c}")?;
    }
    if let Some(d) = &p.detail {
        writeln!(w, "{pad}       {d}")?;
    }
    if let Some(e) = &p.error {
        writeln!(w, "{pad}       error: {e}")?;
    }
    for c in &p.children {
        phase_line(w, c, indent + 4)?;
    }
    Ok(())
}

fn run_detail(w: &mut dyn Write, r: &ShipRun) -> std::io::Result<()> {
    let prev = r.previous_version.as_deref().map(|p| format!("{p} → ")).unwrap_or_default();
    writeln!(w, "Run {}  {prev}{}  [{}]  mode={:?}", r.id, r.version, status_str(r.status), r.mode)?;
    writeln!(w, "  started {} by {}", r.started_at, r.started_by.name)?;
    if let Some(u) = &r.release_url {
        writeln!(w, "  release: {u}")?;
    }
    for p in &r.phases {
        phase_line(w, p, 2)?;
    }
    if !r.artifacts.is_empty() {
        writeln!(w, "  artifacts:")?;
        for a in &r.artifacts {
            writeln!(w, "    - {a}")?;
        }
    }
    Ok(())
}

fn config_human(w: &mut dyn Write, c: &ShipConfig) -> std::io::Result<()> {
    writeln!(w, "{}", serde_json::to_string_pretty(c).unwrap_or_default())
}

enum Event {
    Phase(ShipPhaseEvent),
    Line(ShipLineEvent),
    Restored(Vec<String>),
}

/// Forwards events to the CLI thread that owns stdout.
struct ChannelSink(mpsc::Sender<Event>);
impl ShipSink for ChannelSink {
    fn phase(&self, e: ShipPhaseEvent) {
        let _ = self.0.send(Event::Phase(e));
    }
    fn line(&self, e: ShipLineEvent) {
        let _ = self.0.send(Event::Line(e));
    }
    fn restored_backups(&self, files: &[String]) {
        let _ = self.0.send(Event::Restored(files.to_vec()));
    }
}

fn run_pipeline(ctx: &Ctx, out: &mut Out, s: &ProjectStore, a: RunArgs) -> Result<i32> {
    let mode = if a.no_bump { ShipRunMode::Deploy } else { a.mode };
    if a.no_bump && a.mode != ShipRunMode::Deploy {
        return Err(CoreError::invalid_input(format!("--no-bump contradicts mode {:?}", a.mode)));
    }
    let opts = ShipRunOptions { mode, dry_run: a.dry_run, skip_build: a.skip_build, reuse_build: a.reuse_build, draft: a.draft };
    let cfg = match &a.config {
        Some(file) => ship::config_from_file(&ctx.env.cwd.join(file))?,
        None => ship::config_require(s)?,
    };
    let json = out.json;
    let (tx, rx) = mpsc::channel::<Event>();
    let result = std::thread::scope(|scope| {
        let handle = scope.spawn(move || {
            let sink = ChannelSink(tx);
            ship::run_with_config(s, &ctx.actor, cfg, opts, &sink)
        });
        // Human mode: stream as it happens. JSON mode: stdout carries only the envelope.
        for ev in rx {
            if json {
                if let Event::Restored(files) = &ev {
                    let _ = writeln!(out.io.stderr, "ship: restored {} orphan backup(s)", files.len());
                }
                continue;
            }
            let w = &mut out.io.stdout;
            let _ = match ev {
                Event::Restored(files) => {
                    writeln!(w, "Restored {} orphan backup(s) from an earlier crashed run:", files.len())
                        .and_then(|_| files.iter().try_for_each(|f| writeln!(w, "  - {f}")))
                }
                Event::Phase(p) if p.phase.status == ShipPhaseStatus::Running => {
                    writeln!(w, "[{}/{}] {} ({})", p.index + 1, p.total, p.phase.name, p.phase.kind)
                }
                Event::Phase(p) => phase_line(&mut **w, &p.phase, 2),
                Event::Line(l) => match l.stream {
                    ShipLineStream::Meta => writeln!(w, "    {}", l.line),
                    _ => writeln!(w, "    | {}", l.line),
                },
            };
            let _ = w.flush();
        }
        handle.join().unwrap_or_else(|_| Err(CoreError::internal("ship run thread panicked")))
    });
    let run = result?;
    if let Some(e) = ship::run_outcome_error(&run) {
        if !json {
            let _ = writeln!(out.io.stdout, "\nResult: {}", status_str(run.status));
        }
        return Ok(out.err(&e));
    }
    Ok(out.ok(&run, &[], |w| {
        writeln!(w, "\nResult: {}  v{}  ({} ms)", status_str(run.status), run.version, run.completed_at.unwrap_or(run.started_at) - run.started_at)?;
        if run.dry_run {
            writeln!(w, "Resolved plan:")?;
            for p in &run.phases {
                phase_line(w, p, 2)?;
            }
        }
        if let Some(u) = &run.release_url {
            writeln!(w, "Release: {u}")?;
        }
        Ok(())
    }))
}

fn exec(ctx: &Ctx, out: &mut Out, s: &ProjectStore, action: ShipAction) -> Result<i32> {
    let a = &ctx.actor;
    Ok(match action {
        ShipAction::Init(i) => {
            let opts = ShipInitOptions { template: i.template, params: ship::parse_params(&i.params)?, force: i.force };
            let cfg = ship::init(s, a, opts)?;
            let path = ship::config_path(s);
            out.ok(&cfg, &[], |w| {
                writeln!(w, "Wrote {} ({} phase(s), {} version file(s)).", path.display(), cfg.phases.len(), cfg.version_files.len())?;
                for vf in &cfg.version_files {
                    writeln!(w, "  version: {} ({})", vf.path, vf.key)?;
                }
                writeln!(w, "Next: `quadflow ship config validate`, then `quadflow ship run patch --dry-run`.")
            })
        }
        ShipAction::Config { action } => match action {
            ConfigAction::Show => out.result(ship::config_require(s), config_human),
            ConfigAction::Validate { file } => {
                let v = match file {
                    Some(f) => ship::validate_config(&ship::config_from_file(&ctx.env.cwd.join(f))?, &s.root().path),
                    None => ship::validate(s)?,
                };
                if !v.valid {
                    let e = CoreError::invalid_input(format!("ship config has {} problem(s): {}", v.errors.len(), v.errors.join("; ")))
                        .with_details(serde_json::json!({ "errors": v.errors }));
                    if !out.json {
                        for err in &v.errors {
                            let _ = writeln!(out.io.stderr, "  - {err}");
                        }
                    }
                    return Ok(out.err(&e));
                }
                out.ok(&v, &[], |w| writeln!(w, "Config is valid."))
            }
            ConfigAction::Save { file } => {
                let path = ctx.env.cwd.join(file);
                let bytes = std::fs::read(&path).map_err(|e| CoreError::io(&path, e))?;
                let cfg: ShipConfig = serde_json::from_slice(&bytes)
                    .map_err(|e| CoreError::invalid_input(format!("{}: not a ship config: {e}", path.display())))?;
                out.result(ship::config_save(s, a, cfg), |w, _| writeln!(w, "Saved {}", ship::config_path(s).display()))
            }
            ConfigAction::Delete => out.result(ship::config_delete(s, a), |w, r| match &r.backup_path {
                Some(b) => writeln!(w, "Deleted the ship config (backup: {b})"),
                None => writeln!(w, "No ship config to delete."),
            }),
        },
        ShipAction::Templates(t) => match t.id {
            None => {
                let all = ship::available_templates();
                out.ok(&all, &[], |w| {
                    for t in &all {
                        writeln!(w, "{:<20} {}", t.id, t.label)?;
                        for p in &t.params {
                            let req = if p.required { " (required)" } else { "" };
                            writeln!(w, "{:<22}--param {}=…  {}{req}", "", p.key, p.label)?;
                        }
                    }
                    Ok(())
                })
            }
            Some(id) => out.result(ship::template_preview(s, &id, &ship::parse_params(&t.params)?), config_human),
        },
        ShipAction::Detect => {
            let d = ship::detect_environment(&s.root().path);
            out.ok(&d, &[], |w| {
                writeln!(w, "Project: {} ({:?}), product {:?}", d.project_dir, d.project_kind, d.product_name)?;
                for vf in &d.version_files {
                    writeln!(w, "  version file: {} ({})", vf.path, vf.key)?;
                }
                let have: Vec<&str> = d.tools.iter().filter(|(_, v)| **v).map(|(k, _)| k.as_str()).collect();
                writeln!(w, "Tools: {}", have.join(", "))?;
                if let Some(u) = &d.gh_user {
                    writeln!(w, "GitHub: {u}")?;
                }
                Ok(())
            })
        }
        ShipAction::Status => {
            let st = ship::status(s)?;
            out.ok(&st, &[], |w| {
                writeln!(w, "Branch:  {}", st.branch.as_deref().unwrap_or("(no git)"))?;
                writeln!(w, "Tree:    {}", match st.git_clean { Some(true) => "clean", Some(false) => "DIRTY", None => "unknown" })?;
                match (&st.canonical_version, st.in_sync) {
                    (Some(v), true) => writeln!(w, "Version: {v} (in sync)")?,
                    (None, true) => writeln!(w, "Version: (no version files)")?,
                    _ => {
                        writeln!(w, "Version: OUT OF SYNC")?;
                        for f in &st.version_files {
                            writeln!(w, "  {} → {}", f.file, f.current.as_deref().or(f.error.as_deref()).unwrap_or("?"))?;
                        }
                    }
                }
                match &st.last_run {
                    Some(r) => writeln!(w, "Last run: {} v{} [{}]", r.id, r.version, status_str(r.status)),
                    None => writeln!(w, "Last run: (none)"),
                }
            })
        }
        ShipAction::Readiness(r) => {
            let checks = match r.check {
                Some(id) => vec![ship::readiness_one(s, &id)?],
                None => ship::readiness(s)?,
            };
            out.ok(&checks, &[], |w| {
                for c in &checks {
                    let m = match c.level {
                        ShipCheckLevel::Pass => "ok  ",
                        ShipCheckLevel::Warn => "warn",
                        ShipCheckLevel::Fail => "FAIL",
                    };
                    writeln!(w, "[{m}] {}  ({})", c.label, c.id)?;
                    if c.level != ShipCheckLevel::Pass {
                        if let Some(h) = &c.hint {
                            writeln!(w, "       {h}")?;
                        }
                        if let Some(f) = &c.fix_command {
                            writeln!(w, "       fix: {f}")?;
                        }
                    }
                }
                Ok(())
            })
        }
        ShipAction::Fix(f) => {
            let json = out.json;
            let lines = std::sync::Mutex::new(Vec::new());
            let r = ship::run_fix(s, &f.check, &|l| lines.lock().unwrap().push(l));
            if !json {
                for l in lines.into_inner().unwrap_or_default() {
                    let _ = writeln!(out.io.stdout, "  {}", l.line);
                }
            }
            out.result(r, |w, c| writeln!(w, "{}: {:?}", c.label, c.level))
        }
        ShipAction::Bump(b) => out.result(ship::bump(s, a, b.bump, b.dry_run), |w, r| {
            writeln!(w, "{} {} → {}", if r.dry_run { "Would bump" } else { "Bumped" }, r.from, r.to)?;
            for f in &r.files {
                writeln!(w, "  {f}")?;
            }
            Ok(())
        }),
        ShipAction::Run(r) => run_pipeline(ctx, out, s, r)?,
        ShipAction::Abort(x) => {
            let id = x.run.as_deref().map(Id::parse).transpose()?;
            out.result(ship::abort(s, a, id.as_ref()), |w, r| writeln!(w, "Aborted run {} (v{})", r.id, r.version))
        }
        ShipAction::List => {
            let l = ship::runs_list(s)?;
            out.ok(&l.items, &l.errors, |w| {
                if l.items.is_empty() {
                    writeln!(w, "(no ship runs)")?;
                }
                for r in &l.items {
                    writeln!(w, "{}  v{:<10} {:<11} {:?}  phases={}", r.id, r.version, status_str(r.status), r.mode, r.phases.len())?;
                }
                Ok(())
            })
        }
        ShipAction::Get(g) => out.result(ship::run_resolve(s, &g.run), run_detail),
        ShipAction::RestoreBackups => {
            let restored = ship::restore_backups(s);
            out.ok(&restored, &[], |w| {
                if restored.is_empty() {
                    writeln!(w, "No orphan backups found.")?;
                }
                for r in &restored {
                    writeln!(w, "Restored {r}")?;
                }
                Ok(())
            })
        }
        ShipAction::Diagnostics => {
            let d = ship::diagnostics(s)?;
            out.ok(&d, &[], |w| writeln!(w, "{}", serde_json::to_string_pretty(&d).unwrap_or_default()))
        }
    })
}
