//! Supervisor tests against a real child process: the Node fixture
//! `test_fixture.mjs` built on `packages/sidecar-sdk-node` (skipped with a
//! message when `node` is not on PATH).

use super::*;
use crate::Core;
use crate::domains::app::secrets::Secrets;
use crate::domains::environments::{self, SystemProbe, TargetPlatform};
use crate::error::ErrorCode;
use crate::paths::AppPaths;
use crate::plugins::host::{self, HostCall, HostEnv};
use crate::plugins::{Isolation, LoadedPlugin, Permission, PluginOrigin, PluginStatus};
use std::path::Path;

fn node() -> Option<PathBuf> {
    let n = environments::which(&SystemProbe, TargetPlatform::current(), "node");
    if n.is_none() {
        eprintln!("skipping sidecar test: node is not on PATH");
    }
    n
}

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/sidecar/test_fixture.mjs")
}

struct TestHost {
    env: HostEnv,
    plugin: LoadedPlugin,
    node: PathBuf,
    mode: Mutex<String>,
    restart: SidecarRestart,
    events: Mutex<Vec<(Instant, PluginSidecarStatus)>>,
    notes: Mutex<Vec<(String, Value)>>,
    _dir: tempfile::TempDir,
}

impl SidecarHost for TestHost {
    fn config(&self, plugin_id: &str) -> Result<SidecarConfig> {
        assert_eq!(plugin_id, self.plugin.id);
        let mut env = BTreeMap::new();
        env.insert("FIXTURE_MODE".into(), self.mode.lock().clone());
        env.insert("QUADFLOW_PLUGIN_ID".into(), plugin_id.into());
        Ok(SidecarConfig {
            launch: SidecarLaunch {
                program: self.node.clone(),
                args: vec![fixture().display().to_string()],
                cwd: self._dir.path().to_path_buf(),
                env,
            },
            restart: self.restart,
            initialize: json!({ "protocolVersion": 1, "plugin": { "id": plugin_id } }),
        })
    }
    fn host_call(&self, _plugin_id: &str, method: &str, params: Value) -> Result<Value> {
        host::dispatch(&self.env, HostCall { plugin: &self.plugin, method, params })
    }
    fn notification(&self, _plugin_id: &str, method: &str, params: Value) {
        self.notes.lock().push((method.to_string(), params));
    }
    fn state_changed(&self, status: &PluginSidecarStatus) {
        self.events.lock().push((Instant::now(), status.clone()));
    }
}

fn setup(mode: &str, perms: &[&str], restart: SidecarRestart, opts: SupervisorOptions) -> Option<(Arc<TestHost>, SidecarSupervisor)> {
    let node = node()?;
    let dir = tempfile::Builder::new().prefix("qf-sidecar-").tempdir().unwrap();
    let core = Arc::new(Core::new(AppPaths::under(dir.path())));
    let env = HostEnv::new(core, Secrets::memory(), vec![]);
    let manifest = serde_json::from_value(json!({
        "id": "acme.side", "name": "Side", "version": "1.0.0", "apiVersion": "^1.0.0",
        "platforms": ["windows", "macos", "linux"], "contributes": {}
    }))
    .unwrap();
    let plugin = LoadedPlugin {
        id: "acme.side".into(),
        manifest: Some(manifest),
        root: dir.path().to_path_buf(),
        origin: PluginOrigin::Dev,
        isolation: Isolation::Sandboxed,
        status: PluginStatus::Active,
        enabled: true,
        granted: perms.iter().map(|p| Permission::parse(p).unwrap()).collect(),
        errors: vec![],
        warnings: vec![],
        shadowed: vec![],
    };
    let host = Arc::new(TestHost {
        env,
        plugin,
        node,
        mode: Mutex::new(mode.into()),
        restart,
        events: Mutex::new(vec![]),
        notes: Mutex::new(vec![]),
        _dir: dir,
    });
    let sup = SidecarSupervisor::new(host.clone(), opts);
    Some((host, sup))
}

fn fast() -> SupervisorOptions {
    let ms = Duration::from_millis;
    SupervisorOptions {
        backoff: vec![ms(200), ms(400), ms(800), ms(1600)],
        init_timeout: Duration::from_secs(10),
        request_timeout: Duration::from_secs(15),
        ..SupervisorOptions::default()
    }
}

