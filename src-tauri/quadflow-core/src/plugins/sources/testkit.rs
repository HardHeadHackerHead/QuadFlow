//! Test fixtures: a temp app, a local fake source (file:// index + archives) and
//! a tiny HTTP server with ETag support. No network to real hosts.

use super::fetch::sha256_file;
use super::SourceOptions;
use crate::plugins::registry::LoadOptions;
use crate::plugins::{Platform, MANIFEST_FILE};
use crate::testing::TempApp;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

pub(crate) struct Env {
    pub app: TempApp,
    pub res: tempfile::TempDir,
    pub opts: SourceOptions,
}

impl Env {
    pub fn new() -> Self {
        let app = TempApp::new();
        let res = tempfile::tempdir().unwrap();
        let opts = SourceOptions {
            allow_dev_urls: true,
            // The built-in source points at a closed local port: never the real repo.
            builtin_url: format!("http://127.0.0.1:{}/plugins/index.json", free_port()),
            index_timeout: Duration::from_secs(5),
            download_timeout: Duration::from_secs(30),
            load: LoadOptions {
                resource_dir: Some(res.path().to_path_buf()),
                dev_paths: Some(vec![]),
                platform: Platform::current(),
                target: crate::plugins::current_target(),
                host_api: semver::Version::parse("1.2.0").unwrap(),
            },
        };
        Self { app, res, opts }
    }

    pub fn fake_source(&self) -> FakeSource {
        FakeSource::new()
    }

    /// A bundled plugin in the fake resource dir.
    pub fn bundled_with(&self, id: &str, version: &str, perms: &[&str]) -> PathBuf {
        let dir = self.res.path().join("plugins").join(id);
        write_plugin_dir(&dir, &manifest(id, version, perms, "^1.0.0"), &[]);
        dir
    }
}

pub(crate) fn manifest(id: &str, version: &str, perms: &[&str], api: &str) -> Value {
    json!({
        "id": id, "name": format!("Plugin {id}"), "version": version, "apiVersion": api,
        "description": format!("Test plugin {id}"),
        "platforms": ["windows", "macos", "linux"],
        "ui": { "entry": "dist/index.js" },
        "contributes": { "tiles": [{ "id": "main", "title": format!("{id} tile") }] },
        "permissions": perms,
    })
}

fn write_plugin_dir(dir: &Path, manifest: &Value, extra: &[(String, Vec<u8>)]) {
    std::fs::create_dir_all(dir.join("dist")).unwrap();
    std::fs::write(dir.join("dist/index.js"), "export default {}").unwrap();
    std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_string_pretty(manifest).unwrap()).unwrap();
    for (name, data) in extra {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, data).unwrap();
    }
}

/// A source folder: `index.json` + `archives/<id>-<version>.zip`.
pub(crate) struct FakeSource {
    pub dir: tempfile::TempDir,
    index: Mutex<Value>,
}

