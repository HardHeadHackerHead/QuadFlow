//! CLI JSON contract for `quadflow issues|labels|epics` (data-layer.md §11, §12.3):
//! envelope, exit codes and `data` snapshots for every subcommand.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Proj {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
}

fn project() -> Proj {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("web-api");
    std::fs::create_dir_all(&dir).unwrap();
    let (code, out, _) = cli_raw(&dir, &["init", "--json"]);
    assert_eq!(code, 0, "{out}");
    Proj { _tmp: tmp, dir }
}

fn cli_raw(cwd: &Path, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
    vars.insert("QUADFLOW_ACTOR_NAME".to_string(), "test-agent".to_string());
    let env = CliEnv { cwd: cwd.to_path_buf(), vars };
    let code = {
        let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
        let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
        run(argv, &mut io, &env)
    };
    (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
}

/// Run with `--json`; assert exit code and envelope; return the whole document.
fn j(p: &Proj, expect: i32, args: &[&str]) -> Value {
    let mut a = args.to_vec();
    a.push("--json");
    let (code, out, err) = cli_raw(&p.dir, &a);
    let v: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("not one JSON document ({e}): {out} / {err}"));
    assert_eq!(code, expect, "{args:?} → {out}");
    assert_eq!(v["ok"], expect == 0, "{out}");
    v
}

fn ok(p: &Proj, args: &[&str]) -> Value {
    j(p, 0, args)["data"].clone()
}

/// Redact every element of an id list. (`.**.blockedBy[]` is wrong: insta's
/// deep-wildcard matcher only compares the selector's tail, so `[]` alone
/// matches every top-level array element and blanked whole list snapshots.)
fn ids_redaction() -> insta::internals::Redaction {
    insta::dynamic_redaction(|value, _| match value {
        insta::internals::Content::Seq(v) => {
            insta::internals::Content::Seq(v.into_iter().map(|_| "[id]".into()).collect())
        }
        other => other,
    })
}

macro_rules! snap {
    ($name:expr, $v:expr) => {
        insta::assert_json_snapshot!($name, $v, {
            ".id" => "[id]",
            ".**.id" => "[id]",
            "[].id" => "[id]",
            ".**.createdAt" => "[ts]",
            ".**.updatedAt" => "[ts]",
            ".**.at" => "[ts]",
            ".**.assignedAt" => "[ts]",
            ".**.lastHeartbeat" => "[ts]",
            ".**.blockedBy" => ids_redaction(),
            ".**.dependsOn" => ids_redaction(),
            ".**.parentId" => "[id]",
            ".**.epicId" => "[id]",
        });
    };
}

