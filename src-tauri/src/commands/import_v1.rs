//! QuadFlow 1.x: project list import and 1.x project folders (`quadflow_core::import_v1`).

use crate::core_state::{blocking, CoreState};
use quadflow_core::import_v1::legacy::{self, ImportV1LegacyNotice};
use quadflow_core::import_v1::{self, ImportV1Detection, ImportV1Env, ImportV1Options, ImportV1Report};
use quadflow_core::CoreError;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

fn env(core: &CoreState) -> ImportV1Env {
    ImportV1Env {
        profile: core.core.profile(),
        v1_override: std::env::var(import_v1::ENV_V1_DATA_DIR).ok().filter(|v| !v.trim().is_empty()),
    }
}

/// Is a 1.x installation present, has the import run, and a dry-run preview.
#[tauri::command]
#[specta::specta]
pub async fn import_v1_detect(core: State<'_, CoreState>) -> Result<ImportV1Detection, CoreError> {
    let env = env(&core);
    let c = Arc::clone(&core.core);
    blocking(move || import_v1::detect(&*c.app_db()?, &env)).await
}

/// Add the selected 1.x projects to the projects list (or preview with `dryRun`).
#[tauri::command]
#[specta::specta]
pub async fn import_v1_run(core: State<'_, CoreState>, options: ImportV1Options) -> Result<ImportV1Report, CoreError> {
    let env = env(&core);
    let c = Arc::clone(&core.core);
    blocking(move || import_v1::run(&*c.app_db()?, &env, options, &c.bus)).await
}

/// "Not now": the first-run offer is not shown again (Settings can still run it).
#[tauri::command]
#[specta::specta]
pub async fn import_v1_dismiss(core: State<'_, CoreState>) -> Result<(), CoreError> {
    let c = Arc::clone(&core.core);
    blocking(move || import_v1::dismiss(&*c.app_db()?)).await
}

/// Before opening a project: a 1.x `.quadflow/` is moved aside and a fresh one
/// created (release), or only reported (dev). `null` = nothing to do.
#[tauri::command]
#[specta::specta]
pub async fn import_v1_check_project(
    core: State<'_, CoreState>,
    project_root: String,
) -> Result<Option<ImportV1LegacyNotice>, CoreError> {
    let c = Arc::clone(&core.core);
    blocking(move || legacy::check_project(&PathBuf::from(project_root), c.profile(), &c.bus)).await
}
