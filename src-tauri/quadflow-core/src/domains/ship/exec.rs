//! Phase executor. `execute` runs one `ShipPhase` against a [`ShipContext`]
//! (staging dir, env, vars, artifacts, backups threaded between phases) and
//! returns its [`ShipPhaseResult`]. Output streams through a [`ShipSink`].

use super::checks;
use super::model::*;
use super::sys::{self, ShipCancel};
use super::versions;
use crate::ids::new_id;
use crate::time::now_ms;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

/// Receives everything a run produces. The Tauri layer forwards to a
/// `tauri::ipc::Channel`; the CLI prints.
pub trait ShipSink: Send + Sync {
    fn phase(&self, event: ShipPhaseEvent);
    fn line(&self, event: ShipLineEvent);
    /// Run `req.command` in a host terminal and block until it finishes (or
    /// `cancel` fires). `Unavailable` makes the phase run embedded instead.
    fn external(&self, _req: ShipExternalRequest, _cancel: &ShipCancel) -> ShipExternalOutcome {
        ShipExternalOutcome::Unavailable
    }
    /// Orphan `.ship-bak` files restored before the run started.
    fn restored_backups(&self, _files: &[String]) {}
}

/// A sink that drops everything (tests, callers that only want the record).
pub struct NullSink;
impl ShipSink for NullSink {
    fn phase(&self, _: ShipPhaseEvent) {}
    fn line(&self, _: ShipLineEvent) {}
}

// ------------------------------------------------------------ external terminals

type Pending = Mutex<HashMap<String, mpsc::Sender<ShipExternalResult>>>;

fn pending_external() -> &'static Pending {
    static PENDING: OnceLock<Pending> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Host helper for [`ShipSink::external`]: registers `req.requestId`, calls
/// `send` (which delivers the request to the UI), then waits for
/// [`external_complete`] — or for `cancel`.
pub fn external_roundtrip(
    req: ShipExternalRequest,
    cancel: &ShipCancel,
    send: impl FnOnce(ShipExternalRequest) -> Result<(), String>,
) -> ShipExternalOutcome {
    let key = req.request_id.clone();
    let (tx, rx) = mpsc::channel();
    pending_external().lock().insert(key.clone(), tx);
    let failed = |error: String| ShipExternalResult { success: false, exit_code: None, terminal_id: None, error: Some(error) };
    if let Err(e) = send(req) {
        pending_external().lock().remove(&key);
        return ShipExternalOutcome::Done(failed(format!("could not reach the host terminal: {e}")));
    }
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(r) => return ShipExternalOutcome::Done(r),
            Err(mpsc::RecvTimeoutError::Timeout) if cancel.is_cancelled() => {
                pending_external().lock().remove(&key);
                return ShipExternalOutcome::Done(failed("run aborted".into()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return ShipExternalOutcome::Done(failed("host terminal went away".into()));
            }
        }
    }
}

/// The host reports an external phase finished. Unknown ids are `not_found`
/// (already completed, aborted, or from another process).
pub fn external_complete(request_id: &str, result: ShipExternalResult) -> crate::Result<()> {
    let tx = pending_external()
        .lock()
        .remove(request_id)
        .ok_or_else(|| crate::CoreError::not_found(format!("no pending external phase {request_id}")))?;
    let _ = tx.send(result);
    Ok(())
}

// ------------------------------------------------------------ context

#[derive(Clone)]
pub struct ShipContext {
    pub project_dir: PathBuf,
    pub run_id: crate::Id,
    pub product_name: String,
    pub version: String,
    pub previous_version: Option<String>,
    pub staging_dir: Option<PathBuf>,
    /// Set by `load_env_from_file`; inherited by every command-running phase.
    pub env: BTreeMap<String, String>,
    /// Token vars (`{signature}`, …).
    pub vars: BTreeMap<String, String>,
    pub artifacts: Vec<PathBuf>,
    /// `.ship-bak` files to restore when the run ends.
    pub backups: Vec<PathBuf>,
}

impl ShipContext {
    pub fn new(project_dir: PathBuf, run_id: crate::Id, product_name: String, version: String, previous_version: Option<String>) -> Self {
        Self {
            project_dir,
            run_id,
            product_name,
            version,
            previous_version,
            staging_dir: None,
            env: BTreeMap::new(),
            vars: BTreeMap::new(),
            artifacts: Vec::new(),
            backups: Vec::new(),
        }
    }

    pub fn subst(&self, s: &str) -> String {
        substitute(s, self)
    }

    fn abs(&self, p: &str) -> PathBuf {
        let p = Path::new(p);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.project_dir.join(p)
        }
    }
}

