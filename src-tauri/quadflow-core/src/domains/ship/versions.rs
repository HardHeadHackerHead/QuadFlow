//! Version file editors (json + toml, dotted keys) and semver bumps.
//!
//! Edits preserve formatting: JSON replaces the one `"leaf": "old"` occurrence
//! that sits at the key (verified by re-parsing; otherwise the document is
//! re-serialized), TOML rewrites only the matching `key = "…"` line of the
//! matching `[section]`. Writes are atomic.

use super::model::{ShipBumpType, ShipConfig, ShipVersionFile, ShipVersionFileKind, ShipVersionStatus};
use crate::error::{CoreError, Result};
use crate::store::atomic_write;
use std::path::Path;

pub fn read_version(project_dir: &Path, vf: &ShipVersionFile) -> Result<String> {
    let abs = project_dir.join(&vf.path);
    let content = std::fs::read_to_string(&abs).map_err(|e| CoreError::io(&abs, e))?;
    let v = match vf.kind {
        ShipVersionFileKind::Json => read_json_key(&content, &vf.key),
        ShipVersionFileKind::Toml => read_toml_key(&content, &vf.key),
    };
    v.ok_or_else(|| CoreError::invalid_input(format!("{} has no string value at key `{}`", vf.path, vf.key)))
}

pub fn write_version(project_dir: &Path, vf: &ShipVersionFile, new_version: &str) -> Result<()> {
    let abs = project_dir.join(&vf.path);
    let content = std::fs::read_to_string(&abs).map_err(|e| CoreError::io(&abs, e))?;
    let updated = match vf.kind {
        ShipVersionFileKind::Json => write_json_key(&content, &vf.key, new_version),
        ShipVersionFileKind::Toml => write_toml_key(&content, &vf.key, new_version),
    }
    .ok_or_else(|| CoreError::invalid_input(format!("{} has no string value at key `{}`", vf.path, vf.key)))?;
    if updated != content {
        atomic_write(&abs, updated.as_bytes())?;
    }
    Ok(())
}

pub(crate) fn read_json_key(content: &str, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    json_at(&v, key)?.as_str().map(str::to_string)
}

fn json_at<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    key.split('.').try_fold(v, |cur, part| cur.get(part))
}

pub(crate) fn write_json_key(content: &str, key: &str, new: &str) -> Option<String> {
    let old = read_json_key(content, key)?;
    if old == new {
        return Some(content.to_string());
    }
    let mut expected: serde_json::Value = serde_json::from_str(content).ok()?;
    set_json_path(&mut expected, key, serde_json::Value::String(new.to_string()))?;
    // Try each textual occurrence of `"leaf": "old"`; keep the first whose
    // re-parse equals the intended document (so nested look-alikes are never hit).
    let leaf = key.rsplit('.').next().unwrap_or(key);
    let old_lit = serde_json::to_string(&old).ok()?;
    let new_lit = serde_json::to_string(new).ok()?;
    let leaf_lit = serde_json::to_string(leaf).ok()?;
    for sep in [": ", ":"] {
        let pat = format!("{leaf_lit}{sep}{old_lit}");
        let repl = format!("{leaf_lit}{sep}{new_lit}");
        let mut start = 0;
        while let Some(off) = content[start..].find(&pat) {
            let at = start + off;
            let candidate = format!("{}{}{}", &content[..at], repl, &content[at + pat.len()..]);
            if serde_json::from_str::<serde_json::Value>(&candidate).ok().as_ref() == Some(&expected) {
                return Some(candidate);
            }
            start = at + pat.len();
        }
    }
    let mut out = serde_json::to_string_pretty(&expected).ok()?;
    out.push('\n');
    Some(out)
}

fn set_json_path(v: &mut serde_json::Value, key: &str, new: serde_json::Value) -> Option<()> {
    let parts: Vec<&str> = key.split('.').collect();
    let (last, parents) = parts.split_last()?;
    let mut cur = v;
    for p in parents {
        cur = cur.get_mut(*p)?;
    }
    cur.as_object_mut()?.insert((*last).to_string(), new);
    Some(())
}

