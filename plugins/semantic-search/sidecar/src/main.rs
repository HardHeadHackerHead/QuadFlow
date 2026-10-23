//! Sidecar of the optional `semantic-search` plugin (plugin-system.md §10):
//! indexes agent session transcripts into local embeddings (Candle) and
//! answers semantic searches over them. Its index and downloaded models live
//! in the plugin data folder (`QUADFLOW_PLUGIN_DATA`).
//!
//! Requests (UI → sidecar, `ctx.sidecar.request`):
//! - `status` — job state, progress, index stats, model, GPU build flags
//! - `reloadSettings` — re-read the plugin settings now (also on `settings/didChange`)
//! - `roots` — the session roots that are scanned
//! - `models` — the model catalog with download state
//! - `downloadModel { id }` / `deleteModel { id }` — model files (download runs in the background)
//! - `index { full? }` — start a background index job (`{ started }`)
//! - `stop` — stop the running job / download
//! - `clear` — drop the whole index
//! - `cleanup { maxAgeDays? }` — drop chunks of other models and of old sessions
//! - `search { query, mode?: "sessions"|"chunks", limit?, minScore?, providerId?, project?, currentFiles? }`
//! - `sessions { status?, providerId?, text?, limit? }` — known sessions
//! - `chunks { sessionPath }` — the indexed chunks of one session
//! - `forget { sessionPath }` — drop one session from the index (until it changes again)
//! - `debugInfo` — paths and configuration as text
//!
//! Notifications (sidecar → UI, `ctx.sidecar.onNotification`): `status`,
//! `progress`, `indexed`, `download`.

mod chunker;
mod engine;
mod indexer;
mod models;
mod signals;
mod sources;
mod store;

use indexer::Service;
use quadflow_sidecar::{json, Host, RpcError, RpcResult, Server, Value};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

static SERVICE: OnceLock<Arc<Service>> = OnceLock::new();

fn service() -> Result<&'static Arc<Service>, RpcError> {
    SERVICE.get().ok_or_else(|| RpcError::with_kind("unavailable", "semantic search is still starting"))
}

fn data_dir() -> PathBuf {
    std::env::var_os("QUADFLOW_PLUGIN_DATA")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn err(e: String) -> RpcError {
    match e.strip_prefix("model_missing: ") {
        Some(msg) => RpcError::with_kind("model_missing", msg),
        None => RpcError::new(e),
    }
}

fn str_param<'a>(p: &'a Value, key: &str) -> Option<&'a str> {
    p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn initialize(host: &Host, init: &Value) -> RpcResult {
    let svc = Service::new(data_dir(), host.clone()).map_err(err)?;
    if let Some(s) = init.get("settings").filter(|s| s.is_object()) {
        svc.apply_settings(s);
    }
    if SERVICE.set(Arc::clone(&svc)).is_ok() {
        std::thread::spawn(move || svc.run_scheduler());
    }
    Ok(json!({ "capabilities": {} }))
}

fn download(p: Value) -> RpcResult {
    let svc = service()?;
    let id = str_param(&p, "id").ok_or_else(|| RpcError::invalid_params("id is required"))?.to_string();
    let m = models::MODELS.iter().find(|m| m.id == id).ok_or_else(|| RpcError::with_kind("not_found", format!("unknown model {id}")))?;
    let svc = Arc::clone(svc);
    std::thread::spawn(move || {
        let host_ui = |v: Value| svc_ui(&svc, v);
        let r = svc.download_model(m, &mut |d| host_ui(json!({ "modelId": d.model_id, "file": d.file, "downloadedBytes": d.downloaded_bytes, "totalBytes": d.total_bytes })));
        match r {
            Ok(()) => host_ui(json!({ "modelId": m.id, "done": true })),
            Err(e) => host_ui(json!({ "modelId": m.id, "done": true, "error": e })),
        }
        svc.notify_status();
    });
    Ok(json!({ "started": true }))
}

fn svc_ui(svc: &Service, v: Value) {
    svc.host_ui("download", v);
}

