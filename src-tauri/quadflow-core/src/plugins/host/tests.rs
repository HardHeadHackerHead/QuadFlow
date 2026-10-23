//! Dispatch-table tests: permission enforcement, fs scope escapes, storage /
//! settings / secrets, data through core.

use super::*;
use crate::domains::app::secrets::Secrets;
use crate::domains::project_config::{init_with, InitOptions};
use crate::error::ErrorCode;
use crate::paths::AppPaths;
use crate::plugins::{Isolation, Manifest, PluginOrigin};
use serde_json::json;

struct Env {
    env: HostEnv,
    project: tempfile::TempDir,
    _app: tempfile::TempDir,
}

fn env() -> Env {
    let app = tempfile::Builder::new().prefix("qf-host-app-").tempdir().unwrap();
    let project = tempfile::Builder::new().prefix("qf-host-proj-").tempdir().unwrap();
    let core = Arc::new(Core::new(AppPaths::under(app.path())));
    init_with(project.path(), core.profile(), InitOptions::default(), core.bus.clone()).unwrap();
    let env = HostEnv::new(core, Secrets::memory(), vec![]);
    *env.session.project_override.lock() = Some(project.path().to_path_buf());
    Env { env, project, _app: app }
}

fn manifest(settings: Option<Value>) -> Manifest {
    let mut m = json!({
        "id": "acme.test",
        "name": "Test",
        "version": "1.0.0",
        "apiVersion": "^1.0.0",
        "platforms": ["windows", "macos", "linux"],
        "contributes": {}
    });
    if let Some(s) = settings {
        m["contributes"]["settings"] = s;
    }
    serde_json::from_value(m).expect("test manifest")
}

fn plugin(perms: &[&str]) -> LoadedPlugin {
    plugin_with(perms, None)
}

fn plugin_with(perms: &[&str], settings: Option<Value>) -> LoadedPlugin {
    LoadedPlugin {
        id: "acme.test".into(),
        manifest: Some(manifest(settings)),
        root: PathBuf::from("."),
        origin: PluginOrigin::Dev,
        isolation: Isolation::Sandboxed,
        status: PluginStatus::Active,
        enabled: true,
        granted: perms.iter().map(|p| Permission::parse(p).unwrap()).collect(),
        errors: vec![],
        warnings: vec![],
        shadowed: vec![],
    }
}

fn call(e: &Env, p: &LoadedPlugin, method: &str, params: Value) -> Result<Value> {
    dispatch(&e.env, HostCall { plugin: p, method, params })
}

fn denied_perm(r: Result<Value>) -> String {
    let err = r.expect_err("expected permission_denied");
    assert_eq!(err.code, ErrorCode::PermissionDenied, "{err:?}");
    err.details.as_ref().and_then(|d| d.get("permission")).and_then(Value::as_str).unwrap_or_default().to_string()
}

#[test]
fn missing_permission_is_denied_in_rust() {
    let e = env();
    let none = plugin(&[]);
    assert_eq!(denied_perm(call(&e, &none, "data.ideas.list", json!({}))), "data:ideas:read");
    assert_eq!(denied_perm(call(&e, &none, "data.issues.create", json!({ "issue": {} }))), "data:issues:write");
    assert_eq!(denied_perm(call(&e, &none, "secrets.get", json!({ "name": "token" }))), "secrets");
    assert_eq!(denied_perm(call(&e, &none, "fs.readText", json!({ "path": "a.txt" }))), "fs:read:project");
    assert_eq!(denied_perm(call(&e, &none, "fs.writeText", json!({ "path": "a.txt", "content": "x" }))), "fs:write:project");
    assert_eq!(denied_perm(call(&e, &none, "fs.readText", json!({ "path": "x", "scope": "home" }))), "fs:read:home");
    assert_eq!(
        denied_perm(call(&e, &none, "shell.exec", json!({ "options": { "program": "git", "args": ["--version"] } }))),
        "shell:exec:git"
    );
    assert_eq!(
        denied_perm(call(&e, &none, "http.fetch", json!({ "url": "https://example.com:8443/x" }))),
        "network:example.com:8443"
    );
    assert_eq!(denied_perm(call(&e, &none, "data.projectConfig.update", json!({ "patch": {} }))), "project:config:write");

    // Read does not imply write; write implies read.
    let reader = plugin(&["data:ideas:read"]);
    assert!(call(&e, &reader, "data.ideas.list", json!({})).is_ok());
    assert_eq!(denied_perm(call(&e, &reader, "data.ideas.create", json!({ "idea": { "content": "x" } }))), "data:ideas:write");
    let writer = plugin(&["data:ideas:write"]);
    assert!(call(&e, &writer, "data.ideas.list", json!({})).is_ok());

    // A grant for another program / host does not help.
    let git = plugin(&["shell:exec:git", "network:other.org"]);
    assert_eq!(denied_perm(call(&e, &git, "shell.exec", json!({ "options": { "program": "node" } }))), "shell:exec:node");
    assert!(denied_perm(call(&e, &git, "http.fetch", json!({ "url": "https://example.com/" }))).starts_with("network:"));

    // Promotion needs plans AND issues.
    let plans_only = plugin(&["data:plans:write"]);
    assert_eq!(
        denied_perm(call(&e, &plans_only, "data.plans.promoteAll", json!({ "planId": crate::new_id() }))),
        "data:issues:write"
    );
}

