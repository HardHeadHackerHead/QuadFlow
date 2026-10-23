//! `shell.exec` / `shell.spawn` (plugin-system.md §6.6, §11.3): run a program
//! by **basename** with an argv (never through a shell). The permission
//! `shell:exec:<program>` is checked against the requested basename *before*
//! it is resolved on `PATH`.

use super::{HostCall, HostEnv, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use crate::domains::environments::{self, SystemProbe, TargetPlatform};
use crate::error::{CoreError, Result};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Default / max `timeoutMs` of `shell.exec`.
pub const EXEC_DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const EXEC_MAX_TIMEOUT_MS: u64 = 30 * 60_000;
/// Captured stdout/stderr cap per stream.
pub const EXEC_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecOptions {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    stdin: Option<String>,
}

fn options(c: &HostCall) -> Result<ExecOptions> {
    c.arg("options")
}

/// The requested program as a basename: `[A-Za-z0-9._-]+`, no path, no `..`.
fn program_name(p: &str) -> Result<&str> {
    if p.is_empty() || p == "." || p == ".." || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err(CoreError::invalid_input(format!(
            "shell: program {p:?} must be a bare program name ([A-Za-z0-9._-]+, resolved from PATH)"
        )));
    }
    Ok(p)
}

/// `shell:exec:<name>`; on Windows `git.exe` also matches `shell:exec:git`.
fn exec_perm(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    let o = options(c)?;
    let name = program_name(&o.program)?;
    let mut alts = vec![format!("shell:exec:{name}")];
    if let Some(stem) = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".cmd")).or_else(|| name.strip_suffix(".bat")) {
        if !stem.is_empty() {
            alts.push(format!("shell:exec:{stem}"));
        }
    }
    Ok(alts)
}

fn resolve_program(name: &str) -> Result<PathBuf> {
    environments::which(&SystemProbe, TargetPlatform::current(), name)
        .ok_or_else(|| CoreError::not_found(format!("program {name:?} was not found on PATH")))
}

fn build(env: &HostEnv, c: &HostCall, o: &ExecOptions) -> Result<Command> {
    let exe = resolve_program(program_name(&o.program)?)?;
    let cwd = match o.cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => env.project_root(c).or_else(|_| dirs::home_dir().ok_or_else(|| CoreError::unsupported("no home dir")))?,
    };
    if !cwd.is_dir() {
        return Err(CoreError::invalid_input(format!("shell: cwd {} is not a directory", cwd.display())));
    }
    for k in o.env.keys() {
        if k.is_empty() || k.contains('=') || k.contains('\0') {
            return Err(CoreError::invalid_input(format!("shell: invalid env var name {k:?}")));
        }
    }
    let mut cmd = Command::new(&exe);
    cmd.args(&o.args).current_dir(&cwd).envs(&o.env);
    cmd.stdin(if o.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn spawn_err(program: &str, e: std::io::Error) -> CoreError {
    CoreError::external(format!("could not start {program:?}: {e}"))
}

fn read_capped(mut r: impl Read) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() < EXEC_MAX_OUTPUT_BYTES {
                    let take = n.min(EXEC_MAX_OUTPUT_BYTES - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

fn feed_stdin(child: &mut Child, stdin: Option<String>) {
    if let (Some(mut pipe), Some(s)) = (child.stdin.take(), stdin) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(s.as_bytes());
        });
    }
}

pub(super) fn methods() -> Vec<MethodSpec> {
    vec![MethodSpec::new("shell.exec", PermReq::Fn(exec_perm), |env: &HostEnv, c: &HostCall| {
        let o = options(c)?;
        let timeout = Duration::from_millis(o.timeout_ms.unwrap_or(EXEC_DEFAULT_TIMEOUT_MS).clamp(1, EXEC_MAX_TIMEOUT_MS));
        let mut child = build(env, c, &o)?.spawn().map_err(|e| spawn_err(&o.program, e))?;
        feed_stdin(&mut child, o.stdin.clone());
        let out = child.stdout.take().map(|s| std::thread::spawn(move || read_capped(s)));
        let err = child.stderr.take().map(|s| std::thread::spawn(move || read_capped(s)));
        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    timed_out = true;
                    break child.wait().ok();
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => return Err(CoreError::external(format!("{}: {e}", o.program))),
            }
        };
        let stdout = out.and_then(|h| h.join().ok()).unwrap_or_default();
        let stderr = err.and_then(|h| h.join().ok()).unwrap_or_default();
        if timed_out {
            return Err(CoreError::external(format!("{} timed out after {} ms", o.program, timeout.as_millis()))
                .with_details(json!({ "stdout": stdout, "stderr": stderr })));
        }
        Ok(json!({ "code": status.and_then(|s| s.code()), "stdout": stdout, "stderr": stderr }))
    })]
}

/// Kills the process when the subscription is dropped.
struct KillOnDrop(Arc<Mutex<Child>>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let mut c = self.0.lock();
        if let Ok(None) = c.try_wait() {
            let _ = c.kill();
        }
    }
}

pub(super) fn topics() -> Vec<TopicSpec> {
    vec![TopicSpec::new("shell.spawn", PermReq::Fn(exec_perm), |env: &HostEnv, c: &HostCall, sink: Sink| {
        let o = options(c)?;
        let mut child = build(env, c, &o)?.spawn().map_err(|e| spawn_err(&o.program, e))?;
        feed_stdin(&mut child, o.stdin.clone());
        let pump = |r: Box<dyn Read + Send>, stream: &'static str, sink: Sink| {
            std::thread::spawn(move || {
                let mut r = r;
                let mut chunk = [0u8; 8192];
                loop {
                    match r.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => sink(json!({ "stream": stream, "data": String::from_utf8_lossy(&chunk[..n]) })),
                    }
                }
            })
        };
        let t_out = child.stdout.take().map(|s| pump(Box::new(s), "stdout", sink.clone()));
        let t_err = child.stderr.take().map(|s| pump(Box::new(s), "stderr", sink.clone()));
        let child = Arc::new(Mutex::new(child));
        let waiter = Arc::clone(&child);
        std::thread::spawn(move || {
            let code = loop {
                if let Ok(Some(st)) = waiter.lock().try_wait() {
                    break st.code();
                }
                std::thread::sleep(Duration::from_millis(25));
            };
            if let Some(t) = t_out {
                let _ = t.join();
            }
            if let Some(t) = t_err {
                let _ = t.join();
            }
            sink(json!({ "exit": code }));
        });
        Ok(SubscriptionGuard::new(KillOnDrop(child)))
    })]
}
