//! Atomic file writes and retrying reads (data-layer.md §4.1).
//!
//! Writers create a uniquely named temp file (`.<random>.tmp`) in the target's
//! directory, fsync it and rename it over the target. Readers therefore never
//! observe a partially written file. The target is never removed first.

use crate::error::{CoreError, Result};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

/// Windows error codes that indicate a transient sharing problem (antivirus,
/// indexer, a reader holding the file open) rather than a real failure.
#[cfg(windows)]
fn is_transient_share_error(e: &std::io::Error) -> bool {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
    matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}

#[cfg(not(windows))]
fn is_transient_share_error(_e: &std::io::Error) -> bool {
    false
}

/// Write `bytes` to `path` atomically.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::invalid_input(format!("{} has no parent directory", path.display())))?;
    std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|e| CoreError::io(dir, e))?;
    tmp.write_all(bytes).map_err(|e| CoreError::io(tmp.path(), e))?;
    tmp.as_file().sync_all().map_err(|e| CoreError::io(tmp.path(), e))?;

    // 8 retries: 2, 4, …, 256 ms (~510 ms total) for transient Windows share errors.
    let mut delay_ms = 2u64;
    let mut attempt = 0;
    loop {
        match tmp.persist(path) {
            Ok(_) => break,
            Err(err) => {
                if attempt < 8 && is_transient_share_error(&err.error) {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    delay_ms *= 2;
                    tmp = err.file;
                    continue;
                }
                // Dropping the NamedTempFile deletes the temp file.
                let e = err.error;
                drop(err.file);
                return Err(CoreError::io(path, e));
            }
        }
    }

    #[cfg(unix)]
    {
        // Durable rename: fsync the directory entry.
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Serialize `value` as pretty JSON (+ trailing newline) and write atomically.
pub fn atomic_write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| CoreError::internal(format!("serialize {}: {e}", path.display())))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

/// Read a file, retrying a transient sharing violation twice (10 ms, 50 ms).
/// `Ok(None)` when the file does not exist.
pub fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let delays = [10u64, 50];
    let mut attempt = 0;
    loop {
        match std::fs::read(path) {
            Ok(b) => return Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) if attempt < delays.len() && is_transient_share_error(&e) => {
                std::thread::sleep(Duration::from_millis(delays[attempt]));
                attempt += 1;
            }
            Err(e) => return Err(CoreError::io(path, e)),
        }
    }
}

/// True for names the store ignores when listing: dotfiles (temp files, `.lock`, `.gitignore`).
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_replaces_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("nested").join("a.json");
        atomic_write_json(&p, &serde_json::json!({"a": 1})).unwrap();
        atomic_write_json(&p, &serde_json::json!({"a": 2})).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&read_file(&p).unwrap().unwrap()).unwrap();
        assert_eq!(v["a"], 2);
        let names: Vec<_> = std::fs::read_dir(p.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["a.json".to_string()]);
        assert!(read_file(&tmp.path().join("missing")).unwrap().is_none());
    }
}
