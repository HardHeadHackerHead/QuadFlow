//! `plugins/codex` (AP-3): the manifest's declarative provider drives the
//! generic core — launch argv per approval mode, resume, one-shot, session
//! discovery over real-format rollout files — and, when `codex` is installed,
//! every flag the manifest uses exists in that CLI's `--help`.

use quadflow_core::agents::catalog;
use quadflow_core::agents::models::{models, ModelSettings};
use quadflow_core::agents::{
    build_launch, command_line, parse_spec, AgentDetection, AgentProviderSpec, LaunchRequest, ProcessEnv, SessionClaims,
    SessionScanner, ShellKind,
};
use quadflow_core::agents::AgentApprovalMode as Mode;
use quadflow_core::plugins::registry::validate_plugin_dir;
use quadflow_core::paths::root_key;
use quadflow_core::plugins::{LoadOptions, PluginOrigin};
use std::path::{Path, PathBuf};
use std::process::Command;

fn plugin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins/codex")
}

fn manifest() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(plugin_dir().join("quadflow-plugin.json")).unwrap()).unwrap()
}

fn spec() -> AgentProviderSpec {
    parse_spec(&manifest()["contributes"]["agentProvider"]).unwrap_or_else(|e| panic!("{e:?}"))
}

fn detection() -> AgentDetection {
    AgentDetection {
        provider_id: "codex".into(),
        installed: true,
        path: Some(if cfg!(windows) { r"C:\Tools\codex.exe".into() } else { "/usr/local/bin/codex".into() }),
        version: Some("0.163.0".into()),
        meets_min_version: true,
        error: None,
        checked_at: 0,
    }
}