#[test]
fn issues_contract() {
    let p = project();

    let a = ok(&p, &["issues", "create", "Login page", "--priority", "high", "--labels", "ui,auth", "--criterion", "renders", "--user-story", "As a user I log in"]);
    snap!("create", &a);
    assert_eq!(a["number"], 1);
    assert_eq!(a["status"], "todo");
    assert_eq!(a["createdBy"]["name"], "test-agent");
    let b = ok(&p, &["issues", "create", "Session store", "--blocked-by", "WEB-1", "--status", "blocked"]);
    assert_eq!(b["blockedBy"][0], a["id"]);

    snap!("get", &ok(&p, &["issues", "get", "web-1"]));
    snap!("list", &ok(&p, &["issues", "list"]));
    assert_eq!(ok(&p, &["issues", "list", "--status", "blocked"]).as_array().unwrap().len(), 1);
    assert_eq!(ok(&p, &["issues", "list", "--label", "ui"]).as_array().unwrap().len(), 1);
    assert_eq!(ok(&p, &["issues", "list", "--search", "session"]).as_array().unwrap().len(), 1);

    snap!("update", &ok(&p, &["issues", "update", "#1", "--title", "Login", "--body", "markdown", "--priority", "critical"]));
    let cleared = ok(&p, &["issues", "update", "1", "--body", "", "--user-story", ""]);
    assert!(cleared.get("body").is_none() && cleared.get("userStory").is_none());

    snap!("status", &ok(&p, &["issues", "status", "WEB-1", "review"]));
    snap!("label", &ok(&p, &["issues", "label", "WEB-1", "backend"]));
    snap!("unlabel", &ok(&p, &["issues", "unlabel", "WEB-1", "ui"]));
    let c = ok(&p, &["issues", "comment", "WEB-1", "--body", "Looks good"]);
    snap!("comment", &c);
    snap!("comments", &ok(&p, &["issues", "comments", "WEB-1"]));
    let comment_id = c["comments"][0]["id"].as_str().unwrap().to_string();
    assert!(ok(&p, &["issues", "delete-comment", "WEB-1", &comment_id]).get("comments").is_none());
    let crit = a["acceptanceCriteria"][0]["id"].as_str().unwrap().to_string();
    snap!("criterion", &ok(&p, &["issues", "criterion", "WEB-1", &crit]));

    // claim / heartbeat / release (on the blocked issue: status stays blocked).
    snap!("claim", &ok(&p, &["issues", "claim", "WEB-2", "--agent-label", "agent A", "--terminal-id", "t1", "--session-id", "s-1"]));
    let v = j(&p, 4, &["issues", "claim", "WEB-2", "--agent-label", "agent B", "--terminal-id", "t2"]);
    assert_eq!(v["error"]["code"], "conflict");
    assert!(ok(&p, &["issues", "heartbeat", "WEB-2"])["assignment"].is_object());
    assert!(ok(&p, &["issues", "release", "WEB-2"]).get("assignment").is_none());
    assert_eq!(j(&p, 4, &["issues", "heartbeat", "WEB-2"])["error"]["code"], "conflict");
    let v = j(&p, 2, &["issues", "claim", "WEB-2", "--agent-label", "x", "--session-id", "a b"]);
    assert_eq!(v["error"]["code"], "invalid_input");

    // children / blocking
    ok(&p, &["issues", "create", "Child", "--parent", "WEB-1"]);
    assert_eq!(ok(&p, &["issues", "children", "WEB-1"]).as_array().unwrap().len(), 1);
    snap!("blocking", &ok(&p, &["issues", "blocking", "WEB-2"]));

    // close → done + cascade unblock; reopen → todo.
    let closed = ok(&p, &["issues", "close", "WEB-1"]);
    assert_eq!(closed["status"], "done");
    let unblocked = ok(&p, &["issues", "get", "WEB-2"]);
    assert_eq!(unblocked["status"], "todo");
    assert!(unblocked.get("blockedBy").is_none());
    assert_eq!(ok(&p, &["issues", "list"]).as_array().unwrap().len(), 2, "done hidden by default");
    assert_eq!(ok(&p, &["issues", "list", "--include-done"]).as_array().unwrap().len(), 3);
    assert_eq!(ok(&p, &["issues", "reopen", "WEB-1"])["status"], "todo");

    snap!("delete", &ok(&p, &["issues", "delete", "WEB-3"]));
    assert_eq!(ok(&p, &["issues", "create", "After delete"])["number"], 4, "numbers never reused");

    // Error contract.
    let v = j(&p, 3, &["issues", "get", "QX-999"]);
    assert_eq!(v["error"]["code"], "not_found");
    assert_eq!(j(&p, 3, &["issues", "get", "WEB-999"])["error"]["code"], "not_found");
    assert_eq!(j(&p, 2, &["issues", "status", "WEB-1", "bogus"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["issues", "list", "--status", "todo,bogus"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["issues", "create", "  "])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["issues", "get", "../../etc"])["error"]["code"], "invalid_input");

    // Human output uses display refs.
    let (code, out, _) = cli_raw(&p.dir, &["issues", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains("WEB-1") && out.contains("WEB-2"), "{out}");
    let (code, out, _) = cli_raw(&p.dir, &["issues", "get", "WEB-2"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("WEB-2  Session store"), "{out}");
}

#[test]
fn labels_and_epics_contract() {
    let p = project();
    snap!("labels_upsert", &ok(&p, &["labels", "upsert", "bug", "--color", "#FF0000", "--description", "Broken things"]));
    ok(&p, &["issues", "create", "x", "--labels", "bug"]);
    snap!("labels_rename", &ok(&p, &["labels", "upsert", "defect", "--rename-from", "bug"]));
    assert_eq!(ok(&p, &["issues", "get", "1"])["labels"][0], "defect");
    snap!("labels_list", &ok(&p, &["labels", "list"]));
    assert_eq!(j(&p, 2, &["labels", "upsert", "x", "--color", "red"])["error"]["code"], "invalid_input");
    assert_eq!(ok(&p, &["labels", "delete", "defect"]), serde_json::json!([]));
    assert!(ok(&p, &["issues", "get", "1"]).get("labels").is_none());
    assert_eq!(j(&p, 3, &["labels", "delete", "defect"])["error"]["code"], "not_found");

    let e = ok(&p, &["epics", "create", "Auth", "--priority", "high", "--description", "All auth work"]);
    snap!("epics_create", &e);
    let id = e["id"].as_str().unwrap().to_string();
    snap!("epics_get", &ok(&p, &["epics", "get", &id]));
    snap!("epics_update", &ok(&p, &["epics", "update", &id, "--status", "in-progress", "--description", ""]));
    snap!("epics_list", &ok(&p, &["epics", "list"]));
    ok(&p, &["issues", "update", "1", "--epic", &id]);
    assert_eq!(ok(&p, &["issues", "list", "--epic", &id]).as_array().unwrap().len(), 1);
    snap!("epics_delete", &ok(&p, &["epics", "delete", &id]));
    assert!(ok(&p, &["issues", "get", "1"]).get("epicId").is_none());
    assert_eq!(j(&p, 3, &["epics", "get", &id])["error"]["code"], "not_found");
    assert_eq!(j(&p, 2, &["epics", "get", "nope"])["error"]["code"], "invalid_input");
}

#[test]
fn outside_a_project_exits_5() {
    let tmp = tempfile::tempdir().unwrap();
    for cmd in [&["issues", "list", "--json"][..], &["labels", "list", "--json"], &["epics", "list", "--json"]] {
        let (code, out, _) = cli_raw(tmp.path(), cmd);
        assert_eq!(code, 5, "{cmd:?}: {out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["error"]["code"], "project_not_found");
    }
}
