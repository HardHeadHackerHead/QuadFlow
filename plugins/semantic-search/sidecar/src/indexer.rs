//! The indexing service: configuration (plugin settings), session roots,
//! the embedding engine, background index jobs, the scheduler (periodic /
//! realtime) and search. One instance per sidecar process.

use crate::chunker::{self, ContentChunk};
use crate::engine::{BertEngine, Embedder, HashingEngine};
use crate::models::{self, ModelInfo};
use crate::signals::extract_signals;
use crate::sources::{self, SessionRoot, SessionRootSpec};
use crate::store::{Discovered, IndexingType, SearchFilter, Store, StoredChunk};
use quadflow_sidecar::{json, Host, Value};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Plugin settings (`contributes.settings` in the manifest).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub model: String,
    pub use_gpu: bool,
    /// `manual` | `periodic` | `realtime`.
    pub index_mode: String,
    pub interval_minutes: u64,
    pub max_chunk_tokens: usize,
    pub overlap_tokens: usize,
    pub use_provider_sessions: bool,
    pub session_dirs: Vec<UserDir>,
    pub max_session_age_days: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            model: models::DEFAULT_MODEL_ID.into(),
            use_gpu: false,
            index_mode: "manual".into(),
            interval_minutes: 10,
            max_chunk_tokens: 512,
            overlap_tokens: 50,
            use_provider_sessions: true,
            session_dirs: Vec::new(),
            max_session_age_days: 0,
        }
    }
}

/// A session folder the user added in the settings.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UserDir {
    pub path: String,
    pub glob: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `scanning` | `downloading` | `loading` | `parsing` | `embedding` | `storing`.
    pub phase: String,
    /// Sessions done / to do in this job.
    pub current: usize,
    pub total: usize,
    pub session_path: Option<String>,
    pub file_name: Option<String>,
    /// Chunks of the current session.
    pub chunk: usize,
    pub chunks: usize,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobState {
    /// `idle` | `running`.
    state: String,
    progress: Option<Progress>,
    last_error: Option<String>,
    last_run_at: Option<u64>,
    last_run_indexed: usize,
    last_run_failed: usize,
}

struct Loaded {
    model_id: String,
    use_gpu: bool,
    embedder: Embedder,
}

pub struct Service {
    pub data_dir: PathBuf,
    store: Store,
    host: Host,
    config: Mutex<Config>,
    engine: Mutex<Option<Loaded>>,
    job: Mutex<JobState>,
    running: AtomicBool,
    stop: AtomicBool,
    /// Realtime mode: a watched session file changed (time of the last event).
    dirty_since: Mutex<Option<Instant>>,
    /// `agents.sessionRoots` exists on this host (None = not asked yet).
    provider_api: Mutex<Option<bool>>,
}

