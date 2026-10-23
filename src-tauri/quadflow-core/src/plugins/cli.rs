//! Plugin CLI commands (plugin-system.md §9.1, §9.2): `quadflow <name> …` for a
//! name no core command takes is dispatched to the active plugin that declares
//! `contributes.cliCommands[].name == name`.
//!
//! - `exec` handler (trusted plugins only): the plugin's binary for this target
//!   runs with the remaining argv (no shell), stdin inherited, stdout/stderr
//!   forwarded to the CLI's output as they arrive.
//! - `sidecar` handler: a private sidecar instance in CLI mode
//!   (`QUADFLOW_SIDECAR_MODE=cli`) gets `cli/run`; its `cli/output`
//!   notifications are printed, its `host/call` requests are served by this
//!   process through the same permission-checked dispatch table as the GUI
//!   (`plugins::host::dispatch`) with the plugin's granted permissions.
//!   Terminal / agent / native / UI methods are `unsupported` here.
//!
//! Both get `QUADFLOW_CLI`, `QUADFLOW_PROJECT_DIR`, `QUADFLOW_PLUGIN_ID/DIR/DATA`
//! and `QUADFLOW_JSON`; the global `--json` / `--project` flags are consumed here
//! (wherever they appear before a `--`) and re-exported through that env. The
//! exit code is the handler's.

use super::host::{self, HostCall, HostEnv};
use super::manifest::{check_file_in_root, CliHandler, SidecarRestart};
use super::registry::{Isolation, LoadOptions, LoadedPlugin, PluginRegistry};
use super::sidecar::{self, ResolveContext, SidecarConfig, SidecarHost, SidecarSupervisor, SupervisorOptions};
use super::{current_target, RESERVED_CLI_NAMES};
use crate::cli::output::{Out, EXIT_USAGE};
use crate::cli::Ctx;
use crate::domains::app::secrets::Secrets;
use crate::error::{CoreError, ErrorCode, Result};
use crate::events::EventBus;
use crate::paths::AppPaths;
use crate::store::AppDb;
use crate::Core;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::Duration;

/// Env var names exported to handlers (§9.1).
pub const ENV_CLI: &str = "QUADFLOW_CLI";
pub const ENV_JSON: &str = "QUADFLOW_JSON";
pub const ENV_SIDECAR_MODE: &str = "QUADFLOW_SIDECAR_MODE";

/// How long a CLI-mode sidecar may take for one `cli/run` (effectively unbounded:
/// the user interrupts a hanging command with Ctrl+C).
const CLI_RUN_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 3600);

/// One plugin CLI command, as listed by `quadflow --help` / `quadflow docs --list`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCliCommandInfo {
    pub name: String,
    pub summary: String,
    pub plugin_id: String,
    /// `"exec"` or `"sidecar"`.
    pub handler: String,
}

fn handler_kind(h: &CliHandler) -> &'static str {
    match h {
        CliHandler::Sidecar => "sidecar",
        CliHandler::Exec { .. } => "exec",
    }
}

