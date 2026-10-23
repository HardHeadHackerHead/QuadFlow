//! CLI contract for `quadflow plugins install|update|rollback|uninstall|browse|sources …`
//! (plugin-system.md §12.3) against a local file:// fake source. No network.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::BTreeMap;
use std::io::Write;

struct Env {
    data: tempfile::TempDir,
    res: tempfile::TempDir,
    src: tempfile::TempDir,
    index: std::cell::RefCell<Value>,
}

impl Env {
    fn new() -> Self {
        let e = Self {
            data: tempfile::tempdir().unwrap(),
            res: tempfile::tempdir().unwrap(),
            src: tempfile::tempdir().unwrap(),
            index: std::cell::RefCell::new(json!({"formatVersion": 1, "name": "Local", "plugins": []})),
        };
        std::fs::create_dir_all(e.res.path().join("plugins")).unwrap();
        e.save();
        e
    }

    fn index_url(&self) -> String {
        url::Url::from_file_path(self.src.path().join("index.json")).unwrap().to_string()
    }

    fn save(&self) {
        std::fs::write(self.src.path().join("index.json"), self.index.borrow().to_string()).unwrap();
    }

    fn publish(&self, id: &str, version: &str, perms: &[&str]) {
        let zip = self.src.path().join(format!("{id}-{version}.zip"));
        let manifest = json!({"id": id, "name": id, "version": version, "apiVersion": "^1.0.0",
            "platforms": ["windows", "macos", "linux"], "permissions": perms});
        {
            let f = std::fs::File::create(&zip).unwrap();
            let mut z = zip::ZipWriter::new(f);
            z.start_file("quadflow-plugin.json", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(manifest.to_string().as_bytes()).unwrap();
            z.finish().unwrap();
        }
        let bytes = std::fs::read(&zip).unwrap();
        let v = json!({"version": version, "apiVersion": "^1.0.0", "platforms": ["windows", "macos", "linux"],
            "url": url::Url::from_file_path(&zip).unwrap().to_string(),
            "sha256": hex::encode(sha2::Sha256::digest(&bytes)), "size": bytes.len(), "permissions": perms});
        let mut idx = self.index.borrow_mut();
        let plugins = idx["plugins"].as_array_mut().unwrap();
        match plugins.iter_mut().find(|p| p["id"] == id) {
            Some(p) => p["versions"].as_array_mut().unwrap().push(v),
            None => plugins.push(json!({"id": id, "name": id, "description": "test", "versions": [v]})),
        }
        drop(idx);
        self.save();
    }

    fn cli(&self, args: &[&str]) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut vars = BTreeMap::new();
        vars.insert("QUADFLOW_PROFILE".to_string(), "dev".to_string());
        vars.insert("QUADFLOW_DATA_DIR".to_string(), self.data.path().display().to_string());
        vars.insert("QUADFLOW_RESOURCE_DIR".to_string(), self.res.path().display().to_string());
        vars.insert("QUADFLOW_SECRETS_BACKEND".to_string(), "memory".to_string());
        vars.insert("QUADFLOW_NONINTERACTIVE".to_string(), "1".to_string());
        // Never contact the real repository: the built-in source is a closed local port.
        vars.insert("QUADFLOW_PLUGIN_INDEX_URL".to_string(), "http://127.0.0.1:9/plugins/index.json".to_string());
        let env = CliEnv { cwd: self.data.path().to_path_buf(), vars };
        let code = {
            let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
            let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
            run(argv, &mut io, &env)
        };
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }
}

fn json_of(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not one JSON document ({e}): {s}"))
}

fn installed_dir(env: &Env, id: &str, v: &str) -> std::path::PathBuf {
    env.data.path().join("plugins").join(id).join(v)
}