fn str_err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Service {
    pub fn new(data_dir: PathBuf, host: Host) -> Result<Arc<Self>, String> {
        let store = Store::open(&data_dir.join("semantic.db"))?;
        Ok(Arc::new(Self {
            data_dir,
            store,
            host,
            config: Mutex::new(Config::default()),
            engine: Mutex::new(None),
            job: Mutex::new(JobState {
                state: "idle".into(),
                progress: None,
                last_error: None,
                last_run_at: None,
                last_run_indexed: 0,
                last_run_failed: 0,
            }),
            running: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            dirty_since: Mutex::new(None),
            provider_api: Mutex::new(None),
        }))
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn config(&self) -> Config {
        self.config.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Apply the plugin settings object (`settings.getAll` / `initialize.settings`).
    pub fn apply_settings(&self, v: &Value) {
        let cfg: Config = serde_json::from_value(v.clone()).unwrap_or_else(|err| {
            log::warn!("invalid settings ({err}); using defaults");
            Config::default()
        });
        *self.config.lock().unwrap_or_else(|p| p.into_inner()) = cfg;
    }

    /// Re-read the settings from the host (keeps the current ones on failure).
    pub fn refresh_settings(&self) {
        match self.host.call("settings.getAll", json!({})) {
            Ok(v) => self.apply_settings(&v),
            Err(err) => log::warn!("settings.getAll failed: {err}"),
        }
    }

    pub fn model(&self) -> &'static ModelInfo {
        models::model(&self.config().model)
    }

    // ------------------------------------------------------------------ roots

    /// Session roots: every active provider's (host `agents.sessionRoots`) plus the user's folders.
    pub fn roots(&self) -> Vec<SessionRoot> {
        let cfg = self.config();
        let mut specs: Vec<SessionRootSpec> = Vec::new();
        if cfg.use_provider_sessions {
            match self.host.call_timeout("agents.sessionRoots", json!({}), Duration::from_secs(10)) {
                Ok(v) => {
                    *self.provider_api.lock().unwrap_or_else(|p| p.into_inner()) = Some(true);
                    for mut s in serde_json::from_value::<Vec<SessionRootSpec>>(v).unwrap_or_default() {
                        s.origin = "provider".into();
                        specs.push(s);
                    }
                }
                Err(err) => {
                    // Older hosts: the method does not exist (agents.sessionRoots, API gap).
                    let missing = matches!(err.kind(), Some("not_found" | "unsupported" | "invalid_input")) || err.code == quadflow_sidecar::METHOD_NOT_FOUND;
                    if missing {
                        *self.provider_api.lock().unwrap_or_else(|p| p.into_inner()) = Some(false);
                    }
                    log::debug!("agents.sessionRoots unavailable: {err}");
                }
            }
        }
        for d in cfg.session_dirs.iter().filter(|d| !d.path.trim().is_empty()) {
            specs.push(SessionRootSpec {
                provider_id: d.provider_id.clone(),
                root: d.path.trim().to_string(),
                glob: Some(d.glob.clone()).filter(|g| !g.trim().is_empty()),
                cwd_segments: 0,
                origin: "setting".into(),
            });
        }
        specs
            .into_iter()
            .filter_map(|s| match SessionRoot::new(s.clone()) {
                Ok(r) => Some(r),
                Err(err) => {
                    log::warn!("session root {}: {err}", s.root);
                    None
                }
            })
            .collect()
    }

    pub fn provider_api(&self) -> Option<bool> {
        *self.provider_api.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn discover(&self, roots: &[SessionRoot]) -> Vec<Discovered> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for root in roots {
            for path in root.files(sources::MAX_FILES_PER_ROOT) {
                let key = path.to_string_lossy().to_string();
                if !seen.insert(key.clone()) {
                    continue;
                }
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                out.push(Discovered {
                    id: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                    provider: root.provider_id().to_string(),
                    project: root.project_of(&path),
                    last_modified: meta.modified().map(sources::to_ms).unwrap_or(0),
                    file_size: meta.len(),
                    message_count: 0,
                    path: key,
                });
            }
        }
        out
    }

    // ----------------------------------------------------------------- engine

    fn set_progress(&self, p: Option<Progress>) {
        let mut j = self.job.lock().unwrap_or_else(|p| p.into_inner());
        j.progress = p.clone();
        drop(j);
        if let Some(p) = p {
            self.host.ui("progress", serde_json::to_value(p).unwrap_or(Value::Null));
        }
    }

    pub fn download_model(&self, m: &ModelInfo, progress: &mut dyn FnMut(models::DownloadProgress)) -> Result<(), String> {
        let stop = || self.stop.load(Ordering::SeqCst);
        models::download(&self.data_dir, m, progress, &stop)
    }

    /// Load the configured model (downloading it first when `allow_download`).
    fn ensure_engine(&self, allow_download: bool, mut on_progress: impl FnMut(Progress)) -> Result<(), String> {
        let cfg = self.config();
        let m = models::model(&cfg.model);
        {
            let g = self.engine.lock().unwrap_or_else(|p| p.into_inner());
            if g.as_ref().is_some_and(|l| l.model_id == m.id && l.use_gpu == cfg.use_gpu) {
                return Ok(());
            }
        }
        let embedder = if m.repo.is_none() {
            Embedder::Hashing(HashingEngine::new(m.dimensions))
        } else {
            if !models::is_downloaded(&self.data_dir, m) {
                if !allow_download {
                    return Err(format!("model_missing: the model {} is not downloaded yet", m.name));
                }
                let started = Instant::now();
                self.download_model(m, &mut |d| {
                    on_progress(Progress {
                        phase: "downloading".into(),
                        file_name: Some(d.file.clone()),
                        downloaded_bytes: Some(d.downloaded_bytes),
                        total_bytes: d.total_bytes,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        ..Default::default()
                    })
                })?;
            }
            on_progress(Progress { phase: "loading".into(), ..Default::default() });
            Embedder::Bert(BertEngine::load(&models::model_dir(&self.data_dir, m.id), cfg.use_gpu)?)
        };
        *self.engine.lock().unwrap_or_else(|p| p.into_inner()) = Some(Loaded { model_id: m.id.into(), use_gpu: cfg.use_gpu, embedder });
        Ok(())
    }

    pub fn device(&self) -> Option<String> {
        self.engine.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|l| l.embedder.device_name().to_string())
    }

    pub fn loaded_model(&self) -> Option<String> {
        self.engine.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|l| l.model_id.clone())
    }

    /// Drop the loaded model (settings changed / model deleted).
    pub fn unload(&self) {
        *self.engine.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let mut g = self.engine.lock().unwrap_or_else(|p| p.into_inner());
        let l = g.as_mut().ok_or("embedding model not loaded")?;
        l.embedder.embed_batch(texts)
    }

    // ------------------------------------------------------------------- jobs

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Start a background index job. `full` = reindex everything. `Ok(false)`
    /// when a job is already running.
    pub fn start_job(self: &Arc<Self>, full: bool) -> bool {
        if self.running.swap(true, Ordering::SeqCst) {
            return false;
        }
        self.stop.store(false, Ordering::SeqCst);
        {
            let mut j = self.job.lock().unwrap_or_else(|p| p.into_inner());
            j.state = "running".into();
            j.last_error = None;
        }
        self.notify_status();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let r = me.run_job(full);
            {
                let mut j = me.job.lock().unwrap_or_else(|p| p.into_inner());
                j.state = "idle".into();
                j.progress = None;
                j.last_run_at = Some(crate::store::now_ms());
                match &r {
                    Ok((ok, failed)) => {
                        j.last_run_indexed = *ok;
                        j.last_run_failed = *failed;
                    }
                    Err(err) => j.last_error = Some(err.clone()),
                }
            }
            me.running.store(false, Ordering::SeqCst);
            if let Err(err) = &r {
                log::error!("index job failed: {err}");
            }
            me.notify_status();
            me.host.ui("indexed", json!({ "ok": r.is_ok() }));
        });
        true
    }

    /// `ui/<name>` notification to the plugin's tiles.
    pub fn host_ui(&self, name: &str, v: Value) {
        self.host.ui(name, v);
    }

    pub fn notify_status(&self) {
        self.host.ui("status", self.status_json());
    }

    fn run_job(&self, full: bool) -> Result<(usize, usize), String> {
        self.refresh_settings();
        let started = Instant::now();
        self.set_progress(Some(Progress { phase: "scanning".into(), ..Default::default() }));
        let roots = self.roots();
        let found = self.discover(&roots);
        let sync = self.store.sync(&found)?;
        log::info!("scan: {} sessions in {} roots ({} new, {} changed, {} removed)", sync.total, roots.len(), sync.added, sync.updated, sync.removed);
        if full {
            self.store.mark_all_pending()?;
        }
        let model = self.model();
        let pending = self.store.pending(model.id)?;
        if pending.is_empty() {
            return Ok((0, 0));
        }
        self.ensure_engine(true, |p| self.set_progress(Some(p)))?;
        let cfg = self.config();
        let total = pending.len();
        let (mut ok, mut failed) = (0, 0);
        for (i, path) in pending.iter().enumerate() {
            if self.stop.load(Ordering::SeqCst) {
                log::info!("index job stopped after {i}/{total}");
                break;
            }
            let base = Progress {
                current: i,
                total,
                session_path: Some(path.clone()),
                file_name: Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()),
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..Default::default()
            };
            match self.index_one(path, model, &cfg, &base) {
                Ok(_) => ok += 1,
                Err(err) if err == "stopped" => break,
                Err(err) => {
                    failed += 1;
                    log::warn!("index {path}: {err}");
                    let _ = self.store.set_error(path, &err);
                }
            }
        }
        Ok((ok, failed))
    }

    fn index_one(&self, path: &str, model: &ModelInfo, cfg: &Config, base: &Progress) -> Result<usize, String> {
        let p = Path::new(path);
        let text = std::fs::read_to_string(p).map_err(|err| format!("read: {err}"))?;
        let size = text.len() as u64;
        let lines = text.lines().count();
        drop(text);
        let phase = |name: &str, chunk: usize, chunks: usize| {
            self.set_progress(Some(Progress { phase: name.into(), chunk, chunks, ..base.clone() }));
        };
        match self.store.check(path, size, lines, model.id)? {
            IndexingType::NoChange => Ok(0),
            IndexingType::Incremental { start_line, start_chunk } => {
                phase("parsing", 0, 0);
                let messages = chunker::parse_session_file_from_line(p, start_line, 0)?;
                let chunks = chunker::chunk_by_turns_from_index(&messages, cfg.max_chunk_tokens, cfg.overlap_tokens, start_chunk);
                let stored = self.embed_chunks(&chunks, &phase)?;
                phase("storing", stored.len(), stored.len());
                self.store.store_append(path, model.id, &stored, size, lines)?;
                Ok(stored.len())
            }
            IndexingType::Full { reason } => {
                log::debug!("full index of {path}: {reason}");
                phase("parsing", 0, 0);
                let messages = chunker::parse_session_file(p)?;
                if messages.is_empty() {
                    self.store.set_empty(path, model.id, size, lines)?;
                    return Ok(0);
                }
                let chunks = chunker::chunk_by_turns(&messages, cfg.max_chunk_tokens, cfg.overlap_tokens);
                let stored = self.embed_chunks(&chunks, &phase)?;
                let full: String = messages.iter().map(|m| format!("{}: {}", m.role, m.content)).collect::<Vec<_>>().join("\n");
                let signals = extract_signals(&full);
                phase("storing", stored.len(), stored.len());
                self.store.store_full(path, model.id, &stored, size, lines, &signals)?;
                Ok(stored.len())
            }
        }
    }

    fn embed_chunks(&self, chunks: &[ContentChunk], phase: &dyn Fn(&str, usize, usize)) -> Result<Vec<StoredChunk>, String> {
        let avg = if chunks.is_empty() { 0 } else { chunks.iter().map(|c| c.content.len()).sum::<usize>() / chunks.len() };
        let batch = if avg > 1500 { 8 } else if avg > 1000 { 16 } else { 32 };
        let mut out = Vec::with_capacity(chunks.len());
        for group in chunks.chunks(batch) {
            if self.stop.load(Ordering::SeqCst) {
                return Err("stopped".into());
            }
            phase("embedding", out.len(), chunks.len());
            let texts: Vec<String> = group.iter().map(|c| c.content.clone()).collect();
            let embs = self.embed_batch(&texts)?;
            for (c, emb) in group.iter().zip(embs) {
                out.push(StoredChunk { chunk_index: c.chunk_index, content: c.content.clone(), role: c.role.clone(), turn: c.turn_number, embedding: emb });
            }
        }
        Ok(out)
    }

    // ----------------------------------------------------------------- search

    /// `mode`: `sessions` (aggregated, boosted) or `chunks`.
    pub fn search(&self, query: &str, mode: &str, filter: &SearchFilter, limit: usize, min_score: Option<f32>) -> Result<Value, String> {
        let m = self.model();
        self.ensure_engine(false, |_| {})?;
        let q = {
            let mut g = self.engine.lock().unwrap_or_else(|p| p.into_inner());
            g.as_mut().ok_or("embedding model not loaded")?.embedder.embed(query)?
        };
        let min = min_score.unwrap_or(m.min_similarity);
        if mode == "chunks" {
            self.store.search_chunks(&q, m.id, filter, limit, min).map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
        } else {
            self.store.search_sessions(&q, m.id, filter, limit, min).map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
        }
    }

    // ----------------------------------------------------------------- status

    pub fn status_json(&self) -> Value {
        let cfg = self.config();
        let m = models::model(&cfg.model);
        let job = self.job.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let stats = self.store.stats(m.id).ok();
        json!({
            "state": job.state,
            "progress": job.progress,
            "lastError": job.last_error,
            "lastRunAt": job.last_run_at,
            "lastRunIndexed": job.last_run_indexed,
            "lastRunFailed": job.last_run_failed,
            "stats": stats,
            "model": {
                "id": m.id,
                "name": m.name,
                "downloaded": models::is_downloaded(&self.data_dir, m),
                "loaded": self.loaded_model().as_deref() == Some(m.id),
                "device": self.device(),
            },
            "indexMode": cfg.index_mode,
            "providerSessionRoots": self.provider_api(),
            "dataDir": self.data_dir.display().to_string(),
            "gpu": {
                "cudaCompiled": cfg!(feature = "cuda"),
                "metalCompiled": cfg!(feature = "metal"),
            },
        })
    }

    pub fn roots_json(&self) -> Value {
        let roots = self.roots();
        Value::Array(
            roots
                .iter()
                .map(|r| {
                    json!({
                        "providerId": r.spec.provider_id,
                        "root": r.spec.root,
                        "glob": r.spec.glob,
                        "origin": r.spec.origin,
                        "exists": r.root().is_dir(),
                    })
                })
                .collect(),
        )
    }

    // -------------------------------------------------------------- scheduler

    pub fn mark_dirty(&self) {
        *self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    /// Background loop: periodic jobs and the realtime watcher.
    pub fn run_scheduler(self: Arc<Self>) {
        let mut last_periodic = Instant::now();
        let mut watcher: Option<(Vec<String>, notify::RecommendedWatcher)> = None;
        let mut last_roots_check = Instant::now() - Duration::from_secs(3600);
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let cfg = self.config();
            match cfg.index_mode.as_str() {
                "periodic" => {
                    watcher = None;
                    let every = Duration::from_secs(cfg.interval_minutes.max(1) * 60);
                    if last_periodic.elapsed() >= every {
                        last_periodic = Instant::now();
                        self.start_job(false);
                    }
                }
                "realtime" => {
                    if last_roots_check.elapsed() >= Duration::from_secs(30) {
                        last_roots_check = Instant::now();
                        let roots: Vec<String> = self.roots().iter().filter(|r| r.root().is_dir()).map(|r| r.spec.root.clone()).collect();
                        if watcher.as_ref().map(|(r, _)| r) != Some(&roots) {
                            watcher = self.watch(&roots).map(|w| (roots, w));
                            self.mark_dirty();
                        }
                    }
                    let due = self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed() >= Duration::from_secs(3));
                    if due && !self.is_running() {
                        *self.dirty_since.lock().unwrap_or_else(|p| p.into_inner()) = None;
                        self.start_job(false);
                    }
                }
                _ => {
                    watcher = None;
                    last_periodic = Instant::now();
                }
            }
        }
    }

    fn watch(self: &Arc<Self>, roots: &[String]) -> Option<notify::RecommendedWatcher> {
        use notify::{RecursiveMode, Watcher};
        let me = Arc::downgrade(self);
        let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Any change below a root: the debounced job only reindexes what changed.
            if let (Ok(ev), Some(me)) = (res, me.upgrade()) {
                if !ev.kind.is_access() {
                    me.mark_dirty();
                }
            }
        })
        .map_err(str_err)
        .map_err(|err| log::warn!("file watcher: {err}"))
        .ok()?;
        for r in roots {
            if let Err(err) = w.watch(Path::new(r), RecursiveMode::Recursive) {
                log::warn!("watch {r}: {err}");
            }
        }
        Some(w)
    }
}