/// Replace `{version}`, `{prev_version}`, `{staging_dir}`, `{productName}` and `{<var>}`.
pub fn substitute(template: &str, ctx: &ShipContext) -> String {
    let mut out = template.replace("{version}", &ctx.version).replace("{productName}", &ctx.product_name);
    if let Some(p) = &ctx.previous_version {
        out = out.replace("{prev_version}", p);
    }
    if let Some(s) = &ctx.staging_dir {
        out = out.replace("{staging_dir}", &s.to_string_lossy());
    }
    for (k, v) in &ctx.vars {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// Minimal glob: `*` in the file-name component only; sorted. A leading `**`
/// tries the rest at the project root, then under `src-tauri/` (both common
/// Tauri workspace layouts).
pub fn glob(project_dir: &Path, pattern: &str) -> Vec<PathBuf> {
    if let Some(rest) = pattern.strip_prefix("**") {
        let rest = rest.trim_start_matches(['/', '\\']);
        let out = glob_one(project_dir, rest);
        if !out.is_empty() {
            return out;
        }
        return glob_one(project_dir, &format!("src-tauri/{rest}"));
    }
    glob_one(project_dir, pattern)
}

fn glob_one(project_dir: &Path, pattern: &str) -> Vec<PathBuf> {
    let abs = if Path::new(pattern).is_absolute() { PathBuf::from(pattern) } else { project_dir.join(pattern) };
    let Some(file_pat) = abs.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
        return Vec::new();
    };
    if !file_pat.contains('*') {
        return if abs.exists() { vec![abs] } else { Vec::new() };
    }
    let parent = abs.parent().map(Path::to_path_buf).unwrap_or_else(|| project_dir.to_path_buf());
    let parts: Vec<&str> = file_pat.split('*').collect();
    let mut out: Vec<PathBuf> = std::fs::read_dir(&parent)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_str().is_some_and(|n| wildcard_match(&parts, n)))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// `parts` = pattern split on `*`.
fn wildcard_match(parts: &[&str], name: &str) -> bool {
    let (first, rest) = parts.split_first().expect("split yields at least one part");
    let Some(mut s) = name.strip_prefix(first) else { return false };
    let Some((last, middle)) = rest.split_last() else { return s.is_empty() };
    for m in middle {
        match s.find(m) {
            Some(i) => s = &s[i + m.len()..],
            None => return false,
        }
    }
    s.len() >= last.len() && s.ends_with(last)
}

// ------------------------------------------------------------ crash safety

const BAK_SUFFIX: &str = ".ship-bak";

fn backup_path(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_os_string();
    s.push(BAK_SUFFIX);
    PathBuf::from(s)
}

/// Restore one backup over its live file and remove it.
fn restore_backup(bak: &Path) -> bool {
    let Some(live) = bak.to_str().and_then(|s| s.strip_suffix(BAK_SUFFIX)).map(PathBuf::from) else {
        return false;
    };
    match std::fs::read(bak) {
        Ok(bytes) => {
            if crate::store::atomic_write(&live, &bytes).is_ok() {
                let _ = std::fs::remove_file(bak);
                return true;
            }
            false
        }
        Err(_) => false,
    }
}

pub(crate) fn restore_backups(baks: &[PathBuf]) {
    for b in baks {
        restore_backup(b);
    }
}

/// Restore every `*.ship-bak` left by a crashed run (skips `target/`,
/// `node_modules/`, `.git/` and the QuadFlow folders). Returns the restored files.
pub fn restore_orphan_backups(project_dir: &Path) -> Vec<PathBuf> {
    let mut restored = Vec::new();
    walk_backups(project_dir, 0, &mut |bak| {
        if restore_backup(bak) {
            restored.push(PathBuf::from(bak.to_string_lossy().trim_end_matches(BAK_SUFFIX)));
        }
    });
    restored
}

fn walk_backups(dir: &Path, depth: u32, cb: &mut dyn FnMut(&Path)) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if matches!(name.as_str(), "target" | "node_modules" | ".git" | ".quadflow" | ".quadflow-dev" | "dist" | "release") {
                continue;
            }
            walk_backups(&path, depth + 1, cb);
        } else if name.ends_with(BAK_SUFFIX) {
            cb(&path);
        }
    }
}

// ------------------------------------------------------------ executor

pub(crate) struct Exec<'a> {
    pub config: &'a ShipConfig,
    pub opts: &'a ShipRunOptions,
    pub sink: &'a dyn ShipSink,
    pub cancel: &'a ShipCancel,
}