fn argv(req: LaunchRequest) -> Vec<String> {
    let s = spec();
    let cat = catalog::parse(&std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../catalog/models.json")).unwrap())
        .unwrap()
        .0;
    let list = models("codex", true, &cat, &ModelSettings::default());
    build_launch(&s, &detection(), &req, None, &list, &ProcessEnv::default()).unwrap().argv
}

#[test]
fn manifest_is_valid_and_contributes_codex() {
    let report = validate_plugin_dir(&plugin_dir(), PluginOrigin::Bundled, true, &LoadOptions::from_env(|_| None));
    // `dist/index.js` exists only after `npm run build:plugins`; everything else must validate.
    let errs: Vec<_> = report.errors.iter().filter(|e| !e.message.contains("dist/index.js")).collect();
    assert!(errs.is_empty(), "{errs:?}");
    let s = spec();
    assert_eq!((s.id.as_str(), s.context_file.as_str()), ("codex", "AGENTS.md"));
    assert_eq!(s.launch.approval_modes.supported(), [Mode::Default, Mode::Plan, Mode::Auto, Mode::Bypass]);
}

#[test]
fn launch_argv_per_approval_mode_effort_and_model() {
    let req = |m| LaunchRequest { approval_mode: m, ..Default::default() };
    assert!(argv(req(Mode::Default)).is_empty());
    assert_eq!(argv(req(Mode::Plan)), ["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
    assert_eq!(argv(req(Mode::Auto)), ["--approve-for-me"]);
    assert_eq!(argv(req(Mode::Bypass)), ["--dangerously-bypass-approvals-and-sandbox"]);
    // `accept-edits` has no Codex equivalent.
    let s = spec();
    let err = build_launch(&s, &detection(), &req(Mode::AcceptEdits), None, &[], &ProcessEnv::default()).unwrap_err();
    assert!(err.to_string().contains("approval mode"), "{err}");

    let a = argv(LaunchRequest { model: Some("gpt-5.3-codex".into()), effort: Some("high".into()), ..Default::default() });
    assert_eq!(a, ["--model", "gpt-5.3-codex", "-c", "model_reasoning_effort=high"]);
    // Default effort is omitted (Codex picks the model's own default).
    assert!(argv(LaunchRequest { effort: Some("medium".into()), ..Default::default() }).is_empty());
}

#[test]
fn resume_is_a_prefix_subcommand_and_quotes_per_shell() {
    let id = "01a1664a-57ae-7af1-92f9-aba4bb448849"; // Codex ids are UUIDv7
    let a = argv(LaunchRequest { resume_session_id: Some(id.into()), approval_mode: Mode::Plan, ..Default::default() });
    assert_eq!(a, ["resume", id, "--sandbox", "read-only", "--ask-for-approval", "on-request"]);
    let line = command_line(ShellKind::PowerShell, Path::new(r"C:\Tools\codex.exe"), &a).unwrap();
    assert_eq!(line, format!(r"& 'C:\Tools\codex.exe' 'resume' '{id}' '--sandbox' 'read-only' '--ask-for-approval' 'on-request'"));
    // Non-uuid ids never reach the PTY.
    let s = spec();
    let bad = LaunchRequest { resume_session_id: Some("x; rm -rf ~".into()), ..Default::default() };
    assert!(build_launch(&s, &detection(), &bad, None, &[], &ProcessEnv::default()).is_err());
}

/// A rollout as codex-cli 0.163 writes it: a long `session_meta` first line.
fn write_rollout(home: &Path, id: &str, cwd: &Path) -> PathBuf {
    let day = home.join(".codex/sessions/2026/10/22");
    std::fs::create_dir_all(&day).unwrap();
    let p = day.join(format!("rollout-2026-10-22T21-05-10-{id}.jsonl"));
    let meta = serde_json::json!({
        "timestamp": "2026-10-23T01:05:15.759Z", "ordinal": 0, "type": "session_meta",
        "payload": { "session_id": id, "id": id, "cwd": cwd.to_string_lossy(), "originator": "codex_cli_rs",
                     "cli_version": "0.163.0", "source": "cli", "base_instructions": { "text": "x".repeat(20_000) } }
    });
    let tc = r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#;
    std::fs::write(&p, format!("{meta}\n{tc}\n")).unwrap();
    p
}

#[test]
fn discovery_links_concurrent_launches_fifo() {
    let home = tempfile::tempdir().unwrap();
    let proj = home.path().join("Proj");
    let other = home.path().join("Other");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let env = ProcessEnv { home: Some(home.path().to_path_buf()), ..Default::default() };
    let s = spec();
    let scanner = SessionScanner::new();
    assert!(scanner.list(&s, &proj, None, &env).unwrap().is_empty());

    let a = "01a1664a-57ae-7af1-92f9-aba4bb448849";
    let b = "01a1664a-57ae-7af1-92f9-aba4bb44884a";
    write_rollout(home.path(), a, &proj);
    write_rollout(home.path(), "01a1664a-57ae-7af1-92f9-aba4bb44884b", &other);
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_rollout(home.path(), b, &proj);

    let found = scanner.list(&s, &proj, None, &env).unwrap();
    let mut ids: Vec<_> = found.iter().map(|x| x.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, [a, b], "only sessions of this cwd");
    assert!(scanner.exists(&s, &proj, a, &env));
    assert!(found.iter().all(|x| x.created_at > 1_600_000_000_000), "ms timestamps");

    // Two launches pending in one cwd get distinct sessions, oldest launch first.
    let claims = SessionClaims::new();
    claims.register_pending("codex", &proj, "t1", 0);
    claims.register_pending("codex", &proj, "t2", 1);
    let links = claims.assign("codex", &root_key(&proj), &found);
    let pairs: Vec<_> = links.iter().map(|l| (l.terminal_id.as_str(), l.session_id.as_str())).collect();
    assert_eq!(pairs, [("t1", a), ("t2", b)]);
    assert!(claims.assign("codex", &root_key(&proj), &found).is_empty(), "a session is never claimed twice");
}

/// Flags (`-x` / `--xyz`) and subcommands of an argv template, in order.
fn flags(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).filter(|a| a.starts_with('-') && a.len() > 1).collect()
}

fn help(args: &[&str]) -> Option<String> {
    let out = Command::new(if cfg!(windows) { "codex.exe" } else { "codex" }).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

/// Live check against the installed CLI (skipped when `codex` is not on PATH).
#[test]
fn every_manifest_flag_exists_in_installed_codex_help() {
    let Some(top) = help(&["--help"]) else {
        eprintln!("codex not on PATH; skipping live flag check");
        return;
    };
    let s = spec();
    let l = &s.launch;
    let has = |text: &str, flag: &str| {
        text.split(|c: char| c.is_whitespace() || c == ',').any(|w| w == flag || w.starts_with(&format!("{flag}=")) || w.starts_with(&format!("{flag}<")))
    };
    let mut interactive: Vec<&str> = Vec::new();
    for t in [l.model.as_ref(), l.efforts.as_ref().map(|e| &e.args)].into_iter().flatten() {
        interactive.extend(flags(t));
    }
    for m in s.launch.approval_modes.supported() {
        interactive.extend(flags(l.approval_modes.get(m).unwrap()));
    }
    let resume_help = help(&["resume", "--help"]).expect("codex resume --help");
    for f in &interactive {
        assert!(has(&top, f), "`codex --help` lacks {f}");
        assert!(has(&resume_help, f), "`codex resume --help` lacks {f} (resume args are a prefix subcommand)");
    }
    assert_eq!(l.resume.as_ref().unwrap()[0], "resume");
    assert!(top.lines().any(|x| x.trim_start().starts_with("resume ")), "no resume subcommand");

    let one = &l.one_shot.as_ref().unwrap().args;
    assert_eq!(one[0], "exec");
    let exec_help = help(&["exec", "--help"]).expect("codex exec --help");
    for f in flags(one) {
        assert!(has(&exec_help, f), "`codex exec --help` lacks {f}");
    }
    assert_eq!(one.last().map(String::as_str), Some("-"), "prompt via stdin");
    assert!(exec_help.contains("`-` is used"), "exec no longer reads the prompt from stdin with `-`");
    // Values of enumerated options.
    assert!(top.contains("read-only"), "--sandbox read-only");
    assert!(top.contains("on-request"), "--ask-for-approval on-request");
}
