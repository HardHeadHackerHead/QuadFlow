//! CLI JSON contract for `quadflow discovery …` (data-layer.md §11, §12.3): one
//! snapshot of `data` per subcommand, envelope + exit codes, error contract.
//! Snapshots live in `tests/snapshots/cli_discovery__*.snap`.

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
        let dir = tmp.path().join("discovery-proj");
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
            ".**.discoveryId" => "[id]",
        })
    };
}

#[test]
fn every_subcommand_contract() {
    let p = Proj::new();

    let a = p.ok(&[
        "discovery", "create", "Mobile app", "--overview", "Ship a companion app",
        "--goal", "Offline mode", "--goal", "Push notifications", "--criterion", "1k weekly users",
    ]);
    snap!("create", &a);
    assert_eq!(a["status"], "discovery");
    let a_id = id(&a);
    let b = p.ok(&["discovery", "create", "Billing rework", "--status", "planning"]);
    let b_id = id(&b);

    snap!("list", &p.ok(&["discovery", "list"]));
    snap!("list_filtered", &p.ok(&["discovery", "list", "--status", "planning"]));
    assert_eq!(p.ok(&["discovery", "list", "--text", "MOBILE"]).as_array().unwrap().len(), 1);

    snap!("update", &p.ok(&["discovery", "update", &a_id, "--title", "Mobile companion", "--status", "in_progress", "--goal", "Offline mode"]));
    snap!("update_clear", &p.ok(&["discovery", "update", &a_id, "--overview", "", "--no-criteria"]));

    let r = p.ok(&["discovery", "item-add", &a_id, "--kind", "research", "--title", "Sync engines", "--status", "pending"]);
    let r_id = id(&r["items"][0]);
    let q = p.ok(&["discovery", "item-add", &a_id, "--item-type", "question", "--title", "iOS first?"]);
    let q_id = id(&q["items"][1]);
    let f = p.ok(&[
        "discovery", "item-add", &a_id, "--kind", "reference", "--title", "Design doc",
        "--content", "Figma board", "--metadata", r#"{"url":"https://example.com/design"}"#,
    ]);
    snap!("item_add", &f);
    let f_id = id(&f["items"][2]);
    snap!("item_update", &p.ok(&["discovery", "item-update", &a_id, &q_id, "--status", "answered", "--content", "Yes, iOS first"]));
    snap!("item_update_clear", &p.ok(&["discovery", "item-update", &a_id, &f_id, "--metadata", "", "--content", ""]));
    snap!("items_reorder", &p.ok(&["discovery", "items-reorder", &a_id, &format!("{f_id},{q_id}")]));
    snap!("item_delete", &p.ok(&["discovery", "item-delete", &a_id, &r_id]));
    snap!("get", &p.ok(&["discovery", "get", &a_id]));

    // Links are set on the idea (`ideas update --discovery`).
    let idea = p.ok(&["ideas", "create", "Widget support", "--discovery", &a_id]);
    let idea_id = id(&idea);
    snap!("linked", &p.ok(&["discovery", "linked", &a_id]));
    assert_eq!(p.ok(&["discovery", "linked", &b_id])["ideas"], serde_json::json!([]));

    snap!("delete", &p.ok(&["discovery", "delete", &a_id]));
    p.fails(&["discovery", "get", &a_id], 3, "not_found");
    assert!(p.ok(&["ideas", "get", &idea_id]).get("discoveryId").is_none(), "delete clears the idea's link");
    assert_eq!(p.ok(&["discovery", "list"]).as_array().unwrap().len(), 1);
}

#[test]
fn error_contract() {
    let p = Proj::new();
    let a = id(&p.ok(&["discovery", "create", "x"]));
    let missing = "01jabcdefghjkmnpqrstvwxyz0";

    p.fails(&["discovery", "get", missing], 3, "not_found");
    p.fails(&["discovery", "get", "../../etc"], 2, "invalid_input");
    p.fails(&["discovery", "create", "   "], 2, "invalid_input");
    p.fails(&["discovery", "update", &a], 2, "invalid_input");
    p.fails(&["discovery", "update", &a, "--status", "done"], 2, "invalid_input");
    p.fails(&["discovery", "item-add", &a, "--kind", "idea", "--title", "t"], 2, "invalid_input");
    p.fails(&["discovery", "item-add", &a, "--kind", "note", "--title", "t", "--metadata", "{"], 2, "invalid_input");
    p.fails(&["discovery", "item-update", &a, missing, "--title", "t"], 3, "not_found");
    p.fails(&["discovery", "item-delete", &a, missing], 3, "not_found");
    p.fails(&["discovery", "items-reorder", &a, missing], 3, "not_found");
    p.fails(&["discovery", "linked", missing], 3, "not_found");
    p.fails(&["discovery", "delete", missing], 3, "not_found");

    // Outside a project -> exit 5.
    let empty = tempfile::tempdir().unwrap();
    let (code, out, _) = cli(empty.path(), &["discovery", "list", "--json"]);
    assert_eq!(code, 5, "{out}");
    assert_eq!(json(&out)["error"]["code"], "project_not_found");

    // Corrupt file -> listed as a warning, others still returned.
    let bad = p.dir.join(".quadflow-dev").join("discovery").join(format!("{missing}.json"));
    std::fs::write(&bad, "{ nope").unwrap();
    let (code, out, err) = p.raw(&["discovery", "list", "--json"]);
    assert_eq!(code, 0);
    let v = json(&out);
    assert_eq!(v["data"].as_array().unwrap().len(), 1);
    assert_eq!(v["warnings"].as_array().unwrap().len(), 1);
    assert!(err.contains("warning: could not read"), "{err}");

    // Human output: full ids, exit 0.
    let (code, out, _) = p.raw(&["discovery", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains(&a), "{out}");
    let (code, out, _) = p.raw(&["discovery", "delete", &a]);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), format!("Deleted discovery project {a}"));
}
