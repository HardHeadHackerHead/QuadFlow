//! Plugin CLI commands and agent context docs (plugin-system.md §9): external
//! subcommand dispatch to `exec` and `sidecar` handlers, reserved / conflicting
//! names, `--help` and `docs` listing plugin contributions.
//!
//! Everything runs against a temp data dir, a temp resource dir (bundled
//! plugins) and a temp project. The handler tests need `node` on PATH (skipped
//! with a message otherwise).

mod common;

use common::TempProject;
use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Env {
    data: tempfile::TempDir,
    res: tempfile::TempDir,
    project: TempProject,
}

impl Env {
    fn new() -> Self {
        Self { data: tempfile::tempdir().unwrap(), res: tempfile::tempdir().unwrap(), project: TempProject::new() }
    }

    fn root(&self) -> PathBuf {
        self.project.store.root().path.clone()
    }

    /// A bundled plugin (trusted, permissions auto-granted).
    fn bundled(&self, id: &str, extra: Value) -> PathBuf {
        let dir = self.res.path().join("plugins").join(id);
        write_manifest(&dir, id, extra);
        dir
    }

    fn cli_in(&self, cwd: &Path, args: &[&str]) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut vars = BTreeMap::new();
        vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
        vars.insert("QUADFLOW_DATA_DIR".to_string(), self.data.path().display().to_string());
        vars.insert("QUADFLOW_RESOURCE_DIR".to_string(), self.res.path().display().to_string());
        vars.insert("QUADFLOW_SECRETS_BACKEND".to_string(), "memory".to_string());
        let env = CliEnv { cwd: cwd.to_path_buf(), vars };
        let code = {
            let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
            let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
            run(argv, &mut io, &env)
        };
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    fn cli(&self, args: &[&str]) -> (i32, String, String) {
        self.cli_in(&self.root(), args)
    }
}

fn write_manifest(dir: &Path, id: &str, extra: Value) {
    std::fs::create_dir_all(dir).unwrap();
    let mut v = json!({"id": id, "name": id, "version": "1.0.0", "apiVersion": "^1.0.0", "platforms": ["windows", "macos", "linux"]});
    for (k, val) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = val;
    }
    std::fs::write(dir.join("quadflow-plugin.json"), v.to_string()).unwrap();
}

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not one JSON document ({e}): {s}"))
}

fn target() -> String {
    quadflow_core::plugins::current_target().expect("supported test target")
}

fn node() -> Option<PathBuf> {
    use quadflow_core::domains::environments::{which, SystemProbe, TargetPlatform};
    let n = which(&SystemProbe, TargetPlatform::current(), "node");
    if n.is_none() {
        eprintln!("skipping plugin CLI handler test: node is not on PATH");
    }
    n
}

fn sdk_url() -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/sidecar-sdk-node/index.mjs");
    let p = dunce::canonicalize(p).unwrap();
    format!("file:///{}", p.display().to_string().replace('\\', "/").trim_start_matches('/'))
}

