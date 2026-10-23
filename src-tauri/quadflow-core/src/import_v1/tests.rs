//! Tests with synthesized 1.x shapes (no real user data).

use super::legacy::{self, BACKUP_DIR};
use super::*;
use crate::domains::project_config;
use crate::paths::ProjectRoot;
use crate::store::ProjectStore;
use crate::testing::{TempApp, TempProject};
use serde_json::json;

fn w(path: &Path, v: &serde_json::Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(v).unwrap()).unwrap();
}

/// A `.quadflow/` as 1.x wrote it.
fn write_v1_folder(project: &Path) {
    let q = project.join(".quadflow");
    w(&q.join("config.json"), &json!({"settings": {"next_issue_number": "1", "project_code": "QC"}, "project_code:c:/x/app": "AP"}));
    w(&q.join("issues/a1a1a1a1a1a1a1a1.json"), &json!({"id": "a1a1a1a1a1a1a1a1", "title": "t", "status": "todo", "displayNumber": 1}));
    w(&q.join("labels.json"), &json!([{"id": "l1", "name": "bug", "color": "#ef4444"}]));
    std::fs::create_dir_all(q.join("plans")).unwrap();
}

fn write_v1_install(dir: &Path, projects: &[(&str, &Path, bool)]) {
    std::fs::create_dir_all(dir).unwrap();
    let conn = rusqlite::Connection::open(dir.join("quadflow.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_directory TEXT NOT NULL UNIQUE,
           is_active INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, default_workspace_config TEXT);",
    )
    .unwrap();
    for (i, (name, path, active)) in projects.iter().enumerate() {
        conn.execute(
            "INSERT INTO projects (id, name, working_directory, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            rusqlite::params![format!("id{i}"), name, path.to_string_lossy().replace('/', "\\"), *active as i64, 10 - i as i64],
        )
        .unwrap();
    }
}

fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(dir).sort_by_file_name() {
        let e = e.unwrap();
        if e.file_type().is_file() {
            out.push((e.path().strip_prefix(dir).unwrap().display().to_string(), std::fs::read(e.path()).unwrap()));
        }
    }
    out
}

#[test]
fn detection() {
    let tmp = tempfile::tempdir().unwrap();
    let q = tmp.path().join(".quadflow");
    assert!(!legacy::is_v1_dir(&q), "missing folder");
    std::fs::create_dir_all(q.join("issues")).unwrap();
    assert!(!legacy::is_v1_dir(&q), "empty 1.x-style dirs alone are not data");
    w(&q.join("issues/01hzxq5t8y2v3m4n5p6q7r8s9t.json"), &json!({}));
    assert!(!legacy::is_v1_dir(&q), "ULID file names are the current format");
    w(&q.join("issues/mmwkz7cbwkfmlsremyd.json"), &json!({}));
    assert!(legacy::is_v1_dir(&q), "1.x file names");
    std::fs::remove_file(q.join("issues/mmwkz7cbwkfmlsremyd.json")).unwrap();
    w(&q.join("labels.json"), &json!([]));
    assert!(legacy::is_v1_dir(&q), "1.x labels.json is an array");
    w(&q.join("config.json"), &json!({"formatVersion": 1, "name": "x", "code": "XX"}));
    assert!(!legacy::is_v1_dir(&q), "current config wins");
    w(&q.join("config.json"), &json!({"settings": {"project_code": "QC"}}));
    assert!(legacy::is_v1_dir(&q), "config without formatVersion");
    std::fs::write(q.join("config.json"), "{ broken").unwrap();
    assert!(!legacy::is_v1_dir(&q), "a damaged config is never moved");
    // A real current-format project.
    let p = TempProject::with_profile(Profile::Release);
    assert!(!legacy::is_v1_dir(&p.dir.path().join(".quadflow")));
}

#[test]
fn release_moves_aside_with_numbered_suffix() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("app");
    write_v1_folder(&project);
    let original = snapshot(&project.join(".quadflow"));
    // Two earlier backups exist already.
    std::fs::create_dir_all(project.join(BACKUP_DIR)).unwrap();
    std::fs::write(project.join(BACKUP_DIR).join("keep.txt"), "first").unwrap();
    std::fs::create_dir_all(project.join(format!("{BACKUP_DIR}-2"))).unwrap();
    let n = legacy::check_project(&project, Profile::Release, &EventBus::new()).unwrap().unwrap();
    assert!(n.moved);
    let backup = project.join(format!("{BACKUP_DIR}-3"));
    assert_eq!(PathBuf::from(n.backup_dir.unwrap()), backup);
    assert!(n.message.contains("QuadFlow 1.x") && n.message.contains(".quadflow-v1-backup-3/"), "{}", n.message);
    assert_eq!(snapshot(&backup), original, "moved, byte for byte");
    assert_eq!(std::fs::read_to_string(project.join(BACKUP_DIR).join("keep.txt")).unwrap(), "first");
    // A fresh, readable project.
    let s = ProjectStore::open(ProjectRoot::open_with(&project, Profile::Release).unwrap(), EventBus::new()).unwrap();
    assert_eq!(project_config::read(&s).unwrap().name, "app");
    assert_eq!(crate::domains::issues::list(&s, &Default::default()).unwrap().items.len(), 0);
    // Idempotent.
    assert_eq!(legacy::check_project(&project, Profile::Release, &EventBus::new()).unwrap(), None);
}