/// CLI commands of active plugins, sorted by name.
pub fn commands(reg: &PluginRegistry) -> Vec<PluginCliCommandInfo> {
    let mut v: Vec<PluginCliCommandInfo> = reg
        .contributions()
        .cli_commands
        .into_iter()
        .map(|c| PluginCliCommandInfo {
            name: c.contribution.name.clone(),
            summary: c.contribution.summary.clone(),
            handler: handler_kind(&c.contribution.handler).into(),
            plugin_id: c.plugin_id,
        })
        .filter(|c| !RESERVED_CLI_NAMES.contains(&c.name.as_str()))
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// The plugin registry for this CLI invocation (`QUADFLOW_DATA_DIR`,
/// `QUADFLOW_RESOURCE_DIR` from the injected env).
pub fn load_registry(ctx: &Ctx) -> Result<(AppPaths, Arc<AppDb>, PluginRegistry)> {
    let paths = ctx.app_paths()?;
    let db = Arc::new(AppDb::open(&paths, EventBus::new())?);
    let reg = PluginRegistry::load_with(&paths, &db, &LoadOptions::from_env(|k| ctx.env.var(k).map(str::to_string)))?;
    Ok((paths, db, reg))
}

/// Plugin commands for help output; empty when the registry cannot be loaded.
pub fn commands_best_effort(ctx: &Ctx) -> Vec<PluginCliCommandInfo> {
    load_registry(ctx).map(|(_, _, reg)| commands(&reg)).unwrap_or_default()
}

/// Split the global flags out of an external subcommand's argv: `--json`,
/// `--project <p>` / `--project=<p>` before a `--` are consumed by core.
pub fn split_global_flags(args: &[String]) -> (Vec<String>, bool, Option<PathBuf>) {
    let mut rest = Vec::new();
    let mut json = false;
    let mut project = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            rest.push(a.clone());
            rest.extend(it.by_ref().cloned());
            break;
        }
        if a == "--json" {
            json = true;
        } else if a == "--project" {
            match it.next() {
                Some(p) => project = Some(PathBuf::from(p)),
                None => rest.push(a.clone()),
            }
        } else if let Some(p) = a.strip_prefix("--project=") {
            project = Some(PathBuf::from(p));
        } else {
            rest.push(a.clone());
        }
    }
    (rest, json, project)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push((prev[j] + usize::from(ca != *cb)).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// The closest known command name (core or plugin), if any is close.
fn suggest<'a>(name: &str, known: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    known
        .map(|k| (levenshtein(name, k), k))
        .filter(|(d, k)| *d <= 2 || (name.len() >= 3 && k.starts_with(name)))
        .min_by_key(|(d, _)| *d)
        .map(|(_, k)| k)
}

fn unrecognized(out: &mut Out, name: &str, cmds: &[PluginCliCommandInfo], inactive_owner: Option<&LoadedPlugin>) -> i32 {
    let known = RESERVED_CLI_NAMES.iter().copied().filter(|n| !matches!(*n, "help" | "version" | "gui"));
    let suggestion = suggest(name, known.chain(cmds.iter().map(|c| c.name.as_str())));
    let mut msg = format!("unrecognized subcommand '{name}'");
    if let Some(p) = inactive_owner {
        msg = format!("'{name}' is provided by plugin {:?}, which is not active ({})", p.id, p.status.label());
    }
    if out.json {
        let mut details = json!({ "pluginCommands": cmds });
        if let Some(s) = suggestion {
            details["suggestion"] = json!(s);
        }
        if let Some(p) = inactive_owner {
            details["hint"] = json!(format!("enable it with `quadflow plugins enable {}`", p.id));
        }
        return out.err(&CoreError::invalid_input(msg).with_details(details));
    }
    let w = &mut out.io.stderr;
    let _ = writeln!(w, "error: {msg}");
    if let Some(s) = suggestion {
        let _ = writeln!(w, "\n  tip: a similar subcommand exists: '{s}'");
    }
    if let Some(p) = inactive_owner {
        let _ = writeln!(w, "\n  hint: enable it with `quadflow plugins enable {}`", p.id);
    }
    if cmds.is_empty() {
        let _ = writeln!(w, "\nNo plugin commands are available.");
    } else {
        let _ = writeln!(w, "\nPlugin commands:");
        for c in cmds {
            let _ = writeln!(w, "  {:<14} {}", c.name, c.summary);
        }
    }
    let _ = writeln!(w, "\nFor more information, try '--help'.");
    EXIT_USAGE
}

/// Everything a handler is started with.
struct Invocation<'a> {
    plugin: &'a LoadedPlugin,
    argv: Vec<String>,
    json: bool,
    project: Option<(PathBuf, String)>,
    data_dir: PathBuf,
    cwd: PathBuf,
}

