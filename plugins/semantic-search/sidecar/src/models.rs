//! The embedding model catalog and model downloads (into `<plugin data>/models/<id>/`).

use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Built-in model that needs no download (feature hashing).
pub const HASHING_MODEL_ID: &str = "hashing";
pub const DEFAULT_MODEL_ID: &str = "all-MiniLM-L6-v2";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    /// Hugging Face repository; `None` = built in.
    pub repo: Option<&'static str>,
    pub dimensions: usize,
    /// Approximate download size.
    pub size_bytes: u64,
    /// 1-5.
    pub quality: u8,
    pub description: &'static str,
    /// Chunks scoring below this are not search hits.
    pub min_similarity: f32,
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "all-MiniLM-L6-v2",
        name: "MiniLM L6 v2",
        repo: Some("sentence-transformers/all-MiniLM-L6-v2"),
        dimensions: 384,
        size_bytes: 91_000_000,
        quality: 4,
        description: "Fast, good quality. Recommended.",
        min_similarity: 0.3,
    },
    ModelInfo {
        id: "paraphrase-MiniLM-L3-v2",
        name: "MiniLM L3 v2 (paraphrase)",
        repo: Some("sentence-transformers/paraphrase-MiniLM-L3-v2"),
        dimensions: 384,
        size_bytes: 70_000_000,
        quality: 3,
        description: "Smallest and fastest download; lower quality.",
        min_similarity: 0.3,
    },
    ModelInfo {
        id: "all-mpnet-base-v2",
        name: "MPNet base v2",
        repo: Some("sentence-transformers/all-mpnet-base-v2"),
        dimensions: 768,
        size_bytes: 438_000_000,
        quality: 5,
        description: "Best quality; slower indexing and a large download.",
        min_similarity: 0.3,
    },
    ModelInfo {
        id: HASHING_MODEL_ID,
        name: "Keyword hashing (built in)",
        repo: None,
        dimensions: 384,
        size_bytes: 0,
        quality: 1,
        description: "No download, works offline. Matches shared words only, not meaning.",
        min_similarity: 0.05,
    },
];

/// The catalog entry for `id` (unknown ids fall back to the default model).
pub fn model(id: &str) -> &'static ModelInfo {
    MODELS.iter().find(|m| m.id == id).unwrap_or_else(|| MODELS.iter().find(|m| m.id == DEFAULT_MODEL_ID).unwrap())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    pub info: ModelInfo,
    pub downloaded: bool,
    pub path: Option<String>,
    /// Bytes on disk.
    pub disk_bytes: u64,
}

pub fn model_dir(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("models").join(id)
}

fn weights_present(dir: &Path) -> bool {
    dir.join("model.safetensors").is_file() || dir.join("pytorch_model.bin").is_file()
}

pub fn is_downloaded(data_dir: &Path, m: &ModelInfo) -> bool {
    if m.repo.is_none() {
        return true;
    }
    let dir = model_dir(data_dir, m.id);
    dir.join("config.json").is_file() && dir.join("tokenizer.json").is_file() && weights_present(&dir)
}

fn dir_size(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(Result::ok).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

pub fn statuses(data_dir: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|m| {
            let dir = model_dir(data_dir, m.id);
            let downloaded = is_downloaded(data_dir, m);
            ModelStatus {
                info: m.clone(),
                downloaded,
                path: (downloaded && m.repo.is_some()).then(|| dir.display().to_string()),
                disk_bytes: if m.repo.is_some() { dir_size(&dir) } else { 0 },
            }
        })
        .collect()
}

/// Download progress over all files of one model.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub file: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

/// Download `url` to `dest` through a `.part` file. `Ok(false)` on HTTP 404.
fn fetch(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
    cancelled: &dyn Fn() -> bool,
) -> Result<bool, String> {
    let mut resp = client.get(url).send().map_err(|e| format!("GET {url}: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    let total = resp.content_length();
    let part = dest.with_extension("part");
    let mut out = std::fs::File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut last_report = std::time::Instant::now();
    loop {
        if cancelled() {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("download cancelled".into());
        }
        let n = resp.read(&mut buf).map_err(|e| format!("read {url}: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("write {}: {e}", part.display()))?;
        done += n as u64;
        if last_report.elapsed().as_millis() >= 250 {
            on_progress(done, total);
            last_report = std::time::Instant::now();
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    std::fs::rename(&part, dest).map_err(|e| format!("rename {}: {e}", part.display()))?;
    on_progress(done, total);
    Ok(true)
}

/// Download a catalog model's files (no-op when present or built in).
pub fn download(
    data_dir: &Path,
    m: &ModelInfo,
    on_progress: &mut dyn FnMut(DownloadProgress),
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let Some(repo) = m.repo else { return Ok(()) };
    let dir = model_dir(data_dir, m.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("quadflow-semantic-search/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let base = format!("https://huggingface.co/{repo}/resolve/main");
    let mut get = |file: &str| -> Result<bool, String> {
        let dest = dir.join(file);
        if dest.is_file() {
            return Ok(true);
        }
        let model_id = m.id.to_string();
        let name = file.to_string();
        fetch(
            &client,
            &format!("{base}/{file}"),
            &dest,
            &mut |done, total| {
                on_progress(DownloadProgress { model_id: model_id.clone(), file: name.clone(), downloaded_bytes: done, total_bytes: total })
            },
            cancelled,
        )
    };
    for f in ["config.json", "tokenizer.json"] {
        if !get(f)? {
            return Err(format!("{repo}: {f} not found"));
        }
    }
    if !weights_present(&dir) && !get("model.safetensors")? && !get("pytorch_model.bin")? {
        return Err(format!("{repo}: no model weights found"));
    }
    Ok(())
}

pub fn delete(data_dir: &Path, id: &str) -> Result<(), String> {
    let dir = model_dir(data_dir, id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}
