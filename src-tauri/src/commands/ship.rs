//! Ship commands (data-layer.md §10.2 `ship.rs`). No logic: each command
//! resolves the project store and calls `quadflow_core::domains::ship`.
//! `ship_run` and `ship_run_fix` stream over a `tauri::ipc::Channel`.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::ship::{
    self, ShipBumpResult, ShipBumpType, ShipCancel, ShipConfig, ShipConfigDeleteResult, ShipDiagnostics,
    ShipEnvDetection, ShipExternalOutcome, ShipExternalRequest, ShipExternalResult, ShipInitOptions, ShipLineEvent,
    ShipPhaseEvent, ShipReadinessCheck, ShipRun, ShipRunEvent, ShipRunOptions, ShipSink, ShipStatus, ShipTemplateInfo,
    ShipValidation,
};
use quadflow_core::store::ProjectStore;
use quadflow_core::{Actor, CoreError, Id, ListResult};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

async fn with_store<T: Send + 'static>(
    core: &State<'_, CoreState>,
    project_root: String,
    f: impl FnOnce(&ProjectStore, &Actor) -> Result<T, CoreError> + Send + 'static,
) -> Result<T, CoreError> {
    let c = core.core.clone();
    let actor = core.actor.clone();
    blocking(move || {
        let store: Arc<ProjectStore> = c.project(&PathBuf::from(project_root))?;
        f(&store, &actor)
    })
    .await
}

/// Forwards run output to the frontend channel; external-terminal phases are
/// handed to the frontend, which reports back through `ship_external_complete`.
struct ChannelSink(Channel<ShipRunEvent>);

impl ShipSink for ChannelSink {
    fn phase(&self, event: ShipPhaseEvent) {
        let _ = self.0.send(ShipRunEvent::Phase { event });
    }
    fn line(&self, event: ShipLineEvent) {
        let _ = self.0.send(ShipRunEvent::Line { event });
    }
    fn external(&self, req: ShipExternalRequest, cancel: &ShipCancel) -> ShipExternalOutcome {
        ship::external_roundtrip(req, cancel, |request| {
            self.0.send(ShipRunEvent::ExternalRequest { request }).map_err(|e| e.to_string())
        })
    }
    fn restored_backups(&self, files: &[String]) {
        let _ = self.0.send(ShipRunEvent::RestoredBackups { files: files.to_vec() });
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ship_config_get(core: State<'_, CoreState>, project_root: String) -> Result<Option<ShipConfig>, CoreError> {
    with_store(&core, project_root, |s, _| ship::config_get(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_config_save(core: State<'_, CoreState>, project_root: String, config: ShipConfig) -> Result<ShipConfig, CoreError> {
    with_store(&core, project_root, move |s, a| ship::config_save(s, a, config)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_config_validate(core: State<'_, CoreState>, project_root: String) -> Result<ShipValidation, CoreError> {
    with_store(&core, project_root, |s, _| ship::validate(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_config_delete(core: State<'_, CoreState>, project_root: String) -> Result<ShipConfigDeleteResult, CoreError> {
    with_store(&core, project_root, |s, a| ship::config_delete(s, a)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_init(core: State<'_, CoreState>, project_root: String, options: ShipInitOptions) -> Result<ShipConfig, CoreError> {
    with_store(&core, project_root, move |s, a| ship::init(s, a, options)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_templates() -> Result<Vec<ShipTemplateInfo>, CoreError> {
    Ok(ship::available_templates())
}

#[tauri::command]
#[specta::specta]
pub async fn ship_template_preview(
    core: State<'_, CoreState>,
    project_root: String,
    template: String,
    params: BTreeMap<String, String>,
) -> Result<ShipConfig, CoreError> {
    with_store(&core, project_root, move |s, _| ship::template_preview(s, &template, &params)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_detect(core: State<'_, CoreState>, project_root: String) -> Result<ShipEnvDetection, CoreError> {
    with_store(&core, project_root, |s, _| Ok(ship::detect_environment(&s.root().path))).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_status(core: State<'_, CoreState>, project_root: String) -> Result<ShipStatus, CoreError> {
    with_store(&core, project_root, |s, _| ship::status(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_readiness(core: State<'_, CoreState>, project_root: String) -> Result<Vec<ShipReadinessCheck>, CoreError> {
    with_store(&core, project_root, |s, _| ship::readiness(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_readiness_one(core: State<'_, CoreState>, project_root: String, check_id: String) -> Result<ShipReadinessCheck, CoreError> {
    with_store(&core, project_root, move |s, _| ship::readiness_one(s, &check_id)).await
}

/// Runs the check's own fix command (never an arbitrary one); lines stream on `channel`.
#[tauri::command]
#[specta::specta]
pub async fn ship_run_fix(
    core: State<'_, CoreState>,
    project_root: String,
    check_id: String,
    channel: Channel<ShipLineEvent>,
) -> Result<ShipReadinessCheck, CoreError> {
    with_store(&core, project_root, move |s, _| {
        ship::run_fix(s, &check_id, &|l| {
            let _ = channel.send(l);
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_bump(core: State<'_, CoreState>, project_root: String, bump: ShipBumpType, dry_run: bool) -> Result<ShipBumpResult, CoreError> {
    with_store(&core, project_root, move |s, a| ship::bump(s, a, bump, dry_run)).await
}

/// Long-running; streams `ShipRunEvent`s on `channel` and returns the final record.
#[tauri::command]
#[specta::specta]
pub async fn ship_run(
    core: State<'_, CoreState>,
    project_root: String,
    options: ShipRunOptions,
    channel: Channel<ShipRunEvent>,
) -> Result<ShipRun, CoreError> {
    with_store(&core, project_root, move |s, a| ship::run(s, a, options, &ChannelSink(channel))).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_abort(core: State<'_, CoreState>, project_root: String, run_id: Option<Id>) -> Result<ShipRun, CoreError> {
    with_store(&core, project_root, move |s, a| ship::abort(s, a, run_id.as_ref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_external_complete(request_id: String, result: ShipExternalResult) -> Result<(), CoreError> {
    ship::external_complete(&request_id, result)
}

#[tauri::command]
#[specta::specta]
pub async fn ship_runs_list(core: State<'_, CoreState>, project_root: String) -> Result<ListResult<ShipRun>, CoreError> {
    with_store(&core, project_root, |s, _| ship::runs_list(s)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_runs_get(core: State<'_, CoreState>, project_root: String, id: Id) -> Result<ShipRun, CoreError> {
    with_store(&core, project_root, move |s, _| ship::runs_get(s, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_restore_backups(core: State<'_, CoreState>, project_root: String) -> Result<Vec<String>, CoreError> {
    with_store(&core, project_root, |s, _| Ok(ship::restore_backups(s))).await
}

#[tauri::command]
#[specta::specta]
pub async fn ship_diagnostics(core: State<'_, CoreState>, project_root: String) -> Result<ShipDiagnostics, CoreError> {
    with_store(&core, project_root, |s, _| ship::diagnostics(s)).await
}