#[test]
fn dev_profile_only_reports() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("app");
    write_v1_folder(&project);
    let before = snapshot(&project);
    let n = legacy::check_project(&project, Profile::Dev, &EventBus::new()).unwrap().unwrap();
    assert!(!n.moved && n.backup_dir.is_none());
    assert!(n.message.contains(".quadflow-dev/"));
    assert_eq!(snapshot(&project), before, "nothing written in dev");
}

struct Fixture {
    _tmp: tempfile::TempDir,
    with_v1: PathBuf,
    plain: PathBuf,
    v1: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let with_v1 = tmp.path().join("old-app");
    write_v1_folder(&with_v1);
    let plain = tmp.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let with_v1 = dunce::canonicalize(&with_v1).unwrap();
    let plain = dunce::canonicalize(&plain).unwrap();
    let v1 = tmp.path().join("v1-data");
    write_v1_install(&v1, &[("Old App", &with_v1, true), ("Plain", &plain, false), ("Gone", &tmp.path().join("gone"), false)]);
    Fixture { _tmp: tmp, with_v1, plain, v1 }
}

fn env(profile: Profile, f: &Fixture) -> ImportV1Env {
    ImportV1Env { profile, v1_override: Some(f.v1.display().to_string()) }
}

#[test]
fn locate_rules() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(locate(Profile::Dev, None).is_none(), "dev builds never read the real 1.x install");
    assert!(locate(Profile::Dev, Some(&tmp.path().display().to_string())).is_none(), "no quadflow.db");
    write_v1_install(tmp.path(), &[]);
    assert_eq!(locate(Profile::Dev, Some(&tmp.path().display().to_string())).unwrap(), tmp.path());
}

#[test]
fn dry_run_lists_what_would_happen() {
    let f = fixture();
    let app = TempApp::new();
    let before = snapshot(f.with_v1.parent().unwrap());
    let det = detect(&app.db, &env(Profile::Release, &f)).unwrap();
    assert!(det.found && det.state.is_none());
    let p = det.preview.unwrap().projects;
    let by = |n: &str| p.iter().find(|x| x.name == n).unwrap().clone();
    assert_eq!(by("Old App").outcome, ImportV1Outcome::WouldMoveAside);
    assert!(by("Old App").backup_dir.unwrap().ends_with(BACKUP_DIR));
    assert_eq!(by("Plain").outcome, ImportV1Outcome::WouldRegister);
    assert_eq!(by("Gone").outcome, ImportV1Outcome::MissingDir);
    assert_eq!(snapshot(f.with_v1.parent().unwrap()), before, "a dry run writes nothing");
    assert!(projects::list(&app.db).unwrap().is_empty());
    assert_eq!(state(&app.db).unwrap(), None);
    // Dev profile: 1.x data is only reported.
    let dev = run(&app.db, &env(Profile::Dev, &f), ImportV1Options { dry_run: true, ..Default::default() }, &EventBus::new()).unwrap();
    assert_eq!(dev.projects.iter().find(|x| x.name == "Old App").unwrap().outcome, ImportV1Outcome::V1DataKept);
}

#[test]
fn import_registers_every_project_and_moves_v1_data_aside() {
    let f = fixture();
    let app = TempApp::new();
    let original = snapshot(&f.with_v1.join(".quadflow"));
    let e = env(Profile::Release, &f);
    let rep = run(&app.db, &e, ImportV1Options { all: true, ..Default::default() }, &EventBus::new()).unwrap();
    let by = |n: &str| rep.projects.iter().find(|x| x.name == n).unwrap().clone();
    assert_eq!(by("Old App").outcome, ImportV1Outcome::MovedAside);
    assert_eq!(by("Plain").outcome, ImportV1Outcome::Registered);
    assert_eq!(by("Gone").outcome, ImportV1Outcome::MissingDir);
    assert_eq!(snapshot(&f.with_v1.join(BACKUP_DIR)), original);
    assert!(project_config::read(&ProjectStore::open(ProjectRoot::open_with(&f.with_v1, Profile::Release).unwrap(), EventBus::new()).unwrap()).is_ok());
    assert!(!f.plain.join(".quadflow").exists(), "a folder without 1.x data is only registered");

    let mut reg = projects::list(&app.db).unwrap();
    reg.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(reg.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["Old App", "Plain"]);
    assert_eq!(root_key(Path::new(&reg[0].root)), root_key(&f.with_v1));
    let active = settings::get_string(&app.db, settings::SHELL, settings::KEY_ACTIVE_PROJECT).unwrap();
    assert_eq!(active.as_deref(), Some(reg[0].id.as_str()), "the 1.x active project is active");
    assert_eq!(state(&app.db).unwrap().unwrap().status, ImportV1StateStatus::Completed);

    // Re-running changes nothing.
    let again = run(&app.db, &e, ImportV1Options { all: true, ..Default::default() }, &EventBus::new()).unwrap();
    assert!(again.projects.iter().filter(|p| p.name != "Gone").all(|p| p.outcome == ImportV1Outcome::AlreadyRegistered));
    assert!(!f.with_v1.join(format!("{BACKUP_DIR}-2")).exists());
    assert_eq!(projects::list(&app.db).unwrap().len(), 2);
}

