//! SQLite index under the plugin data dir (`semantic.db`): one row per
//! session transcript (discovered → indexed) and its embedded chunks.
//! Search is a brute-force cosine scan over the chunks of the active model.
//!
//! No migrations: a database with another `user_version` is recreated.

use crate::engine::cosine_similarity;
use crate::signals::{files_overlap, ConversationSignals};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    path TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    last_modified INTEGER NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    model_id TEXT,
    indexed_at INTEGER,
    indexed_size INTEGER NOT NULL DEFAULT 0,
    indexed_lines INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    has_success INTEGER NOT NULL DEFAULT 0,
    has_failure INTEGER NOT NULL DEFAULT 0,
    files_mentioned TEXT NOT NULL DEFAULT '[]',
    task_type TEXT,
    discovered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider);
CREATE TABLE IF NOT EXISTS chunks (
    session_path TEXT NOT NULL REFERENCES sessions(path) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    role TEXT,
    turn INTEGER,
    model_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (session_path, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_model ON chunks(model_id);
"#;

pub fn now_ms() -> u64 {
    crate::sources::to_ms(std::time::SystemTime::now())
}

/// A session file found by a scan.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: String,
    pub id: String,
    pub provider: String,
    pub project: String,
    pub last_modified: u64,
    pub file_size: u64,
    pub message_count: usize,
}

/// A chunk with its embedding, ready to store.
#[derive(Debug, Clone)]
pub struct StoredChunk {
    pub chunk_index: usize,
    pub content: String,
    pub role: Option<String>,
    pub turn: Option<usize>,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IndexingType {
    NoChange,
    /// Only lines after `start_line` are new; new chunks start at `start_chunk`.
    Incremental { start_line: usize, start_chunk: usize },
    Full { reason: String },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub removed: usize,
    pub updated: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub sessions: usize,
    pub indexed: usize,
    pub pending: usize,
    pub errors: usize,
    /// Chunks of the active model.
    pub chunks: usize,
    /// Chunks of other models (from before a model switch; reindex to drop them).
    pub other_model_chunks: usize,
    pub last_indexed_at: Option<u64>,
    pub db_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub path: String,
    pub id: String,
    pub provider: String,
    pub project: String,
    pub last_modified: u64,
    pub file_size: u64,
    pub message_count: usize,
    pub status: String,
    pub error: Option<String>,
    pub model_id: Option<String>,
    pub indexed_at: Option<u64>,
    pub chunk_count: usize,
    pub task_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRow {
    pub chunk_index: usize,
    pub content: String,
    pub role: Option<String>,
    pub turn: Option<usize>,
    pub model_id: String,
    pub dimensions: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    pub provider_id: Option<String>,
    pub project: Option<String>,
    /// Files being worked on (boosts sessions that mention them).
    #[serde(default)]
    pub current_files: Vec<String>,
}

/// Session-level hit (aggregated over its chunks).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub session_id: String,
    pub session_path: String,
    pub provider_id: String,
    pub project: String,
    pub last_modified: u64,
    /// Best chunk similarity after recency / signal / file boosts (≤ 1).
    pub score: f32,
    /// Raw best chunk similarity.
    pub best_similarity: f32,
    pub avg_similarity: f32,
    pub matching_chunks: usize,
    pub total_chunks: usize,
    pub preview: String,
    pub preview_role: Option<String>,
    pub task_type: Option<String>,
}

/// Chunk-level hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkHit {
    pub session_id: String,
    pub session_path: String,
    pub provider_id: String,
    pub project: String,
    pub chunk_index: usize,
    pub content: String,
    pub role: Option<String>,
    pub turn: Option<usize>,
    pub score: f32,
}

fn emb_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn bytes_to_emb(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn preview(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}...", s.chars().take(max).collect::<String>())
}

fn e(err: rusqlite::Error) -> String {
    format!("index database: {err}")
}

pub struct Store {
    conn: Mutex<Connection>,
    path: std::path::PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;").map_err(e)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
        if version != SCHEMA_VERSION {
            conn.execute_batch("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS sessions;").map_err(e)?;
        }
        conn.execute_batch(SCHEMA).map_err(e)?;
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};")).map_err(e)?;
        Ok(Self { conn: Mutex::new(conn), path: path.to_path_buf() })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Replace the set of known sessions with a fresh scan: new files are added
    /// as `pending`, changed ones updated (an indexed session whose file changed
    /// becomes `pending` again), vanished ones removed with their chunks.
    pub fn sync(&self, found: &[Discovered]) -> Result<SyncResult, String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(e)?;
        let existing: HashMap<String, (u64, u64)> = {
            let mut st = tx.prepare("SELECT path, last_modified, file_size FROM sessions").map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64))))
                .map_err(e)?;
            rows.collect::<Result<_, _>>().map_err(e)?
        };
        let mut res = SyncResult { total: found.len(), ..Default::default() };
        let now = now_ms() as i64;
        let seen: HashSet<&str> = found.iter().map(|d| d.path.as_str()).collect();
        for d in found {
            match existing.get(&d.path) {
                None => {
                    tx.execute(
                        "INSERT INTO sessions (path, id, provider, project, last_modified, file_size, message_count, status, discovered_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)",
                        params![d.path, d.id, d.provider, d.project, d.last_modified as i64, d.file_size as i64, d.message_count as i64, now],
                    )
                    .map_err(e)?;
                    res.added += 1;
                }
                Some(&(lm, size)) if lm != d.last_modified || size != d.file_size => {
                    tx.execute(
                        "UPDATE sessions SET provider = ?2, project = ?3, last_modified = ?4, file_size = ?5, message_count = ?6,
                             status = CASE WHEN status = 'indexed' THEN 'pending' ELSE status END
                         WHERE path = ?1",
                        params![d.path, d.provider, d.project, d.last_modified as i64, d.file_size as i64, d.message_count as i64],
                    )
                    .map_err(e)?;
                    res.updated += 1;
                }
                Some(_) => {
                    tx.execute("UPDATE sessions SET provider = ?2, project = ?3 WHERE path = ?1", params![d.path, d.provider, d.project])
                        .map_err(e)?;
                }
            }
        }
        for p in existing.keys().filter(|p| !seen.contains(p.as_str())) {
            tx.execute("DELETE FROM sessions WHERE path = ?1", [p]).map_err(e)?;
            res.removed += 1;
        }
        tx.commit().map_err(e)?;
        Ok(res)
    }

    /// Paths that need (re)indexing for `model_id`, newest first.
    pub fn pending(&self, model_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn();
        let mut st = conn
            .prepare(
                "SELECT path FROM sessions WHERE status != 'indexed' OR model_id IS NULL OR model_id != ?1
                 ORDER BY last_modified DESC",
            )
            .map_err(e)?;
        let rows = st.query_map([model_id], |r| r.get::<_, String>(0)).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    /// Mark every session for reindexing.
    pub fn mark_all_pending(&self) -> Result<(), String> {
        self.conn().execute("UPDATE sessions SET status = 'pending', error = NULL", []).map_err(e)?;
        Ok(())
    }

    #[cfg(test)]
    pub fn session(&self, path: &str) -> Result<Option<SessionRow>, String> {
        let conn = self.conn();
        conn.query_row(&format!("{SESSION_SELECT} WHERE path = ?1"), [path], session_row).optional().map_err(e)
    }

    /// What indexing `path` needs, given its current size / line count.
    pub fn check(&self, path: &str, size: u64, lines: usize, model_id: &str) -> Result<IndexingType, String> {
        let conn = self.conn();
        let row: Option<(Option<String>, String, u64, usize, usize)> = conn
            .query_row(
                "SELECT model_id, status, indexed_size, indexed_lines, chunk_count FROM sessions WHERE path = ?1",
                [path],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as usize, r.get::<_, i64>(4)? as usize)),
            )
            .optional()
            .map_err(e)?;
        let Some((model, status, isize, ilines, chunks)) = row else {
            return Ok(IndexingType::Full { reason: "new session".into() });
        };
        if model.as_deref() != Some(model_id) || chunks == 0 && ilines == 0 {
            return Ok(IndexingType::Full { reason: "not indexed with the current model".into() });
        }
        if size == isize && lines == ilines {
            return Ok(if status == "indexed" { IndexingType::NoChange } else { IndexingType::Full { reason: "requeued".into() } });
        }
        if size > isize && lines > ilines {
            return Ok(IndexingType::Incremental { start_line: ilines, start_chunk: chunks });
        }
        Ok(IndexingType::Full { reason: "file was rewritten".into() })
    }

    /// Store a fully indexed session (replaces its chunks).
    #[allow(clippy::too_many_arguments)]
    pub fn store_full(
        &self,
        path: &str,
        model_id: &str,
        chunks: &[StoredChunk],
        size: u64,
        lines: usize,
        signals: &ConversationSignals,
    ) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(e)?;
        tx.execute("DELETE FROM chunks WHERE session_path = ?1", [path]).map_err(e)?;
        insert_chunks(&tx, path, model_id, chunks)?;
        tx.execute(
            "UPDATE sessions SET status = 'indexed', error = NULL, model_id = ?2, indexed_at = ?3, indexed_size = ?4,
                 indexed_lines = ?5, chunk_count = ?6, has_success = ?7, has_failure = ?8, files_mentioned = ?9, task_type = ?10
             WHERE path = ?1",
            params![
                path,
                model_id,
                now_ms() as i64,
                size as i64,
                lines as i64,
                chunks.len() as i64,
                signals.has_success_signal as i64,
                signals.has_failure_signal as i64,
                serde_json::to_string(&signals.files_mentioned).unwrap_or_else(|_| "[]".into()),
                signals.task_type,
            ],
        )
        .map_err(e)?;
        tx.commit().map_err(e)
    }

    /// Append the chunks of new transcript lines (incremental indexing).
    pub fn store_append(&self, path: &str, model_id: &str, chunks: &[StoredChunk], size: u64, lines: usize) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(e)?;
        insert_chunks(&tx, path, model_id, chunks)?;
        tx.execute(
            "UPDATE sessions SET status = 'indexed', error = NULL, indexed_at = ?2, indexed_size = ?3, indexed_lines = ?4,
                 chunk_count = chunk_count + ?5
             WHERE path = ?1",
            params![path, now_ms() as i64, size as i64, lines as i64, chunks.len() as i64],
        )
        .map_err(e)?;
        tx.commit().map_err(e)
    }

    pub fn set_error(&self, path: &str, error: &str) -> Result<(), String> {
        self.conn().execute("UPDATE sessions SET status = 'error', error = ?2 WHERE path = ?1", params![path, error]).map_err(e)?;
        Ok(())
    }

    /// Index state of a session that has nothing to embed (no messages).
    pub fn set_empty(&self, path: &str, model_id: &str, size: u64, lines: usize) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE sessions SET status = 'indexed', error = NULL, model_id = ?2, indexed_at = ?3, indexed_size = ?4,
                     indexed_lines = ?5, chunk_count = 0
                 WHERE path = ?1",
                params![path, model_id, now_ms() as i64, size as i64, lines as i64],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn stats(&self, model_id: &str) -> Result<IndexStats, String> {
        let conn = self.conn();
        let count = |sql: &str| -> Result<usize, String> { conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| n as usize).map_err(e) };
        let sessions = count("SELECT COUNT(*) FROM sessions")?;
        let indexed = count("SELECT COUNT(*) FROM sessions WHERE status = 'indexed'")?;
        let errors = count("SELECT COUNT(*) FROM sessions WHERE status = 'error'")?;
        let pending = count("SELECT COUNT(*) FROM sessions WHERE status = 'pending'")?;
        let chunks = conn
            .query_row("SELECT COUNT(*) FROM chunks WHERE model_id = ?1", [model_id], |r| r.get::<_, i64>(0))
            .map_err(e)? as usize;
        let all_chunks = count("SELECT COUNT(*) FROM chunks")?;
        let last: Option<i64> = conn.query_row("SELECT MAX(indexed_at) FROM sessions", [], |r| r.get(0)).map_err(e)?;
        let db_bytes = ["", "-wal"]
            .iter()
            .filter_map(|s| std::fs::metadata(format!("{}{s}", self.path.display())).ok())
            .map(|m| m.len())
            .sum();
        Ok(IndexStats {
            sessions,
            indexed,
            pending,
            errors,
            chunks,
            other_model_chunks: all_chunks - chunks,
            last_indexed_at: last.map(|v| v as u64),
            db_bytes,
        })
    }

    /// Known sessions, newest first.
    pub fn sessions(&self, status: Option<&str>, provider: Option<&str>, text: Option<&str>, limit: usize) -> Result<Vec<SessionRow>, String> {
        let conn = self.conn();
        let mut st = conn
            .prepare(&format!(
                "{SESSION_SELECT}
                 WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR provider = ?2)
                   AND (?3 IS NULL OR path LIKE '%' || ?3 || '%' OR project LIKE '%' || ?3 || '%')
                 ORDER BY last_modified DESC LIMIT ?4"
            ))
            .map_err(e)?;
        let rows = st.query_map(params![status, provider, text, limit as i64], session_row).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn chunks_of(&self, path: &str) -> Result<Vec<ChunkRow>, String> {
        let conn = self.conn();
        let mut st = conn
            .prepare("SELECT chunk_index, content, role, turn, model_id, length(embedding) FROM chunks WHERE session_path = ?1 ORDER BY chunk_index")
            .map_err(e)?;
        let rows = st
            .query_map([path], |r| {
                Ok(ChunkRow {
                    chunk_index: r.get::<_, i64>(0)? as usize,
                    content: r.get(1)?,
                    role: r.get(2)?,
                    turn: r.get::<_, Option<i64>>(3)?.map(|t| t as usize),
                    model_id: r.get(4)?,
                    dimensions: r.get::<_, i64>(5)? as usize / 4,
                })
            })
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn delete_session(&self, path: &str) -> Result<(), String> {
        self.conn().execute("DELETE FROM sessions WHERE path = ?1", [path]).map_err(e)?;
        Ok(())
    }

    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch("DELETE FROM chunks; DELETE FROM sessions;").map_err(e)?;
        let _ = conn.execute_batch("VACUUM;");
        Ok(())
    }

    /// Drop chunks of models other than `model_id`, and of sessions not modified
    /// for `max_age_days` (0 = keep all); those sessions become `pending`.
    pub fn cleanup(&self, model_id: &str, max_age_days: u32) -> Result<usize, String> {
        let conn = self.conn();
        let mut removed = conn.execute("DELETE FROM chunks WHERE model_id != ?1", [model_id]).map_err(e)?;
        if max_age_days > 0 {
            let cutoff = now_ms().saturating_sub(max_age_days as u64 * 86_400_000) as i64;
            removed += conn
                .execute("DELETE FROM chunks WHERE session_path IN (SELECT path FROM sessions WHERE last_modified < ?1)", [cutoff])
                .map_err(e)?;
            conn.execute(
                "UPDATE sessions SET status = 'stale', chunk_count = 0, indexed_size = 0, indexed_lines = 0 WHERE last_modified < ?1",
                [cutoff],
            )
            .map_err(e)?;
        }
        let _ = conn.execute_batch("VACUUM;");
        Ok(removed)
    }

    /// Chunks of the active model joined with their session, filtered.
    fn scan(&self, model_id: &str, f: &SearchFilter, mut visit: impl FnMut(ScanRow)) -> Result<(), String> {
        let conn = self.conn();
        let mut st = conn
            .prepare(
                "SELECT c.session_path, c.chunk_index, c.content, c.role, c.turn, c.embedding,
                        s.id, s.provider, s.project, s.last_modified, s.chunk_count, s.has_success, s.has_failure,
                        s.files_mentioned, s.task_type
                 FROM chunks c JOIN sessions s ON s.path = c.session_path
                 WHERE c.model_id = ?1 AND (?2 IS NULL OR s.provider = ?2) AND (?3 IS NULL OR s.project = ?3)",
            )
            .map_err(e)?;
        let mut rows = st.query(params![model_id, f.provider_id, f.project]).map_err(e)?;
        while let Some(r) = rows.next().map_err(e)? {
            visit(ScanRow {
                path: r.get(0).map_err(e)?,
                chunk_index: r.get::<_, i64>(1).map_err(e)? as usize,
                content: r.get(2).map_err(e)?,
                role: r.get(3).map_err(e)?,
                turn: r.get::<_, Option<i64>>(4).map_err(e)?.map(|t| t as usize),
                embedding: bytes_to_emb(&r.get::<_, Vec<u8>>(5).map_err(e)?),
                id: r.get(6).map_err(e)?,
                provider: r.get(7).map_err(e)?,
                project: r.get(8).map_err(e)?,
                last_modified: r.get::<_, i64>(9).map_err(e)? as u64,
                chunk_count: r.get::<_, i64>(10).map_err(e)? as usize,
                has_success: r.get::<_, i64>(11).map_err(e)? != 0,
                has_failure: r.get::<_, i64>(12).map_err(e)? != 0,
                files: serde_json::from_str(&r.get::<_, String>(13).map_err(e)?).unwrap_or_default(),
                task_type: r.get(14).map_err(e)?,
            });
        }
        Ok(())
    }

    pub fn search_chunks(&self, q: &[f32], model_id: &str, f: &SearchFilter, limit: usize, min: f32) -> Result<Vec<ChunkHit>, String> {
        let mut hits = Vec::new();
        self.scan(model_id, f, |r| {
            let score = cosine_similarity(q, &r.embedding);
            if score >= min {
                hits.push(ChunkHit {
                    session_id: r.id,
                    session_path: r.path,
                    provider_id: r.provider,
                    project: r.project,
                    chunk_index: r.chunk_index,
                    content: r.content,
                    role: r.role,
                    turn: r.turn,
                    score,
                });
            }
        })?;
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }

    /// Session hits with context boosts: recency (+10 % < 7 days, +5 % < 30 days),
    /// success signal (+8 %), unresolved failure (−5 %), mentions a current file (+15 %).
    pub fn search_sessions(&self, q: &[f32], model_id: &str, f: &SearchFilter, limit: usize, min: f32) -> Result<Vec<SessionHit>, String> {
        struct Agg {
            first: ScanRow,
            scores: Vec<f32>,
            best: f32,
            best_content: String,
            best_role: Option<String>,
        }
        let mut map: HashMap<String, Agg> = HashMap::new();
        self.scan(model_id, f, |r| {
            let sim = cosine_similarity(q, &r.embedding);
            let a = map.entry(r.path.clone()).or_insert_with(|| Agg {
                first: ScanRow { embedding: Vec::new(), content: String::new(), ..r.clone() },
                scores: Vec::new(),
                best: f32::MIN,
                best_content: String::new(),
                best_role: None,
            });
            if sim >= min {
                a.scores.push(sim);
            }
            if sim > a.best {
                a.best = sim;
                a.best_content = r.content;
                a.best_role = r.role;
            }
        })?;
        let now = now_ms();
        let mut hits: Vec<SessionHit> = map
            .into_values()
            .filter(|a| !a.scores.is_empty())
            .map(|a| {
                let s = &a.first;
                let mut score = a.best;
                let age_days = now.saturating_sub(s.last_modified) / 86_400_000;
                if age_days < 7 {
                    score *= 1.10;
                } else if age_days < 30 {
                    score *= 1.05;
                }
                if s.has_success {
                    score *= 1.08;
                }
                if s.has_failure && !s.has_success {
                    score *= 0.95;
                }
                if files_overlap(&f.current_files, &s.files) {
                    score *= 1.15;
                }
                SessionHit {
                    session_id: s.id.clone(),
                    session_path: s.path.clone(),
                    provider_id: s.provider.clone(),
                    project: s.project.clone(),
                    last_modified: s.last_modified,
                    score: score.min(1.0),
                    best_similarity: a.best,
                    avg_similarity: a.scores.iter().sum::<f32>() / a.scores.len() as f32,
                    matching_chunks: a.scores.len(),
                    total_chunks: s.chunk_count,
                    preview: preview(&a.best_content, 240),
                    preview_role: a.best_role,
                    task_type: s.task_type.clone(),
                }
            })
            .collect();
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(limit);
        Ok(hits)
    }
}

