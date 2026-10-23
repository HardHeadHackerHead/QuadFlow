//! Project commands (data-layer.md §10.2 `project.rs`) plus core info and the
//! per-project watcher subscription.

use crate::core_state::{blocking, CoreState};
use quadflow_core::cli::project::InitResult;
use quadflow_core::domains::doctor::{self, DoctorReport};
use quadflow_core::domains::project_config::{self, InitOptions, ProjectConfig, ProjectConfigPatch};
use quadflow_core::paths::{default_working_dir, ENV_PROJECT_DIR};
use quadflow_core::{CoreError, Profile};
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

/// Build profile + resolved locations, for the shell and dev tooling.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub profile: Profile,
    pub app_identifier: String,
    /// `.quadflow` or `.quadflow-dev`.
    pub project_dir_name: String,
    pub data_dir: String,
    pub db_path: String,
    pub logs_dir: String,
    /// Where the shell should point when no project is open: `QUADFLOW_PROJECT_DIR`,
    /// or a scratch dir in the dev profile; `null` = shell default (home).
    pub default_working_dir: Option<String>,
    /// `QUADFLOW_SKIP_ONBOARDING=1`: the shell never shows the first-run
    /// welcome flow (the GUI harness sets it so e2e tests start in the workspace).
    pub skip_onboarding: bool,
}

/// Env var that suppresses the first-run onboarding (see `CoreInfo::skip_onboarding`).
pub const ENV_SKIP_ONBOARDING: &str = "QUADFLOW_SKIP_ONBOARDING";

fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| matches!(v.trim(), "1" | "true" | "yes")).unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub async fn core_info(core: State<'_, CoreState>) -> Result<CoreInfo, CoreError> {
    let paths = core.core.paths.clone();
    blocking(move || {
        let env_dir = std::env::var(ENV_PROJECT_DIR).ok();
        let wd = default_working_dir(paths.profile, env_dir.as_deref(), &paths.data_dir);
        if let Some(dir) = &wd {
            std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;
        }
        Ok(CoreInfo {
            profile: paths.profile,
            app_identifier: paths.profile.app_identifier().to_string(),
            project_dir_name: paths.profile.project_dir_name().to_string(),
            data_dir: paths.data_dir.display().to_string(),
            db_path: paths.db_path.display().to_string(),
            logs_dir: paths.logs_dir.display().to_string(),
            default_working_dir: wd.map(|p| p.display().to_string()),
            skip_onboarding: env_flag(ENV_SKIP_ONBOARDING),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn project_init(
    core: State<'_, CoreState>,
    project_root: String,
    opts: InitOptions,
) -> Result<InitResult, CoreError> {
    let c = core.core.clone();
    blocking(move || {
        let store = project_config::init_with(&PathBuf::from(&project_root), c.profile(), opts, c.bus.clone())?;
        let store = c.adopt_project(store);
        Ok(InitResult {
            root: store.root().path.display().to_string(),
            data_dir: store.data_dir().display().to_string(),
            profile: store.root().profile,
            config: project_config::read(&store)?,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn project_config_get(core: State<'_, CoreState>, project_root: String) -> Result<ProjectConfig, CoreError> {
    let c = core.core.clone();
    blocking(move || project_config::read(&*c.project(&PathBuf::from(project_root))?)).await
}

#[tauri::command]
#[specta::specta]
pub async fn project_config_update(
    core: State<'_, CoreState>,
    project_root: String,
    patch: ProjectConfigPatch,
) -> Result<ProjectConfig, CoreError> {
    let c = core.core.clone();
    let actor = core.actor.clone();
    blocking(move || project_config::update(&*c.project(&PathBuf::from(project_root))?, &actor, patch)).await
}

#[tauri::command]
#[specta::specta]
pub async fn project_doctor(
    core: State<'_, CoreState>,
    project_root: String,
    fix: bool,
) -> Result<DoctorReport, CoreError> {
    let c = core.core.clone();
    let actor = core.actor.clone();
    blocking(move || doctor::run(&*c.project(&PathBuf::from(project_root))?, &actor, fix)).await
}

/// Start emitting `External` `data-changed` events for a project's folder.
#[tauri::command]
#[specta::specta]
pub async fn project_watch(core: State<'_, CoreState>, project_root: String) -> Result<(), CoreError> {
    let c = core.core.clone();
    blocking(move || c.watch_project(&PathBuf::from(project_root))).await
}

#[tauri::command]
#[specta::specta]
pub async fn project_unwatch(core: State<'_, CoreState>, project_root: String) -> Result<(), CoreError> {
    let c = core.core.clone();
    blocking(move || {
        c.unwatch_project(&quadflow_core::paths::root_key(&PathBuf::from(project_root)));
        Ok(())
    })
    .await
}