#[test]
fn inactive_plugins_and_unknown_methods() {
    let e = env();
    let mut p = plugin(&["data:ideas:read"]);
    p.status = PluginStatus::Disabled;
    assert_eq!(call(&e, &p, "data.ideas.list", json!({})).unwrap_err().code, ErrorCode::PermissionDenied);
    let p = plugin(&[]);
    assert_eq!(call(&e, &p, "nope.method", json!({})).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(call(&e, &p, "storage.get", json!([1, 2])).unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn data_goes_through_core_as_the_plugin() {
    let e = env();
    let p = plugin(&["data:ideas:write", "data:issues:write"]);
    let idea = call(&e, &p, "data.ideas.create", json!({ "idea": { "content": "From a plugin" } })).unwrap();
    assert_eq!(idea["content"], "From a plugin");
    let list = call(&e, &p, "data.ideas.list", json!({})).unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let issue = call(&e, &p, "data.issues.create", json!({ "issue": { "title": "Bug" } })).unwrap();
    let r = call(&e, &p, "data.issues.displayRef", json!({ "issueRef": issue["id"] })).unwrap();
    assert!(r.as_str().unwrap().ends_with("-1"), "{r}");
    // Explicit projectRoot works too; a missing one is project_not_found.
    let root = e.project.path().display().to_string();
    assert!(call(&e, &p, "data.ideas.list", json!({ "projectRoot": root })).is_ok());
    let err = call(&e, &p, "data.ideas.list", json!({ "projectRoot": e.project.path().join("nope").display().to_string() }))
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ProjectNotFound);
}

#[test]
fn ideas_bulk_tag_needs_write_and_tags_every_idea() {
    let e = env();
    let w = plugin(&["data:ideas:write"]);
    let a = call(&e, &w, "data.ideas.create", json!({ "idea": { "content": "A" } })).unwrap();
    let b = call(&e, &w, "data.ideas.create", json!({ "idea": { "content": "B" } })).unwrap();
    let ids = json!([a["id"], b["id"]]);
    let reader = plugin(&["data:ideas:read"]);
    assert_eq!(denied_perm(call(&e, &reader, "data.ideas.bulkTag", json!({ "ids": ids, "tag": "x" }))), "data:ideas:write");
    let tagged = call(&e, &w, "data.ideas.bulkTag", json!({ "ids": ids, "tag": "Triage" })).unwrap();
    assert_eq!(tagged.as_array().unwrap().len(), 2);
    let list = call(&e, &w, "data.ideas.list", json!({ "query": { "tags": ["triage"] } })).unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 2);
    // An unknown id writes nothing.
    let err = call(&e, &w, "data.ideas.bulkTag", json!({ "ids": [a["id"], "01HZZZZZZZZZZZZZZZZZZZZZZZ"], "tag": "y" })).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn fs_rejects_dotdot_and_absolute_in_relative_scopes() {
    let e = env();
    let p = plugin(&["fs:write:project"]);
    std::fs::write(e.project.path().join("ok.txt"), "hi").unwrap();
    assert_eq!(call(&e, &p, "fs.readText", json!({ "path": "ok.txt" })).unwrap(), json!("hi"));
    for bad in ["../outside.txt", "sub/../../outside.txt", "..\\outside.txt", "a/..", "C:/Windows/win.ini", "/etc/passwd", "a:b"] {
        let err = call(&e, &p, "fs.readText", json!({ "path": bad })).unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied, "{bad}: {err:?}");
    }
    // The project's QuadFlow data dir is off limits in the project scope.
    let dir = e.env.core.profile().project_dir_name();
    let err = call(&e, &p, "fs.readText", json!({ "path": format!("{dir}/config.json") })).unwrap_err();
    assert_eq!(err.code, ErrorCode::PermissionDenied);
    // Writes are atomic and create parents.
    call(&e, &p, "fs.writeText", json!({ "path": "a/b/c.txt", "content": "x" })).unwrap();
    assert_eq!(std::fs::read_to_string(e.project.path().join("a/b/c.txt")).unwrap(), "x");
    let listing = call(&e, &p, "fs.list", json!({ "path": "a" })).unwrap();
    assert_eq!(listing[0]["name"], "b");
    assert_eq!(listing[0]["kind"], "dir");
    assert_eq!(call(&e, &p, "fs.stat", json!({ "path": "missing" })).unwrap(), Value::Null);
    assert_eq!(call(&e, &p, "fs.remove", json!({ "path": "" })).unwrap_err().code, ErrorCode::InvalidInput);
}

/// Make `link` point at directory `target` (symlink; on Windows a junction when
/// symlinks need privileges). `false` if the platform refuses both.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return true;
        }
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