impl Exec<'_> {
    fn emit(&self, ctx: &ShipContext, phase: &str, stream: ShipLineStream, line: &str) {
        self.sink.line(ShipLineEvent {
            run_id: ctx.run_id.to_string(),
            phase: phase.to_string(),
            stream,
            line: line.to_string(),
            ts: now_ms(),
        });
    }

    fn meta(&self, ctx: &ShipContext, phase: &str, line: &str) {
        self.emit(ctx, phase, ShipLineStream::Meta, line);
    }

    /// Run a command line; output streams to the sink and is kept on `pr`.
    fn shell(&self, pr: &mut ShipPhaseResult, ctx: &ShipContext, line: &str, cwd: &Path, env: &BTreeMap<String, String>) -> bool {
        self.meta(ctx, &pr.name, &format!("$ {line}"));
        let run_id = ctx.run_id.to_string();
        let phase = pr.name.clone();
        let on_line = |is_err: bool, l: &str| {
            self.sink.line(ShipLineEvent {
                run_id: run_id.clone(),
                phase: phase.clone(),
                stream: if is_err { ShipLineStream::Stderr } else { ShipLineStream::Stdout },
                line: l.to_string(),
                ts: now_ms(),
            })
        };
        let r = sys::run_streaming(line, cwd, env, self.cancel, &on_line);
        pr.exit_code = r.exit_code;
        append(&mut pr.stdout, &r.stdout);
        append(&mut pr.stderr, &r.stderr);
        if r.success {
            pr.status = ShipPhaseStatus::Passed;
        } else {
            pr.status = ShipPhaseStatus::Failed;
            pr.error = Some(if r.cancelled {
                "aborted".to_string()
            } else {
                let tail: Vec<&str> = r.stderr.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect();
                let code = r.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                if tail.is_empty() { format!("exit {code}") } else { format!("exit {code}: {}", tail.join(" | ")) }
            });
        }
        r.success
    }

    /// `build` / `shell` with `externalTerminal`: ask the host, else run embedded.
    fn command_phase(&self, pr: &mut ShipPhaseResult, ctx: &ShipContext, line: &str, cwd: &Path, env: &BTreeMap<String, String>, external: bool) {
        if external && !env.is_empty() {
            self.meta(ctx, &pr.name, "phase has env vars a terminal tile cannot receive; running embedded");
        } else if external {
            let req = ShipExternalRequest {
                request_id: new_id().to_string(),
                run_id: ctx.run_id.clone(),
                phase: pr.name.clone(),
                command: line.to_string(),
                cwd: cwd.display().to_string(),
            };
            match self.sink.external(req, self.cancel) {
                ShipExternalOutcome::Done(r) => {
                    pr.exit_code = r.exit_code;
                    pr.detail = Some(match &r.terminal_id {
                        Some(t) => format!("ran in terminal {t}"),
                        None => "ran in a host terminal".into(),
                    });
                    if r.success {
                        pr.status = ShipPhaseStatus::Passed;
                    } else {
                        pr.status = ShipPhaseStatus::Failed;
                        pr.error = Some(r.error.unwrap_or_else(|| format!("exited with code {:?}", r.exit_code)));
                    }
                    return;
                }
                ShipExternalOutcome::Unavailable => {
                    self.meta(ctx, &pr.name, "no host terminal available; running embedded");
                }
            }
        }
        self.shell(pr, ctx, line, cwd, env);
    }

    pub fn execute(&self, phase: &ShipPhase, ctx: &mut ShipContext) -> ShipPhaseResult {
        let mut pr = ShipPhaseResult::pending(phase);
        pr.status = ShipPhaseStatus::Running;
        let started = now_ms();
        pr.started_at = Some(started);
        if self.cancel.is_cancelled() {
            pr.status = ShipPhaseStatus::Skipped;
            pr.detail = Some("run aborted".into());
        } else {
            self.run_phase(phase, ctx, &mut pr);
        }
        if pr.status == ShipPhaseStatus::Running {
            pr.status = ShipPhaseStatus::Passed;
        }
        let done = now_ms();
        pr.completed_at = Some(done);
        pr.duration_ms = Some(done - started);
        pr
    }

    fn run_phase(&self, phase: &ShipPhase, ctx: &mut ShipContext, pr: &mut ShipPhaseResult) {
        let dry = self.opts.dry_run;
        macro_rules! fail {
            ($($arg:tt)*) => {{
                pr.status = ShipPhaseStatus::Failed;
                pr.error = Some(format!($($arg)*));
                return;
            }};
        }
        macro_rules! skip {
            ($($arg:tt)*) => {{
                pr.status = ShipPhaseStatus::Skipped;
                pr.detail = Some(format!($($arg)*));
                return;
            }};
        }
        match phase {
            ShipPhase::Checks { checks: ids, .. } => {
                let mut failures = Vec::new();
                for id in ids {
                    let r = checks::evaluate(&ctx.project_dir, id, self.config, true);
                    let mark = match r.level {
                        ShipCheckLevel::Pass => "pass",
                        ShipCheckLevel::Warn => "warn",
                        ShipCheckLevel::Fail => "FAIL",
                    };
                    self.meta(ctx, &pr.name, &format!("[{mark}] {}{}", r.label, r.hint.as_deref().map(|h| format!(" — {h}")).unwrap_or_default()));
                    if r.level == ShipCheckLevel::Fail {
                        failures.push(format!("{id}: {}", r.hint.unwrap_or_else(|| "failed".into())));
                    }
                }
                pr.detail = Some(format!("{} check(s)", ids.len()));
                if !failures.is_empty() {
                    fail!("{}", failures.join("; "));
                }
            }

            ShipPhase::EnsureStagingDir { path, clean, .. } => {
                let abs = ctx.abs(&ctx.subst(path));
                pr.detail = Some(abs.display().to_string());
                if !dry {
                    if *clean && abs.exists() {
                        if let Err(e) = std::fs::remove_dir_all(&abs) {
                            fail!("clean {}: {e}", abs.display());
                        }
                    }
                    if let Err(e) = std::fs::create_dir_all(&abs) {
                        fail!("create {}: {e}", abs.display());
                    }
                }
                ctx.staging_dir = Some(abs);
            }

            ShipPhase::LoadEnvFromFile { var, file, required, .. } => {
                let abs = ctx.abs(&ctx.subst(file));
                pr.detail = Some(format!("{var} ← {}", abs.display()));
                if !abs.exists() {
                    if *required {
                        fail!("required file not found: {}", abs.display());
                    }
                    skip!("optional file missing: {}", abs.display());
                }
                if dry {
                    return;
                }
                match std::fs::read_to_string(&abs) {
                    Ok(s) => {
                        ctx.env.insert(var.clone(), s.trim().to_string());
                    }
                    Err(e) => fail!("read {}: {e}", abs.display()),
                }
            }

            ShipPhase::PatchTauriConf { path, before_bundle_command, windows_sign_command, webview_install_mode, .. } => {
                let abs = ctx.abs(path.as_deref().unwrap_or("src-tauri/tauri.conf.json"));
                if !abs.exists() {
                    fail!("{} not found", abs.display());
                }
                let mut changes = Vec::new();
                if let Some(c) = before_bundle_command {
                    changes.push(format!("build.beforeBundleCommand = {}", ctx.subst(c)));
                }
                if let Some(c) = windows_sign_command {
                    changes.push(format!("bundle.windows.signCommand = {}", ctx.subst(c)));
                }
                if let Some(m) = webview_install_mode {
                    changes.push(format!("bundle.windows.webviewInstallMode = {m}"));
                }
                pr.detail = Some(format!("{}: {}", abs.display(), changes.join("; ")));
                if dry {
                    return;
                }
                let original = match std::fs::read_to_string(&abs) {
                    Ok(s) => s,
                    Err(e) => fail!("read {}: {e}", abs.display()),
                };
                let mut v: serde_json::Value = match serde_json::from_str(&original) {
                    Ok(v) => v,
                    Err(e) => fail!("parse {}: {e}", abs.display()),
                };
                let bak = backup_path(&abs);
                if let Err(e) = crate::store::atomic_write(&bak, original.as_bytes()) {
                    fail!("write backup: {}", e.message);
                }
                ctx.backups.push(bak);
                let Some(root) = v.as_object_mut() else { fail!("{} is not a JSON object", abs.display()) };
                if let Some(c) = before_bundle_command {
                    obj(root, "build").insert("beforeBundleCommand".into(), ctx.subst(c).into());
                }
                if let Some(c) = windows_sign_command {
                    let cmd = ctx.subst(c).replace("{file}", "%1");
                    obj(obj(root, "bundle"), "windows").insert("signCommand".into(), cmd.into());
                }
                if let Some(m) = webview_install_mode {
                    obj(obj(root, "bundle"), "windows").insert("webviewInstallMode".into(), serde_json::json!({ "type": m }));
                }
                let mut out = serde_json::to_string_pretty(&v).unwrap_or_default();
                out.push('\n');
                if let Err(e) = crate::store::atomic_write(&abs, out.as_bytes()) {
                    fail!("write {}: {}", abs.display(), e.message);
                }
            }

            ShipPhase::RestoreTauriConf { path, .. } => {
                let abs = ctx.abs(path.as_deref().unwrap_or("src-tauri/tauri.conf.json"));
                let bak = backup_path(&abs);
                if !bak.exists() {
                    skip!("no {}", bak.display());
                }
                pr.detail = Some(format!("{} ← {}", abs.display(), bak.display()));
                if dry {
                    return;
                }
                if !restore_backup(&bak) {
                    fail!("could not restore {}", abs.display());
                }
                ctx.backups.retain(|b| b != &bak);
            }

            ShipPhase::VersionBump { .. } => {
                let Some(bump) = self.opts.mode.bump() else {
                    skip!("deploy mode: keeping version {}", ctx.version);
                };
                pr.detail = Some(format!("{} → {}", ctx.previous_version.as_deref().unwrap_or("?"), ctx.version));
                if dry {
                    return;
                }
                if let Err(e) = versions::bump_all(&ctx.project_dir, self.config, bump, false) {
                    fail!("{}", e.message);
                }
            }

            ShipPhase::Build { command, working_directory, external_terminal, .. } => {
                if self.opts.skip_build || self.opts.reuse_build {
                    skip!("{}", if self.opts.reuse_build { "--reuse-build" } else { "--skip-build" });
                }
                let line = ctx.subst(command);
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                let cwd = working_directory.as_deref().map(|w| ctx.abs(&ctx.subst(w))).unwrap_or_else(|| ctx.project_dir.clone());
                let env = ctx.env.clone();
                self.command_phase(pr, ctx, &line, &cwd, &env, *external_terminal);
            }

            ShipPhase::VerifyAuthenticode { file, .. } => {
                let pattern = ctx.subst(file);
                let target = glob(&ctx.project_dir, &pattern).into_iter().next();
                pr.detail = Some(target.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| pattern.clone()));
                if dry {
                    return;
                }
                let Some(target) = target else { fail!("no file matched `{pattern}`") };
                if !cfg!(windows) {
                    skip!("verify_authenticode is Windows-only");
                }
                let ps = format!(
                    "$s = Get-AuthenticodeSignature -LiteralPath '{}'; if ($s.Status -ne 'Valid') {{ Write-Error \"signature status: $($s.Status) $($s.StatusMessage)\"; exit 1 }} else {{ Write-Output \"Valid: $($s.SignerCertificate.Subject)\" }}",
                    target.display().to_string().replace('\'', "''")
                );
                let line = format!("powershell -NoProfile -NonInteractive -Command \"{}\"", ps.replace('"', "\\\""));
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::SignAuthenticode { files, tool, .. } => {
                let Some(tool) = tool.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
                    fail!("sign_authenticode needs a `tool` (e.g. `signtool sign /fd sha256 /a {{file}}`)");
                };
                let mut targets = Vec::new();
                for f in files {
                    let pat = ctx.subst(f);
                    let m = glob(&ctx.project_dir, &pat);
                    if m.is_empty() && !dry {
                        fail!("no file matched `{pat}`");
                    }
                    targets.extend(m);
                }
                pr.detail = Some(format!("{} file(s)", targets.len()));
                if dry {
                    return;
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                for t in &targets {
                    let quoted = format!("\"{}\"", t.display());
                    let tool = ctx.subst(tool);
                    let line = if tool.contains("{file}") { tool.replace("{file}", &quoted) } else { format!("{tool} {quoted}") };
                    if !self.shell(pr, ctx, &line, &cwd, &env) {
                        return;
                    }
                    pr.artifacts.push(t.display().to_string());
                }
            }

            ShipPhase::StageArtifact { source_glob, dest_name, .. } => {
                let Some(staging) = ctx.staging_dir.clone() else {
                    fail!("no staging dir (add an ensure_staging_dir phase first)");
                };
                let pat = ctx.subst(source_glob);
                let dest = staging.join(ctx.subst(dest_name));
                let src = glob(&ctx.project_dir, &pat).into_iter().next();
                pr.detail = Some(format!("{} → {}", src.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| pat.clone()), dest.display()));
                if dry {
                    return;
                }
                let Some(src) = src else { fail!("no artifact matched `{pat}`") };
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::copy(&src, &dest) {
                    fail!("copy {} → {}: {e}", src.display(), dest.display());
                }
                pr.artifacts.push(dest.display().to_string());
                ctx.artifacts.push(dest);
            }

            ShipPhase::ReadUpdaterSig { source_glob, store_as, .. } => {
                let pat = ctx.subst(source_glob);
                if dry {
                    ctx.vars.entry(store_as.clone()).or_insert_with(|| "<signature>".into());
                    pr.detail = Some(format!("{{{store_as}}} ← {pat}"));
                    return;
                }
                let Some(sig) = glob(&ctx.project_dir, &pat).into_iter().next() else {
                    fail!("no .sig matched `{pat}` (was TAURI_SIGNING_PRIVATE_KEY set for the build?)");
                };
                let content = match std::fs::read_to_string(&sig) {
                    Ok(s) => s.trim().to_string(),
                    Err(e) => fail!("read {}: {e}", sig.display()),
                };
                if content.is_empty() {
                    fail!("{} is empty", sig.display());
                }
                pr.detail = Some(format!("{{{store_as}}} ← {} ({} chars)", sig.display(), content.len()));
                ctx.vars.insert(store_as.clone(), content);
            }

            ShipPhase::BuildLatestJson { repo, platform, bundle_name, tag, sig_var, dest, notes, .. } => {
                let Some(signature) = ctx.vars.get(sig_var).cloned() else {
                    fail!("no `{{{sig_var}}}` var (add a read_updater_sig phase first)");
                };
                let tag = ctx.subst(tag);
                let bundle = ctx.subst(bundle_name);
                let dest_abs = ctx.abs(&ctx.subst(dest));
                pr.detail = Some(dest_abs.display().to_string());
                if dry {
                    return;
                }
                let mut platforms = serde_json::Map::new();
                // Keep the other platforms already published on this release.
                if let Some(v) = fetch_existing_latest_json(&ctx.project_dir, repo, &tag) {
                    self.meta(ctx, &pr.name, &format!("merging the other platforms from {repo} {tag} latest.json"));
                    if let Some(p) = v.get("platforms").and_then(|p| p.as_object()) {
                        for (k, v) in p {
                            if k != platform {
                                platforms.insert(k.clone(), v.clone());
                            }
                        }
                    }
                }
                platforms.insert(
                    platform.clone(),
                    serde_json::json!({
                        "signature": signature,
                        "url": format!("https://github.com/{repo}/releases/download/{tag}/{bundle}"),
                    }),
                );
                let manifest = serde_json::json!({
                    "version": ctx.version,
                    "notes": ctx.subst(notes),
                    "pub_date": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                    "platforms": platforms,
                });
                let mut out = serde_json::to_string_pretty(&manifest).unwrap_or_default();
                out.push('\n');
                if let Err(e) = crate::store::atomic_write(&dest_abs, out.as_bytes()) {
                    fail!("write {}: {}", dest_abs.display(), e.message);
                }
                pr.artifacts.push(dest_abs.display().to_string());
                ctx.artifacts.push(dest_abs);
            }

            ShipPhase::GhRelease { repo, tag, title, notes, notes_file, draft, files, .. } => {
                let tag = ctx.subst(tag);
                let (title, notes) = (ctx.subst(title), ctx.subst(notes));
                let notes_file = notes_file.as_deref().map(|f| ctx.abs(&ctx.subst(f)));
                if let Some(f) = &notes_file {
                    if !dry && !f.is_file() {
                        fail!("notes file not found: {}", f.display());
                    }
                }
                let draft = *draft || self.opts.draft;
                let mut uploads = Vec::new();
                for f in files {
                    let pat = ctx.subst(f);
                    let m = glob(&ctx.project_dir, &pat);
                    if m.is_empty() && !dry {
                        fail!("no file matched `{pat}`");
                    }
                    uploads.extend(m);
                }
                let url = format!("https://github.com/{repo}/releases/tag/{tag}");
                pr.detail = Some(format!("{repo} {tag}{} · {} file(s)", if draft { " (draft)" } else { "" }, uploads.len()));
                if dry {
                    return;
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                let exists = sys::run_line(&cwd, &format!("gh release view {tag} --repo {repo}")).map(|o| o.status.success()).unwrap_or(false);
                if !exists {
                    let notes_arg = match &notes_file {
                        Some(f) => format!("--notes-file {}", quote_arg(&f.display().to_string())),
                        None => format!("--notes {}", quote_arg(&notes)),
                    };
                    let line = format!(
                        "gh release create {tag} --repo {repo} --title {} {notes_arg}{}",
                        quote_arg(&title),
                        if draft { " --draft" } else { "" }
                    );
                    if !self.shell(pr, ctx, &line, &cwd, &env) {
                        return;
                    }
                }
                for f in &uploads {
                    let line = format!("gh release upload {tag} \"{}\" --repo {repo} --clobber", f.display());
                    if !self.shell(pr, ctx, &line, &cwd, &env) {
                        return;
                    }
                    pr.artifacts.push(f.display().to_string());
                }
                pr.url = Some(url);
            }

            ShipPhase::CodesignMacos { app_bundle, identity, entitlements, .. } => {
                let bundle = ctx.subst(app_bundle);
                let target = glob(&ctx.project_dir, &bundle).into_iter().next().map(|p| p.display().to_string()).unwrap_or(bundle);
                let mut line = format!("codesign --force --deep --options runtime --sign {}", quote_arg(identity));
                if let Some(ent) = entitlements {
                    line.push_str(&format!(" --entitlements {}", quote_arg(&ctx.subst(ent))));
                }
                line.push_str(&format!(" {}", quote_arg(&target)));
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                if !cfg!(target_os = "macos") {
                    skip!("codesign_macos is macOS-only");
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::Notarize { artifact, keychain_profile, .. } => {
                let line = format!(
                    "xcrun notarytool submit {} --keychain-profile {} --wait",
                    quote_arg(&ctx.subst(artifact)),
                    quote_arg(keychain_profile)
                );
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                if !cfg!(target_os = "macos") {
                    skip!("notarize is macOS-only");
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::StapleNotarization { artifact, .. } => {
                let line = format!("xcrun stapler staple {}", quote_arg(&ctx.subst(artifact)));
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                if !cfg!(target_os = "macos") {
                    skip!("staple_notarization is macOS-only");
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::CreateDmg { app_bundle, dest, volume_name, .. } => {
                let bundle = ctx.subst(app_bundle);
                let bundle = glob(&ctx.project_dir, &bundle).into_iter().next().map(|p| p.display().to_string()).unwrap_or(bundle);
                let dest = ctx.subst(dest);
                let vol = volume_name.as_deref().map(|v| ctx.subst(v)).unwrap_or_else(|| ctx.product_name.clone());
                let line = if sys::tool_available("create-dmg") {
                    format!("create-dmg --volname {} {} {}", quote_arg(&vol), quote_arg(&dest), quote_arg(&bundle))
                } else {
                    format!("hdiutil create -volname {} -srcfolder {} -ov -format UDZO {}", quote_arg(&vol), quote_arg(&bundle), quote_arg(&dest))
                };
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                if !cfg!(target_os = "macos") {
                    skip!("create_dmg is macOS-only");
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                if self.shell(pr, ctx, &line, &cwd, &env) {
                    pr.artifacts.push(dest.clone());
                    ctx.artifacts.push(PathBuf::from(dest));
                }
            }

            ShipPhase::Shell { command, skippable, skip_flag, working_directory, env, external_terminal, .. } => {
                if *skippable && skip_flag.as_deref() == Some("skip-build") && self.opts.skip_build {
                    skip!("--skip-build");
                }
                let line = ctx.subst(command);
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                let cwd = working_directory.as_deref().map(|w| ctx.abs(&ctx.subst(w))).unwrap_or_else(|| ctx.project_dir.clone());
                let mut effective = ctx.env.clone();
                for (k, v) in env {
                    effective.insert(k.clone(), ctx.subst(v));
                }
                self.command_phase(pr, ctx, &line, &cwd, &effective, *external_terminal);
            }

            ShipPhase::GitCommit { message, paths, sign, .. } => {
                let add = if paths.is_empty() {
                    "git add -A".to_string()
                } else {
                    format!("git add {}", paths.iter().map(|p| quote_arg(&ctx.subst(p))).collect::<Vec<_>>().join(" "))
                };
                let commit = format!("git commit{} -m {}", if *sign { " -S" } else { "" }, quote_arg(&ctx.subst(message)));
                let line = format!("{add} && {commit}");
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                if !self.shell(pr, ctx, &line, &cwd, &env) {
                    let out = format!("{}{}", pr.stdout.as_deref().unwrap_or(""), pr.stderr.as_deref().unwrap_or("")).to_lowercase();
                    if out.contains("nothing to commit") || out.contains("nothing added to commit") {
                        pr.error = None;
                        skip!("nothing to commit");
                    }
                }
            }

            ShipPhase::GitTag { tag, message, sign, if_exists, .. } => {
                let mut tag = ctx.subst(tag);
                if !dry && sys::git_tag_exists(&ctx.project_dir, &tag) {
                    match if_exists {
                        ShipTagConflict::Skip => skip!("tag {tag} already exists"),
                        ShipTagConflict::Fail => fail!("tag {tag} already exists"),
                        ShipTagConflict::Replace => {
                            let _ = sys::run_line(&ctx.project_dir, &format!("git tag -d {tag}"));
                        }
                        ShipTagConflict::Suffix => {
                            let base = tag.clone();
                            let mut n = 2;
                            while sys::git_tag_exists(&ctx.project_dir, &format!("{base}-r{n}")) && n < 10_000 {
                                n += 1;
                            }
                            tag = format!("{base}-r{n}");
                        }
                    }
                }
                let msg = message.as_deref().map(|m| ctx.subst(m)).unwrap_or_else(|| tag.clone());
                let line = format!("git tag {} {tag} -m {}", if *sign { "-s" } else { "-a" }, quote_arg(&msg));
                pr.command = Some(line.clone());
                pr.detail = Some(tag);
                if dry {
                    return;
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::GitPush { remote, tag_strategy, .. } => {
                let flags = match tag_strategy {
                    ShipTagPush::None => "",
                    ShipTagPush::Tags => " --tags",
                    ShipTagPush::Follow => " --follow-tags",
                };
                let line = format!("git push{flags} {remote}");
                pr.command = Some(line.clone());
                if dry {
                    return;
                }
                let (cwd, env) = (ctx.project_dir.clone(), ctx.env.clone());
                self.shell(pr, ctx, &line, &cwd, &env);
            }

            ShipPhase::WriteFile { path, content, overwrite, .. } => {
                let abs = ctx.abs(&ctx.subst(path));
                pr.detail = Some(abs.display().to_string());
                if dry {
                    return;
                }
                if abs.exists() && !overwrite {
                    skip!("{} exists (overwrite: false)", abs.display());
                }
                if let Err(e) = crate::store::atomic_write(&abs, ctx.subst(content).as_bytes()) {
                    fail!("write {}: {}", abs.display(), e.message);
                }
                pr.artifacts.push(abs.display().to_string());
            }

            ShipPhase::Sequence { children, .. } => {
                for child in children {
                    let r = self.execute(child, ctx);
                    let failed = r.status == ShipPhaseStatus::Failed;
                    if failed {
                        pr.error = Some(format!("`{}` failed: {}", r.name, r.error.clone().unwrap_or_default()));
                    }
                    pr.artifacts.extend(r.artifacts.iter().cloned());
                    pr.children.push(r);
                    if failed {
                        pr.status = ShipPhaseStatus::Failed;
                        return;
                    }
                }
                pr.detail = Some(format!("{} step(s)", children.len()));
            }

            ShipPhase::Parallel { children, .. } => {
                // Dry runs resolve children in order (the plan is what matters).
                let results: Vec<(ShipPhaseResult, ShipContext)> = if dry {
                    children.iter().map(|c| { let mut cc = ctx.clone(); (self.execute(c, &mut cc), cc) }).collect()
                } else {
                    std::thread::scope(|scope| {
                        let handles: Vec<_> = children
                            .iter()
                            .map(|c| {
                                let mut cc = ctx.clone();
                                scope.spawn(move || (self.execute(c, &mut cc), cc))
                            })
                            .collect();
                        handles.into_iter().filter_map(|h| h.join().ok()).collect()
                    })
                };
                let mut failed = Vec::new();
                for (r, cc) in results {
                    for a in cc.artifacts {
                        if !ctx.artifacts.contains(&a) {
                            ctx.artifacts.push(a);
                        }
                    }
                    for (k, v) in cc.vars {
                        ctx.vars.entry(k).or_insert(v);
                    }
                    for (k, v) in cc.env {
                        ctx.env.entry(k).or_insert(v);
                    }
                    for b in cc.backups {
                        if !ctx.backups.contains(&b) {
                            ctx.backups.push(b);
                        }
                    }
                    if r.status == ShipPhaseStatus::Failed {
                        failed.push(r.name.clone());
                    }
                    pr.artifacts.extend(r.artifacts.iter().cloned());
                    pr.children.push(r);
                }
                pr.detail = Some(format!("{} parallel step(s)", children.len()));
                if !failed.is_empty() {
                    fail!("failed: {}", failed.join(", "));
                }
            }
        }
    }
}

fn obj<'m>(m: &'m mut serde_json::Map<String, serde_json::Value>, key: &str) -> &'m mut serde_json::Map<String, serde_json::Value> {
    let entry = m.entry(key.to_string()).or_insert_with(|| serde_json::json!({}));
    if !entry.is_object() {
        *entry = serde_json::json!({});
    }
    entry.as_object_mut().expect("just made it an object")
}

fn append(slot: &mut Option<String>, s: &str) {
    if s.is_empty() {
        return;
    }
    slot.get_or_insert_with(String::new).push_str(s);
}

/// Double-quote one shell argument (cmd and sh both accept `"…"`).
fn quote_arg(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

/// The `latest.json` already attached to `repo`'s release `tag`, if any. Asks
/// `gh` first — that also sees draft releases and private repos, where the
/// public download URL 404s — then falls back to the public URL.
fn fetch_existing_latest_json(cwd: &Path, repo: &str, tag: &str) -> Option<serde_json::Value> {
    if sys::tool_available("gh") {
        let line = format!("gh release download {tag} --repo {repo} --pattern latest.json --output -");
        if let Ok(o) = sys::run_line(cwd, &line) {
            if o.status.success() {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                    return Some(v);
                }
            }
        }
    }
    fetch_json(&format!("https://github.com/{repo}/releases/download/{tag}/latest.json"))
}

fn fetch_json(url: &str) -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build().ok()?;
    let resp = client.get(url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    serde_json::from_str(&resp.text().ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ShipContext {
        ShipContext::new(PathBuf::from("/p"), new_id(), "Acme".into(), "1.2.3".into(), Some("1.2.2".into()))
    }

    #[test]
    fn substitutes_tokens() {
        let mut c = ctx();
        c.staging_dir = Some(PathBuf::from("/p/release/v1.2.3"));
        c.vars.insert("signature".into(), "SIG".into());
        let out = substitute("{productName} v{version} from {prev_version} sig={signature} dir={staging_dir}", &c);
        assert_eq!(out, "Acme v1.2.3 from 1.2.2 sig=SIG dir=/p/release/v1.2.3");
    }

    #[test]
    fn wildcard() {
        let parts = |p: &'static str| p.split('*').collect::<Vec<_>>();
        assert!(wildcard_match(&parts("*1.0.0*.exe"), "app_1.0.0_x64-setup.exe"));
        assert!(!wildcard_match(&parts("*1.0.0*.exe"), "app_1.0.0.nsis.zip"));
        assert!(wildcard_match(&parts("*.nsis.zip"), "a.nsis.zip"));
        assert!(!wildcard_match(&parts("*.nsis.zip"), "a.nsis.zip.sig"));
        assert!(wildcard_match(&parts("a*"), "a"));
    }

    #[test]
    fn glob_finds_matches() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("src-tauri/target/dist")).unwrap();
        std::fs::write(t.path().join("src-tauri/target/dist/app-1.0.0.exe"), "").unwrap();
        std::fs::write(t.path().join("src-tauri/target/dist/notes.txt"), "").unwrap();
        assert_eq!(glob(t.path(), "src-tauri/target/dist/*.exe").len(), 1);
        assert_eq!(glob(t.path(), "**target/dist/*1.0.0*").len(), 1);
    }

    #[test]
    fn restores_orphan_backups() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("tauri.conf.json"), "patched").unwrap();
        std::fs::write(t.path().join("tauri.conf.json.ship-bak"), "original").unwrap();
        let restored = restore_orphan_backups(t.path());
        assert_eq!(restored.len(), 1);
        assert_eq!(std::fs::read_to_string(t.path().join("tauri.conf.json")).unwrap(), "original");
        assert!(!t.path().join("tauri.conf.json.ship-bak").exists());
    }

    #[test]
    fn external_complete_unknown_is_not_found() {
        let r = ShipExternalResult { success: true, exit_code: Some(0), terminal_id: None, error: None };
        assert_eq!(external_complete("nope", r).unwrap_err().code, crate::ErrorCode::NotFound);
    }
}
