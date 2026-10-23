//! Service-level tests: run records, streaming, abort, config contract.

use super::*;
use crate::events::Domain;
use crate::model::Actor;
use crate::testing::TempProject;
use parking_lot::Mutex;
use std::sync::Arc;

fn actor() -> Actor {
    Actor::human("tester")
}

fn shell_phase(name: &str, command: &str) -> ShipPhase {
    ShipPhase::Shell {
        name: name.into(),
        command: command.into(),
        skippable: false,
        skip_flag: None,
        working_directory: None,
        env: Default::default(),
        external_terminal: false,
    }
}

fn project(phases: Vec<ShipPhase>) -> TempProject {
    let p = TempProject::new();
    std::fs::write(p.dir.path().join("package.json"), "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\"\n}\n").unwrap();
    let cfg = ShipConfig {
        format_version: SHIP_FORMAT_VERSION,
        product_name: "Demo".into(),
        version_files: detect_version_files(p.dir.path()),
        phases,
        changelog: ShipChangelogConfig { source: ShipChangelogSource::Manual, since: "last_tag".into() },
    };
    config_save(&p.store, &actor(), cfg).unwrap();
    p
}

#[derive(Default)]
struct Recorder {
    phases: Mutex<Vec<ShipPhaseEvent>>,
    lines: Mutex<Vec<ShipLineEvent>>,
}
impl ShipSink for Recorder {
    fn phase(&self, e: ShipPhaseEvent) {
        self.phases.lock().push(e);
    }
    fn line(&self, e: ShipLineEvent) {
        self.lines.lock().push(e);
    }
}

#[test]
fn two_runs_of_the_same_version_keep_two_records() {
    let p = project(vec![shell_phase("hello", "echo hello")]);
    let opts = ShipRunOptions::new(ShipRunMode::Deploy);
    let a = run(&p.store, &actor(), opts.clone(), &NullSink).unwrap();
    let b = run(&p.store, &actor(), opts, &NullSink).unwrap();
    assert_eq!(a.version, "1.0.0");
    assert_eq!(a.version, b.version);
    assert_ne!(a.id, b.id);
    assert_eq!(a.status, ShipRunStatus::Completed);
    let runs = runs_list(&p.store).unwrap();
    assert_eq!(runs.items.len(), 2);
    assert!(runs.errors.is_empty());
    assert_eq!(runs.items[0].id, b.id, "newest first");
    assert_eq!(run_by_version(&p.store, "v1.0.0").unwrap().id, b.id);
    assert!(p.store.data_dir().join("local/ship/runs").join(format!("{}.json", a.id)).is_file());
}

#[test]
fn streams_lines_and_phase_events_and_bumps() {
    let p = project(vec![ShipPhase::VersionBump { name: "bump".into() }, shell_phase("say", "echo v{version} of {productName}")]);
    let rec = Recorder::default();
    let r = run(&p.store, &actor(), ShipRunOptions::new(ShipRunMode::Minor), &rec).unwrap();
    assert_eq!(r.status, ShipRunStatus::Completed, "{r:?}");
    assert_eq!((r.previous_version.as_deref(), r.version.as_str()), (Some("1.0.0"), "1.1.0"));
    let pkg = std::fs::read_to_string(p.dir.path().join("package.json")).unwrap();
    assert_eq!(pkg, "{\n  \"name\": \"demo\",\n  \"version\": \"1.1.0\"\n}\n");
    let phases = rec.phases.lock();
    assert_eq!(phases.len(), 4, "running + done per phase");
    assert_eq!(phases[0].phase.status, ShipPhaseStatus::Running);
    assert_eq!(phases[3].phase.status, ShipPhaseStatus::Passed);
    assert!(rec.lines.lock().iter().any(|l| l.stream == ShipLineStream::Stdout && l.line.contains("v1.1.0 of Demo")));
    assert!(r.phases[1].stdout.as_deref().unwrap_or("").contains("v1.1.0 of Demo"));
}

#[test]
fn failed_phase_stops_the_run_and_reports() {
    let p = project(vec![shell_phase("boom", "exit 3"), shell_phase("never", "echo no")]);
    let r = run(&p.store, &actor(), ShipRunOptions::new(ShipRunMode::Deploy), &NullSink).unwrap();
    assert_eq!(r.status, ShipRunStatus::Failed);
    assert_eq!(r.phases[0].exit_code, Some(3));
    assert_eq!(r.phases[1].status, ShipPhaseStatus::Pending);
    let e = run_outcome_error(&r).unwrap();
    assert_eq!(e.code, crate::ErrorCode::External);
    assert!(e.message.contains("boom"));
    assert_eq!(runs_get(&p.store, &r.id).unwrap().status, ShipRunStatus::Failed);
}

