//! CLI JSON contract for `quadflow scripts …` (data-layer.md §11, §12.3):
//! envelope, exit codes and `data` snapshots for every subcommand.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Env {
    _tmp: tempfile::TempDir,
    proj: PathBuf,
    data: PathBuf,
}

impl Env {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("qf-cli-scripts-").tempdir().unwrap();
        let proj = tmp.path().join("web-app");
        let data = tmp.path().join("appdata");
        std::fs::create_dir_all(&proj).unwrap();
        let e = Env { proj: dunce::canonicalize(&proj).unwrap(), data, _tmp: tmp };
        let (code, out, _) = e.cli(&["init", "--json"]);
        assert_eq!(code, 0, "{out}");
        e
    }

    fn cli(&self, args: &[&str]) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut vars = BTreeMap::new();
        vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
        vars.insert("QUADFLOW_DATA_DIR".to_string(), self.data.display().to_string());
        let env = CliEnv { cwd: self.proj.clone(), vars };
        let code = {
            let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
            let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
            run(argv, &mut io, &env)
        };
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    /// Run with `--json`, assert the exit code and envelope, return `data` (or `error`).
    fn json(&self, args: &[&str], expect_code: i32) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (code, out, err) = self.cli(&a);
        assert_eq!(code, expect_code, "{args:?}\nstdout: {out}\nstderr: {err}");
        let v: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("not one JSON document ({e}): {out}"));
        if expect_code == 0 {
            assert_eq!(v["ok"], true, "{out}");
            v["data"].clone()
        } else {
            assert_eq!(v["ok"], false, "{out}");
            v["error"].clone()
        }
    }

    /// Redact ids, timestamps and temp paths for snapshots.
    fn redact(&self, v: Value) -> Value {
        let root = self.proj.display().to_string();
        let ulid = regex::Regex::new(r"^[0-9a-hjkmnp-tv-z]{26}$").unwrap();
        fn walk(v: Value, root: &str, ulid: &regex::Regex, key: Option<&str>) -> Value {
            match v {
                Value::Object(m) => Value::Object(
                    m.into_iter().map(|(k, v)| {
                        let nv = walk(v, root, ulid, Some(&k));
                        (k, nv)
                    }).collect(),
                ),
                Value::Array(a) => Value::Array(a.into_iter().map(|v| walk(v, root, ulid, key)).collect()),
                Value::Number(_) if matches!(key, Some("createdAt" | "updatedAt")) => Value::String("[ts]".into()),
                Value::String(s) if ulid.is_match(&s) => Value::String("[id]".into()),
                Value::String(s) if s.contains(root) => Value::String(s.replace(root, "[root]").replace('\\', "/")),
                other => other,
            }
        }
        walk(v, &root, &ulid, None)
    }
}

fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

