//! Per-project cross-process advisory lock (data-layer.md §4.2).
//!
//! `<root>/.quadflow/.lock`, locked with std `File::lock`/`try_lock`
//! (`LockFileEx` on Windows, `flock` on Unix). Writes take it; reads don't.

use crate::error::{CoreError, Result};
use crate::paths::ProjectRoot;
use std::fs::{File, OpenOptions, TryLockError};
use std::time::{Duration, Instant};

pub const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// Held exclusive lock; released on drop.
pub struct ProjectLock {
    file: File,
}

impl ProjectLock {
    /// Exclusive lock. Polls `try_lock()` starting at 1 ms, doubling, capped at
    /// 50 ms, until `timeout` → `lock_timeout`.
    pub fn acquire(root: &ProjectRoot, timeout: Duration) -> Result<ProjectLock> {
        let path = root.lock_path();
        let dir = root.data_dir();
        std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(&dir, e))?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| CoreError::io(&path, e))?;
        let start = Instant::now();
        let mut delay = Duration::from_millis(1);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(ProjectLock { file }),
                Err(TryLockError::WouldBlock) => {
                    if start.elapsed() >= timeout {
                        return Err(CoreError::lock_timeout(format!(
                            "timed out after {:?} waiting for the project lock {}",
                            timeout,
                            path.display()
                        )));
                    }
                    std::thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(50));
                }
                Err(TryLockError::Error(e)) => return Err(CoreError::io(&path, e)),
            }
        }
    }
}

impl Drop for ProjectLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Profile;

    #[test]
    fn second_lock_times_out_until_first_released() {
        let tmp = tempfile::tempdir().unwrap();
        let root = ProjectRoot::at(tmp.path(), Profile::Dev).unwrap();
        let a = ProjectLock::acquire(&root, DEFAULT_LOCK_TIMEOUT).unwrap();
        let e = ProjectLock::acquire(&root, Duration::from_millis(30)).err().unwrap();
        assert_eq!(e.code, crate::error::ErrorCode::LockTimeout);
        drop(a);
        ProjectLock::acquire(&root, Duration::from_millis(30)).unwrap();
    }
}
