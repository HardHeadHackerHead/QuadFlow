//! Detection of an installed agent CLI (agent-providers.md §4.1 `detect`):
//! resolve `detect.command` on PATH (PATHEXT on Windows), then `extraPaths`,
//! run `versionArgs` (≤ 5 s) and match `versionRegex`. Cached 1 h in memory.

use super::spec::ProviderRef;
use crate::model::Timestamp;
use crate::time::now_ms;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DETECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const DETECT_CACHE_TTL: Duration = Duration::from_secs(3600);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    pub provider_id: String,
    pub installed: bool,
    /// Resolved absolute program path.
    pub path: Option<String>,
    pub version: Option<String>,
    pub meets_min_version: bool,
    pub error: Option<String>,
    pub checked_at: Timestamp,
}

/// The parts of the process environment detection and path templates use.
#[derive(Clone, Debug, Default)]
pub struct ProcessEnv {
    pub path: Option<OsString>,
    pub pathext: Option<String>,
    pub home: Option<PathBuf>,
    pub app_data: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
}

impl ProcessEnv {
    pub fn current() -> Self {
        Self {
            path: std::env::var_os("PATH"),
            pathext: std::env::var("PATHEXT").ok(),
            home: dirs::home_dir(),
            app_data: if cfg!(windows) { std::env::var_os("APPDATA").map(PathBuf::from) } else { dirs::config_dir() },
            local_app_data: if cfg!(windows) {
                std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
            } else {
                dirs::data_local_dir()
            },
        }
    }

    /// Expand `{home}` `{appData}` `{localAppData}`; `None` if a variable is unknown/unset.
    pub fn expand(&self, template: &str) -> Option<PathBuf> {
        let mut out = String::new();
        let mut rest = template;
        while let Some(start) = rest.find('{') {
            out.push_str(&rest[..start]);
            let end = rest[start..].find('}')? + start;
            let val = match &rest[start + 1..end] {
                "home" => self.home.as_ref()?,
                "appData" => self.app_data.as_ref()?,
                "localAppData" => self.local_app_data.as_ref()?,
                _ => return None,
            };
            out.push_str(&val.to_string_lossy());
            rest = &rest[end + 1..];
        }
        out.push_str(rest);
        Some(PathBuf::from(out))
    }
}

fn is_file(p: &Path) -> bool {
    p.is_file()
}

