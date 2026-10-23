//! `quadflow init` and `quadflow doctor` (data-layer.md §3.2, §4.4, §11).

use super::output::Out;
use super::Ctx;
use crate::domains::doctor::{self, CheckStatus};
use crate::domains::project_config::{self, InitOptions, ProjectConfig};
use crate::events::EventBus;
use crate::paths::Profile;
use crate::store::ProjectStore;
use serde::Serialize;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InitResult {
    pub root: String,
    pub data_dir: String,
    pub profile: Profile,
    pub config: ProjectConfig,
}

pub fn init(ctx: &Ctx, out: &mut Out, name: Option<String>, code: Option<String>) -> i32 {
    let target = ctx.project_flag.clone().unwrap_or_else(|| ctx.env.cwd.clone());
    let r = project_config::init_with(&target, ctx.profile, InitOptions { name, code }, EventBus::new()).and_then(
        |store: ProjectStore| {
            Ok(InitResult {
                root: store.root().path.display().to_string(),
                data_dir: store.data_dir().display().to_string(),
                profile: store.root().profile,
                config: project_config::read(&store)?,
            })
        },
    );
    out.result(r, |w, r| {
        writeln!(w, "Initialized QuadFlow project \"{}\" (code {}) in {}", r.config.name, r.config.code, r.data_dir)
    })
}

pub fn doctor(ctx: &Ctx, out: &mut Out, fix: bool) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let report = match doctor::run(&store, &ctx.actor, fix) {
        Ok(r) => r,
        Err(e) => return out.err(&e),
    };
    let ok = report.ok;
    let code = out.ok(&report, &[], |w| {
        writeln!(w, "{} ({} profile, {})", report.root, report.profile.as_str(), report.data_dir)?;
        for c in &report.checks {
            let mark = match (c.status, c.fixed) {
                (_, true) => "fixed",
                (CheckStatus::Ok, _) => "ok",
                (CheckStatus::Warn, _) => "warn",
                (CheckStatus::Error, _) => "ERROR",
            };
            writeln!(w, "  [{mark:>5}] {}: {}", c.id, c.message)?;
            for p in &c.paths {
                writeln!(w, "          {p}")?;
            }
        }
        if !fix && report.checks.iter().any(|c| c.status != CheckStatus::Ok) {
            writeln!(w, "Run `quadflow doctor --fix` to repair what can be repaired.")?;
        }
        Ok(())
    });
    if code == 0 && !ok {
        1
    } else {
        code
    }
}
