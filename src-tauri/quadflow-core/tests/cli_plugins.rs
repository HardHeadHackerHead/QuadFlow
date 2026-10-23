//! CLI contract for `quadflow plugins …` (plugin-system.md §12.3, §15.3).
//! Everything runs against a temp data dir + temp resource dir.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

struct Env {
    data: tempfile::TempDir,
    res: tempfile::TempDir,
}

impl Env {
    fn new() -> Self {
        let e = Self { data: tempfile::tempdir().unwrap(), res: tempfile::tempdir().unwrap() };
        e.plugin("issues", json!({"permissions": ["data:issues:write"]}));
        let this = quadflow_core::plugins::Platform::current().unwrap().as_str();
        let others: Vec<&str> = ["windows", "macos", "linux"].into_iter().filter(|p| *p != this).collect();
        e.plugin("elsewhere", json!({"platforms": others}));
        e.plugin("future", json!({"apiVersion": "^2.0.0"}));
        e
    }

    fn plugin(&self, id: &str, extra: Value) {
        let dir = self.res.path().join("plugins").join(id);
        write_manifest(&dir, id, extra);
    }

    fn cli(&self, args: &[&str]) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut vars = BTreeMap::new();
        vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
        vars.insert("QUADFLOW_DATA_DIR".to_string(), self.data.path().display().to_string());
        vars.insert("QUADFLOW_RESOURCE_DIR".to_string(), self.res.path().display().to_string());
        let env = CliEnv { cwd: self.data.path().to_path_buf(), vars };
        let code = {
            let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
            let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
            run(argv, &mut io, &env)
        };
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
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

#[test]
fn list_info_enable_disable() {
    let env = Env::new();
    let (code, out, _) = env.cli(&["plugins", "list", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v = json_of(&out);
    let ids: Vec<&str> = v["data"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["future", "issues"], "unsupported-platform plugins are hidden by default");
    let future = &v["data"][0];
    assert_eq!(future["status"]["kind"], "incompatible");
    assert_eq!(v["data"][1]["status"]["kind"], "active");
    assert_eq!(v["data"][1]["origin"], "bundled");
    assert_eq!(v["data"][1]["permissions"][0]["granted"], true);

    let (_, out, _) = env.cli(&["plugins", "list", "--all", "--json"]);
    assert_eq!(json_of(&out)["data"].as_array().unwrap().len(), 3);

    let (code, out, _) = env.cli(&["plugins", "disable", "issues", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"]["status"]["kind"], "disabled");
    let (_, out, _) = env.cli(&["plugins", "info", "issues", "--json"]);
    assert_eq!(json_of(&out)["data"]["enabled"], false);
    let (code, out, _) = env.cli(&["plugins", "enable", "issues"]);
    assert_eq!(code, 0);
    assert!(out.contains("Enabled issues: active"), "{out}");

    let (code, out, _) = env.cli(&["plugins", "info", "nope", "--json"]);
    assert_eq!(code, 3);
    assert_eq!(json_of(&out)["error"]["code"], "not_found");

    let (code, out, _) = env.cli(&["plugins", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains("issues") && out.contains("incompatible"), "{out}");
}

#[test]
fn validate_reports_errors_with_exit_2() {
    let env = Env::new();
    let dir = env.data.path().join("my-plugin");
    write_manifest(
        &dir,
        "acme.thing",
        json!({"icon": "assets/missing.svg", "permissions": ["fs:read:root"]}),
    );
    let (code, out, _) = env.cli(&["plugins", "validate", dir.to_str().unwrap(), "--json"]);
    assert_eq!(code, 2, "{out}");
    let v = json_of(&out);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "invalid_input");
    assert!(v["error"]["details"].as_array().unwrap().iter().any(|e| e["path"] == "/permissions/0"), "{v}");

    write_manifest(&dir, "acme.thing", json!({}));
    let (code, out, _) = env.cli(&["plugins", "validate", dir.to_str().unwrap(), "--json"]);
    assert_eq!(code, 0, "{out}");
    let v = json_of(&out);
    assert_eq!(v["data"]["valid"], true);
    assert_eq!(v["data"]["id"], "acme.thing");

    // Bare id: refused for dev, accepted as bundled.
    write_manifest(&dir, "thing", json!({}));
    let (code, _, err) = env.cli(&["plugins", "validate", dir.to_str().unwrap()]);
    assert_eq!(code, 2);
    assert!(err.contains("bare id"), "{err}");
    let (code, _, _) = env.cli(&["plugins", "validate", dir.to_str().unwrap(), "--origin", "bundled"]);
    assert_eq!(code, 0);

    // Incompatible but valid: exit 0 with a note.
    write_manifest(&dir, "acme.thing", json!({"apiVersion": "^9.0.0"}));
    let (code, out, _) = env.cli(&["plugins", "validate", dir.to_str().unwrap()]);
    assert_eq!(code, 0);
    assert!(out.contains("would not activate"), "{out}");
}
