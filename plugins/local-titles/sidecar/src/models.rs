//! Model catalog, on-disk status and downloads (moved from the app's
//! `src-tauri/src/title/models.rs`). Models live in the plugin's data folder:
//! `<QUADFLOW_PLUGIN_DATA>/models/<model id>/<file>`.

use quadflow_sidecar::{json, Host, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct TitleModel {
    pub id: &'static str,
    pub name: &'static str,
    pub size_bytes: u64,
    pub quality_rating: u8,
    pub tier: &'static str,
    pub file_name: &'static str,
    pub download_url: &'static str,
}

pub const MODELS: &[TitleModel] = &[
    TitleModel {
        id: "tinyllama-1.1b-chat-q4k",
        name: "TinyLlama 1.1B Chat (Q4_K_M)",
        size_bytes: 700_000_000,
        quality_rating: 2,
        tier: "light",
        file_name: "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
        download_url: "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
    },
    TitleModel {
        id: "qwen2.5-7b-instruct-q4k",
        name: "Qwen 2.5 7B Instruct (Q4_K_M)",
        size_bytes: 4_500_000_000,
        quality_rating: 4,
        tier: "balanced",
        file_name: "qwen2.5-7b-instruct-q4_k_m.gguf",
        download_url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
    },
    TitleModel {
        id: "llama3.1-8b-instruct-q4k",
        name: "Llama 3.1 8B Instruct (Q4_K_M)",
        size_bytes: 5_000_000_000,
        quality_rating: 5,
        tier: "high",
        file_name: "llama-3.1-8b-instruct-q4_k_m.gguf",
        download_url: "https://huggingface.co/Meta-Llama/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/llama-3.1-8b-instruct-q4_k_m.gguf",
    },
];

pub fn find(id: &str) -> Option<&'static TitleModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// `<plugin data>/models`: `QUADFLOW_PLUGIN_DATA`, else the `initialize` params, else the cwd
/// (the host starts sidecars in their data folder).
pub fn models_dir(host: &Host) -> PathBuf {
    let base = std::env::var_os("QUADFLOW_PLUGIN_DATA")
        .map(PathBuf::from)
        .or_else(|| {
            host.init()
                .and_then(|i| i.pointer("/plugin/dataDir"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("models")
}

pub fn model_path(host: &Host, m: &TitleModel) -> PathBuf {
    models_dir(host).join(m.id).join(m.file_name)
}

/// Downloads in progress (model ids); a second request for the same model is refused.
fn active() -> &'static Mutex<Vec<String>> {
    static ACTIVE: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Set by `titles/cancelDownload`; checked between chunks.
fn cancel_flag() -> &'static Arc<AtomicBool> {
    static CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    CANCEL.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

pub fn status_json(host: &Host, m: &TitleModel) -> Value {
    let path = model_path(host, m);
    let downloaded = path.is_file();
    let downloading = active().lock().map(|a| a.iter().any(|x| x == m.id)).unwrap_or(false);
    json!({
        "id": m.id,
        "name": m.name,
        "sizeBytes": m.size_bytes,
        "qualityRating": m.quality_rating,
        "tier": m.tier,
        "downloaded": downloaded,
        "downloading": downloading,
        "path": if downloaded { Value::String(path.to_string_lossy().into_owned()) } else { Value::Null },
    })
}

pub fn list_json(host: &Host) -> Value {
    Value::Array(MODELS.iter().map(|m| status_json(host, m)).collect())
}

/// Start a background download; progress as `ui/downloadProgress`, the end as `ui/downloadDone`.
pub fn start_download(host: &Host, m: &'static TitleModel) -> Result<(), String> {
    if model_path(host, m).is_file() {
        host.ui("downloadDone", json!({ "modelId": m.id, "ok": true }));
        return Ok(());
    }
    {
        let mut a = active().lock().map_err(|_| "download state poisoned".to_string())?;
        if a.iter().any(|x| x == m.id) {
            return Err(format!("{} is already downloading", m.name));
        }
        a.push(m.id.to_string());
    }
    cancel_flag().store(false, Ordering::SeqCst);
    let host = host.clone();
    std::thread::spawn(move || {
        let r = download(&host, m);
        if let Ok(mut a) = active().lock() {
            a.retain(|x| x != m.id);
        }
        match r {
            Ok(()) => host.ui("downloadDone", json!({ "modelId": m.id, "ok": true })),
            Err(e) => {
                host.log("warn", format!("download of {} failed: {e}", m.id));
                host.ui("downloadDone", json!({ "modelId": m.id, "ok": false, "error": e }));
            }
        }
    });
    Ok(())
}

pub fn cancel_downloads() {
    cancel_flag().store(true, Ordering::SeqCst);
}

fn download(host: &Host, m: &TitleModel) -> Result<(), String> {
    let dest = model_path(host, m);
    let dir = dest.parent().ok_or("bad model path")?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let part = dest.with_extension("gguf.part");

    let resp = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build()
        .get(m.download_url)
        .call()
        .map_err(|e| format!("HTTP request failed: {e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(m.size_bytes);
    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&part).map_err(|e| format!("could not create {}: {e}", part.display()))?;
    let mut buf = vec![0u8; 1 << 20];
    let mut done: u64 = 0;
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel_flag().load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("download error: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("write error: {e}"))?;
        done += n as u64;
        if last.elapsed() >= Duration::from_millis(250) {
            last = Instant::now();
            host.ui("downloadProgress", json!({ "modelId": m.id, "downloadedBytes": done, "totalBytes": total }));
        }
    }
    file.flush().map_err(|e| format!("write error: {e}"))?;
    drop(file);
    fs::rename(&part, &dest).map_err(|e| format!("could not move {} into place: {e}", part.display()))?;
    host.ui("downloadProgress", json!({ "modelId": m.id, "downloadedBytes": done, "totalBytes": done.max(total) }));
    Ok(())
}

pub fn delete(host: &Host, m: &TitleModel) -> Result<(), String> {
    crate::inference::unload(m.id);
    let dir = models_dir(host).join(m.id);
    if dir.exists() {
        remove_dir(&dir)?;
    }
    Ok(())
}

fn remove_dir(dir: &Path) -> Result<(), String> {
    fs::remove_dir_all(dir).map_err(|e| format!("could not delete {}: {e}", dir.display()))
}
