//! `quadflow import-v1` — bring the project list over from QuadFlow 1.x.

use super::output::Out;
use super::Ctx;
use crate::events::EventBus;
use crate::import_v1::{self, ImportV1Env, ImportV1Options, ImportV1Outcome, ImportV1Report};
use clap::Args;
use std::io::Write;
use std::path::PathBuf;

#[derive(Args, Debug)]
pub struct ImportV1Args {
    /// Project folders to add (default with --all: every project the 1.x app knows).
    #[arg(value_name = "DIR")]
    pub dirs: Vec<PathBuf>,
    /// Import every project the 1.x app knows.
    #[arg(long)]
    pub all: bool,
    /// Only report what would happen; change nothing.
    #[arg(long)]
    pub dry_run: bool,
}

pub fn handle(ctx: &Ctx, out: &mut Out, args: ImportV1Args) -> i32 {
    let db = match ctx.app_db() {
        Ok(db) => db,
        Err(e) => return out.err(&e),
    };
    let env = ImportV1Env {
        profile: ctx.profile,
        v1_override: ctx.env.var(import_v1::ENV_V1_DATA_DIR).map(str::to_string),
    };
    let mut dirs: Vec<String> = args.dirs.iter().map(|d| ctx.env.cwd.join(d).display().to_string()).collect();
    if let Some(p) = &ctx.project_flag {
        dirs.push(ctx.env.cwd.join(p).display().to_string());
    }
    let opts = ImportV1Options { projects: dirs, all: args.all, dry_run: args.dry_run };
    let report = match import_v1::run(&db, &env, opts, &EventBus::new()) {
        Ok(r) => r,
        Err(e) => return out.err(&e),
    };
    let failed = report.projects.iter().any(|p| p.outcome == ImportV1Outcome::Failed);
    let code = out.ok(&report, &[], |w| human(w, &report));
    if code == 0 && failed {
        1
    } else {
        code
    }
}

fn outcome_label(o: ImportV1Outcome) -> &'static str {
    match o {
        ImportV1Outcome::Registered => "added",
        ImportV1Outcome::AlreadyRegistered => "already in the list",
        ImportV1Outcome::MovedAside => "added; 1.x data moved aside",
        ImportV1Outcome::WouldRegister => "would be added",
        ImportV1Outcome::WouldMoveAside => "would be added; 1.x data would be moved aside",
        ImportV1Outcome::V1DataKept => "has 1.x data (dev build: left as is)",
        ImportV1Outcome::MissingDir => "folder missing (skipped)",
        ImportV1Outcome::Failed => "FAILED",
    }
}

fn human(w: &mut dyn Write, r: &ImportV1Report) -> std::io::Result<()> {
    if r.dry_run {
        writeln!(w, "Dry run: nothing was changed.")?;
    }
    match &r.data_dir {
        Some(d) => writeln!(w, "QuadFlow 1.x data: {d}")?,
        None => writeln!(w, "QuadFlow 1.x data: not found (set QUADFLOW_V1_DATA_DIR)")?,
    }
    for p in &r.projects {
        writeln!(w, "{:<28} {}  ({})", p.name, outcome_label(p.outcome), p.root)?;
        if let Some(b) = &p.backup_dir {
            writeln!(w, "{:<28} backup: {b}", "")?;
        }
        if let Some(e) = &p.error {
            writeln!(w, "{:<28} error: {e}", "")?;
        }
    }
    writeln!(w, "App settings are not imported: they start at the defaults.")
}