#[test]
fn scripts_contract() {
    let e = Env::new();

    // ---- create / get / list
    let dev = e.json(
        &[
            "scripts", "create", "Dev server", "--command", "npm run dev", "--description", "Vite", "--kind", "server",
            "--preview-url", "http://localhost:5173", "--tag", "Web", "--env", "PORT=5173", "--working-directory", "app",
        ],
        0,
    );
    insta::assert_json_snapshot!("create", e.redact(dev.clone()));
    let dev_id = id_of(&dev);
    let build = e.json(
        &["scripts", "create", "Build", "--command", "cargo build", "--setup", "rustup show", "--shell", "bash", "--platform", "linux", "--platform", "macos"],
        0,
    );
    let build_id = id_of(&build);
    insta::assert_json_snapshot!("get", e.redact(e.json(&["scripts", "get", &dev_id], 0)));
    insta::assert_json_snapshot!("list", e.redact(e.json(&["scripts", "list"], 0)));
    assert_eq!(e.json(&["scripts", "list", "--platform", "windows"], 0).as_array().unwrap().len(), 1);
    assert_eq!(e.json(&["scripts", "list", "--text", "CARGO"], 0)[0]["id"], build_id.as_str());

    // ---- update (set + clear), tag, pin, archive
    let u = e.json(&["scripts", "update", &dev_id, "--clear", "description", "--clear", "env", "--shell", "pwsh"], 0);
    insta::assert_json_snapshot!("update", e.redact(u));
    let t = e.json(&["scripts", "tag", &dev_id, "Frontend"], 0);
    assert_eq!(t["tags"], serde_json::json!(["web", "frontend"]));
    let t = e.json(&["scripts", "untag", &dev_id, "web"], 0);
    assert_eq!(t["tags"], serde_json::json!(["frontend"]));
    assert_eq!(e.json(&["scripts", "pin", &dev_id], 0)["pinned"], true);
    assert_eq!(e.json(&["scripts", "unpin", &dev_id], 0)["pinned"], false);
    assert_eq!(e.json(&["scripts", "archive", &build_id], 0)["archived"], true);
    assert_eq!(e.json(&["scripts", "list"], 0).as_array().unwrap().len(), 1);
    assert_eq!(e.json(&["scripts", "list", "--include-archived"], 0).as_array().unwrap().len(), 2);
    assert_eq!(e.json(&["scripts", "unarchive", &build_id], 0)["archived"], false);
    assert_eq!(e.json(&["scripts", "search", "cargo"], 0).as_array().unwrap().len(), 1);

    // ---- get-command
    let rc = e.json(&["scripts", "get-command", &build_id, "--platform", "linux"], 0);
    insta::assert_json_snapshot!("get_command", e.redact(rc));
    let (code, out, _) = e.cli(&["scripts", "get-command", &build_id, "--platform", "linux"]);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), "rustup show && cargo build");
    let err = e.json(&["scripts", "get-command", &build_id, "--platform", "windows"], 1);
    assert_eq!(err["code"], "unsupported");

    // ---- environments: referenced by name, resolved on this machine
    let env = e.json(&["scripts", "env-add", "Node LTS", "--shell", "bash", "--init", "nvm use --lts", "--env", "NODE_ENV=development"], 0);
    insta::assert_json_snapshot!("env_add", e.redact(env.clone()));
    insta::assert_json_snapshot!("env_list", e.redact(e.json(&["scripts", "env-list"], 0)));
    assert_eq!(e.json(&["scripts", "env-get", "node lts"], 0)["id"], env["id"]);
    let err = e.json(&["scripts", "env-add", "NODE LTS", "--shell", "sh"], 4);
    assert_eq!(err["code"], "conflict");
    e.json(&["scripts", "update", &build_id, "--environment", "Node LTS"], 0);
    let rc = e.json(&["scripts", "get-command", &build_id, "--platform", "linux"], 0);
    assert_eq!(rc["fullCommand"], "export NODE_ENV='development' && nvm use --lts && rustup show && cargo build");
    assert_eq!(rc["environment"]["name"], "Node LTS");
    e.json(&["scripts", "update", &build_id, "--environment", "Missing Env"], 0);
    let err = e.json(&["scripts", "get-command", &build_id, "--platform", "linux"], 3);
    assert_eq!(err["code"], "not_found");

    let detected = e.json(&["scripts", "env-detect"], 0);
    let list = detected.as_array().unwrap();
    assert!(list.iter().any(|x| x["builtIn"] == true), "{detected}");
    assert!(list.iter().any(|x| x["name"] == "Node LTS" && x["builtIn"] == false));
    let del = e.json(&["scripts", "env-delete", "Node LTS"], 0);
    assert_eq!(del["deleted"], env["id"]);
    assert_eq!(e.json(&["scripts", "env-get", "Node LTS"], 3)["code"], "not_found");

    // ---- groups on a fresh project
    insta::assert_json_snapshot!("groups_list_empty", e.json(&["scripts", "groups", "list"], 0));
    let g = e.json(&["scripts", "groups", "create", "Full stack", "--description", "everything", "--script", &dev_id], 0);
    let gid = id_of(&g);
    let g = e.json(&["scripts", "groups", "add", &gid, &build_id, "--delay-ms", "1500", "--order", "0"], 0);
    insta::assert_json_snapshot!("groups_add", e.redact(g));
    let g = e.json(&["scripts", "groups", "update", &gid, "--mode", "sequential", "--clear-description"], 0);
    insta::assert_json_snapshot!("groups_update", e.redact(g));
    insta::assert_json_snapshot!("groups_get", e.redact(e.json(&["scripts", "groups", "get", &gid], 0)));
    insta::assert_json_snapshot!("groups_list", e.redact(e.json(&["scripts", "groups", "list"], 0)));
    let err = e.json(&["scripts", "groups", "add", &gid, &build_id], 4);
    assert_eq!(err["code"], "conflict");
    let g = e.json(&["scripts", "groups", "remove", &gid, &build_id], 0);
    assert_eq!(g["members"].as_array().unwrap().len(), 1);
    assert_eq!(e.json(&["scripts", "groups", "remove", &gid, &build_id], 3)["code"], "not_found");

    // Deleting a script removes it from the group.
    let del = e.json(&["scripts", "delete", &dev_id], 0);
    assert_eq!(del["deleted"], dev_id.as_str());
    let g = e.json(&["scripts", "groups", "get", &gid], 0);
    assert!(g.get("members").is_none(), "{g}");
    assert_eq!(e.json(&["scripts", "groups", "delete", &gid], 0)["deleted"], gid.as_str());

    // ---- errors
    assert_eq!(e.json(&["scripts", "get", "../../etc"], 2)["code"], "invalid_input");
    assert_eq!(e.json(&["scripts", "get", "01h00000000000000000000000"], 3)["code"], "not_found");
    assert_eq!(e.json(&["scripts", "create", "x", "--command", "y", "--shell", "fish"], 2)["code"], "invalid_input");
    assert_eq!(e.json(&["scripts", "create", "x", "--command", "y", "--working-directory", "../up"], 2)["code"], "invalid_input");
    assert_eq!(e.json(&["scripts", "update", &build_id, "--clear", "bogus"], 2)["code"], "invalid_input");
    assert_eq!(e.json(&["scripts", "groups", "create", "g", "--mode", "random"], 2)["code"], "invalid_input");
    let elsewhere = e._tmp.path().join("nowhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    assert_eq!(
        e.json(&["scripts", "list", "--project", elsewhere.to_str().unwrap()], 5)["code"],
        "project_not_found"
    );

    // Human output works too.
    let (code, out, _) = e.cli(&["scripts", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains("Build"), "{out}");
    assert!(Path::new(&e.proj).join(".quadflow-dev").join("scripts").join(format!("{build_id}.json")).is_file());
}