#[test]
fn fs_rejects_symlink_escapes() {
    let e = env();
    let outside = tempfile::Builder::new().prefix("qf-host-outside-").tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "top secret").unwrap();
    let link = e.project.path().join("escape");
    assert!(link_dir(outside.path(), &link), "could not create a directory link for the test");
    let p = plugin(&["fs:write:project"]);
    for (m, extra) in [
        ("fs.readText", json!({})),
        ("fs.list", json!({})),
        ("fs.writeText", json!({ "content": "pwned" })),
        ("fs.mkdir", json!({})),
    ] {
        let path = if m == "fs.list" || m == "fs.mkdir" { "escape/sub" } else { "escape/secret.txt" };
        let mut params = json!({ "path": path });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let err = call(&e, &p, m, params).unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied, "{m}: {err:?}");
    }
    assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "top secret");
    assert!(!outside.path().join("sub").exists());

    // A link inside the plugin's own data dir is rejected the same way.
    let data = e.env.core.paths.plugin_data_dir.join("acme.test");
    std::fs::create_dir_all(&data).unwrap();
    assert!(link_dir(outside.path(), &data.join("out")));
    let none = plugin(&[]);
    let err = call(&e, &none, "fs.readText", json!({ "path": "out/secret.txt", "scope": "pluginData" })).unwrap_err();
    assert_eq!(err.code, ErrorCode::PermissionDenied);
}

#[test]
fn fs_plugin_scopes_need_no_permission_and_absolute_needs_any_or_a_pick() {
    let e = env();
    let none = plugin(&[]);
    call(&e, &none, "fs.writeText", json!({ "path": "state.json", "content": "{}", "scope": "pluginData" })).unwrap();
    assert!(e.env.core.paths.plugin_data_dir.join("acme.test/state.json").is_file());
    call(&e, &none, "fs.writeText", json!({ "path": "x.txt", "content": "1", "scope": "projectPluginData" })).unwrap();
    call(&e, &none, "fs.writeText", json!({ "path": "y.txt", "content": "2", "scope": "projectPluginLocal" })).unwrap();
    let pdir = e.project.path().join(e.env.core.profile().project_dir_name());
    assert!(pdir.join("plugins/acme.test/x.txt").is_file());
    assert!(pdir.join("local/plugins/acme.test/y.txt").is_file());

    let outside = tempfile::Builder::new().prefix("qf-host-abs-").tempdir().unwrap();
    let f = outside.path().join("picked.txt");
    std::fs::write(&f, "picked").unwrap();
    let params = json!({ "path": f.display().to_string(), "scope": "absolute" });
    assert_eq!(denied_perm(call(&e, &none, "fs.readText", params.clone())), "fs:read:any");
    e.env.session.allow_path("acme.test", outside.path());
    assert_eq!(call(&e, &none, "fs.readText", params).unwrap(), json!("picked"));
    let rel = json!({ "path": "relative.txt", "scope": "absolute" });
    assert!(call(&e, &plugin(&["fs:read:any"]), "fs.readText", rel).is_err());
}