impl Invocation<'_> {
    /// The handler env on top of the (injected) process env.
    fn env(&self, ctx: &Ctx) -> Vec<(String, String)> {
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        let mut v: Vec<(String, String)> = ctx.env.vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        v.push((ENV_CLI.into(), exe));
        v.push((
            crate::paths::ENV_PROJECT_DIR.into(),
            self.project.as_ref().map(|(p, _)| p.display().to_string()).unwrap_or_default(),
        ));
        v.push(("QUADFLOW_PLUGIN_ID".into(), self.plugin.id.clone()));
        v.push(("QUADFLOW_PLUGIN_DIR".into(), self.plugin.root.display().to_string()));
        v.push(("QUADFLOW_PLUGIN_DATA".into(), self.data_dir.display().to_string()));
        v.push((ENV_JSON.into(), if self.json { "1" } else { "0" }.into()));
        v.push((crate::paths::ENV_PROFILE.into(), ctx.profile.as_str().into()));
        v
    }
}

/// `quadflow <name> <args…>` for a name clap did not recognize.
pub fn run_external(ctx: &Ctx, out: &mut Out, raw: Vec<OsString>) -> i32 {
    let raw: Vec<String> = raw.into_iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let Some((name, rest)) = raw.split_first() else {
        return out.err(&CoreError::invalid_input("missing subcommand"));
    };
    let (argv, json_flag, project_flag) = split_global_flags(rest);
    out.json |= json_flag;
    let ctx = Ctx {
        env: ctx.env,
        profile: ctx.profile,
        project_flag: project_flag.or_else(|| ctx.project_flag.clone()),
        actor: ctx.actor.clone(),
    };

    let (paths, _db, reg) = match load_registry(&ctx) {
        Ok(r) => r,
        Err(e) => return out.err(&e),
    };
    let cmds = commands(&reg);
    if RESERVED_CLI_NAMES.contains(&name.as_str()) {
        // A core name that clap routed here (e.g. `help` variants): never a plugin's.
        return unrecognized(out, name, &cmds, None);
    }
    let owner = reg.active().find(|p| {
        p.manifest.as_ref().is_some_and(|m| m.contributes.cli_commands.iter().any(|c| &c.name == name))
    });
    let Some(plugin) = owner else {
        let inactive = reg.all().find(|p| {
            !p.is_active() && p.manifest.as_ref().is_some_and(|m| m.contributes.cli_commands.iter().any(|c| &c.name == name))
        });
        return unrecognized(out, name, &cmds, inactive);
    };
    let cmd = plugin
        .manifest
        .as_ref()
        .and_then(|m| m.contributes.cli_commands.iter().find(|c| &c.name == name))
        .expect("owner declares the command")
        .clone();

    // Project: optional for plugin commands (empty QUADFLOW_PROJECT_DIR when none).
    let project = match ctx.project_root() {
        Ok(r) => Some((r.path.clone(), r.key.clone())),
        Err(e) if e.code == ErrorCode::ProjectNotFound => None,
        Err(e) if ctx.project_flag.is_some() => return out.err(&e),
        Err(_) => None,
    };
    let data_dir = paths.plugin_data_dir.join(&plugin.id);
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        return out.err(&CoreError::io(&data_dir, e));
    }
    let inv = Invocation { plugin, argv, json: out.json, project, data_dir, cwd: ctx.env.cwd.clone() };
    match &cmd.handler {
        CliHandler::Exec { binaries } => run_exec(&ctx, out, &inv, binaries),
        CliHandler::Sidecar => run_sidecar(&ctx, out, &inv, &paths),
    }
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

enum Chunk {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}

fn pump(mut r: impl Read + Send + 'static, tx: mpsc::Sender<Chunk>, stdout: bool) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let c = buf[..n].to_vec();
                    if tx.send(if stdout { Chunk::Stdout(c) } else { Chunk::Stderr(c) }).is_err() {
                        break;
                    }
                }
            }
        }
    })
}