#[test]
fn explicit_dirs_and_errors() {
    let f = fixture();
    let app = TempApp::new();
    let e = env(Profile::Dev, &f);
    let rep = run(&app.db, &e, ImportV1Options { projects: vec![f.with_v1.display().to_string()], ..Default::default() }, &EventBus::new()).unwrap();
    assert_eq!(rep.projects.len(), 1);
    assert_eq!(rep.projects[0].outcome, ImportV1Outcome::V1DataKept);
    assert!(f.with_v1.join(".quadflow/issues/a1a1a1a1a1a1a1a1.json").is_file(), "dev never moves .quadflow/");
    assert_eq!(projects::list(&app.db).unwrap().len(), 1);
    let err = run(&app.db, &e, ImportV1Options::default(), &EventBus::new()).unwrap_err();
    assert_eq!(err.code, crate::ErrorCode::InvalidInput);
    let none = ImportV1Env { profile: Profile::Dev, v1_override: None };
    assert_eq!(run(&app.db, &none, ImportV1Options { all: true, ..Default::default() }, &EventBus::new()).unwrap_err().code, crate::ErrorCode::NotFound);
    dismiss(&app.db).unwrap();
    assert_eq!(state(&app.db).unwrap().unwrap().status, ImportV1StateStatus::Dismissed);
}

fn cli(cwd: &Path, data: &Path, profile: &str, args: &[&str]) -> (i32, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut vars = std::collections::BTreeMap::new();
    vars.insert("QUADFLOW_PROFILE".to_string(), profile.to_string());
    vars.insert("QUADFLOW_DATA_DIR".to_string(), data.display().to_string());
    vars.insert("QUADFLOW_RESOURCE_DIR".to_string(), data.join("res").display().to_string());
    let env = crate::cli::CliEnv { cwd: cwd.to_path_buf(), vars };
    let code = {
        let mut io = crate::cli::Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
        let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
        crate::cli::run(argv, &mut io, &env)
    };
    (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
}

#[test]
fn cli_moves_v1_data_aside_on_open() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let project = tmp.path().join("app");
    write_v1_folder(&project);
    let sub = project.join("src");
    std::fs::create_dir_all(&sub).unwrap();

    // From a subfolder (walk-up): pointed out, never moved.
    let (_, _, err) = cli(&sub, &data, "release", &["issues", "list"]);
    assert!(err.contains("QuadFlow 1.x"), "{err}");
    assert!(!project.join(BACKUP_DIR).exists());

    // Dev profile: reported, not moved.
    let (_, _, err) = cli(&project, &data, "dev", &["issues", "list"]);
    assert!(err.contains("Dev builds"), "{err}");
    assert!(!project.join(BACKUP_DIR).exists());

    // Release, in the project folder: moved aside, fresh project, warning in JSON.
    let (code, out, err) = cli(&project, &data, "release", &["issues", "list", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(err.contains("moved to .quadflow-v1-backup/"), "{err}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v["warnings"][0]["message"].as_str().unwrap().contains("QuadFlow 1.x"), "{out}");
    assert!(project.join(BACKUP_DIR).join("issues/a1a1a1a1a1a1a1a1.json").is_file());
    let (code, out, err) = cli(&project, &data, "release", &["issues", "list", "--json"]);
    assert_eq!(code, 0);
    assert!(!err.contains("QuadFlow 1.x") && !out.contains("warnings"), "second open is quiet");

    // `import-v1 --dry-run` with an explicit folder.
    let other = tmp.path().join("other");
    write_v1_folder(&other);
    let (code, out, _) = cli(tmp.path(), &data, "release", &["import-v1", "--dry-run", "other", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["data"]["projects"][0]["outcome"], "would_move_aside");
    assert!(!other.join(BACKUP_DIR).exists());
}
