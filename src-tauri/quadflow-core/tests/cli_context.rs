//! `quadflow context …` / `quadflow docs …` contract (agent-providers.md §7.2).

mod common;

use common::TempProject;
use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

fn cli(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
    // `docs` / `context` read the plugin registry: keep it off the real data dir.
    let data = cwd.join(".qf-test-data");
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

/// Every domain doc moved into its plugin (MIG-*): give the test a bundled
/// plugin `docsy` with one agent context doc in the resource dir `cli()` uses.
fn docs_plugin(cwd: &Path) {
    let dir = cwd.join(".qf-test-data").join("res").join("plugins").join("docsy");
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    let manifest = serde_json::json!({
        "id": "docsy", "name": "Docsy", "version": "1.0.0", "apiVersion": "^1.0.0",
        "platforms": ["windows", "macos", "linux"],
        "contributes": {"agentContextDocs": [{"id": "docsy", "title": "Docsy", "file": "docs/agent.md"}]}
    });
    std::fs::write(dir.join("quadflow-plugin.json"), manifest.to_string()).unwrap();
    std::fs::write(dir.join("docs/agent.md"), "# Docsy\n\nRun `quadflow docsy`.\n").unwrap();
}

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not one JSON document ({e}): {s}"))
}

#[test]
fn context_files_modules_and_sync() {
    let p = TempProject::new();
    let root = p.store.root().path.clone();
    docs_plugin(&root);
    std::fs::write(root.join("AGENTS.md"), "# Agents\n\nMine.\n").unwrap();

    let (code, out, _) = cli(&root, &["context", "list", "--json"]);
    assert_eq!(code, 0);
    let v = json(&out);
    assert_eq!(v["data"]["modules"][0]["id"], "quadflow");
    assert_eq!(v["data"]["modules"][0]["enabled"], true);
    assert!(v["data"]["files"].as_array().unwrap().is_empty());

    let (code, out, _) = cli(&root, &["context", "files", "add", "AGENTS.md", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json(&out)["data"]["files"][0]["file"], "AGENTS.md");
    let (code, _, _) = cli(&root, &["context", "files", "add", "../evil.md", "--json"]);
    assert_eq!(code, 2);

    let (code, _, _) = cli(&root, &["context", "enable", "docsy", "--json"]);
    assert_eq!(code, 0);
    let agents = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
    assert!(agents.starts_with("# Agents\n\nMine.\n"));
    assert!(agents.contains("# Docsy"));

    let (code, out, _) = cli(&root, &["context", "enable", "nope", "--json"]);
    assert_eq!(code, 3);
    assert_eq!(json(&out)["error"]["code"], "not_found");

    let (code, _, _) = cli(&root, &["context", "reset"]);
    assert_eq!(code, 0);
    assert!(!std::fs::read_to_string(root.join("AGENTS.md")).unwrap().contains("# Docsy"));

    // Dangling marker: sync fails (corrupt), --repair fixes it.
    let broken = format!("top\n{}\nhalf", quadflow_core::context::writer::MARKER_START);
    std::fs::write(root.join("AGENTS.md"), broken).unwrap();
    let (code, out, _) = cli(&root, &["context", "sync", "--json"]);
    assert_ne!(code, 0);
    assert_eq!(json(&out)["error"]["code"], "corrupt");
    let (code, _, _) = cli(&root, &["context", "sync", "--repair"]);
    assert_eq!(code, 0);

    let (code, _, _) = cli(&root, &["context", "files", "remove", "AGENTS.md"]);
    assert_eq!(code, 0);
}

#[test]
fn docs_list_and_module() {
    let p = TempProject::new();
    let root = p.store.root().path.clone();
    docs_plugin(&root);
    let (code, out, _) = cli(&root, &["docs", "--list", "--json"]);
    assert_eq!(code, 0);
    let ids: Vec<String> = json(&out)["data"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
    assert!(ids.contains(&"quadflow".to_string()) && ids.contains(&"docsy".to_string()));
    let (code, out, _) = cli(&root, &["docs", "quadflow"]);
    assert_eq!(code, 0);
    assert!(out.contains("quadflow docs"));
}
