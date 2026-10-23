//! Sidecar of the `local-titles` plugin (plugin-system.md §10): terminal
//! titles from a local GGUF model via llama.cpp, plus model download /
//! management. The plugin's UI module calls it from its `titleGenerators.llama`
//! contribution and its settings page.
//!
//! Requests (UI → sidecar, `ctx.sidecar.request`):
//! - `titles/info` → `{ backend: "llama.cpp" | "none", gpu: "cuda" | "metal" | "vulkan" | null, modelsDir }`
//! - `titles/models` → `[{ id, name, sizeBytes, qualityRating, tier, downloaded, downloading, path }]`
//! - `titles/download { modelId }` → `{ started: true }`; progress `ui/downloadProgress
//!   { modelId, downloadedBytes, totalBytes }`, end `ui/downloadDone { modelId, ok, error? }`
//! - `titles/cancelDownload` → `{ ok }`
//! - `titles/delete { modelId }` → `{ ok }`
//! - `titles/generate { text, modelId, minWords, maxWords, deviceMode?, gpuLayers?, maxTokens?, temperature? }`
//!   → `{ title, device }` (error `not_found` when the model is not downloaded)

mod inference;
mod models;

use quadflow_sidecar::{json, RpcError, Server, Value};

fn str_param<'a>(p: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    p.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| RpcError::invalid_params(format!("missing `{key}`")))
}

fn u32_param(p: &Value, key: &str, default: u32) -> u32 {
    p.get(key).and_then(Value::as_u64).map(|v| v.min(u32::MAX as u64) as u32).unwrap_or(default)
}

fn model_param(p: &Value) -> Result<&'static models::TitleModel, RpcError> {
    let id = str_param(p, "modelId")?;
    models::find(id).ok_or_else(|| RpcError::with_kind("not_found", format!("unknown model {id:?}")))
}

fn main() -> std::io::Result<()> {
    Server::new()
        .on_request("titles/info", |host, _| {
            Ok(json!({
                "backend": inference::backend(),
                "gpu": inference::gpu_backend(),
                "modelsDir": models::models_dir(host).to_string_lossy(),
            }))
        })
        .on_request("titles/models", |host, _| Ok(models::list_json(host)))
        .on_request("titles/download", |host, p| {
            let m = model_param(&p)?;
            models::start_download(host, m).map_err(RpcError::new)?;
            Ok(json!({ "started": true }))
        })
        .on_request("titles/cancelDownload", |_, _| {
            models::cancel_downloads();
            Ok(json!({ "ok": true }))
        })
        .on_request("titles/delete", |host, p| {
            let m = model_param(&p)?;
            models::delete(host, m).map_err(RpcError::new)?;
            Ok(json!({ "ok": true }))
        })
        .on_request("titles/generate", |host, p| {
            let text = str_param(&p, "text")?;
            let m = model_param(&p)?;
            let path = models::model_path(host, m);
            if !path.is_file() {
                return Err(RpcError::with_kind("not_found", format!("{} is not downloaded", m.name)));
            }
            let opts = inference::GenerateOptions {
                model_id: m.id.to_string(),
                device_mode: p.get("deviceMode").and_then(Value::as_str).unwrap_or("auto").to_string(),
                gpu_layers: p.get("gpuLayers").and_then(Value::as_u64).map(|v| v as u32),
                max_tokens: u32_param(&p, "maxTokens", 12).clamp(1, 64),
                temperature: p.get("temperature").and_then(Value::as_f64).unwrap_or(0.2) as f32,
                min_words: u32_param(&p, "minWords", 3),
                max_words: u32_param(&p, "maxWords", 6),
            };
            let (title, device) = inference::generate(text, &path, &opts).map_err(RpcError::new)?;
            Ok(json!({ "title": title, "device": device }))
        })
        .on_shutdown(|_, _| {
            models::cancel_downloads();
            Ok(Value::Null)
        })
        .run()
}
