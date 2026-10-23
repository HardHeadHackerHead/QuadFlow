//! CLI JSON contract for `quadflow ideas …` (data-layer.md §11, §12.3): one
//! snapshot of `data` per subcommand, envelope + exit codes, error contract.
//! Snapshots live in `tests/snapshots/cli_ideas__*.snap`.

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
        let dir = tmp.path().join("ideas-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let p = Proj { _tmp: tmp, dir };
        let (code, out, _) = p.raw(&["init", "--json"]);
        assert_eq!(code, 0, "{out}");
        p
    }

    fn raw(&self, args: &[&str]) -> (i32, String, String) {
        cli(&self.dir, args)
    }

    /// Run with `--json`, assert exit 0 + ok envelope, return `data`.
    fn ok(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (code, out, err) = self.raw(&a);
        assert_eq!(code, 0, "{args:?}\nstdout: {out}\nstderr: {err}");
        let v = json(&out);
        assert_eq!(v["ok"], true, "{out}");
        assert!(v.get("warnings").is_none(), "{out}");
        v["data"].clone()
    }

    /// Run with `--json`, expect failure with `code` / `exit`.
    fn fails(&self, args: &[&str], exit: i32, code: &str) {
        let mut a = args.to_vec();
        a.push("--json");
        let (c, out, _) = self.raw(&a);
        assert_eq!(c, exit, "{args:?}: {out}");
        let v = json(&out);
        assert_eq!(v["ok"], false, "{out}");
        assert_eq!(v["error"]["code"], code, "{out}");
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

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

/// Snapshot `data` with ids and timestamps redacted.
macro_rules! snap {
    ($name:expr, $v:expr) => {
        insta::assert_json_snapshot!($name, $v, {
            ".id" => "[id]",
            ".**.id" => "[id]",
            "[].id" => "[id]",
            ".**.createdAt" => "[ts]",
            ".**.updatedAt" => "[ts]",
            ".**.at" => "[ts]",
        })
    };
}

/// Replace ULIDs and epoch-ms / formatted timestamps in free text.
fn scrub(s: &str) -> String {
    let ulid = regex::Regex::new(r"[0-9a-hjkmnp-tv-z]{26}").unwrap();
    let ms = regex::Regex::new(r"\b1\d{12}\b").unwrap();
    let date = regex::Regex::new(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC").unwrap();
    let s = ulid.replace_all(s, "[id]");
    let s = ms.replace_all(&s, "[ts]");
    date.replace_all(&s, "[date]").into_owned()
}

#[test]
fn every_subcommand_contract() {
    let p = Proj::new();

    let a = p.ok(&["ideas", "create", "Dark mode", "--tag", "UI", "--tag", "theme"]);
    snap!("create", &a);
    assert_eq!(a["createdBy"], serde_json::json!({"kind": "agent", "name": "cli"}));
    let a_id = id(&a);
    let b = p.ok(&["ideas", "create", "Faster startup", "--tags", "perf,ui"]);
    let b_id = id(&b);

    snap!("list", &p.ok(&["ideas", "list"]));
    snap!("list_filtered", &p.ok(&["ideas", "list", "--tag", "perf"]));
    snap!("search_alias", &p.ok(&["ideas", "search", "--query", "dark"]));
    snap!("get", &p.ok(&["ideas", "get", &a_id]));

    snap!("update", &p.ok(&["ideas", "update", &a_id, "--content", "Dark mode toggle", "--tags", "ui,theme,settings"]));
    snap!("update_positional", &p.ok(&["ideas", "update", &a_id, "Dark mode toggle in settings"]));
    snap!("add_tag", &p.ok(&["ideas", "add-tag", &a_id, "Beta"]));
    snap!("tag_alias", &p.ok(&["ideas", "tag", &a_id, "gamma"]));
    snap!("remove_tag", &p.ok(&["ideas", "remove-tag", &a_id, "beta"]));
    snap!("untag_alias", &p.ok(&["ideas", "untag", &a_id, "gamma"]));
    snap!("bulk_tag", &p.ok(&["ideas", "bulk-tag", &format!("{a_id},{b_id}"), "sprint"]));
    snap!("archive", &p.ok(&["ideas", "archive", &b_id]));
    assert_eq!(p.ok(&["ideas", "list"]).as_array().unwrap().len(), 1);
    assert_eq!(p.ok(&["ideas", "list", "--include-archived"]).as_array().unwrap().len(), 2);
    snap!("unarchive", &p.ok(&["ideas", "unarchive", &b_id]));

    let n = p.ok(&["ideas", "add-note", &a_id, "Started in the settings panel"]);
    snap!("add_note", &n);
    let note_id = id(&n["notes"][0]);
    snap!("delete_note", &p.ok(&["ideas", "delete-note", &a_id, &note_id]));

    let s = p.ok(&["ideas", "add-suggestion", &a_id, "--kind", "clarify", "Add a dark mode switch to Settings"]);
    snap!("add_suggestion", &s);
    let s1 = id(&s["suggestions"][0]);
    snap!("resolve_suggestion_accept", &p.ok(&["ideas", "resolve-suggestion", &a_id, &s1, "--accept"]));
    p.fails(&["ideas", "resolve-suggestion", &a_id, &s1, "--reject"], 4, "conflict");
    let s = p.ok(&["ideas", "add-suggestion", &a_id, "Shorter"]);
    let s2 = id(&s["suggestions"][1]);
    snap!("resolve_suggestion_reject", &p.ok(&["ideas", "resolve-suggestion", &a_id, &s2, "--reject"]));
    snap!("delete_suggestion", &p.ok(&["ideas", "delete-suggestion", &a_id, &s2]));
    snap!("revert", &p.ok(&["ideas", "revert", &a_id]));

    snap!("stats", &p.ok(&["ideas", "stats"]));
    let ex = p.ok(&["ideas", "export", "--format", "json"]);
    let parsed: Value = serde_json::from_str(ex.as_str().unwrap()).unwrap();
    snap!("export_json", &parsed);
    insta::assert_snapshot!("export_markdown", scrub(p.ok(&["ideas", "export"]).as_str().unwrap()));
    insta::assert_snapshot!("export_csv", scrub(p.ok(&["ideas", "export", "--format", "csv"]).as_str().unwrap()));

    snap!("merge", &p.ok(&["ideas", "merge", &format!("{a_id},{b_id}"), &a_id]));
    p.fails(&["ideas", "get", &b_id], 3, "not_found");

    snap!("delete", &p.ok(&["ideas", "delete", &a_id]));
    assert_eq!(p.ok(&["ideas", "list", "--include-archived"]), serde_json::json!([]));
}

#[test]
fn error_contract() {
    let p = Proj::new();
    let a = id(&p.ok(&["ideas", "create", "x"]));
    let missing = "01jabcdefghjkmnpqrstvwxyz0";

    p.fails(&["ideas", "get", missing], 3, "not_found");
    p.fails(&["ideas", "get", "../../etc"], 2, "invalid_input");
    p.fails(&["ideas", "create", "   "], 2, "invalid_input");
    p.fails(&["ideas", "add-tag", &a, " "], 2, "invalid_input");
    p.fails(&["ideas", "update", &a], 2, "invalid_input");
    p.fails(&["ideas", "bulk-tag", &format!("{a},{missing}"), "t"], 3, "not_found");
    p.fails(&["ideas", "merge", &a, &a], 2, "invalid_input");
    p.fails(&["ideas", "add-suggestion", &a, "--kind", "rewrite", "t"], 2, "invalid_input");
    p.fails(&["ideas", "resolve-suggestion", &a, missing, "--accept"], 3, "not_found");
    p.fails(&["ideas", "delete", missing], 3, "not_found");
    p.fails(&["ideas", "export", "--format", "xml"], 2, "invalid_input");

    // Outside a project → exit 5.
    let empty = tempfile::tempdir().unwrap();
    let (code, out, _) = cli(empty.path(), &["ideas", "list", "--json"]);
    assert_eq!(code, 5, "{out}");
    assert_eq!(json(&out)["error"]["code"], "project_not_found");

    // Corrupt file → listed as a warning, other ideas still returned.
    let bad = p.dir.join(".quadflow-dev").join("ideas").join(format!("{missing}.json"));
    std::fs::write(&bad, "{ nope").unwrap();
    let (code, out, err) = p.raw(&["ideas", "list", "--json"]);
    assert_eq!(code, 0);
    let v = json(&out);
    assert_eq!(v["data"].as_array().unwrap().len(), 1);
    assert_eq!(v["warnings"].as_array().unwrap().len(), 1);
    assert!(err.contains("warning: could not read"), "{err}");

    // Human output: full ids, exit 0.
    let (code, out, _) = p.raw(&["ideas", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains(&a), "{out}");
    let (code, out, _) = p.raw(&["ideas", "delete", &a]);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), format!("Deleted idea {a}"));
}