/// Find `command` on PATH (honouring PATHEXT on Windows), then in `extra`.
pub fn resolve_program(command: &str, extra: &[String], env: &ProcessEnv) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        let pe = env.pathext.clone().unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        pe.split(';').filter(|e| !e.is_empty()).map(|e| e.to_lowercase()).collect()
    } else {
        Vec::new()
    };
    if let Some(path) = &env.path {
        for dir in std::env::split_paths(path) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            if cfg!(windows) {
                // A bare name without extension is not runnable on Windows; try PATHEXT.
                for ext in &exts {
                    let cand = dir.join(format!("{command}{ext}"));
                    if is_file(&cand) {
                        return Some(dunce::simplified(&cand).to_path_buf());
                    }
                }
            } else {
                let cand = dir.join(command);
                if is_executable(&cand) {
                    return Some(cand);
                }
            }
        }
    }
    extra.iter().filter_map(|t| env.expand(t)).find(|p| if cfg!(windows) { is_file(p) } else { is_executable(p) })
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}
#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// A command that never opens a console window on Windows.
pub fn hidden_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run `program args`, capture stdout+stderr (each capped at `cap`), kill after `timeout`.
pub(crate) fn run_capture(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
) -> std::io::Result<(Option<i32>, Vec<u8>, Vec<u8>, bool)> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let (Some(bytes), Some(mut sin)) = (stdin, child.stdin.take()) {
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = sin.write_all(&bytes);
            // dropping closes stdin
        });
    }
    let reader = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let mut chunk = [0u8; 8192];
                loop {
                    match r.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if buf.len() < cap {
                                let take = n.min(cap - buf.len());
                                buf.extend_from_slice(&chunk[..take]);
                            }
                        }
                    }
                }
            }
            buf
        })
    };
    let out_t = reader(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err_t = reader(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let out = out_t.join().unwrap_or_default();
    let err = err_t.join().unwrap_or_default();
    Ok((status.and_then(|s| s.code()), out, err, timed_out))
}

/// Detect one provider (uncached).
pub fn detect(p: &ProviderRef, env: &ProcessEnv) -> AgentDetection {
    let d = &p.spec.detect;
    let mut res = AgentDetection {
        provider_id: p.spec.id.clone(),
        installed: false,
        path: None,
        version: None,
        meets_min_version: false,
        error: None,
        checked_at: now_ms(),
    };
    let Some(program) = resolve_program(&d.command, d.extra_paths.current(), env) else {
        res.error = Some(format!("{} was not found on PATH", d.command));
        return res;
    };
    res.installed = true;
    res.path = Some(program.to_string_lossy().to_string());
    let mut cmd = hidden_command(&program);
    cmd.args(&d.version_args);
    match run_capture(cmd, None, DETECT_TIMEOUT, 64 * 1024) {
        Ok((_, out, err, timed_out)) => {
            let text = format!("{}\n{}", String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
            if timed_out {
                res.error = Some(format!("{} {} timed out", d.command, d.version_args.join(" ")));
            }
            res.version = Regex::new(&d.version_regex)
                .ok()
                .and_then(|re| re.captures(&text))
                .and_then(|c| c.get(1).or_else(|| c.get(0)))
                .map(|m| m.as_str().to_string());
        }
        Err(e) => res.error = Some(format!("failed to run {}: {e}", program.display())),
    }
    res.meets_min_version = match (&d.min_version, &res.version) {
        (None, _) => true,
        (Some(min), Some(v)) => match (lenient_version(v), semver::Version::parse(min)) {
            (Some(v), Ok(min)) => v >= min,
            _ => false,
        },
        (Some(_), None) => false,
    };
    res
}

fn lenient_version(s: &str) -> Option<semver::Version> {
    if let Ok(v) = semver::Version::parse(s) {
        return Some(v);
    }
    let parts: Vec<u64> = s.split('.').take(3).map(|x| x.parse().ok()).collect::<Option<_>>()?;
    Some(semver::Version::new(*parts.first()?, *parts.get(1).unwrap_or(&0), *parts.get(2).unwrap_or(&0)))
}

/// 1 h in-memory cache of detection results, keyed by provider id.
#[derive(Default)]
pub struct DetectCache {
    entries: Mutex<HashMap<String, (Instant, AgentDetection)>>,
}

impl DetectCache {
    pub fn get_or_detect(&self, p: &ProviderRef, env: &ProcessEnv, refresh: bool) -> AgentDetection {
        if !refresh {
            if let Some((at, d)) = self.entries.lock().get(&p.spec.id) {
                if at.elapsed() < DETECT_CACHE_TTL {
                    return d.clone();
                }
            }
        }
        let d = detect(p, env);
        self.entries.lock().insert(p.spec.id.clone(), (Instant::now(), d.clone()));
        d
    }

    pub fn clear(&self) {
        self.entries.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::spec::{fixtures, parse_spec};

    fn fake_cli(dir: &Path, name: &str, version_line: &str) -> PathBuf {
        if cfg!(windows) {
            let p = dir.join(format!("{name}.cmd"));
            std::fs::write(&p, format!("@echo off\r\necho {version_line}\r\n")).unwrap();
            p
        } else {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\necho '{version_line}'\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        }
    }

    #[test]
    fn detects_program_on_path_and_version() {
        let tmp = tempfile::tempdir().unwrap();
        let prog = fake_cli(tmp.path(), "alpha", "1.4.2 (Alpha Agent)");
        let mut v = fixtures::preassign();
        v["detect"]["minVersion"] = serde_json::json!("1.2.0");
        let spec = parse_spec(&v).unwrap();
        let env = ProcessEnv { path: Some(tmp.path().as_os_str().to_owned()), ..Default::default() };
        let p = ProviderRef { plugin_id: "alpha", spec: &spec, root: None };
        let d = detect(&p, &env);
        assert!(d.installed, "{d:?}");
        assert_eq!(d.path.as_deref().map(PathBuf::from), Some(dunce::simplified(&prog).to_path_buf()));
        assert_eq!(d.version.as_deref(), Some("1.4.2"));
        assert!(d.meets_min_version);

        // Cached until refresh.
        let cache = DetectCache::default();
        let first = cache.get_or_detect(&p, &env, false);
        let none_env = ProcessEnv::default();
        assert_eq!(cache.get_or_detect(&p, &none_env, false), first);
        assert!(!cache.get_or_detect(&p, &none_env, true).installed);
    }

    #[test]
    fn missing_program_and_extra_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let env = ProcessEnv { path: Some(OsString::new()), home: Some(tmp.path().into()), ..Default::default() };
        let p = ProviderRef { plugin_id: "alpha", spec: &spec, root: None };
        let d = detect(&p, &env);
        assert!(!d.installed && d.error.is_some());

        let local = tmp.path().join("bin");
        std::fs::create_dir_all(&local).unwrap();
        let prog = fake_cli(&local, "alpha", "2.0.0");
        let found = resolve_program("alpha", &[format!("{{home}}/bin/{}", prog.file_name().unwrap().to_string_lossy())], &env);
        assert_eq!(found, Some(prog));
        assert_eq!(env.expand("{nope}/x"), None);
    }
}