#[test]
fn storage_settings_and_secrets() {
    let e = env();
    let p = plugin_with(
        &["secrets"],
        Some(json!({
            "type": "object",
            "properties": { "greeting": { "type": "string", "default": "hi" }, "count": { "type": "integer", "minimum": 0 } },
            "additionalProperties": false
        })),
    );
    assert_eq!(call(&e, &p, "storage.get", json!({ "key": "k" })).unwrap(), Value::Null);
    call(&e, &p, "storage.set", json!({ "key": "k", "value": { "a": 1 } })).unwrap();
    call(&e, &p, "storage.set", json!({ "key": "k2", "value": 2, "scope": "project" })).unwrap();
    assert_eq!(call(&e, &p, "storage.get", json!({ "key": "k" })).unwrap(), json!({ "a": 1 }));
    assert_eq!(call(&e, &p, "storage.keys", json!({})).unwrap(), json!(["k"]));
    assert_eq!(call(&e, &p, "storage.keys", json!({ "scope": "project" })).unwrap(), json!(["k2"]));
    call(&e, &p, "storage.delete", json!({ "key": "k" })).unwrap();
    assert_eq!(call(&e, &p, "storage.get", json!({ "key": "k" })).unwrap(), Value::Null);
    let big = "x".repeat(super::kv::KV_MAX_VALUE_BYTES + 1);
    assert_eq!(call(&e, &p, "storage.set", json!({ "key": "big", "value": big })).unwrap_err().code, ErrorCode::InvalidInput);

    assert_eq!(call(&e, &p, "settings.getAll", json!({})).unwrap(), json!({ "greeting": "hi" }));
    call(&e, &p, "settings.set", json!({ "key": "count", "value": 3 })).unwrap();
    assert_eq!(call(&e, &p, "settings.set", json!({ "key": "count", "value": -1 })).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(call(&e, &p, "settings.set", json!({ "key": "nope", "value": 1 })).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(call(&e, &p, "settings.getAll", json!({})).unwrap(), json!({ "greeting": "hi", "count": 3 }));

    call(&e, &p, "secrets.set", json!({ "name": "token", "value": "s3cret" })).unwrap();
    assert_eq!(call(&e, &p, "secrets.get", json!({ "name": "token" })).unwrap(), json!("s3cret"));
    assert_eq!(e.env.secrets.get("plugin:acme.test:token").unwrap().as_deref(), Some("s3cret"));
    let db = e.env.core.app_db().unwrap();
    assert_eq!(crate::plugins::sources::install::plugin_secret_names(&db, "acme.test").unwrap(), vec!["token"]);
    assert_eq!(call(&e, &p, "secrets.get", json!({ "name": "other:x" })).unwrap_err().code, ErrorCode::InvalidInput);
    call(&e, &p, "secrets.delete", json!({ "name": "token" })).unwrap();
    assert_eq!(call(&e, &p, "secrets.get", json!({ "name": "token" })).unwrap(), Value::Null);
    assert!(crate::plugins::sources::install::plugin_secret_names(&db, "acme.test").unwrap().is_empty());
}

#[test]
fn shell_exec_checks_the_basename_before_resolving() {
    let e = env();
    let p = plugin(&["shell:exec:git"]);
    for bad in ["../git", "C:\\Windows\\git", "/usr/bin/git", "git status"] {
        let err = call(&e, &p, "shell.exec", json!({ "options": { "program": bad } })).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidInput, "{bad}");
    }
}

#[test]
fn subscriptions_check_permissions_too() {
    let e = env();
    let none = plugin(&[]);
    let sink: Sink = Arc::new(|_| {});
    let sub = |p: &LoadedPlugin, topic: &str, params: Value| {
        subscribe(&e.env, HostCall { plugin: p, method: topic, params }, sink.clone()).map(|_| ())
    };
    let err = sub(&none, "data.onDidChange", json!({ "domain": "issues" })).unwrap_err();
    assert_eq!(err.code, ErrorCode::PermissionDenied);
    // `settings` (only its `chat/*` keys) needs `data:chat:read` (API 1.4); `projects` is not plugin data.
    assert_eq!(sub(&none, "data.onDidChange", json!({ "domain": "settings" })).unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(sub(&none, "data.onDidChange", json!({ "domain": "projects" })).unwrap_err().code, ErrorCode::InvalidInput);
    assert!(sub(&none, "data.onDidChange", json!({ "domain": "project_config" })).is_ok());
    assert_eq!(sub(&none, "shell.spawn", json!({ "options": { "program": "git" } })).unwrap_err().code, ErrorCode::PermissionDenied);
    assert_eq!(sub(&none, "fs.watch", json!({ "path": "" })).unwrap_err().code, ErrorCode::PermissionDenied);

    // An allowed data subscription receives events for its domain.
    let got = Arc::new(Mutex::new(Vec::<Value>::new()));
    let g = Arc::clone(&got);
    let p = plugin(&["data:ideas:write"]);
    let _guard = subscribe(
        &e.env,
        HostCall { plugin: &p, method: "data.onDidChange", params: json!({ "domain": ["ideas"] }) },
        Arc::new(move |v| g.lock().push(v)),
    )
    .unwrap();
    call(&e, &p, "data.ideas.create", json!({ "idea": { "content": "evt" } })).unwrap();
    assert!(got.lock().iter().any(|v| v["domain"] == "ideas"), "{:?}", got.lock());
}

#[test]
fn available_lists_core_methods() {
    let e = env();
    let names = e.env.available();
    for m in ["data.ideas.list", "storage.get", "fs.readText", "shell.exec", "http.fetch", "log.info", "project.list", "fs.watch"] {
        assert!(names.iter().any(|n| n == m), "{m}");
    }
    assert!(core_method_names().iter().any(|n| n == "secrets.get"));
}

#[test]
fn api_1_4_ship_methods() {
    let e = env();
    let read = plugin(&["data:ship:read"]);
    let write = plugin(&["data:ship:write"]);
    let templates = call(&e, &read, "data.ship.templates", json!({})).unwrap();
    assert!(templates.as_array().is_some_and(|t| t.iter().any(|x| x["id"] == "minimal")), "{templates}");
    assert_eq!(call(&e, &read, "data.ship.diagnostics", json!({})).unwrap()["configExists"], json!(false));
    assert!(call(&e, &read, "data.ship.detect", json!({})).unwrap().is_object());
    assert_eq!(denied_perm(call(&e, &read, "data.ship.init", json!({ "options": {} }))), "data:ship:write");
    std::fs::write(e.project.path().join("package.json"), r#"{ "name": "x", "version": "1.0.0" }"#).unwrap();
    assert!(call(&e, &write, "data.ship.init", json!({ "options": { "template": "minimal" } })).unwrap().is_object());
    assert_eq!(call(&e, &read, "data.ship.diagnostics", json!({})).unwrap()["configExists"], json!(true));
    assert_eq!(denied_perm(call(&e, &read, "data.ship.configDelete", json!({}))), "data:ship:write");
    assert_eq!(denied_perm(call(&e, &read, "data.ship.restoreBackups", json!({}))), "data:ship:write");
    assert_eq!(call(&e, &write, "data.ship.restoreBackups", json!({})).unwrap(), json!([]));
    let del = call(&e, &write, "data.ship.configDelete", json!({})).unwrap();
    assert_eq!(del["deleted"], json!(true), "{del}");
    let sink: Sink = Arc::new(|_| {});
    let err = subscribe(&e.env, HostCall { plugin: &read, method: "data.ship.runFix", params: json!({ "checkId": "x" }) }, sink)
        .map(|_| ())
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::PermissionDenied);
}

#[test]
fn api_1_4_chat_methods() {
    let e = env();
    let read = plugin(&["data:chat:read"]);
    let write = plugin(&["data:chat:write"]);
    assert_eq!(call(&e, &read, "data.chat.settingsGet", json!({})).unwrap()["hasApiKey"], json!(false));
    assert_eq!(denied_perm(call(&e, &read, "data.chat.settingsUpdate", json!({ "patch": {} }))), "data:chat:write");
    assert_eq!(denied_perm(call(&e, &read, "data.chat.ask", json!({ "question": "hi" }))), "data:chat:write");
    // The Chat plugin's own secret counts as the endpoint key.
    e.env.secrets.set("plugin:chat:apiKey", "sk-x").unwrap();
    assert_eq!(call(&e, &read, "data.chat.settingsGet", json!({})).unwrap()["hasApiKey"], json!(true));

    // Settings events: only `chat/*` ids reach a `data:chat:read` subscriber.
    let got = Arc::new(Mutex::new(Vec::<Value>::new()));
    let g = Arc::clone(&got);
    let _guard = subscribe(
        &e.env,
        HostCall { plugin: &read, method: "data.onDidChange", params: json!({ "domain": "settings" }) },
        Arc::new(move |v| g.lock().push(v)),
    )
    .unwrap();
    crate::domains::app::settings::set(&e.env.core.app_db().unwrap(), "ui", "theme", json!("dark")).unwrap();
    let s = call(&e, &write, "data.chat.settingsUpdate", json!({ "patch": { "defaultModel": "m9" } })).unwrap();
    assert_eq!(s["defaultModel"], "m9");
    let got = got.lock();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0]["ids"], json!(["chat/defaultModel"]));
}

