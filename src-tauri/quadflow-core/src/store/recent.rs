//! `RecentWrites`: what this process wrote recently, so the file watcher can
//! drop its own writes (data-layer.md §4.3, §8.2).

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

pub const RECENT_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Mark {
    Written { len: u64, mtime: Option<SystemTime> },
    Deleted,
}

#[derive(Clone, Default)]
pub struct RecentWrites {
    inner: Arc<Mutex<HashMap<PathBuf, (Mark, Instant)>>>,
}

impl RecentWrites {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that this process just wrote `path` (call after the write completed).
    pub fn record_write(&self, path: &Path) {
        if let Ok(md) = std::fs::metadata(path) {
            let mark = Mark::Written { len: md.len(), mtime: md.modified().ok() };
            self.insert(path, mark);
        }
    }

    pub fn record_delete(&self, path: &Path) {
        self.insert(path, Mark::Deleted);
    }

    fn insert(&self, path: &Path, mark: Mark) {
        let mut m = self.inner.lock();
        let now = Instant::now();
        m.retain(|_, (_, at)| now.duration_since(*at) < RECENT_TTL);
        m.insert(path.to_path_buf(), (mark, now));
    }

    /// True if the current state of `path` is exactly what this process wrote
    /// (same length + mtime, or deleted) within the last 2 s.
    pub fn is_own(&self, path: &Path) -> bool {
        let m = self.inner.lock();
        let Some((mark, at)) = m.get(path) else { return false };
        if at.elapsed() >= RECENT_TTL {
            return false;
        }
        match (mark, std::fs::metadata(path)) {
            (Mark::Deleted, Err(e)) => e.kind() == std::io::ErrorKind::NotFound,
            (Mark::Written { len, mtime }, Ok(md)) => md.len() == *len && md.modified().ok() == *mtime,
            _ => false,
        }
    }
}
