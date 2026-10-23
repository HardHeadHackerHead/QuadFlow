//! Process helpers for the ship domain: windowless commands, tool lookup, git,
//! free disk space, and the streaming shell runner used by every
//! command-running phase and by readiness fixes.

use crate::error::{CoreError, Result};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A `Command` that never opens a console window on Windows (the GUI has no
/// console, so every child would otherwise flash a new cmd.exe window).
#[cfg(windows)]
pub(crate) fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new(program);
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

#[cfg(not(windows))]
pub(crate) fn command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    Command::new(program)
}

/// `cmd /C <line>` on Windows, `sh -c <line>` elsewhere.
pub(crate) fn shell_command(line: &str) -> Command {
    #[cfg(windows)]
    {
        // Hand cmd the line verbatim: `Command::arg` would escape inner quotes as `\"`, which
        // cmd does not understand, so every quoted path in a phase command arrived with literal
        // quote characters. `/S /C "<line>"` strips exactly the outer pair and runs the rest.
        use std::os::windows::process::CommandExt;
        let mut c = command("cmd");
        c.args(["/S", "/C"]).raw_arg(format!("\"{line}\""));
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = command("sh");
        c.args(["-c", line]);
        c
    }
}

pub fn tool_available(tool: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    command(finder).arg(tool).stdin(Stdio::null()).output().map(|o| o.status.success()).unwrap_or(false)
}

/// Run a shell command line to completion, capturing output (no stdin).
pub(crate) fn run_line(cwd: &Path, line: &str) -> std::io::Result<std::process::Output> {
    let mut c = shell_command(line);
    c.current_dir(cwd).stdin(Stdio::null());
    noninteractive_env(&mut c);
    c.output()
}

fn git(project_dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    command("git")
        .args(args)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| CoreError::external(format!("git {}: {e}", args.join(" "))))
}

fn git_ok(project_dir: &Path, args: &[&str]) -> Result<String> {
    let out = git(project_dir, args)?;
    if !out.status.success() {
        return Err(CoreError::external(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn git_clean(project_dir: &Path) -> Result<bool> {
    Ok(git_ok(project_dir, &["status", "--porcelain"])?.is_empty())
}

pub fn git_branch(project_dir: &Path) -> Result<String> {
    git_ok(project_dir, &["rev-parse", "--abbrev-ref", "HEAD"])
}

pub fn git_short_sha(project_dir: &Path) -> Result<String> {
    git_ok(project_dir, &["rev-parse", "--short", "HEAD"])
}

pub fn git_last_tag(project_dir: &Path) -> Option<String> {
    git_ok(project_dir, &["describe", "--tags", "--abbrev=0"]).ok().filter(|s| !s.is_empty())
}

pub fn git_tag_exists(project_dir: &Path, tag: &str) -> bool {
    git(project_dir, &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}")])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `- subject` lines from `since` (`last_tag` or a ref) to HEAD.
pub fn changelog_from_git(project_dir: &Path, since: &str) -> Result<String> {
    let from = if since == "last_tag" { git_last_tag(project_dir) } else { Some(since.to_string()) };
    let range = from.map(|f| format!("{f}..HEAD"));
    let mut args = vec!["log", "--pretty=format:- %s"];
    if let Some(r) = &range {
        args.push(r);
    }
    git_ok(project_dir, &args)
}

/// Best-effort free bytes on the volume holding `path`.
pub fn free_bytes_on_volume(path: &Path) -> Option<u64> {
    if cfg!(windows) {
        let abs = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let drive = abs.to_string_lossy().chars().next().filter(|c| c.is_ascii_alphabetic())?;
        let ps = format!("(Get-PSDrive {drive} -ErrorAction Stop).Free");
        let out = command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &ps]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse::<u64>().ok().filter(|n| *n > 0)
    } else {
        let out = command("df").args(["-k", &path.to_string_lossy()]).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        let avail_kb: u64 = s.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
        Some(avail_kb * 1024)
    }
}

/// Defaults that make auth prompts fail fast instead of hanging a phase
/// (stdin is also closed): git, Git Credential Manager, gh, ssh askpass.
fn noninteractive_env(c: &mut Command) {
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GH_PROMPT_DISABLED", "1")
        .env("SSH_ASKPASS_REQUIRE", "never");
}

/// Cooperative cancellation shared by a run, its executor and its host.
#[derive(Clone, Debug, Default)]
pub struct ShipCancel(Arc<AtomicBool>);

impl ShipCancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub(crate) struct ShellOutcome {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub cancelled: bool,
}

/// Stream: `(is_stderr, line)`.
pub(crate) type LineFn<'a> = &'a (dyn Fn(bool, &str) + Sync);

/// Run `line` in `cwd` with `env` overlaid on the non-interactive defaults,
/// streaming each output line to `on_line` and collecting everything for the
/// run record. Killed (process tree) when `cancel` fires.
pub(crate) fn run_streaming(
    line: &str,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    cancel: &ShipCancel,
    on_line: LineFn,
) -> ShellOutcome {
    let mut c = shell_command(line);
    c.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    noninteractive_env(&mut c);
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            let msg = format!("spawn `{line}`: {e}");
            on_line(true, &msg);
            return ShellOutcome { success: false, exit_code: None, stdout: String::new(), stderr: msg, cancelled: false };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    std::thread::scope(|scope| {
        let read = |pipe: Option<Box<dyn std::io::Read + Send>>, is_err: bool| {
            scope.spawn(move || {
                let mut collected = String::new();
                if let Some(p) = pipe {
                    for l in BufReader::new(p).lines() {
                        let Ok(l) = l else { break };
                        on_line(is_err, &l);
                        collected.push_str(&l);
                        collected.push('\n');
                    }
                }
                collected
            })
        };
        let h_out = read(stdout.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), false);
        let h_err = read(stderr.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), true);
        let mut cancelled = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(_) => break None,
            }
            if cancel.is_cancelled() && !cancelled {
                cancelled = true;
                kill_tree(&mut child);
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stdout = h_out.join().unwrap_or_default();
        let stderr = h_err.join().unwrap_or_default();
        ShellOutcome {
            success: !cancelled && status.map(|s| s.success()).unwrap_or(false),
            exit_code: status.and_then(|s| s.code()),
            stdout,
            stderr,
            cancelled,
        }
    })
}

fn kill_tree(child: &mut std::process::Child) {
    if cfg!(windows) {
        let _ = command("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).output();
    }
    let _ = child.kill();
}