fn debug_info(svc: &Service) -> String {
    let cfg = svc.config();
    let mut s = String::from("=== Semantic Search ===\n");
    s.push_str(&format!("data dir: {}\n", svc.data_dir.display()));
    s.push_str(&format!("database: {}\n", svc.data_dir.join("semantic.db").display()));
    s.push_str(&format!("models dir: {}\n", svc.data_dir.join("models").display()));
    for m in models::statuses(&svc.data_dir) {
        s.push_str(&format!("  {} — downloaded: {} ({} bytes)\n", m.info.id, m.downloaded, m.disk_bytes));
    }
    s.push_str(&format!("loaded model: {:?} on {:?}\n", svc.loaded_model(), svc.device()));
    s.push_str(&format!("GPU build: cuda={} metal={}\n", cfg!(feature = "cuda"), cfg!(feature = "metal")));
    s.push_str(&format!("GPU available: cuda={} metal={}\n", engine::is_cuda_available(), engine::is_metal_available()));
    s.push_str(&format!("settings: {}\n", serde_json::to_string_pretty(&cfg).unwrap_or_default()));
    s.push_str(&format!("provider session roots (agents.sessionRoots): {:?}\n", svc.provider_api()));
    for r in svc.roots() {
        s.push_str(&format!("  [{}] {} {} (exists: {})\n", r.spec.origin, r.spec.provider_id, r.spec.root, r.root().is_dir()));
    }
    s
}

fn main() -> std::io::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).target(env_logger::Target::Stderr).init();
    Server::new()
        .on_initialize(initialize)
        .on_notification("settings/didChange", |_h, _p| {
            if let Ok(svc) = service() {
                svc.refresh_settings();
                svc.notify_status();
            }
        })
        .on_request("status", |_h, _p| Ok(service()?.status_json()))
        .on_request("reloadSettings", |_h, _p| {
            let svc = service()?;
            svc.refresh_settings();
            svc.notify_status();
            Ok(svc.status_json())
        })
        .on_request("roots", |_h, _p| Ok(service()?.roots_json()))
        .on_request("models", |_h, _p| Ok(serde_json::to_value(models::statuses(&service()?.data_dir)).unwrap_or(Value::Null)))
        .on_request("downloadModel", |_h, p| download(p))
        .on_request("deleteModel", |_h, p| {
            let svc = service()?;
            let id = str_param(&p, "id").ok_or_else(|| RpcError::invalid_params("id is required"))?;
            if svc.loaded_model().as_deref() == Some(id) {
                svc.unload();
            }
            models::delete(&svc.data_dir, id).map_err(err)?;
            svc.notify_status();
            Ok(Value::Null)
        })
        .on_request("index", |_h, p| {
            let svc = service()?;
            let full = p.get("full").and_then(Value::as_bool).unwrap_or(false);
            Ok(json!({ "started": svc.start_job(full) }))
        })
        .on_request("stop", |_h, _p| {
            service()?.request_stop();
            Ok(Value::Null)
        })
        .on_request("clear", |_h, _p| {
            let svc = service()?;
            svc.request_stop();
            svc.store().clear().map_err(err)?;
            svc.notify_status();
            Ok(Value::Null)
        })
        .on_request("cleanup", |_h, p| {
            let svc = service()?;
            let days = p.get("maxAgeDays").and_then(Value::as_u64).map(|d| d as u32).unwrap_or(svc.config().max_session_age_days);
            let removed = svc.store().cleanup(svc.model().id, days).map_err(err)?;
            svc.notify_status();
            Ok(json!({ "chunksRemoved": removed }))
        })
        .on_request("search", |_h, p| {
            let svc = service()?;
            let query = str_param(&p, "query").unwrap_or("").trim().to_string();
            if query.is_empty() {
                return Ok(json!([]));
            }
            let filter: store::SearchFilter = serde_json::from_value(p.clone()).unwrap_or_default();
            let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 200) as usize;
            let min = p.get("minScore").and_then(Value::as_f64).map(|v| v as f32);
            svc.search(&query, str_param(&p, "mode").unwrap_or("sessions"), &filter, limit, min).map_err(err)
        })
        .on_request("sessions", |_h, p| {
            let svc = service()?;
            let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(500).clamp(1, 5000) as usize;
            let rows = svc
                .store()
                .sessions(str_param(&p, "status"), str_param(&p, "providerId"), str_param(&p, "text"), limit)
                .map_err(err)?;
            Ok(serde_json::to_value(rows).unwrap_or(Value::Null))
        })
        .on_request("forget", |_h, p| {
            let svc = service()?;
            let path = str_param(&p, "sessionPath").ok_or_else(|| RpcError::invalid_params("sessionPath is required"))?;
            svc.store().delete_session(path).map_err(err)?;
            svc.notify_status();
            Ok(Value::Null)
        })
        .on_request("chunks", |_h, p| {
            let svc = service()?;
            let path = str_param(&p, "sessionPath").ok_or_else(|| RpcError::invalid_params("sessionPath is required"))?;
            Ok(serde_json::to_value(svc.store().chunks_of(path).map_err(err)?).unwrap_or(Value::Null))
        })
        .on_request("debugInfo", |_h, _p| Ok(Value::String(debug_info(service()?))))
        .on_shutdown(|_h, _p| {
            if let Ok(svc) = service() {
                svc.request_stop();
            }
            Ok(Value::Null)
        })
        .run()
}