fn run_exec(ctx: &Ctx, out: &mut Out, inv: &Invocation, binaries: &std::collections::BTreeMap<String, String>) -> i32 {
    let plugin = inv.plugin;
    if plugin.isolation != Isolation::Trusted {
        return out.err(&CoreError::permission_denied(format!(
            "plugin {:?} is sandboxed; `exec` CLI handlers are only allowed for trusted plugins (use a `sidecar` handler)",
            plugin.id
        )));
    }
    let Some(target) = current_target() else {
        return out.err(&CoreError::unsupported("no CLI binary for this platform"));
    };
    let Some(rel) = binaries.get(&target) else {
        return out.err(&CoreError::unsupported(format!("plugin {:?} has no CLI binary for {target}", plugin.id)));
    };
    if let Err(e) = check_file_in_root(&plugin.root, rel) {
        return out.err(&CoreError::not_found(format!("plugin {:?} CLI binary: {e}", plugin.id)));
    }
    let program = plugin.root.join(rel);
    let mut cmd = Command::new(&program);
    cmd.args(&inv.argv)
        .current_dir(&inv.cwd)
        .envs(inv.env(ctx))
        .env_remove(ENV_SIDECAR_MODE)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return out.err(&CoreError::external(format!("could not start {}: {e}", program.display())))
        }
    };
    let (tx, rx) = mpsc::channel();
    let t1 = pump(child.stdout.take().expect("piped"), tx.clone(), true);
    let t2 = pump(child.stderr.take().expect("piped"), tx, false);
    for c in rx {
        match c {
            Chunk::Stdout(b) => {
                let _ = out.io.stdout.write_all(&b);
                let _ = out.io.stdout.flush();
            }
            Chunk::Stderr(b) => {
                let _ = out.io.stderr.write_all(&b);
                let _ = out.io.stderr.flush();
            }
        }
    }
    let _ = (t1.join(), t2.join());
    match child.wait() {
        Ok(s) => s.code().unwrap_or(1),
        Err(e) => out.err(&CoreError::external(format!("wait for {}: {e}", program.display()))),
    }
}

// ---------------------------------------------------------------------------
// sidecar (CLI mode)
// ---------------------------------------------------------------------------

enum Event {
    Output { stderr: bool, text: String },
    Done(Result<Value>),
}

struct CliSidecarHost {
    env: Arc<HostEnv>,
    plugin: LoadedPlugin,
    project: Option<(String, String)>,
    tx: Mutex<mpsc::Sender<Event>>,
}

impl SidecarHost for CliSidecarHost {
    fn config(&self, plugin_id: &str) -> Result<SidecarConfig> {
        if plugin_id != self.plugin.id {
            return Err(CoreError::internal(format!("CLI host serves only {:?}", self.plugin.id)));
        }
        let settings = host::dispatch(&self.env, HostCall { plugin: &self.plugin, method: "settings.getAll", params: json!({}) })
            .unwrap_or_else(|_| json!({}));
        let rc = ResolveContext {
            paths: &self.env.core.paths,
            host_version: env!("CARGO_PKG_VERSION"),
            mode: "cli",
            project: self.project.clone(),
            settings,
            locale: locale(),
        };
        let mut cfg = sidecar::resolve(&self.plugin, &rc)?;
        // One command, one process: a crash fails the command instead of restarting.
        cfg.restart = SidecarRestart::Never;
        Ok(cfg)
    }

    fn host_call(&self, _plugin_id: &str, method: &str, params: Value) -> Result<Value> {
        let available = self.env.available();
        if !available.iter().any(|m| m == method) {
            return Err(CoreError::unsupported(format!(
                "{method} is not available in CLI mode (terminal, agent, native and UI methods need the QuadFlow app)"
            )));
        }
        host::dispatch(&self.env, HostCall { plugin: &self.plugin, method, params })
    }

    fn notification(&self, plugin_id: &str, method: &str, params: Value) {
        if method != "cli/output" {
            log::debug!("[sidecar:{plugin_id}] (cli mode) ignoring notification {method}");
            return;
        }
        let text = params.get("text").and_then(Value::as_str).unwrap_or_default().to_string();
        let stderr = params.get("stream").and_then(Value::as_str) == Some("stderr");
        let _ = self.tx.lock().send(Event::Output { stderr, text });
    }
}