#[test]
fn dry_run_resolves_without_side_effects() {
    let p = project(vec![
        ShipPhase::VersionBump { name: "bump".into() },
        ShipPhase::GitTag { name: "tag".into(), tag: "v{version}".into(), message: None, sign: false, if_exists: ShipTagConflict::Fail },
    ]);
    let mut opts = ShipRunOptions::new(ShipRunMode::Patch);
    opts.dry_run = true;
    let r = run(&p.store, &actor(), opts, &NullSink).unwrap();
    assert_eq!(r.status, ShipRunStatus::DryRun);
    assert_eq!(r.phases[1].command.as_deref(), Some("git tag -a v1.0.1 -m \"v1.0.1\""));
    assert!(runs_list(&p.store).unwrap().items.is_empty());
    assert!(std::fs::read_to_string(p.dir.path().join("package.json")).unwrap().contains("1.0.0"));
}

#[test]
fn abort_kills_the_running_command() {
    let slow = if cfg!(windows) { "ping -n 30 127.0.0.1 > nul" } else { "sleep 30" };
    let p = Arc::new(project(vec![shell_phase("slow", slow), shell_phase("after", "echo after")]));
    let started = Arc::new(Recorder::default());
    let (p2, s2) = (p.clone(), started.clone());
    let h = std::thread::spawn(move || run(&p2.store, &actor(), ShipRunOptions::new(ShipRunMode::Deploy), &*s2).unwrap());
    let t0 = std::time::Instant::now();
    while started.phases.lock().is_empty() {
        assert!(t0.elapsed().as_secs() < 20, "run never started");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    let aborted = abort(&p.store, &actor(), None).unwrap();
    assert_eq!(aborted.status, ShipRunStatus::Aborted);
    let r = h.join().unwrap();
    assert!(t0.elapsed().as_secs() < 20, "command was not killed");
    assert_eq!(r.status, ShipRunStatus::Aborted);
    assert_eq!(r.phases[1].status, ShipPhaseStatus::Skipped);
    assert_eq!(runs_get(&p.store, &r.id).unwrap().status, ShipRunStatus::Aborted);
    assert_eq!(abort(&p.store, &actor(), Some(&r.id)).unwrap_err().code, crate::ErrorCode::Conflict);
}

#[test]
fn config_contract() {
    let p = TempProject::new();
    assert!(config_get(&p.store).unwrap().is_none());
    assert_eq!(config_require(&p.store).unwrap_err().code, crate::ErrorCode::NotFound);
    assert_eq!(status(&p.store).unwrap_err().code, crate::ErrorCode::NotFound);
    assert!(readiness(&p.store).unwrap().is_empty());

    std::fs::write(p.dir.path().join("Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    p.store.bus().subscribe(move |e| ev.lock().push(e.domain));
    let cfg = init(&p.store, &actor(), ShipInitOptions::default()).unwrap();
    assert_eq!(cfg.product_name, "demo");
    assert!(events.lock().contains(&Domain::Ship));
    let raw = std::fs::read_to_string(config_path(&p.store)).unwrap();
    assert!(raw.contains("\"formatVersion\": 1") && raw.contains("\"versionFiles\"") && raw.contains("\"type\": \"ensure_staging_dir\""), "{raw}");
    assert_eq!(init(&p.store, &actor(), ShipInitOptions::default()).unwrap_err().code, crate::ErrorCode::Conflict);
    assert!(validate(&p.store).unwrap().valid, "{:?}", validate(&p.store).unwrap());

    // Corrupt config: reported, never replaced by a read-modify-write.
    std::fs::write(config_path(&p.store), "{ nope").unwrap();
    assert_eq!(config_get(&p.store).unwrap_err().code, crate::ErrorCode::Corrupt);
    assert!(diagnostics(&p.store).unwrap().config_parse_error.is_some());
    let del = config_delete(&p.store, &actor()).unwrap();
    assert!(del.deleted);
    assert_eq!(std::fs::read_to_string(del.backup_path.unwrap()).unwrap(), "{ nope");
    assert!(!config_delete(&p.store, &actor()).unwrap().deleted);

    // Newer format → incompatible.
    std::fs::write(config_path(&p.store), "{\"formatVersion\":2,\"productName\":\"x\",\"phases\":[]}").unwrap();
    assert_eq!(config_get(&p.store).unwrap_err().code, crate::ErrorCode::Incompatible);
}

#[test]
fn validation_catches_missing_tool_and_unknown_checks() {
    let p = project(vec![
        ShipPhase::Checks { name: "pre".into(), checks: vec!["qwick_authenticated".into(), "git_clean".into()] },
        ShipPhase::SignAuthenticode { name: "sign".into(), files: vec!["*.exe".into()], tool: None },
        shell_phase("pre", "echo dup"),
    ]);
    let v = validate(&p.store).unwrap();
    assert!(!v.valid);
    let all = v.errors.join("\n");
    assert!(all.contains("unknown check `qwick_authenticated`"), "{all}");
    assert!(all.contains("needs a `tool`"), "{all}");
    assert!(all.contains("duplicate phase name: pre"), "{all}");
    let e = run(&p.store, &actor(), ShipRunOptions::new(ShipRunMode::Deploy), &NullSink).unwrap_err();
    assert_eq!(e.code, crate::ErrorCode::InvalidInput);
}

#[test]
fn camel_case_phase_fields_round_trip() {
    let json = serde_json::json!({
        "type": "shell", "name": "x", "command": "c", "skipFlag": "skip-build", "workingDirectory": "sub", "externalTerminal": true
    });
    let phase: ShipPhase = serde_json::from_value(json.clone()).unwrap();
    let ShipPhase::Shell { skip_flag, working_directory, external_terminal, .. } = &phase else { panic!() };
    assert_eq!((skip_flag.as_deref(), working_directory.as_deref(), *external_terminal), (Some("skip-build"), Some("sub"), true));
    let back = serde_json::to_value(&phase).unwrap();
    assert_eq!(back["skipFlag"], "skip-build");
    assert!(back.get("skip_flag").is_none());
    let r: ShipRunEvent = serde_json::from_value(serde_json::json!({"type": "restored_backups", "files": ["a"]})).unwrap();
    assert_eq!(r, ShipRunEvent::RestoredBackups { files: vec!["a".into()] });
}

#[test]
fn runs_a_config_file_instead_of_the_stored_config() {
    // The stored config would fail; the file config must be the one that runs.
    let p = project(vec![shell_phase("stored", "exit 3")]);
    let file_cfg = ShipConfig {
        format_version: SHIP_FORMAT_VERSION,
        product_name: "FromFile".into(),
        version_files: detect_version_files(p.dir.path()),
        phases: vec![shell_phase("from-file", "echo {productName}")],
        changelog: ShipChangelogConfig { source: ShipChangelogSource::Manual, since: "last_tag".into() },
    };
    let path = p.dir.path().join("release.ship.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&file_cfg).unwrap()).unwrap();
    let cfg = config_from_file(&path).unwrap();
    assert_eq!(cfg, file_cfg);
    let r = run_with_config(&p.store, &actor(), cfg, ShipRunOptions::new(ShipRunMode::Deploy), &NullSink).unwrap();
    assert_eq!(r.status, ShipRunStatus::Completed, "{r:?}");
    assert_eq!(r.phases[0].name, "from-file");
    assert_eq!(runs_list(&p.store).unwrap().items.len(), 1, "the run is recorded in the project");

    std::fs::write(&path, b"{\"formatVersion\": 1}").unwrap();
    assert_eq!(config_from_file(&path).unwrap_err().code, crate::error::ErrorCode::InvalidInput);
    std::fs::write(&path, serde_json::to_vec(&ShipConfig { format_version: 99, ..file_cfg }).unwrap()).unwrap();
    assert_eq!(config_from_file(&path).unwrap_err().code, crate::error::ErrorCode::Incompatible);
}

#[test]
fn quoted_paths_with_spaces_reach_the_shell_intact() {
    // cmd.exe must get the line verbatim (no `\"` escaping); same line works under sh.
    let p = project(vec![shell_phase("write", "echo hi > \"out file.txt\"")]);
    let r = run(&p.store, &actor(), ShipRunOptions::new(ShipRunMode::Deploy), &NullSink).unwrap();
    assert_eq!(r.status, ShipRunStatus::Completed, "{r:?}");
    let out = std::fs::read_to_string(p.dir.path().join("out file.txt")).unwrap();
    assert_eq!(out.trim(), "hi");
}

#[test]
fn gh_release_notes_file_is_optional_camel_case() {
    let p: ShipPhase =
        serde_json::from_str(r#"{"type":"gh_release","name":"rel","repo":"o/r","notesFile":"{staging_dir}/notes.md","files":[]}"#).unwrap();
    let ShipPhase::GhRelease { notes_file, draft, .. } = &p else { panic!("{p:?}") };
    assert_eq!(notes_file.as_deref(), Some("{staging_dir}/notes.md"));
    assert!(*draft);
    let without: ShipPhase = serde_json::from_str(r#"{"type":"gh_release","name":"rel","repo":"o/r","files":[]}"#).unwrap();
    assert!(!serde_json::to_string(&without).unwrap().contains("notesFile"));
}