#[test]
fn api_1_4_missions_methods() {
    let e = env();
    let read = plugin(&["data:missions:read"]);
    let write = plugin(&["data:missions:write"]);
    let m = call(&e, &write, "data.missions.create", json!({ "mission": { "name": "M" } })).unwrap();
    let mid = m["id"].as_str().unwrap().to_string();
    assert_eq!(
        denied_perm(call(&e, &read, "data.missions.logActivity", json!({ "missionId": mid, "activity": { "detail": "x" } }))),
        "data:missions:write"
    );
    let a = call(&e, &write, "data.missions.logActivity", json!({ "missionId": mid, "activity": { "detail": "a note" } })).unwrap();
    assert_eq!(a["detail"], "a note");

    let store = e.env.core.project(e.project.path()).unwrap();
    let actor = crate::Actor::plugin("acme.test");
    let mid_id: crate::Id = serde_json::from_value(json!(mid)).unwrap();
    let p = crate::domains::missions::proposal_create(&store, &actor, &mid_id, serde_json::from_value(json!({ "goal": "do it" })).unwrap())
        .unwrap();
    let r = call(&e, &write, "data.missions.proposalSetStatus", json!({ "missionId": mid, "proposalId": p.id, "status": "approved" }))
        .unwrap();
    assert_eq!(r["status"], "approved");

    let member =
        call(&e, &write, "data.missions.memberAdd", json!({ "missionId": mid, "input": { "agentDefinitionId": "builtin-fullstack-dev" } }))
            .unwrap();
    let entry = crate::domains::missions::merge_enqueue(
        &store,
        &actor,
        &mid_id,
        serde_json::from_value(json!({ "memberId": member["id"], "branchName": "b", "worktreePath": "w" })).unwrap(),
    )
    .unwrap();
    let u = call(&e, &write, "data.missions.mergeUpdate", json!({ "missionId": mid, "entryId": entry.id, "patch": { "status": "merged" } }))
        .unwrap();
    assert_eq!(u["status"], "merged");
    call(&e, &write, "data.missions.send", json!({ "missionId": mid, "message": { "content": "hello" } })).unwrap();
    let reads = call(&e, &write, "data.missions.markRead", json!({ "missionId": mid, "reader": "human" })).unwrap();
    assert!(reads["lastRead"]["human"].is_string(), "{reads}");
}

#[test]
fn api_1_4_methods_are_listed() {
    let e = env();
    let names = e.env.available();
    for m in [
        "data.ship.templates",
        "data.ship.init",
        "data.ship.detect",
        "data.ship.diagnostics",
        "data.ship.readinessOne",
        "data.ship.runFix",
        "data.ship.configDelete",
        "data.ship.restoreBackups",
        "data.chat.settingsGet",
        "data.chat.settingsUpdate",
        "data.chat.models",
        "data.chat.ask",
        "data.missions.proposalSetStatus",
        "data.missions.mergeUpdate",
        "data.missions.logActivity",
        "data.missions.markRead",
    ] {
        assert!(names.iter().any(|n| n == m), "{m}");
    }
}
