//! CLI contract for the DL-1 commands (data-layer.md §11, §12.3): JSON envelope,
//! exit codes, `init` + walk-up discovery from a subdirectory.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

fn cli(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
    // Unknown subcommands, `docs` and `--help` read the plugin registry: keep it
    // off the real data dir.
    static DATA: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let data = DATA.get_or_init(|| tempfile::tempdir().unwrap()).path();
    vars.insert("QUADFLOW_DATA_DIR".to_string(), data.display().to_string());
    vars.insert("QUADFLOW_RESOURCE_DIR".to_string(), data.join("res").display().to_string());
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

#[test]
fn init_doctor_walk_up_and_exit_codes() {
    let tmp = tempfile::tempdir().unwrap();
    let proj = tmp.path().join("web-api");
    let sub = proj.join("src").join("deep");
    std::fs::create_dir_all(&sub).unwrap();

    let (code, out, _) = cli(&proj, &["init", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v = json(&out);
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["config"]["code"], "WEB");
    assert_eq!(v["data"]["config"]["formatVersion"], 1);
    assert_eq!(v["data"]["profile"], "dev");
    assert!(proj.join(".quadflow-dev").join("config.json").is_file());
    assert!(!proj.join(".quadflow").exists());

    // Second init → conflict (exit 4).
    let (code, out, _) = cli(&proj, &["init", "--json"]);
    assert_eq!(code, 4);
    assert_eq!(json(&out)["error"]["code"], "conflict");

    // Walk up from a subdirectory.
    let (code, out, _) = cli(&sub, &["doctor", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v = json(&out);
    assert_eq!(v["ok"], true);
    assert_eq!(v["data"]["ok"], true);
    assert_eq!(
        Path::new(v["data"]["root"].as_str().unwrap()),
        dunce::canonicalize(&proj).unwrap().as_path()
    );

    // Human mode prints text, exit 0.
    let (code, out, _) = cli(&sub, &["doctor"]);
    assert_eq!(code, 0);
    assert!(out.contains("[   ok] config"), "{out}");

    // Explicit --project to a non-project → exit 5 with envelope.
    let empty = tmp.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let (code, out, _) = cli(&proj, &["doctor", "--json", "--project", empty.to_str().unwrap()]);
    assert_eq!(code, 5);
    let v = json(&out);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "project_not_found");

    // A domain command outside a project → exit 5 too.
    let (code, out, _) = cli(&proj, &["issues", "list", "--json", "--project", empty.to_str().unwrap()]);
    assert_eq!(code, 5, "{out}");

    // Invalid init code → invalid_input (exit 2).
    let (code, out, _) = cli(&empty, &["init", "--code", "x", "--json"]);
    assert_eq!(code, 2);
    assert_eq!(json(&out)["error"]["code"], "invalid_input");

    // Usage error → exit 2, JSON envelope when --json is present.
    let (code, out, _) = cli(&proj, &["--json", "bogus-command"]);
    assert_eq!(code, 2);
    assert_eq!(json(&out)["error"]["code"], "invalid_input");
    let (code, _, err) = cli(&proj, &["bogus-command"]);
    assert_eq!(code, 2);
    assert!(!err.is_empty());

    // Unknown docs module → not_found (exit 3).
    let (code, out, _) = cli(&proj, &["docs", "nope", "--json"]);
    assert_eq!(code, 3);
    assert_eq!(json(&out)["error"]["code"], "not_found");

    // --help is not an error.
    let (code, out, _) = cli(&proj, &["--help"]);
    assert_eq!(code, 0);
    assert!(out.contains("Usage"));
}
