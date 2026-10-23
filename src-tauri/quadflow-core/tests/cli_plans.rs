//! CLI JSON contract for `quadflow plans` (data-layer.md §11, §12.3): envelope,
//! exit codes and `data` snapshots for every subcommand.

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

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
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
            ".**.startedAt" => "[ts]",
            ".**.completedAt" => "[ts]",
            ".**.at" => "[ts]",
            ".**.parentId" => "[id]",
            ".**.dependsOn" => ids_redaction(),
            ".**.blockedBy" => ids_redaction(),
            ".**.issueId" => "[id]",
            ".**.epicId" => "[id]",
            ".**.planId" => "[id]",
            ".**.stepId" => "[id]",
        });
    };
}

#[test]
fn plans_contract() {
    let p = project();

    let plan = ok(&p, &[
        "plans", "create", "Auth rewrite", "--description", "Replace sessions", "--spec-content", "# Spec",
        "--spec-type", "refactor", "--decision", "JWT: stateless", "--risk-notes", "token theft",
    ]);
    snap!("create", &plan);
    assert_eq!(plan["status"], "spec_draft");
    assert_eq!(plan["createdBy"]["name"], "test-agent");
    let pid = s(&plan["id"]);
    // Skills' older form: `create --title`.
    assert_eq!(ok(&p, &["plans", "create", "--title", "Other"])["title"], "Other");

    snap!("list", &ok(&p, &["plans", "list"]));
    assert_eq!(ok(&p, &["plans", "list", "--search", "sessions"]).as_array().unwrap().len(), 1);
    assert_eq!(ok(&p, &["plans", "list", "--status", "draft"]).as_array().unwrap().len(), 2);
    snap!("get", &ok(&p, &["plans", "get", &pid]));

    snap!("update", &ok(&p, &["plans", "update", &pid, "--status", "ready", "--title", "Auth v2", "--context", "ctx"]));
    let cleared = ok(&p, &["plans", "update", &pid, "--description", "", "--risk-notes", "", "--spec-content", "", "--clear-decisions"]);
    for k in ["description", "riskNotes", "spec", "decisions"] {
        assert!(cleared.get(k).is_none(), "{k} not cleared: {cleared}");
    }

    // Discovery link (DL-5 reads `discoveryId`).
    let disc = s(&ok(&p, &["discovery", "create", "Auth discovery"])["id"]);
    assert_eq!(ok(&p, &["plans", "update", &pid, "--discovery", &disc])["discoveryId"], disc.as_str());
    assert_eq!(ok(&p, &["plans", "list", "--discovery", &disc]).as_array().unwrap().len(), 1);
    assert_eq!(ok(&p, &["discovery", "linked", &disc])["plans"].as_array().unwrap().len(), 1);
    assert!(ok(&p, &["plans", "update", &pid, "--discovery", "none"]).get("discoveryId").is_none());

    // Steps.
    let a = ok(&p, &[
        "plans", "step-add", &pid, "Backend", "--kind", "implement", "--effort", "high", "--criterion", "API works",
        "--target-files", "src/api.rs,src/db.rs",
    ]);
    snap!("step_add", &a);
    let backend = s(&a["steps"][0]["id"]);
    let b = ok(&p, &["plans", "step-add", &pid, "--title", "Endpoints", "--parent", &backend]);
    let endpoints = s(&b["steps"][1]["id"]);
    let c = ok(&p, &["plans", "step-add", &pid, "Tests", "--parent", &backend, "--depends-on", &endpoints, "--step-type", "test"]);
    let tests = s(&c["steps"][2]["id"]);
    let d = ok(&p, &["plans", "step-add", &pid, "Docs", "--estimated-effort", "low"]);
    let docs = s(&d["steps"][3]["id"]);

    snap!("step_update", &ok(&p, &["plans", "step-update", &docs, "--notes", "later", "--code-context", "fn x()", "--estimated-hours", "2"]));
    let cl = ok(&p, &["plans", "step-update", &docs, "--plan", &pid, "--notes", "", "--code-context", "none", "--estimated-hours", ""]);
    let st = &cl["steps"][3];
    assert!(st.get("notes").is_none() && st.get("codeContext").is_none() && st.get("estimatedHours").is_none(), "{st}");
    let r = ok(&p, &["plans", "steps-reorder", &pid, &format!("{docs},{backend}")]);
    snap!("steps_reorder", &r);
    assert_eq!(r["steps"][0]["title"], "Docs");
    ok(&p, &["plans", "step-update", &docs, "--status", "skip"]);

    // Comments.
    let cm = ok(&p, &["plans", "comment", &pid, "--body", "Review: fine", "--comment-type", "review"]);
    snap!("comment", &cm);
    snap!("comments", &ok(&p, &["plans", "comments", &pid]));
    let cid = s(&cm["comments"][0]["id"]);
    assert!(ok(&p, &["plans", "comment-delete", &pid, &cid]).get("comments").is_none());

    // Promotion: epics for parent steps, blockers from dependsOn, skipped steps left out.
    let pr = ok(&p, &["plans", "promote", &pid]);
    snap!("promote", &pr);
    assert_eq!(pr["created"], 3);
    assert_eq!(pr["epics"].as_array().unwrap().len(), 1);
    assert_eq!(pr["issues"].as_array().unwrap().len(), 2);
    let again = ok(&p, &["plans", "promote", &pid]);
    assert_eq!(again["created"], 0, "promote is idempotent");
    assert_eq!(again["issues"], pr["issues"]);
    assert_eq!(ok(&p, &["issues", "list", "--include-done"]).as_array().unwrap().len(), 2);
    let one = ok(&p, &["plans", "promote", &pid, "--step", &tests]);
    assert_eq!(one["created"], 0);
    let tests_issue = one["issues"][0].clone();
    assert_eq!(tests_issue["blockedBy"].as_array().unwrap().len(), 1);

    // Issue status → step status (same transaction), and the plan auto-transitions.
    let issues = ok(&p, &["issues", "list", "--include-done"]);
    let ep_issue = issues.as_array().unwrap().iter().find(|i| i["title"] == "Endpoints").unwrap().clone();
    ok(&p, &["issues", "status", &s(&ep_issue["id"]), "in_progress"]);
    let g = ok(&p, &["plans", "get", &pid]);
    let ep_step = g["steps"].as_array().unwrap().iter().find(|st| st["id"] == endpoints.as_str()).unwrap();
    assert_eq!(ep_step["status"], "in_progress");
    assert_eq!(g["status"], "executing");
    // Step status → issue status.
    let u = ok(&p, &["plans", "step-update", &tests, "--status", "done"]);
    assert!(u["steps"].as_array().unwrap().iter().any(|st| st["id"] == tests.as_str() && st["status"] == "completed"));
    assert_eq!(ok(&p, &["issues", "get", &s(&tests_issue["id"])])["status"], "done");

    snap!("step_delete", &ok(&p, &["plans", "step-delete", &docs]));
    snap!("delete", &ok(&p, &["plans", "delete", &pid]));
    assert_eq!(j(&p, 3, &["plans", "get", &pid])["error"]["code"], "not_found");

    // Error contract.
    assert_eq!(j(&p, 2, &["plans", "get", "../x"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["plans", "update", &pid, "--status", "bogus"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["plans", "create", " "])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["plans", "create"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 3, &["plans", "step-update", &docs, "--title", "x"])["error"]["code"], "not_found");

    // Human output.
    let other = s(&ok(&p, &["plans", "list"])[0]["id"]);
    ok(&p, &["plans", "step-add", &other, "First step"]);
    let (code, out, _) = cli_raw(&p.dir, &["plans", "get", &other]);
    assert_eq!(code, 0);
    assert!(out.contains("Other") && out.contains("1. [pending] First step"), "{out}");
    let (code, out, _) = cli_raw(&p.dir, &["plans", "promote", &other]);
    assert_eq!(code, 0);
    assert!(out.contains("WEB-3  First step"), "{out}");
}

#[test]
fn outside_a_project_exits_5() {
    let tmp = tempfile::tempdir().unwrap();
    let (code, out, _) = cli_raw(tmp.path(), &["plans", "list", "--json"]);
    assert_eq!(code, 5, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["error"]["code"], "project_not_found");
}