fn wait_for(sup: &SidecarSupervisor, state: PluginSidecarState, within: Duration) -> PluginSidecarStatus {
    let deadline = Instant::now() + within;
    loop {
        let s = sup.status("acme.side");
        if s.state == state {
            return s;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {state:?}; now {s:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

fn wait_dead(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while pid_alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still alive");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn request_response_notifications_and_stop() {
    let Some((host, sup)) = setup("normal", &[], SidecarRestart::OnCrash, fast()) else { return };
    assert_eq!(sup.status("acme.side").state, PluginSidecarState::Stopped);
    // On demand: the first request starts it and waits for the handshake.
    let r = sup.request("acme.side", "ping", json!({ "x": 1 }), None).unwrap();
    assert_eq!(r["pong"], json!({ "x": 1 }));
    assert_eq!(r["env"], "acme.side");
    let st = sup.status("acme.side");
    assert_eq!(st.state, PluginSidecarState::Running);
    let pid = st.pid.expect("pid");
    assert_eq!(r["pid"], json!(pid));
    assert_eq!(sup.request("acme.side", "init", json!({}), None).unwrap()["plugin"]["id"], "acme.side");

    // Sidecar → host notifications.
    sup.request("acme.side", "emit", json!({ "n": 2 }), None).unwrap();
    sup.request("acme.side", "stderr", json!({}), None).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let notes = host.notes.lock().clone();
    assert!(notes.iter().any(|(m, p)| m == "host/emit" && p["topic"] == "tick" && p["payload"]["n"] == 2), "{notes:?}");
    assert!(notes.iter().any(|(m, p)| m == "ui/hello" && p["n"] == 2), "{notes:?}");
    let logs = sup.logs("acme.side");
    assert!(logs.iter().any(|l| l.contains("[stderr] to stderr")), "{logs:?}");
    assert!(logs.iter().any(|l| l.contains("initialized as acme.side")), "{logs:?}");

    // Unknown method → error from the sidecar.
    assert!(sup.request("acme.side", "nope", json!({}), None).is_err());
    // Timeout.
    let e = sup.request("acme.side", "slow", json!({}), Some(Duration::from_millis(200))).unwrap_err();
    assert!(e.message.contains("timed out"), "{e:?}");
    assert_eq!(sup.status("acme.side").state, PluginSidecarState::Running);

    // Graceful stop: shutdown + exit, process gone.
    sup.stop("acme.side");
    assert_eq!(sup.status("acme.side").state, PluginSidecarState::Stopped);
    wait_dead(pid);
    assert_eq!(sup.status("acme.side").restarts, 0, "a stop is not a crash");
}

#[test]
fn host_call_goes_through_the_permission_checked_dispatch_table() {
    let Some((_host, sup)) = setup("normal", &["data:ideas:read"], SidecarRestart::OnCrash, fast()) else { return };
    // Implicit permission (own storage).
    let set = sup
        .request("acme.side", "hostCall", json!({ "method": "storage.set", "params": { "key": "k", "value": 42 } }), None)
        .unwrap();
    assert!(set.get("ok").is_some(), "{set}");
    let get = sup.request("acme.side", "hostCall", json!({ "method": "storage.get", "params": { "key": "k" } }), None).unwrap();
    assert_eq!(get["ok"], 42);
    // Not granted → permission_denied naming the permission, exactly like a UI call.
    let denied = sup.request("acme.side", "hostCall", json!({ "method": "secrets.get", "params": { "name": "t" } }), None).unwrap();
    assert_eq!(denied["error"], "permission_denied", "{denied}");
    assert_eq!(denied["data"]["details"]["permission"], "secrets");
    let denied = sup.request("acme.side", "hostCall", json!({ "method": "data.issues.create", "params": { "issue": {} } }), None).unwrap();
    assert_eq!(denied["error"], "permission_denied", "{denied}");
    assert_eq!(denied["data"]["details"]["permission"], "data:issues:write");
    let unknown = sup.request("acme.side", "hostCall", json!({ "method": "nope.nope" }), None).unwrap();
    assert_eq!(unknown["error"], "invalid_input");
    sup.stop_all();
}

#[test]
fn crash_restarts_with_backoff_then_fails_after_five_crashes() {
    let Some((host, sup)) = setup("exit-after-init", &[], SidecarRestart::OnCrash, fast()) else { return };
    sup.ensure_started("acme.side");
    let failed = wait_for(&sup, PluginSidecarState::Failed, Duration::from_secs(60));
    assert_eq!(failed.restarts, 4, "{failed:?}");
    assert_eq!(failed.recent_crashes, 5);
    assert!(failed.last_error.as_deref().unwrap().contains("crashed 5 times"), "{failed:?}");

    // Backoff: each Restarting → next Starting gap is at least the scheduled delay.
    let ev = host.events.lock().clone();
    let mut gaps = vec![];
    for (i, (t, s)) in ev.iter().enumerate() {
        if s.state == PluginSidecarState::Restarting {
            let next = ev[i + 1..].iter().find(|(_, s)| s.state == PluginSidecarState::Starting).expect("restart");
            gaps.push(next.0.duration_since(*t));
        }
    }
    assert_eq!(gaps.len(), 4, "{ev:?}");
    for (gap, want) in gaps.iter().zip(fast().backoff) {
        assert!(*gap >= want - Duration::from_millis(30), "gap {gap:?} < backoff {want:?}");
    }
    assert!(gaps[3] > gaps[0], "backoff grows: {gaps:?}");

    // Failed is sticky: requests are refused without spawning.
    let e = sup.request("acme.side", "ping", json!({}), None).unwrap_err();
    assert_eq!(e.code, ErrorCode::External);
    assert!(e.message.contains("failed"), "{e:?}");

    // Manual restart clears it.
    *host.mode.lock() = "normal".into();
    sup.restart("acme.side");
    assert!(sup.request("acme.side", "ping", json!({}), None).is_ok());
    let st = sup.status("acme.side");
    assert_eq!((st.state, st.restarts, st.recent_crashes), (PluginSidecarState::Running, 0, 0));
    sup.stop_all();
}

#[test]
fn crash_fails_pending_requests_and_restarts() {
    let Some((_host, sup)) = setup("normal", &[], SidecarRestart::OnCrash, fast()) else { return };
    let pid1 = sup.request("acme.side", "ping", json!({}), None).unwrap()["pid"].as_u64().unwrap();
    let e = sup.request("acme.side", "crash", json!({}), None).unwrap_err();
    assert_eq!(e.code, ErrorCode::External);
    assert!(e.message.contains("exited"), "{e:?}");
    // The next request waits through the backoff for the restarted process.
    let pid2 = sup.request("acme.side", "ping", json!({}), None).unwrap()["pid"].as_u64().unwrap();
    assert_ne!(pid1, pid2);
    let st = sup.status("acme.side");
    assert_eq!((st.restarts, st.recent_crashes), (1, 1));
    sup.stop_all();
}

#[test]
fn restart_never_fails_on_first_crash() {
    let Some((_host, sup)) = setup("normal", &[], SidecarRestart::Never, fast()) else { return };
    let _ = sup.request("acme.side", "crash", json!({}), None);
    let st = wait_for(&sup, PluginSidecarState::Failed, Duration::from_secs(10));
    assert!(st.last_error.unwrap().contains("restart: never"));
}

#[test]
fn killing_the_tree_kills_grandchildren() {
    let Some((_host, sup)) = setup("normal", &[], SidecarRestart::Never, fast()) else { return };
    let child = sup.request("acme.side", "spawnChild", json!({}), None).unwrap()["child"].as_u64().unwrap() as u32;
    let pid = sup.status("acme.side").pid.unwrap();
    assert!(pid_alive(child));
    // stop(): the sidecar exits on `exit`, then the process tree (job / group) is killed.
    sup.stop("acme.side");
    wait_dead(pid);
    wait_dead(child);
}

#[test]
fn ui_methods_are_restricted() {
    for bad in ["", "$/cancelRequest", "host/call", "ui/x", "cli/run", "initialize", "shutdown", "exit", "agentProvider/launch"] {
        assert!(check_ui_method(bad).is_err(), "{bad}");
    }
    for ok in ["ping", "discord/init", "hello.world"] {
        assert!(check_ui_method(ok).is_ok(), "{ok}");
    }
}

#[test]
fn config_error_is_failed() {
    struct NoSidecar;
    impl SidecarHost for NoSidecar {
        fn config(&self, _: &str) -> Result<SidecarConfig> {
            Err(CoreError::unsupported("no sidecar for this platform (plan9-x86_64)"))
        }
        fn host_call(&self, _: &str, _: &str, _: Value) -> Result<Value> {
            unreachable!()
        }
    }
    let sup = SidecarSupervisor::new(Arc::new(NoSidecar), fast());
    let e = sup.request("x", "ping", json!({}), None).unwrap_err();
    assert!(e.message.contains("no sidecar for this platform"), "{e:?}");
    assert_eq!(sup.status("x").state, PluginSidecarState::Failed);
    sup.stop("x");
    assert_eq!(sup.status("x").state, PluginSidecarState::Stopped);
}
