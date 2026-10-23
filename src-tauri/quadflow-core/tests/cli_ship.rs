//! CLI JSON contract for `quadflow ship …` (data-layer.md §6.7, §11, §12.3):
//! envelope + exit codes per subcommand, `data` snapshots, and the error
//! contract (a failed `ship run --json` / invalid `ship config validate --json`
//! exit non-zero). Snapshots live in `tests/snapshots/cli_ship__*.snap`.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Proj {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
}

impl Proj {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ship-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{\n  \"name\": \"demo-app\",\n  \"version\": \"1.0.0\"\n}\n").unwrap();
        let p = Proj { _tmp: tmp, dir };
        let (code, out, _) = p.raw(&["init", "--json"]);
        assert_eq!(code, 0, "{out}");
        p
    }

    fn raw(&self, args: &[&str]) -> (i32, String, String) {
        cli(&self.dir, args)
    }

    fn ok(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (code, out, err) = self.raw(&a);
        assert_eq!(code, 0, "{args:?}\nstdout: {out}\nstderr: {err}");
        let v = json(&out);
        assert_eq!(v["ok"], true, "{out}");
        v["data"].clone()
    }

    /// Expect failure with exit `exit` and error `code`; returns the error object.
    fn fails(&self, args: &[&str], exit: i32, code: &str) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (c, out, _) = self.raw(&a);
        assert_eq!(c, exit, "{args:?}: {out}");
        let v = json(&out);
        assert_eq!(v["ok"], false, "{out}");
        assert_eq!(v["error"]["code"], code, "{out}");
        v["error"].clone()
    }

    fn write_config(&self, cfg: Value) {
        let f = self.dir.join("ship-config.json");
        std::fs::write(&f, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
        self.ok(&["ship", "config", "save", "--file", "ship-config.json"]);
    }
}

fn cli(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
    let env = CliEnv { cwd: cwd.to_path_buf(), vars };
    let code = {
        let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
        let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
        run(argv, &mut io, &env)
    };
    (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
}

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not one JSON document ({e}): {s}"))
}

macro_rules! snap {
    ($name:expr, $v:expr) => {
        insta::assert_json_snapshot!($name, $v, {
            ".id" => "[id]",
            "[].id" => "[id]",
            ".**.runId" => "[id]",
            ".**.startedAt" => "[ts]",
            ".**.completedAt" => "[ts]",
            ".**.durationMs" => "[ms]",
            ".projectDir" => "[path]",
            ".configPath" => "[path]",
            ".runsDir" => "[path]",
            ".backupPath" => "[path]",
        })
    };
}

fn shell(name: &str, command: &str) -> Value {
    serde_json::json!({ "type": "shell", "name": name, "command": command })
}

fn config(phases: Vec<Value>) -> Value {
    serde_json::json!({
        "formatVersion": 1,
        "productName": "Demo",
        "versionFiles": [{ "path": "package.json", "kind": "json", "key": "version" }],
        "phases": phases,
        "changelog": { "source": "manual" },
    })
}

#[test]
fn config_lifecycle_contract() {
    let p = Proj::new();
    p.fails(&["ship", "config", "show"], 3, "not_found");
    p.fails(&["ship", "status"], 3, "not_found");
    p.fails(&["ship", "run", "patch"], 3, "not_found");
    assert_eq!(p.ok(&["ship", "readiness"]), serde_json::json!([]));

    let templates = p.ok(&["ship", "templates"]);
    snap!("templates", &templates);
    let ids: Vec<&str> = templates.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"minimal") && ids.contains(&"tauri-windows"));
    snap!("templates_preview", &p.ok(&["ship", "templates", "--id", "vercel", "--param", "bump=false", "--param", "push_tag=false"]));
    p.fails(&["ship", "templates", "--id", "vercel", "--param", "nope=1"], 2, "invalid_input");
    p.fails(&["ship", "templates", "--id", "no-such-template"], 2, "invalid_input");

    let cfg = p.ok(&["ship", "init"]);
    snap!("init", &cfg);
    assert!(!cfg.to_string().to_lowercase().contains("qwick"));
    p.fails(&["ship", "init"], 4, "conflict");
    snap!("config_show", &p.ok(&["ship", "config", "show"]));
    snap!("config_validate", &p.ok(&["ship", "config", "validate"]));
    snap!("status", &p.ok(&["ship", "status"]));
    snap!("readiness", &p.ok(&["ship", "readiness"]));
    snap!("readiness_one", &p.ok(&["ship", "readiness", "--check", "version_files_in_sync"]));
    snap!("bump_dry_run", &p.ok(&["ship", "bump", "minor", "--dry-run"]));
    snap!("bump", &p.ok(&["ship", "bump", "patch"]));
    assert!(std::fs::read_to_string(p.dir.join("package.json")).unwrap().contains("\"version\": \"1.0.1\""));
    snap!("diagnostics", &p.ok(&["ship", "diagnostics"]));
    snap!("restore_backups", &p.ok(&["ship", "restore-backups"]));
    let d = p.ok(&["ship", "detect"]);
    assert_eq!(d["productName"], "demo-app");
    assert_eq!(d["projectKind"], "npm");
    assert!(d["tools"].get("qwick").is_none());

    // Invalid config: validate --json exits non-zero with the problems in details.
    p.write_config(serde_json::json!({
        "formatVersion": 1,
        "productName": "Demo",
        "versionFiles": [{ "path": "missing.json", "kind": "json", "key": "version" }],
        "phases": [
            { "type": "checks", "name": "pre", "checks": ["qwick_authenticated"] },
            { "type": "sign_authenticode", "name": "sign", "files": ["*.exe"] },
        ],
    }));
    let e = p.fails(&["ship", "config", "validate"], 2, "invalid_input");
    snap!("config_validate_invalid", &e);
    p.fails(&["ship", "run", "deploy"], 2, "invalid_input");
    let (code, _, err) = p.raw(&["ship", "config", "validate"]);
    assert_eq!(code, 2);
    assert!(err.contains("unknown check `qwick_authenticated`"), "{err}");

    snap!("config_delete", &p.ok(&["ship", "config", "delete"]));
    assert_eq!(p.ok(&["ship", "config", "delete"])["deleted"], false);
}