impl FakeSource {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("archives")).unwrap();
        let s = Self { dir, index: Mutex::new(json!({"formatVersion": 1, "name": "Fake source", "plugins": []})) };
        s.save();
        s
    }

    pub fn url(&self) -> String {
        url::Url::from_file_path(self.dir.path().join("index.json")).unwrap().to_string()
    }

    pub fn archive_path(&self, id: &str, version: &str) -> PathBuf {
        self.dir.path().join("archives").join(format!("{id}-{version}.zip"))
    }

    fn save(&self) {
        let body = serde_json::to_string_pretty(&*self.index.lock()).unwrap();
        std::fs::write(self.dir.path().join("index.json"), body).unwrap();
    }

    /// Publish a version whose manifest and index agree.
    pub fn publish(&self, id: &str, version: &str, perms: &[&str], notes: Option<&str>) {
        self.publish_full(id, version, perms, perms, "^1.0.0", vec![], notes);
    }

    pub fn publish_files(&self, id: &str, version: &str, perms: &[&str], files: Vec<(String, Vec<u8>)>) {
        self.publish_full(id, version, perms, perms, "^1.0.0", files, None);
    }

    pub fn publish_with_manifest_perms(&self, id: &str, version: &str, index_perms: &[&str], manifest_perms: &[&str]) {
        self.publish_full(id, version, index_perms, manifest_perms, "^1.0.0", vec![], None);
    }

    pub fn publish_api(&self, id: &str, version: &str, api: &str) {
        self.publish_full(id, version, &[], &[], api, vec![], None);
    }

    pub fn mark_bundled(&self, id: &str) {
        let mut idx = self.index.lock();
        for p in idx["plugins"].as_array_mut().unwrap() {
            if p["id"] == id {
                p["bundled"] = json!(true);
            }
        }
        drop(idx);
        self.save();
    }

    #[allow(clippy::too_many_arguments)]
    fn publish_full(
        &self,
        id: &str,
        version: &str,
        index_perms: &[&str],
        manifest_perms: &[&str],
        api: &str,
        extra_entries: Vec<(String, Vec<u8>)>,
        notes: Option<&str>,
    ) {
        let zip = self.archive_path(id, version);
        let m = serde_json::to_vec_pretty(&manifest(id, version, manifest_perms, api)).unwrap();
        let mut files: Vec<(String, Vec<u8>)> =
            vec![(MANIFEST_FILE.to_string(), m), ("dist/index.js".to_string(), b"export default {}".to_vec())];
        files.extend(extra_entries);
        let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        super::archive::tests::write_zip(&zip, &refs);
        let sha = sha256_file(&zip).unwrap();
        let size = std::fs::metadata(&zip).unwrap().len();
        let mut v = json!({
            "version": version, "apiVersion": api, "platforms": ["windows", "macos", "linux"],
            "url": url::Url::from_file_path(&zip).unwrap().to_string(),
            "sha256": sha, "size": size, "permissions": index_perms,
        });
        if let Some(n) = notes {
            v["notes"] = json!(n);
        }
        let mut idx = self.index.lock();
        let plugins = idx["plugins"].as_array_mut().unwrap();
        match plugins.iter_mut().find(|p| p["id"] == id) {
            Some(p) => p["versions"].as_array_mut().unwrap().push(v),
            None => plugins.push(json!({"id": id, "name": format!("Plugin {id}"), "description": "A test plugin", "versions": [v]})),
        }
        drop(idx);
        self.save();
    }
}

/// Minimal HTTP/1.1 server: serves files from a directory with strong ETags
/// (sha256 of the body) and `If-None-Match` → 304; or hangs forever.
pub(crate) struct TestServer {
    port: u16,
    ok: Arc<AtomicUsize>,
    not_modified: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl TestServer {
    pub fn serve_dir(root: &Path) -> Self {
        Self::start(Some(root.to_path_buf()))
    }

    /// Accepts connections and never responds.
    pub fn hang() -> Self {
        Self::start(None)
    }

    fn start(root: Option<PathBuf>) -> Self {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        l.set_nonblocking(true).unwrap();
        let ok = Arc::new(AtomicUsize::new(0));
        let nm = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (ok2, nm2, stop2) = (ok.clone(), nm.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut held: Vec<TcpStream> = Vec::new();
            while !stop2.load(Ordering::Relaxed) {
                match l.accept() {
                    Ok((s, _)) => {
                        s.set_nonblocking(false).ok();
                        match &root {
                            None => held.push(s),
                            Some(r) => handle(s, r, &ok2, &nm2),
                        }
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        });
        Self { port, ok, not_modified: nm, stop }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}/{path}", self.port)
    }
    pub fn hits_200(&self) -> usize {
        self.ok.load(Ordering::Relaxed)
    }
    pub fn hits_304(&self) -> usize {
        self.not_modified.load(Ordering::Relaxed)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn handle(mut s: TcpStream, root: &Path, ok: &AtomicUsize, nm: &AtomicUsize) {
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut reader = BufReader::new(s.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
    let mut inm = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("if-none-match") {
                inm = Some(v.trim().to_string());
            }
        }
    }
    let file = root.join(&path);
    let body = match std::fs::File::open(&file) {
        Ok(mut f) => {
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            b
        }
        Err(_) => {
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
    };
    use sha2::Digest;
    let etag = format!("\"{}\"", hex::encode(sha2::Sha256::digest(&body)));
    if inm.as_deref() == Some(etag.as_str()) {
        nm.fetch_add(1, Ordering::Relaxed);
        let _ = s.write_all(format!("HTTP/1.1 304 Not Modified\r\nETag: {etag}\r\nConnection: close\r\n\r\n").as_bytes());
        return;
    }
    ok.fetch_add(1, Ordering::Relaxed);
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nETag: {etag}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(&body);
}