/// An exec "binary" that runs `bin/cli.mjs` with node: a `.cmd` on Windows, a
/// shell script elsewhere. Prints `{ok, data: {argv, env}}`; `exit N` exits N.
fn write_exec_tool(dir: &Path, node: &Path) -> String {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(
        bin.join("cli.mjs"),
        r#"
const env = {}
for (const k of ['QUADFLOW_JSON', 'QUADFLOW_PROJECT_DIR', 'QUADFLOW_PLUGIN_ID', 'QUADFLOW_PLUGIN_DIR',
                 'QUADFLOW_PLUGIN_DATA', 'QUADFLOW_CLI', 'QUADFLOW_SIDECAR_MODE', 'QUADFLOW_PROFILE']) {
  env[k] = process.env[k] ?? null
}
const argv = process.argv.slice(2)
process.stderr.write('exec stderr line\n')
process.stdout.write(JSON.stringify({ ok: true, data: { via: 'exec', argv, env } }) + '\n')
if (argv[0] === 'exit') process.exit(Number(argv[1]))
"#,
    )
    .unwrap();
    if cfg!(windows) {
        std::fs::write(bin.join("tool.cmd"), format!("@\"{}\" \"%~dp0cli.mjs\" %*\r\n", node.display())).unwrap();
        "bin/tool.cmd".into()
    } else {
        let p = bin.join("tool");
        std::fs::write(&p, format!("#!/bin/sh\nexec \"{}\" \"$(dirname \"$0\")/cli.mjs\" \"$@\"\n", node.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        "bin/tool".into()
    }
}

#[test]
fn reserved_and_conflicting_names_are_rejected() {
    let env = Env::new();
    let exec = |name: &str| json!({"name": name, "summary": "x", "handler": {"type": "exec", "binaries": {target(): "bin/t"}}});
    // A plugin may not take a core command name.
    let dir = env.bundled("hijack", json!({"contributes": {"cliCommands": [exec("issues")]}}));
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin/t"), "").unwrap();
    // Two plugins with the same command name: the second (by id) fails.
    for id in ["aa", "bb"] {
        let dir = env.bundled(id, json!({"contributes": {"cliCommands": [exec("dup")]}}));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin/t"), "").unwrap();
    }

    let (_, out, _) = env.cli(&["plugins", "info", "hijack", "--json"]);
    let v = json_of(&out);
    assert_eq!(v["data"]["status"]["kind"], "failed", "{out}");
    assert!(v["data"]["status"]["reason"].as_str().unwrap().contains("reserved"), "{out}");

    let (_, out, _) = env.cli(&["plugins", "info", "bb", "--json"]);
    let v = json_of(&out);
    assert_eq!(v["data"]["status"]["kind"], "failed", "{out}");
    assert!(v["data"]["status"]["reason"].as_str().unwrap().contains("already provided by plugin \"aa\""), "{out}");
    let (_, out, _) = env.cli(&["plugins", "info", "aa", "--json"]);
    assert_eq!(json_of(&out)["data"]["status"]["kind"], "active");

    // The core command still wins.
    let (code, out, _) = env.cli(&["issues", "list", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert!(json_of(&out)["data"].is_array());

    // Help lists only the valid plugin command.
    let (code, help, _) = env.cli(&["--help"]);
    assert_eq!(code, 0);
    assert!(help.contains("dup") && help.contains("[plugin: aa]"), "{help}");
    assert!(!help.contains("[plugin: hijack]"), "{help}");
}

#[test]
fn unknown_and_inactive_commands() {
    let env = Env::new();
    let dir = env.bundled(
        "offline",
        json!({"contributes": {"cliCommands": [{"name": "off", "summary": "Off", "handler": {"type": "exec", "binaries": {target(): "bin/t"}}}]}}),
    );
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::write(dir.join("bin/t"), "").unwrap();

    let (code, out, _) = env.cli(&["nope", "--json"]);
    assert_eq!(code, 2);
    let v = json_of(&out);
    assert_eq!(v["error"]["code"], "invalid_input");
    assert_eq!(v["error"]["details"]["pluginCommands"][0]["name"], "off");

    let (code, _, err) = env.cli(&["isues"]);
    assert_eq!(code, 2);
    assert!(err.contains("unrecognized subcommand 'isues'") && err.contains("'issues'"), "{err}");
    assert!(err.contains("Plugin commands:") && err.contains("off"), "{err}");

    let (code, _, _) = env.cli(&["plugins", "disable", "offline"]);
    assert_eq!(code, 0);
    let (code, out, _) = env.cli(&["--json", "off", "x"]);
    assert_eq!(code, 2);
    let v = json_of(&out);
    assert!(v["error"]["message"].as_str().unwrap().contains("not active"), "{out}");
    assert!(v["error"]["details"]["hint"].as_str().unwrap().contains("plugins enable offline"));
}

#[test]
fn exec_handler_passes_argv_env_and_exit_code() {
    let Some(node) = node() else { return };
    let env = Env::new();
    let dir = env.res.path().join("plugins").join("tooly");
    std::fs::create_dir_all(&dir).unwrap();
    let bin = write_exec_tool(&dir, &node);
    write_manifest(
        &dir,
        "tooly",
        json!({"contributes": {"cliCommands": [{"name": "tooly", "summary": "Tooly", "handler": {"type": "exec", "binaries": {target(): bin}}}]}}),
    );

    let (code, out, err) = env.cli(&["tooly", "ping", "--json", "a b", "--", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(err.contains("exec stderr line"), "{err}");
    let v = json_of(&out);
    assert_eq!(v["data"]["argv"], json!(["ping", "a b", "--", "--json"]), "global --json consumed only before --");
    let e = &v["data"]["env"];
    assert_eq!(e["QUADFLOW_JSON"], "1");
    assert_eq!(e["QUADFLOW_PLUGIN_ID"], "tooly");
    assert_eq!(e["QUADFLOW_PROFILE"], "dev");
    assert_eq!(e["QUADFLOW_SIDECAR_MODE"], Value::Null);
    assert!(!e["QUADFLOW_CLI"].as_str().unwrap().is_empty());
    let pdir = PathBuf::from(e["QUADFLOW_PROJECT_DIR"].as_str().unwrap());
    assert_eq!(dunce::canonicalize(pdir).unwrap(), dunce::canonicalize(env.root()).unwrap());
    let data = PathBuf::from(e["QUADFLOW_PLUGIN_DATA"].as_str().unwrap());
    assert!(data.is_dir() && data.starts_with(env.data.path()));

    // Exit code passthrough; no project → empty QUADFLOW_PROJECT_DIR.
    let outside = tempfile::tempdir().unwrap();
    let (code, out, _) = env.cli_in(outside.path(), &["tooly", "exit", "4"]);
    assert_eq!(code, 4);
    let v = json_of(&out);
    assert_eq!(v["data"]["env"]["QUADFLOW_JSON"], "0");
    assert_eq!(v["data"]["env"]["QUADFLOW_PROJECT_DIR"], "");

    // --project before the name is honored as well.
    let root = env.root().display().to_string();
    let (_, out, _) = env.cli_in(outside.path(), &["--project", &root, "tooly", "x"]);
    assert!(!json_of(&out)["data"]["env"]["QUADFLOW_PROJECT_DIR"].as_str().unwrap().is_empty());
}

#[test]
fn exec_handler_refused_for_sandboxed_plugins() {
    let Some(node) = node() else { return };
    let env = Env::new();
    // An installed third-party plugin (no grants needed: it requests none) is sandboxed.
    let dir = env.data.path().join("plugins").join("acme.sbx").join("1.0.0");
    std::fs::create_dir_all(&dir).unwrap();
    let bin = write_exec_tool(&dir, &node);
    write_manifest(
        &dir,
        "acme.sbx",
        json!({"contributes": {"cliCommands": [{"name": "sbx", "summary": "Sbx", "handler": {"type": "exec", "binaries": {target(): bin}}}]}}),
    );
    let (_, out, _) = env.cli(&["plugins", "info", "acme.sbx", "--json"]);
    let v = json_of(&out);
    assert_eq!(v["data"]["isolation"], "sandboxed", "{out}");
    assert_eq!(v["data"]["status"]["kind"], "active", "{out}");
    let (code, out, _) = env.cli(&["sbx", "ping", "--json"]);
    assert_eq!(code, 1, "{out}");
    let v = json_of(&out);
    assert_eq!(v["error"]["code"], "permission_denied");
    assert!(v["error"]["message"].as_str().unwrap().contains("trusted"));
}

const NODE_SIDECAR: &str = r#"
import { createServer } from '__SDK__'
createServer()
  .onInitialize((init) => ({ capabilities: { cli: init.host.mode === 'cli' } }))
  .onRequest('cli/run', async (p, host) => {
    const prev = (await host.call('storage.get', { key: 'runs' })) ?? 0
    await host.call('storage.set', { key: 'runs', value: prev + 1 })
    let terminals = 'available'
    try { await host.call('terminals.list', {}) } catch (e) { terminals = e.kind }
    if (p.argv[0] === 'fail') {
      host.notify('cli/output', { stream: 'stderr', text: 'nope\n' })
      return { exitCode: 3 }
    }
    const data = { via: 'sidecar', argv: p.argv, json: p.json, projectRoot: p.projectRoot, runs: prev + 1,
                   terminals, mode: process.env.QUADFLOW_SIDECAR_MODE, hasCwd: typeof p.cwd === 'string' }
    host.notify('cli/output', { stream: 'stdout', text: JSON.stringify({ ok: true, data }) + '\n' })
    return { exitCode: 0 }
  })
  .run()
"#;

#[test]
fn sidecar_handler_runs_in_cli_mode() {
    if node().is_none() {
        return;
    }
    let env = Env::new();
    let dir = env.bundled(
        "nodey",
        json!({
            "permissions": ["sidecar:runtime:node"],
            "sidecar": {"runtime": "node", "entry": "sidecar.mjs"},
            "contributes": {
                "cliCommands": [{"name": "nodey", "summary": "Nodey via its sidecar", "handler": {"type": "sidecar"}}],
                "agentContextDocs": [
                    {"id": "nodey", "title": "Nodey", "file": "docs/nodey.md"},
                    {"id": "extra", "title": "Nodey extra", "file": "docs/extra.md"},
                    {"id": "ship", "title": "Ship (plugin)", "file": "docs/ship.md"}
                ]
            }
        }),
    );
    std::fs::write(dir.join("sidecar.mjs"), NODE_SIDECAR.replace("__SDK__", &sdk_url())).unwrap();
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("docs/nodey.md"), "# Nodey\n\nRun `quadflow nodey`.\n").unwrap();
    std::fs::write(dir.join("docs/extra.md"), "# Nodey extra\n").unwrap();
    std::fs::write(dir.join("docs/ship.md"), "# Ship from a plugin\n").unwrap();

    for expected_runs in [1, 2] {
        let (code, out, err) = env.cli(&["nodey", "ping", "--json"]);
        assert_eq!(code, 0, "{out}{err}");
        let v = json_of(&out);
        let d = &v["data"];
        assert_eq!(d["via"], "sidecar");
        assert_eq!(d["argv"], json!(["ping"]));
        assert_eq!(d["json"], true);
        assert_eq!(d["mode"], "cli");
        assert_eq!(d["hasCwd"], true);
        assert_eq!(d["runs"], expected_runs, "host/call storage goes through the dispatch table");
        assert_eq!(d["terminals"], "unsupported", "app-only methods are unsupported in CLI mode");
        assert!(!d["projectRoot"].as_str().unwrap().is_empty());
    }
    let (code, out, err) = env.cli(&["nodey", "fail"]);
    assert_eq!(code, 3, "{out}{err}");
    assert_eq!(err, "nope\n");

    // Docs: plugin modules are listed and printable (no core-bundled domain docs are left).
    let (code, out, _) = env.cli(&["docs", "--list", "--json"]);
    assert_eq!(code, 0);
    let mods = json_of(&out)["data"].as_array().unwrap().clone();
    let find = |id: &str| mods.iter().find(|m| m["id"] == id).cloned();
    assert_eq!(find("nodey").unwrap()["source"], "nodey");
    assert_eq!(find("nodey.extra").unwrap()["title"], "Nodey extra");
    assert_eq!(find("nodey.ship").unwrap()["source"], "nodey", "doc ids other than the plugin id are namespaced");
    let (_, human, _) = env.cli(&["docs", "--list"]);
    assert!(human.contains("[plugin: nodey]") && human.contains("Plugin commands:"), "{human}");
    let (code, out, _) = env.cli(&["docs", "nodey"]);
    assert_eq!(code, 0);
    assert!(out.contains("Run `quadflow nodey`"));

    // Context modules: a plugin doc can be enabled into the project's context files.
    let root = env.root();
    std::fs::write(root.join("AGENTS.md"), "# Agents\n").unwrap();
    assert_eq!(env.cli(&["context", "files", "add", "AGENTS.md"]).0, 0);
    let (code, out, _) = env.cli(&["context", "enable", "nodey.extra", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert!(std::fs::read_to_string(root.join("AGENTS.md")).unwrap().contains("# Nodey extra"));
    let (_, out, _) = env.cli(&["context", "list", "--json"]);
    let v = json_of(&out);
    let row = v["data"]["modules"].as_array().unwrap().iter().find(|m| m["id"] == "nodey.extra").unwrap().clone();
    assert_eq!(row["enabled"], true);

    // Disabling the plugin removes its docs and commands.
    assert_eq!(env.cli(&["plugins", "disable", "nodey"]).0, 0);
    let (_, out, _) = env.cli(&["docs", "--list", "--json"]);
    assert!(!out.contains("nodey"), "{out}");
    let (code, _, _) = env.cli(&["nodey", "ping"]);
    assert_eq!(code, 2);
}

#[test]
fn plugin_doc_replaces_core_bundled_doc_but_not_the_base() {
    let env = Env::new();
    let dir = env.bundled(
        "ideas",
        json!({"contributes": {"agentContextDocs": [{"id": "ideas", "title": "Ideas (plugin)", "file": "docs/ideas.md"}]}}),
    );
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("docs/ideas.md"), "# Ideas from the plugin\n").unwrap();
    let dir = env.bundled(
        "quadflow",
        json!({"contributes": {"agentContextDocs": [{"id": "quadflow", "title": "Hijack", "file": "docs/q.md"}]}}),
    );
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("docs/q.md"), "# Not the base\n").unwrap();

    let (code, out, _) = env.cli(&["docs", "ideas", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"], "# Ideas from the plugin\n");
    let (_, out, _) = env.cli(&["docs", "--list", "--json"]);
    let mods = json_of(&out)["data"].as_array().unwrap().clone();
    assert_eq!(mods.iter().filter(|m| m["id"] == "ideas").count(), 1);
    assert_eq!(mods.iter().find(|m| m["id"] == "ideas").unwrap()["source"], "ideas");
    assert_eq!(mods[0]["id"], "quadflow");
    assert_eq!(mods[0]["source"], "core");
    assert!(!out.contains("Hijack"));
}
