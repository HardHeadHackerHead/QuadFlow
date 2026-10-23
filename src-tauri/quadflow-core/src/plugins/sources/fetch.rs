//! HTTP(S) / file fetching for sources and archives (plugin-system.md §12.3):
//! conditional GET with ETag, hard timeouts and size caps, streaming SHA-256.

use crate::error::{CoreError, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

/// Result of a conditional index fetch.
#[derive(Debug)]
pub enum Fetched {
    /// `304 Not Modified` — the cached body is current.
    NotModified,
    Body { bytes: Vec<u8>, etag: Option<String> },
}

fn client(timeout: Duration) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout.min(Duration::from_secs(10)))
        .user_agent(concat!("QuadFlow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CoreError::internal(format!("http client: {e}")))
}

fn file_path(u: &str) -> Result<std::path::PathBuf> {
    url::Url::parse(u)
        .ok()
        .and_then(|p| p.to_file_path().ok())
        .ok_or_else(|| CoreError::invalid_input(format!("{u:?} is not a valid file URL")))
}

/// Read at most `max` bytes; more → error.
fn read_capped(mut r: impl Read, max: u64, what: &str) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    r.by_ref()
        .take(max + 1)
        .read_to_end(&mut buf)
        .map_err(|e| CoreError::external(format!("{what}: read failed: {e}")))?;
    if buf.len() as u64 > max {
        return Err(CoreError::invalid_input(format!("{what} is larger than {max} bytes")));
    }
    Ok(buf)
}

/// GET `url` with `If-None-Match: etag`.
pub fn fetch_index(u: &str, etag: Option<&str>, timeout: Duration, max: u64) -> Result<Fetched> {
    if u.starts_with("file:") {
        let p = file_path(u)?;
        let f = std::fs::File::open(&p).map_err(|e| CoreError::external(format!("{}: {e}", p.display())))?;
        return Ok(Fetched::Body { bytes: read_capped(f, max, "index")?, etag: None });
    }
    let mut req = client(timeout)?.get(u);
    if let Some(t) = etag {
        req = req.header(reqwest::header::IF_NONE_MATCH, t);
    }
    let resp = req.send().map_err(|e| CoreError::external(format!("{u}: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::NotModified);
    }
    if !status.is_success() {
        return Err(CoreError::external(format!("{u}: HTTP {status}")));
    }
    let etag = resp.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    if resp.content_length().is_some_and(|n| n > max) {
        return Err(CoreError::invalid_input(format!("index is larger than {max} bytes")));
    }
    Ok(Fetched::Body { bytes: read_capped(resp, max, "index")?, etag })
}

/// Integrity failure (tampered / wrong archive). `corrupt` + `details.integrity = true`.
pub fn integrity_error(msg: impl Into<String>) -> CoreError {
    CoreError::new(crate::ErrorCode::Corrupt, format!("integrity check failed: {}", msg.into()))
        .with_details(serde_json::json!({ "integrity": true }))
}

/// Download `u` to `dest`, streaming SHA-256 and enforcing `expected_size` and `cap`.
/// On any mismatch `dest` is deleted and an integrity error returned.
pub fn download_verified(u: &str, dest: &Path, expected_sha256: &str, expected_size: u64, cap: u64, timeout: Duration) -> Result<()> {
    if expected_size > cap {
        return Err(integrity_error(format!("archive size {expected_size} exceeds the {cap}-byte limit")));
    }
    let res = (|| -> Result<()> {
        let reader: Box<dyn Read> = if u.starts_with("file:") {
            let p = file_path(u)?;
            Box::new(std::fs::File::open(&p).map_err(|e| CoreError::external(format!("{}: {e}", p.display())))?)
        } else {
            let resp = client(timeout)?.get(u).send().map_err(|e| CoreError::external(format!("{u}: {e}")))?;
            if !resp.status().is_success() {
                return Err(CoreError::external(format!("{u}: HTTP {}", resp.status())));
            }
            Box::new(resp)
        };
        let mut out = std::fs::File::create(dest).map_err(|e| CoreError::io(dest, e))?;
        let mut hasher = Sha256::new();
        let mut total: u64 = 0;
        let mut reader = reader.take(expected_size + 1);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| CoreError::external(format!("{u}: download failed: {e}")))?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > expected_size {
                return Err(integrity_error(format!("archive is larger than the {expected_size} bytes the index declares")));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| CoreError::io(dest, e))?;
        }
        out.sync_all().map_err(|e| CoreError::io(dest, e))?;
        if total != expected_size {
            return Err(integrity_error(format!("archive is {total} bytes, the index declares {expected_size}")));
        }
        let got = hex::encode(hasher.finalize());
        if !got.eq_ignore_ascii_case(expected_sha256) {
            return Err(integrity_error(format!("sha256 {got} does not match the index ({expected_sha256})")));
        }
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    res
}

/// SHA-256 of a file, hex.
pub fn sha256_file(p: &Path) -> Result<String> {
    let mut f = std::fs::File::open(p).map_err(|e| CoreError::io(p, e))?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h).map_err(|e| CoreError::io(p, e))?;
    Ok(hex::encode(h.finalize()))
}