#[test]
fn run_contract() {
    let p = Proj::new();
    p.write_config(config(vec![shell("hello", "echo shipping v{version} of {productName}")]));

    // Two runs of the same version keep two records.
    let a = p.ok(&["ship", "run", "deploy"]);
    snap!("run_deploy", &a);
    let b = p.ok(&["ship", "run", "deploy", "--no-bump"]);
    assert_eq!(a["version"], "1.0.0");
    assert_eq!(a["version"], b["version"]);
    assert_ne!(a["id"], b["id"]);
    let runs = p.ok(&["ship", "list"]);
    assert_eq!(runs.as_array().unwrap().len(), 2);
    snap!("list", &runs);
    assert_eq!(p.ok(&["ship", "get", "1.0.0"])["id"], b["id"]);
    assert_eq!(p.ok(&["ship", "get", a["id"].as_str().unwrap()])["id"], a["id"]);
    p.fails(&["ship", "get", "9.9.9"], 3, "not_found");
    p.fails(&["ship", "abort"], 3, "not_found");
    p.fails(&["ship", "abort", a["id"].as_str().unwrap()], 4, "conflict");
    p.fails(&["ship", "run", "patch", "--no-bump"], 2, "invalid_input");

    // Dry run: resolved plan, nothing persisted, version files untouched.
    let dry = p.ok(&["ship", "run", "major", "--dry-run"]);
    snap!("run_dry", &dry);
    assert_eq!(dry["version"], "2.0.0");
    assert_eq!(p.ok(&["ship", "list"]).as_array().unwrap().len(), 2);

    // A failed run exits non-zero in JSON mode, with the record in details.
    p.write_config(config(vec![shell("boom", "exit 7"), shell("never", "echo no")]));
    let e = p.fails(&["ship", "run", "deploy"], 1, "external");
    assert_eq!(e["details"]["run"]["status"], "failed");
    assert_eq!(e["details"]["run"]["phases"][0]["exitCode"], 7);
    snap!("run_failed", &e["details"]["run"]);
    let (code, out, _) = p.raw(&["ship", "run", "deploy"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("Result: failed"), "{out}");
    assert_eq!(p.ok(&["ship", "list"]).as_array().unwrap().len(), 4);

    // Human mode streams phase lines.
    p.write_config(config(vec![shell("hello", "echo streamed-line")]));
    let (code, out, _) = p.raw(&["ship", "run", "deploy"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("| streamed-line") && out.contains("[PASS] hello"), "{out}");

    // Usage errors.
    let (code, _, _) = p.raw(&["ship", "run", "sideways", "--json"]);
    assert_eq!(code, 2);
}

#[test]
fn unknown_project_kind_errors_loudly() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, _, _) = cli(tmp.path(), &["init", "--json"]);
    assert_eq!(code, 0);
    let (code, out, _) = cli(tmp.path(), &["ship", "init", "--json"]);
    assert_eq!(code, 1, "{out}");
    let v = json(&out);
    assert_eq!(v["error"]["code"], "unsupported");
    assert!(!tmp.path().join(".quadflow-dev/ship/config.json").exists());
}