/// `a.b.c` → section `a.b`, key `c`; `version` → top level.
fn split_toml_key(key: &str) -> (Option<&str>, &str) {
    match key.rfind('.') {
        Some(i) => (Some(&key[..i]), &key[i + 1..]),
        None => (None, key),
    }
}

fn toml_section(line: &str) -> Option<String> {
    let t = line.trim();
    if t.starts_with("[[") {
        return Some(t.trim_start_matches('[').trim_end_matches(']').trim().to_string());
    }
    t.strip_prefix('[').and_then(|s| s.strip_suffix(']')).map(|s| s.trim().to_string())
}

/// `key = "value"` → `Some(("key", "value"))` (string values only).
fn toml_kv(line: &str) -> Option<(&str, &str)> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return None;
    }
    let eq = t.find('=')?;
    let k = t[..eq].trim();
    let rest = t[eq + 1..].trim();
    let rest = rest.split(" #").next().unwrap_or(rest).trim();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let inner = rest[1..].strip_suffix(quote)?;
    Some((k, inner))
}

pub(crate) fn read_toml_key(content: &str, key: &str) -> Option<String> {
    let (section, leaf) = split_toml_key(key);
    let mut current: Option<String> = None;
    for line in content.lines() {
        if let Some(s) = toml_section(line) {
            current = Some(s);
            continue;
        }
        if current.as_deref() != section {
            continue;
        }
        if let Some((k, v)) = toml_kv(line) {
            if k == leaf {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub(crate) fn write_toml_key(content: &str, key: &str, new: &str) -> Option<String> {
    let (section, leaf) = split_toml_key(key);
    let mut current: Option<String> = None;
    let mut out = String::with_capacity(content.len() + 8);
    let mut replaced = false;
    for line in content.split_inclusive('\n') {
        if let Some(s) = toml_section(line) {
            current = Some(s);
        } else if !replaced && current.as_deref() == section {
            if let Some((k, _)) = toml_kv(line) {
                if k == leaf {
                    // Replace only the quoted value; keep spacing and trailing comments.
                    let eq = line.find('=').expect("toml_kv found '='");
                    let open = eq + 1 + line[eq + 1..].find(['"', '\'']).expect("quoted value");
                    let quote = &line[open..open + 1];
                    let close = open + 1 + line[open + 1..].find(quote).expect("closing quote");
                    out.push_str(&line[..open + 1]);
                    out.push_str(new);
                    out.push_str(&line[close..]);
                    replaced = true;
                    continue;
                }
            }
        }
        out.push_str(line);
    }
    replaced.then_some(out)
}

/// `1.2.3` (+ optional `-pre` / `+meta`, dropped) bumped.
pub fn bump_version(current: &str, bump: ShipBumpType) -> Result<String> {
    let base = current.split(['-', '+']).next().unwrap_or(current);
    let bad = || CoreError::invalid_input(format!("version {current:?} is not MAJOR.MINOR.PATCH"));
    let parts: Vec<u64> = base.split('.').map(|p| p.parse().map_err(|_| bad())).collect::<Result<_>>()?;
    let [major, minor, patch] = parts[..] else { return Err(bad()) };
    Ok(match bump {
        ShipBumpType::Major => format!("{}.0.0", major + 1),
        ShipBumpType::Minor => format!("{major}.{}.0", minor + 1),
        ShipBumpType::Patch => format!("{major}.{minor}.{}", patch + 1),
    })
}

pub fn read_all(project_dir: &Path, config: &ShipConfig) -> Vec<ShipVersionStatus> {
    config
        .version_files
        .iter()
        .map(|vf| match read_version(project_dir, vf) {
            Ok(v) => ShipVersionStatus { file: vf.path.clone(), current: Some(v), error: None },
            Err(e) => ShipVersionStatus { file: vf.path.clone(), current: None, error: Some(e.message) },
        })
        .collect()
}

/// The one version every version file agrees on. Errors if a file cannot be
/// read or two files disagree; `Ok(None)` when the config has no version files.
pub fn canonical_version(project_dir: &Path, config: &ShipConfig) -> Result<Option<String>> {
    let statuses = read_all(project_dir, config);
    let mut canonical: Option<(String, String)> = None;
    for s in &statuses {
        match (&s.current, &s.error) {
            (Some(v), _) => match &canonical {
                None => canonical = Some((s.file.clone(), v.clone())),
                Some((file, c)) if c != v => {
                    return Err(CoreError::conflict(format!(
                        "version files out of sync: {} has {c}, {} has {v}",
                        file, s.file
                    )))
                }
                Some(_) => {}
            },
            (None, err) => {
                return Err(CoreError::invalid_input(err.clone().unwrap_or_else(|| format!("{}: unreadable", s.file))))
            }
        }
    }
    Ok(canonical.map(|(_, v)| v))
}

/// Bump every version file. Returns `(from, to)`.
pub fn bump_all(project_dir: &Path, config: &ShipConfig, bump: ShipBumpType, dry_run: bool) -> Result<(String, String)> {
    let current = canonical_version(project_dir, config)?
        .ok_or_else(|| CoreError::invalid_input("the ship config has no versionFiles to bump"))?;
    let new = bump_version(&current, bump)?;
    if !dry_run {
        for vf in &config.version_files {
            write_version(project_dir, vf, &new)?;
        }
    }
    Ok((current, new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bumps() {
        assert_eq!(bump_version("1.0.0", ShipBumpType::Patch).unwrap(), "1.0.1");
        assert_eq!(bump_version("1.2.5", ShipBumpType::Minor).unwrap(), "1.3.0");
        assert_eq!(bump_version("1.2.5", ShipBumpType::Major).unwrap(), "2.0.0");
        assert_eq!(bump_version("1.0.0-rc.1", ShipBumpType::Patch).unwrap(), "1.0.1");
        assert_eq!(bump_version("1.0", ShipBumpType::Patch).unwrap_err().code, crate::ErrorCode::InvalidInput);
    }

    #[test]
    fn json_edit_preserves_formatting_and_skips_nested_lookalikes() {
        let s = "{\n  \"dep\": { \"version\": \"1.0.0\" },\n  \"version\": \"1.0.0\",\n  \"name\": \"x\"\n}\n";
        let out = write_json_key(s, "version", "1.0.1").unwrap();
        assert_eq!(out, "{\n  \"dep\": { \"version\": \"1.0.0\" },\n  \"version\": \"1.0.1\",\n  \"name\": \"x\"\n}\n");
        let nested = write_json_key(s, "dep.version", "2.0.0").unwrap();
        assert!(nested.contains("{ \"version\": \"2.0.0\" }"));
        assert!(nested.contains("\"version\": \"1.0.0\",\n"));
    }

    #[test]
    fn toml_edit_only_touches_the_section() {
        let s = "[package]\nname = \"a\"\nversion = \"1.0.0\" # x\n\n[dependencies]\nfoo = { version = \"2.0.0\" }\n";
        let out = write_toml_key(s, "package.version", "1.0.1").unwrap();
        assert!(out.contains("[package]\nname = \"a\"\nversion = \"1.0.1\" # x\n"));
        assert!(out.contains("foo = { version = \"2.0.0\" }"));
        assert_eq!(read_toml_key(&out, "package.version").as_deref(), Some("1.0.1"));
        assert!(write_toml_key(s, "workspace.package.version", "1.0.1").is_none());
    }

    #[test]
    fn toml_dotted_section() {
        let s = "[workspace]\nmembers = []\n\n[workspace.package]\nversion = \"0.3.0\"\r\n";
        assert_eq!(read_toml_key(s, "workspace.package.version").as_deref(), Some("0.3.0"));
        let out = write_toml_key(s, "workspace.package.version", "0.4.0").unwrap();
        assert!(out.ends_with("version = \"0.4.0\"\r\n"));
        assert_eq!(read_toml_key(s, "version"), None);
    }
}
