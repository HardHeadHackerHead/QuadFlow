//! Safe extraction of plugin release archives (plugin-system.md §12.3): rejects
//! absolute paths, `..`, drive prefixes, backslash tricks, symlink entries, too
//! many entries and zip bombs. Nothing is written outside `dest`.

use crate::error::{CoreError, Result};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const MAX_ENTRIES: usize = 10_000;
/// Total uncompressed bytes allowed (zip-bomb guard).
pub const MAX_UNCOMPRESSED: u64 = 1024 * 1024 * 1024;

fn reject(name: &str, why: &str) -> CoreError {
    super::fetch::integrity_error(format!("archive entry {name:?} rejected: {why}"))
}

/// Validate one entry name and map it to a relative path under the destination.
pub fn safe_entry_path(name: &str) -> Result<PathBuf> {
    if name.is_empty() {
        return Err(reject(name, "empty name"));
    }
    if name.contains('\\') {
        return Err(reject(name, "backslash in path"));
    }
    if name.contains('\0') || name.chars().any(char::is_control) {
        return Err(reject(name, "control character in path"));
    }
    if name.starts_with('/') {
        return Err(reject(name, "absolute path"));
    }
    if name.contains(':') {
        return Err(reject(name, "drive prefix or stream name"));
    }
    let mut out = PathBuf::new();
    for seg in name.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(reject(name, "parent directory component")),
            s => out.push(s),
        }
    }
    // Belt and braces: the platform's own parse must agree.
    if out.components().any(|c| !matches!(c, Component::Normal(_))) || out.as_os_str().is_empty() {
        return Err(reject(name, "not a plain relative path"));
    }
    Ok(out)
}

/// Extract `zip` into `dest` (created; must not exist or be empty).
pub fn extract_zip(zip: &Path, dest: &Path) -> Result<usize> {
    let f = std::fs::File::open(zip).map_err(|e| CoreError::io(zip, e))?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| super::fetch::integrity_error(format!("not a valid zip archive: {e}")))?;
    if ar.len() > MAX_ENTRIES {
        return Err(super::fetch::integrity_error(format!("archive has {} entries (limit {MAX_ENTRIES})", ar.len())));
    }
    // Validate every entry before writing anything.
    let mut plan: Vec<(usize, PathBuf, bool)> = Vec::with_capacity(ar.len());
    let mut total: u64 = 0;
    for i in 0..ar.len() {
        let e = ar.by_index_raw(i).map_err(|e| super::fetch::integrity_error(format!("corrupt zip entry: {e}")))?;
        let name = e.name().to_string();
        let rel = safe_entry_path(&name)?;
        if let Some(mode) = e.unix_mode() {
            let kind = mode & 0o170000;
            if kind == 0o120000 {
                return Err(reject(&name, "symbolic link"));
            }
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(reject(&name, "special file"));
            }
        }
        if e.enclosed_name().is_none() {
            return Err(reject(&name, "path escapes the archive root"));
        }
        total = total.saturating_add(e.size());
        if total > MAX_UNCOMPRESSED {
            return Err(super::fetch::integrity_error("archive expands beyond the size limit"));
        }
        plan.push((i, rel, e.is_dir()));
    }
    std::fs::create_dir_all(dest).map_err(|e| CoreError::io(dest, e))?;
    let mut written: u64 = 0;
    for (i, rel, is_dir) in &plan {
        let target = dest.join(rel);
        if *is_dir {
            std::fs::create_dir_all(&target).map_err(|e| CoreError::io(&target, e))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| CoreError::io(parent, e))?;
        }
        if target.exists() {
            return Err(reject(&rel.display().to_string(), "duplicate entry"));
        }
        let mut entry = ar.by_index(*i).map_err(|e| super::fetch::integrity_error(format!("corrupt zip entry: {e}")))?;
        let mut out = std::fs::File::create(&target).map_err(|e| CoreError::io(&target, e))?;
        // Copy with a running cap: declared sizes can lie.
        let mut limited = (&mut entry).take(MAX_UNCOMPRESSED - written + 1);
        let n = std::io::copy(&mut limited, &mut out)
            .map_err(|e| super::fetch::integrity_error(format!("extracting {}: {e}", rel.display())))?;
        written += n;
        if written > MAX_UNCOMPRESSED {
            return Err(super::fetch::integrity_error("archive expands beyond the size limit"));
        }
    }
    Ok(plan.len())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a zip at `path` from (name, contents) pairs.
    pub(crate) fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        for (name, data) in files {
            z.start_file(*name, SimpleFileOptions::default()).unwrap();
            z.write_all(data).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn entry_names() {
        assert_eq!(safe_entry_path("a/b.txt").unwrap(), PathBuf::from("a").join("b.txt"));
        assert_eq!(safe_entry_path("./a//b").unwrap(), PathBuf::from("a").join("b"));
        for bad in ["../x", "a/../../x", "/etc/passwd", "C:/x", "C:x", "a\\..\\x", "\\\\server\\x", "a:stream", "", ".", "x/\u{1}"] {
            assert!(safe_entry_path(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn zip_slip_rejected_and_nothing_written() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("evil.zip");
        write_zip(&z, &[("quadflow-plugin.json", b"{}"), ("../escaped.txt", b"pwned")]);
        let dest = d.path().join("out");
        let e = extract_zip(&z, &dest).unwrap_err();
        assert!(e.message.contains("parent directory"), "{e}");
        assert!(!d.path().join("escaped.txt").exists());
        assert!(!dest.join("quadflow-plugin.json").exists(), "validation happens before any write");
    }

    #[test]
    fn symlink_entries_rejected() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("link.zip");
        {
            let f = std::fs::File::create(&z).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.add_symlink("link", "/etc/passwd", SimpleFileOptions::default()).unwrap();
            w.finish().unwrap();
        }
        let e = extract_zip(&z, &d.path().join("out")).unwrap_err();
        assert!(e.message.contains("symbolic link"), "{e}");
    }

    #[test]
    fn extracts_normal_archive() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("ok.zip");
        write_zip(&z, &[("quadflow-plugin.json", b"{}"), ("dist/index.js", b"x")]);
        let dest = d.path().join("out");
        assert_eq!(extract_zip(&z, &dest).unwrap(), 2);
        assert_eq!(std::fs::read(dest.join("dist/index.js")).unwrap(), b"x");
    }

    #[test]
    fn garbage_is_not_a_zip() {
        let d = tempfile::tempdir().unwrap();
        let z = d.path().join("x.zip");
        std::fs::write(&z, b"definitely not a zip").unwrap();
        assert!(extract_zip(&z, &d.path().join("out")).unwrap_err().message.contains("integrity"));
    }
}
