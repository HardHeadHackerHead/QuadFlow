//! CLI JSON contract for `quadflow missions …` (data-layer.md §11, §12.3):
//! envelope, exit codes and `data` snapshots for every subcommand.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

struct Proj {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    data: PathBuf,
}

fn project() -> Proj {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("web-api");
    let data = tmp.path().join("appdata");
    std::fs::create_dir_all(&dir).unwrap();
    let p = Proj { _tmp: tmp, dir, data };
    let (code, out, _) = cli_raw(&p, &["init", "--json"]);
    assert_eq!(code, 0, "{out}");
    p
}

fn cli_raw(p: &Proj, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
    vars.insert("QUADFLOW_ACTOR_NAME".to_string(), "test-agent".to_string());
    vars.insert("QUADFLOW_DATA_DIR".to_string(), p.data.display().to_string());
    let env = CliEnv { cwd: p.dir.clone(), vars };
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
    let (code, out, err) = cli_raw(p, &a);
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

macro_rules! snap {
    ($name:expr, $v:expr) => {
        insta::assert_json_snapshot!($name, $v, {
            ".id" => "[id]",
            ".**.id" => "[id]",
            ".missionId" => "[id]",
            ".**.missionId" => "[id]",
            ".**.blockedBy" => "[ids]",
            ".**.memberId" => "[id]",
            ".**.fromMemberId" => "[id]",
            ".**.toMemberId" => "[id]",
            ".**.issueId" => "[id]",
            ".**.issueIds" => "[ids]",
            ".**.assignedIssueId" => "[id]",
            ".**.orchestratorMemberId" => "[id]",
            ".lastRead" => "[cursors]",
            ".**.messageId" => "[id]",
            ".**.proposalId" => "[id]",
            ".**.entryId" => "[id]",
            ".**.createdAt" => "[ts]",
            ".**.updatedAt" => "[ts]",
            ".**.startedAt" => "[ts]",
            ".**.completedAt" => "[ts]",
            ".**.mergedAt" => "[ts]",
            ".**.lastHeartbeat" => "[ts]",
            ".**.assignedAt" => "[ts]",
            ".**.at" => "[ts]",
        });
    };
}

#[test]
fn missions_contract() {
    let p = project();
    ok(&p, &["issues", "create", "Login page", "--priority", "high"]);
    ok(&p, &["issues", "create", "Logout", "--priority", "low"]);

    // templates / agents (built-ins merged at read time)
    let t = ok(&p, &["missions", "templates"]);
    assert_eq!(t.as_array().unwrap().len(), 8);
    snap!("templates_first", &t[0]);
    snap!("template", &ok(&p, &["missions", "template", "builtin-bug-bash"]));
    let custom = ok(&p, &["missions", "template-upsert", r#"{"name":"Mine","category":"ops","successCriteria":["green"]}"#]);
    snap!("template_upsert", &custom);
    snap!("template_delete", &ok(&p, &["missions", "template-delete", &s(&custom["id"])]));
    assert_eq!(j(&p, 4, &["missions", "template-delete", "builtin-bug-bash"])["error"]["code"], "conflict");

    let agents = ok(&p, &["missions", "agents"]);
    assert_eq!(agents.as_array().unwrap().len(), 12);
    snap!("agents_first", &agents[0]);
    let custom_agent = ok(&p, &["missions", "agent-upsert", "--name", "Reviewer", "--role", "qa", "--model", "opus"]);
    snap!("agent_upsert", &custom_agent);
    assert_eq!(ok(&p, &["missions", "agents"]).as_array().unwrap().len(), 13);
    snap!("agent_delete", &ok(&p, &["missions", "agent-delete", &s(&custom_agent["id"])]));
    assert_eq!(j(&p, 2, &["missions", "agent-upsert", "--name", "x", "--role", "qa", "--model", "x;rm"])["error"]["code"], "invalid_input");

    // mission lifecycle
    let m = ok(&p, &["missions", "create", "Sprint 1", "--template", "builtin-feature-build", "--mode", "persistent", "--issues", "WEB-1,#2"]);
    snap!("create", &m);
    let mid = s(&m["id"]);
    snap!("list", &ok(&p, &["missions", "list"]));
    snap!("get", &ok(&p, &["missions", "get", &mid]));
    snap!("issues", &ok(&p, &["missions", "issues", &mid]));
    snap!("progress", &ok(&p, &["missions", "progress", &mid]));

    let lead = ok(&p, &["missions", "member-add", &mid, "builtin-scrum-master", "--name", "Coordinator"]);
    snap!("member_add", &lead);
    let dev = ok(&p, &["missions", "member-add", &mid, "builtin-fullstack-dev", "--name", "Dev", "--model", "sonnet"]);
    snap!("members", &ok(&p, &["missions", "members", &mid]));
    snap!(
        "member_update",
        &ok(&p, &["missions", "member-update", &mid, "Dev", "--status", "spawning", "--branch", "agent/x/dev", "--worktree", "/tmp/dev", "--terminal", "t-1"])
    );
    snap!("heartbeat", &ok(&p, &["missions", "heartbeat", &mid, "Dev"]));
    snap!("update", &ok(&p, &["missions", "update", &mid, "--status", "active", "--orchestrator", "Coordinator"]));

    // claim-next takes the high-priority issue, then the low one, then null.
    let c = ok(&p, &["missions", "claim-next", &mid, "Dev"]);
    snap!("claim_next", &c);
    assert_eq!(c["number"], 1);
    assert_eq!(ok(&p, &["missions", "claim-next", &mid, &s(&lead["id"])])["number"], 2);
    assert!(ok(&p, &["missions", "claim-next", &mid, "Dev"]).is_null());

    // messages + cursors
    let msg = ok(&p, &["missions", "send", &mid, "Please take #1", "--from", "Coordinator", "--to", "Dev", "--kind", "assignment", "--issue", "WEB-1"]);
    snap!("send", &msg);
    ok(&p, &["missions", "send", &mid, "Blocked on API", "--from", "Dev", "--kind", "blocker"]);
    ok(&p, &["missions", "send", &mid, "hello everyone"]);
    snap!("messages", &ok(&p, &["missions", "messages", &mid, "--for", "Dev"]));
    snap!("unread", &ok(&p, &["missions", "unread", &mid, "Dev"]));
    snap!("inbox", &ok(&p, &["missions", "inbox", &mid, "Dev"]));
    assert_eq!(ok(&p, &["missions", "unread", &mid, "Dev"])["unread"], 0);
    let reads = ok(&p, &["missions", "mark-read", &mid, "human"]);
    assert!(reads["lastRead"]["human"].is_string() && reads["lastRead"][s(&dev["id"])].is_string(), "{reads}");
    snap!("mark_read", &reads);
    assert_eq!(j(&p, 2, &["missions", "send", &mid, "x", "--kind", "shout"])["error"]["code"], "invalid_input");

    // activity
    snap!("log", &ok(&p, &["missions", "log", &mid, "Split work by layer", "--kind", "note", "--member", "Coordinator"]));
    let acts = ok(&p, &["missions", "activity", &mid]);
    let kinds: Vec<String> = acts.as_array().unwrap().iter().map(|a| s(&a["kind"])).collect();
    assert!(kinds.contains(&"issue_claimed".into()) && kinds.contains(&"status_changed".into()), "{kinds:?}");
    snap!("activity_tail", &ok(&p, &["missions", "activity", &mid, "--limit", "2"]));

    // proposals
    let prop = ok(&p, &["missions", "propose", &mid, "--goal", "Two devs", "--agents", r#"[{"name":"FE","role":"frontend","issueIds":["WEB-1"],"allowedFiles":["src/ui.tsx"]}]"#, "--agent", "qa:Tester", "--cost", "1.5", "--minutes", "40"]);
    snap!("propose", &prop);
    let pid = s(&prop["id"]);
    snap!("proposal_modify", &ok(&p, &["missions", "proposal-modify", &mid, &pid, "--goal", "Two devs + QA"]));
    snap!("proposal_status", &ok(&p, &["missions", "proposal-status", &mid, &pid, "approved"]));
    snap!("proposals", &ok(&p, &["missions", "proposals", &mid]));
    assert_eq!(j(&p, 4, &["missions", "proposal-status", &mid, &pid, "rejected"])["error"]["code"], "conflict");

    // merge queue: closing Dev's issue queues its branch automatically.
    ok(&p, &["issues", "close", "WEB-1"]);
    let q = ok(&p, &["missions", "merge-queue", &mid]);
    assert_eq!(q.as_array().unwrap().len(), 1);
    snap!("merge_queue", &q);
    snap!("merge_enqueue", &ok(&p, &["missions", "merge-enqueue", &mid, "Dev", "--priority", "critical"]));
    let next = ok(&p, &["missions", "merge-next", &mid]);
    snap!("merge_next", &next);
    assert_eq!(next["priority"], "critical");
    snap!("merge_update", &ok(&p, &["missions", "merge-update", &mid, &s(&next["id"]), "--status", "merged"]));
    snap!("assign", &ok(&p, &["missions", "assign", &mid, "2"]));

    snap!("member_remove", &ok(&p, &["missions", "member-remove", &mid, "Coordinator"]));
    snap!("progress_after", &ok(&p, &["missions", "progress", &mid]));

    // errors
    assert_eq!(j(&p, 3, &["missions", "get", "01arz3ndektsv4rrffq69g5fav"])["error"]["code"], "not_found");
    assert_eq!(j(&p, 2, &["missions", "get", "../etc"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 2, &["missions", "list", "--status", "flying"])["error"]["code"], "invalid_input");
    assert_eq!(j(&p, 3, &["missions", "heartbeat", &mid, "Nobody"])["error"]["code"], "not_found");

    snap!("delete", &ok(&p, &["missions", "delete", &mid]));
    assert!(ok(&p, &["missions", "list"]).as_array().unwrap().is_empty());
    assert!(ok(&p, &["issues", "get", "2"]).get("missionId").is_none());
}

#[test]
fn missions_human_output_and_no_project() {
    let p = project();
    let (code, out, _) = cli_raw(&p, &["missions", "create", "Plain"]);
    assert_eq!(code, 0);
    assert!(out.contains("Plain"), "{out}");
    let (code, out, _) = cli_raw(&p, &["missions", "templates"]);
    assert_eq!(code, 0);
    assert!(out.contains("builtin-feature-build"), "{out}");

    let tmp = tempfile::tempdir().unwrap();
    let bare = Proj { dir: tmp.path().to_path_buf(), data: tmp.path().join("appdata"), _tmp: tmp };
    let (code, out, _) = cli_raw(&bare, &["missions", "list", "--json"]);
    assert_eq!(code, 5, "{out}");
    // App-DB subcommands work without a project.
    let (code, _, _) = cli_raw(&bare, &["missions", "agents", "--json"]);
    assert_eq!(code, 0);
    let _ = Path::new("");
}