#[derive(Clone)]
struct ScanRow {
    path: String,
    chunk_index: usize,
    content: String,
    role: Option<String>,
    turn: Option<usize>,
    embedding: Vec<f32>,
    id: String,
    provider: String,
    project: String,
    last_modified: u64,
    chunk_count: usize,
    has_success: bool,
    has_failure: bool,
    files: Vec<String>,
    task_type: Option<String>,
}

const SESSION_SELECT: &str = "SELECT path, id, provider, project, last_modified, file_size, message_count, status, error,
    model_id, indexed_at, chunk_count, task_type FROM sessions";

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        path: r.get(0)?,
        id: r.get(1)?,
        provider: r.get(2)?,
        project: r.get(3)?,
        last_modified: r.get::<_, i64>(4)? as u64,
        file_size: r.get::<_, i64>(5)? as u64,
        message_count: r.get::<_, i64>(6)? as usize,
        status: r.get(7)?,
        error: r.get(8)?,
        model_id: r.get(9)?,
        indexed_at: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
        chunk_count: r.get::<_, i64>(11)? as usize,
        task_type: r.get(12)?,
    })
}

fn insert_chunks(tx: &rusqlite::Transaction, path: &str, model_id: &str, chunks: &[StoredChunk]) -> Result<(), String> {
    let mut st = tx
        .prepare(
            "INSERT OR REPLACE INTO chunks (session_path, chunk_index, content, role, turn, model_id, embedding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .map_err(e)?;
    for c in chunks {
        st.execute(params![
            path,
            c.chunk_index as i64,
            c.content,
            c.role,
            c.turn.map(|t| t as i64),
            model_id,
            emb_to_bytes(&c.embedding)
        ])
        .map_err(e)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("qf-semantic-store-{}-{}", std::process::id(), now_ms()));
        (Store::open(&dir.join("semantic.db")).unwrap(), dir)
    }

    #[test]
    fn sync_index_search_roundtrip() {
        let (s, dir) = tmp_store();
        let d = |p: &str, lm: u64| Discovered {
            path: p.into(),
            id: p.into(),
            provider: "prov".into(),
            project: "proj".into(),
            last_modified: lm,
            file_size: 10,
            message_count: 2,
        };
        let r = s.sync(&[d("a", 1), d("b", 1)]).unwrap();
        assert_eq!((r.added, r.removed), (2, 0));
        assert_eq!(s.pending("m").unwrap().len(), 2);
        let chunk = |i: usize, v: Vec<f32>| StoredChunk { chunk_index: i, content: format!("c{i}"), role: Some("user".into()), turn: Some(1), embedding: v };
        s.store_full("a", "m", &[chunk(0, vec![1.0, 0.0]), chunk(1, vec![0.0, 1.0])], 10, 2, &Default::default()).unwrap();
        assert_eq!(s.check("a", 10, 2, "m").unwrap(), IndexingType::NoChange);
        assert_eq!(s.check("a", 20, 4, "m").unwrap(), IndexingType::Incremental { start_line: 2, start_chunk: 2 });
        assert!(matches!(s.check("a", 10, 2, "other").unwrap(), IndexingType::Full { .. }));
        assert_eq!(s.pending("m").unwrap(), vec!["b".to_string()]);

        let hits = s.search_sessions(&[1.0, 0.0], "m", &SearchFilter::default(), 10, 0.5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_path, "a");
        assert_eq!(hits[0].preview, "c0");
        let chunks = s.search_chunks(&[0.0, 1.0], "m", &SearchFilter::default(), 10, 0.5).unwrap();
        assert_eq!(chunks[0].content, "c1");
        assert!(s.search_sessions(&[1.0, 0.0], "m", &SearchFilter { provider_id: Some("x".into()), ..Default::default() }, 10, 0.5).unwrap().is_empty());

        let st = s.stats("m").unwrap();
        assert_eq!((st.sessions, st.indexed, st.pending, st.chunks), (2, 1, 1, 2));

        // b vanished, a changed → a pending again, b removed with nothing left behind.
        let r = s.sync(&[d("a", 2)]).unwrap();
        assert_eq!((r.removed, r.updated), (1, 1));
        assert_eq!(s.session("a").unwrap().unwrap().status, "pending");
        s.delete_session("a").unwrap();
        assert_eq!(s.stats("m").unwrap().chunks, 0);
        drop(s);
        let _ = std::fs::remove_dir_all(dir);
    }
}