#[test]
fn sources_install_update_uninstall() {
    let env = Env::new();
    env.publish("acme.hello", "1.0.0", &["notifications"]);

    // sources add / list
    let (code, out, _) = env.cli(&["plugins", "sources", "add", &env.index_url(), "--json"]);
    assert_eq!(code, 0, "{out}");
    let src = json_of(&out)["data"].clone();
    assert_eq!(src["pluginCount"], 1);
    assert_eq!(src["name"], "Local");
    let sid = src["id"].as_str().unwrap().to_string();
    let (code, out, _) = env.cli(&["plugins", "sources", "list", "--json"]);
    assert_eq!(code, 0);
    let list = json_of(&out)["data"].as_array().unwrap().clone();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["builtin"], true);

    // browse
    let (code, out, _) = env.cli(&["plugins", "browse", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"][0]["entry"]["id"], "acme.hello");

    // install without --yes on a non-TTY → usage error (exit 2), nothing installed
    let (code, out, _) = env.cli(&["plugins", "install", "acme.hello", "--json"]);
    assert_eq!(code, 2, "{out}");
    assert_eq!(json_of(&out)["error"]["code"], "invalid_input");
    assert!(!installed_dir(&env, "acme.hello", "1.0.0").exists());

    let (code, out, _) = env.cli(&["plugins", "install", "acme.hello", "--source", &sid, "--yes", "--json"]);
    assert_eq!(code, 0, "{out}");
    let p = json_of(&out)["data"].clone();
    assert_eq!(p["status"]["kind"], "active", "{p}");
    assert_eq!(p["origin"], "installed");
    assert!(installed_dir(&env, "acme.hello", "1.0.0").is_dir());

    // update adding a permission: --check lists it as needing approval
    env.publish("acme.hello", "1.1.0", &["notifications", "clipboard:write"]);
    let (code, out, _) = env.cli(&["plugins", "update", "--check", "--json"]);
    assert_eq!(code, 0, "{out}");
    let ups = json_of(&out)["data"].clone();
    assert_eq!(ups[0]["version"], "1.1.0");
    assert_eq!(ups[0]["needsConsent"], true);
    assert_eq!(ups[0]["addedPermissions"], json!(["clipboard:write"]));

    // update all without --yes: reported pending, still 1.0.0
    let (code, out, _) = env.cli(&["plugins", "update", "--json"]);
    assert_eq!(code, 0, "{out}");
    let run = json_of(&out)["data"].clone();
    assert_eq!(run["updated"], json!([]));
    assert_eq!(run["pending"][0]["pluginId"], "acme.hello");
    // update one without --yes: exit 2
    let (code, _, _) = env.cli(&["plugins", "update", "acme.hello", "--json"]);
    assert_eq!(code, 2);
    let (_, out, _) = env.cli(&["plugins", "info", "acme.hello", "--json"]);
    assert_eq!(json_of(&out)["data"]["version"], "1.0.0");

    let (code, out, _) = env.cli(&["plugins", "update", "acme.hello", "--yes", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"]["updated"][0]["version"], "1.1.0");

    // rollback → 1.0.0
    let (code, out, _) = env.cli(&["plugins", "rollback", "acme.hello", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"]["version"], "1.0.0");

    // uninstall
    let (code, out, _) = env.cli(&["plugins", "uninstall", "acme.hello", "--delete-data", "--json"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(json_of(&out)["data"]["revertedToBundled"], false);
    assert!(!env.data.path().join("plugins").join("acme.hello").exists());
    let (code, _, _) = env.cli(&["plugins", "info", "acme.hello", "--json"]);
    assert_eq!(code, 3);

    // sources remove; built-in cannot be removed
    let (code, _, _) = env.cli(&["plugins", "sources", "remove", "official", "--json"]);
    assert_eq!(code, 2);
    let (code, out, _) = env.cli(&["plugins", "sources", "remove", &sid, "--json"]);
    assert_eq!(code, 0, "{out}");
}

#[test]
fn tampered_archive_fails_with_integrity_error() {
    let env = Env::new();
    env.publish("acme.hello", "1.0.0", &[]);
    let zip = env.src.path().join("acme.hello-1.0.0.zip");
    let mut b = std::fs::read(&zip).unwrap();
    let n = b.len();
    b[n / 3] ^= 0x55;
    std::fs::write(&zip, b).unwrap();
    env.cli(&["plugins", "sources", "add", &env.index_url()]);
    let (code, out, _) = env.cli(&["plugins", "install", "acme.hello", "--yes", "--json"]);
    assert_eq!(code, 1, "{out}");
    let e = json_of(&out)["error"].clone();
    assert_eq!(e["code"], "corrupt");
    assert!(e["message"].as_str().unwrap().contains("integrity"));
    assert!(!installed_dir(&env, "acme.hello", "1.0.0").exists());
}

#[test]
fn refresh_reports_down_sources_without_failing() {
    let env = Env::new();
    env.publish("acme.hello", "1.0.0", &[]);
    env.cli(&["plugins", "sources", "add", &env.index_url()]);
    let (code, out, _) = env.cli(&["plugins", "sources", "refresh", "--json"]);
    assert_eq!(code, 0, "{out}");
    let list = json_of(&out)["data"].as_array().unwrap().clone();
    let builtin = list.iter().find(|s| s["builtin"] == true).unwrap();
    assert!(builtin["lastError"].is_string(), "the unreachable built-in source records an error");
    let local = list.iter().find(|s| s["builtin"] == false).unwrap();
    assert!(local["lastError"].is_null());
    // Human output too.
    let (code, out, _) = env.cli(&["plugins", "sources", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains("[built-in]") && out.contains("error:"), "{out}");
}