fn locale() -> String {
    std::env::var("LANG")
        .ok()
        .and_then(|l| l.split('.').next().map(|s| s.replace('_', "-")))
        .filter(|l| !l.is_empty() && l != "C")
        .unwrap_or_else(|| "en-US".into())
}

fn run_sidecar(ctx: &Ctx, out: &mut Out, inv: &Invocation, paths: &AppPaths) -> i32 {
    let plugin = inv.plugin;
    if !sidecar::has_sidecar(plugin) {
        return out.err(&CoreError::unsupported(format!("plugin {:?} declares a sidecar CLI handler but no sidecar", plugin.id)));
    }
    let secrets = match Secrets::from_env(ctx.profile, |k| ctx.env.var(k).map(str::to_string)) {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let core = Arc::new(Core::new(paths.clone()));
    let env = Arc::new(HostEnv::new(core, secrets, vec![]));
    if let Some((root, _)) = &inv.project {
        *env.session.project_override.lock() = Some(root.clone());
    }
    let project = inv.project.as_ref().map(|(p, k)| (p.display().to_string(), k.clone()));
    let (tx, rx) = mpsc::channel();
    let host = Arc::new(CliSidecarHost { env, plugin: plugin.clone(), project: project.clone(), tx: Mutex::new(tx.clone()) });
    let opts = SupervisorOptions { logs_dir: Some(paths.logs_dir.clone()), ..SupervisorOptions::default() };
    let sup = SidecarSupervisor::new(host, opts);

    let params = json!({
        "argv": inv.argv,
        "cwd": inv.cwd.display().to_string(),
        "json": inv.json,
        "projectRoot": project.as_ref().map(|(p, _)| p.clone()),
    });
    let (sup2, id) = (sup.clone(), plugin.id.clone());
    let worker = std::thread::spawn(move || {
        let r = sup2.request(&id, "cli/run", params, Some(CLI_RUN_TIMEOUT));
        let _ = tx.send(Event::Done(r));
    });
    let mut result = Err(CoreError::external("sidecar exited"));
    for ev in rx.iter() {
        match ev {
            Event::Output { stderr, text } => {
                let w = if stderr { &mut out.io.stderr } else { &mut out.io.stdout };
                let _ = w.write_all(text.as_bytes());
                let _ = w.flush();
            }
            Event::Done(r) => {
                result = r;
                break;
            }
        }
    }
    let _ = worker.join();
    sup.stop(&plugin.id);
    // Output notifications that raced the response are already in order (one
    // reader thread); drain anything left.
    for ev in rx.try_iter() {
        if let Event::Output { stderr, text } = ev {
            let w = if stderr { &mut out.io.stderr } else { &mut out.io.stdout };
            let _ = w.write_all(text.as_bytes());
        }
    }
    let _ = out.io.stdout.flush();
    match result {
        Ok(v) => match v.get("exitCode").and_then(Value::as_i64) {
            Some(code) => i32::try_from(code).unwrap_or(1),
            None if v.is_null() || v.is_object() => 0,
            None => out.err(&CoreError::external(format!("plugin {:?}: cli/run returned {v}", plugin.id))),
        },
        Err(e) => out.err(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn global_flags_are_consumed_before_double_dash() {
        let (rest, json, project) = split_global_flags(&s(&["ping", "--json", "--project", "/p", "x", "--", "--json"]));
        assert_eq!(rest, s(&["ping", "x", "--", "--json"]));
        assert!(json);
        assert_eq!(project, Some(PathBuf::from("/p")));
        let (rest, json, project) = split_global_flags(&s(&["--project=/q", "a"]));
        assert_eq!(rest, s(&["a"]));
        assert!(!json);
        assert_eq!(project, Some(PathBuf::from("/q")));
    }

    #[test]
    fn suggestions() {
        let known = ["ideas", "issues", "hello"];
        assert_eq!(suggest("isues", known.iter().copied()), Some("issues"));
        assert_eq!(suggest("hel", known.iter().copied()), Some("hello"));
        assert_eq!(suggest("zzzzzz", known.iter().copied()), None);
    }
}
