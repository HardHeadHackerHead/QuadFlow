//! Write QuadFlow plugin sidecars in Rust (plugin-system.md §10).
//!
//! The host talks JSON-RPC 2.0 to your process over stdin/stdout, one JSON
//! object per line (NDJSON). This crate does the framing, the handshake
//! (`initialize` / `initialized` / `shutdown` / `exit`) and request routing;
//! you register handlers:
//!
//! ```no_run
//! use quadflow_sidecar::{Server, json};
//!
//! fn main() -> std::io::Result<()> {
//!     Server::new()
//!         .on_request("ping", |_host, params| Ok(json!({ "pong": params })))
//!         .on_request("count", |host, _| {
//!             // Any host API method, permission-checked like a UI call.
//!             host.call("storage.get", json!({ "key": "count" }))
//!         })
//!         .run()
//! }
//! ```
//!
//! Never print to stdout yourself: it is the protocol channel. Use
//! [`Host::log`] or stderr (both end up in the plugin's log).
//!
//! Each request runs on its own thread, so a handler may call back into the
//! host ([`Host::call`]) while other requests are served.

pub use serde_json::{json, Value};

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// JSON-RPC error code used by the host for its errors (`data.code` = QuadFlow error code).
pub const HOST_ERROR: i64 = -32000;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// A JSON-RPC error, either returned by your handler or received from the host.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { code: HOST_ERROR, message: message.into(), data: Some(json!({ "code": "internal" })) }
    }
    /// An error with a QuadFlow error code (`invalid_input`, `not_found`, …).
    pub fn with_kind(kind: &str, message: impl Into<String>) -> Self {
        Self { code: HOST_ERROR, message: message.into(), data: Some(json!({ "code": kind })) }
    }
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self { code: INVALID_PARAMS, message: message.into(), data: Some(json!({ "code": "invalid_input" })) }
    }
    /// The QuadFlow error code the host sent (`permission_denied`, `not_found`, …).
    pub fn kind(&self) -> Option<&str> {
        self.data.as_ref()?.get("code")?.as_str()
    }
    /// `details` the host sent (e.g. `{ "permission": "secrets" }` for `permission_denied`).
    pub fn details(&self) -> Option<&Value> {
        self.data.as_ref()?.get("details")
    }
    fn to_value(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.data {
            v["data"] = d.clone();
        }
        v
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.kind() {
            Some(k) => write!(f, "{k}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for RpcError {}

pub type RpcResult = Result<Value, RpcError>;
type RequestFn = Arc<dyn Fn(&Host, Value) -> RpcResult + Send + Sync>;
type NotifyFn = Arc<dyn Fn(&Host, Value) + Send + Sync>;
type InitFn = Arc<dyn Fn(&Host, &Value) -> RpcResult + Send + Sync>;
type Writer = Box<dyn Write + Send>;
type Job = Box<dyn FnOnce(&Host) -> RpcResult + Send>;

struct HostInner {
    out: Mutex<Writer>,
    pending: Mutex<HashMap<String, mpsc::Sender<RpcResult>>>,
    next: AtomicU64,
    init: OnceLock<Value>,
}

/// The connection back to QuadFlow. Cheap to clone; usable from any thread.
#[derive(Clone)]
pub struct Host {
    inner: Arc<HostInner>,
}

impl Host {
    fn send(&self, v: Value) {
        let mut line = v.to_string();
        line.push('\n');
        let mut out = self.inner.out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = out.write_all(line.as_bytes());
        let _ = out.flush();
    }

    /// Raw request to the host, waiting up to `timeout`.
    pub fn request_timeout(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        let id = format!("s{}", self.inner.next.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = mpsc::channel();
        self.inner.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                self.inner.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err(RpcError::with_kind("external", format!("host request {method} timed out")))
            }
        }
    }

    /// `host/call`: run a host API method (`storage.get`, `data.issues.create`,
    /// `http.fetch`, …) with this plugin's granted permissions.
    pub fn call(&self, method: &str, params: Value) -> RpcResult {
        self.call_timeout(method, params, Duration::from_secs(60))
    }

    pub fn call_timeout(&self, method: &str, params: Value, timeout: Duration) -> RpcResult {
        self.request_timeout("host/call", json!({ "method": method, "params": params }), timeout)
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// `host/emit`: published to the plugin bus as `"<pluginId>:<topic>"`
    /// (`ctx.events.onPlugin(pluginId, topic, …)`).
    pub fn emit(&self, topic: &str, payload: Value) {
        self.notify("host/emit", json!({ "topic": topic, "payload": payload }));
    }

    /// `ui/<name>`: delivered to `ctx.sidecar.onNotification(name, …)` in the plugin's UI.
    pub fn ui(&self, name: &str, params: Value) {
        self.notify(&format!("ui/{name}"), params);
    }

    /// `host/log` (`debug` | `info` | `warn` | `error`).
    pub fn log(&self, level: &str, message: impl Into<String>) {
        self.notify("host/log", json!({ "level": level, "message": message.into() }));
    }

    /// The `initialize` params (host, plugin, project, settings, locale), once received.
    pub fn init(&self) -> Option<&Value> {
        self.inner.init.get()
    }

    fn respond(&self, id: Value, r: RpcResult) {
        match r {
            Ok(v) => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": v })),
            Err(e) => self.send(json!({ "jsonrpc": "2.0", "id": id, "error": e.to_value() })),
        }
    }
}

/// Request router + serve loop.
#[derive(Default)]
pub struct Server {
    requests: HashMap<String, RequestFn>,
    notifications: HashMap<String, NotifyFn>,
    init: Option<InitFn>,
    shutdown: Option<RequestFn>,
}

impl Server {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_request(mut self, method: &str, f: impl Fn(&Host, Value) -> RpcResult + Send + Sync + 'static) -> Self {
        self.requests.insert(method.to_string(), Arc::new(f));
        self
    }

    pub fn on_notification(mut self, method: &str, f: impl Fn(&Host, Value) + Send + Sync + 'static) -> Self {
        self.notifications.insert(method.to_string(), Arc::new(f));
        self
    }

    /// The result becomes the `initialize` response (`{ "capabilities": … }`).
    pub fn on_initialize(mut self, f: impl Fn(&Host, &Value) -> RpcResult + Send + Sync + 'static) -> Self {
        self.init = Some(Arc::new(f));
        self
    }

    pub fn on_shutdown(mut self, f: impl Fn(&Host, Value) -> RpcResult + Send + Sync + 'static) -> Self {
        self.shutdown = Some(Arc::new(f));
        self
    }

    /// Serve on stdin/stdout until `exit` or stdin closes.
    pub fn run(self) -> io::Result<()> {
        let stdin = io::stdin();
        self.run_with(stdin.lock(), io::stdout())
    }

    /// Serve on any reader/writer (tests).
    pub fn run_with(self, input: impl BufRead, output: impl Write + Send + 'static) -> io::Result<()> {
        let host = Host {
            inner: Arc::new(HostInner {
                out: Mutex::new(Box::new(output)),
                pending: Mutex::new(HashMap::new()),
                next: AtomicU64::new(1),
                init: OnceLock::new(),
            }),
        };
        let mut reader = BufReader::new(input);
        let mut line = String::new();
        let mut workers = Vec::new();
        loop {
            line.clear();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                if !line.trim().is_empty() {
                    eprintln!("quadflow-sidecar: ignoring a non-JSON line from the host");
                }
                continue;
            };
            let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
            let id = msg.get("id").cloned().filter(|i| !i.is_null());
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            match (method, id) {
                (Some(m), Some(id)) => {
                    let handler: Option<Job> = match m.as_str() {
                        "initialize" => {
                            let _ = host.inner.init.set(params.clone());
                            let f = self.init.clone();
                            Some(Box::new(move |h: &Host| match f {
                                Some(f) => f(h, &params),
                                None => Ok(json!({ "capabilities": {} })),
                            }))
                        }
                        "shutdown" => {
                            let f = self.shutdown.clone();
                            Some(Box::new(move |h: &Host| match f {
                                Some(f) => f(h, params),
                                None => Ok(Value::Null),
                            }))
                        }
                        other => self.requests.get(other).cloned().map(|f| {
                            Box::new(move |h: &Host| f(h, params)) as Job
                        }),
                    };
                    match handler {
                        Some(f) => {
                            let h = host.clone();
                            workers.push(std::thread::spawn(move || {
                                let r = f(&h);
                                h.respond(id, r);
                            }));
                            workers.retain(|w| !w.is_finished());
                        }
                        None => host.respond(
                            id,
                            Err(RpcError { code: METHOD_NOT_FOUND, message: format!("unknown method {m:?}"), data: None }),
                        ),
                    }
                }
                (Some(m), None) => {
                    if m == "exit" {
                        break;
                    }
                    if let Some(f) = self.notifications.get(&m).cloned() {
                        let h = host.clone();
                        std::thread::spawn(move || f(&h, params));
                    }
                }
                (None, Some(id)) => {
                    let key = match &id {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let tx = host.inner.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
                    if let Some(tx) = tx {
                        let r = match msg.get("error").filter(|e| !e.is_null()) {
                            Some(e) => Err(RpcError {
                                code: e.get("code").and_then(Value::as_i64).unwrap_or(HOST_ERROR),
                                message: e.get("message").and_then(Value::as_str).unwrap_or("error").to_string(),
                                data: e.get("data").cloned(),
                            }),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                }
                (None, None) => {}
            }
        }
        // Let in-flight `shutdown` (and other) responses go out before returning.
        for w in workers {
            let _ = w.join();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    /// A writer that forwards each written line to a channel.
    struct Chan(mpsc::Sender<Value>, Vec<u8>);
    impl Write for Chan {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.1.extend_from_slice(b);
            while let Some(i) = self.1.iter().position(|c| *c == b'\n') {
                let line: Vec<u8> = self.1.drain(..=i).collect();
                let _ = self.0.send(serde_json::from_slice(&line).unwrap());
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// stdin as a pipe the test writes to.
    struct Pipe(Receiver<String>, Vec<u8>);
    impl io::Read for Pipe {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.1.is_empty() {
                match self.0.recv() {
                    Ok(s) => self.1 = s.into_bytes(),
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.1.len());
            buf[..n].copy_from_slice(&self.1[..n]);
            self.1.drain(..n);
            Ok(n)
        }
    }

    #[test]
    fn handshake_requests_and_host_calls() {
        let (in_tx, in_rx) = mpsc::channel::<String>();
        let (out_tx, out_rx) = mpsc::channel::<Value>();
        let server = Server::new()
            .on_request("ping", |_h, p| Ok(json!({ "pong": p })))
            .on_request("count", |h, _| h.call("storage.get", json!({ "key": "n" })))
            .on_request("fails", |_h, _| Err(RpcError::with_kind("not_found", "nothing")));
        let t = std::thread::spawn(move || server.run_with(BufReader::new(Pipe(in_rx, vec![])), Chan(out_tx, vec![])));
        let send = |v: Value| in_tx.send(format!("{v}\n")).unwrap();
        let recv = || out_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1 } }));
        assert_eq!(recv(), json!({ "jsonrpc": "2.0", "id": 1, "result": { "capabilities": {} } }));
        send(json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }));

        send(json!({ "jsonrpc": "2.0", "id": 2, "method": "ping", "params": [1] }));
        assert_eq!(recv()["result"], json!({ "pong": [1] }));

        send(json!({ "jsonrpc": "2.0", "id": 3, "method": "fails" }));
        let e = recv();
        assert_eq!(e["error"]["data"]["code"], "not_found");

        send(json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" }));
        assert_eq!(recv()["error"]["code"], METHOD_NOT_FOUND);

        // count → the sidecar asks the host (host/call), the host answers, the result flows back.
        send(json!({ "jsonrpc": "2.0", "id": 5, "method": "count" }));
        let call = recv();
        assert_eq!(call["method"], "host/call");
        assert_eq!(call["params"], json!({ "method": "storage.get", "params": { "key": "n" } }));
        send(json!({ "jsonrpc": "2.0", "id": call["id"], "result": 9 }));
        assert_eq!(recv(), json!({ "jsonrpc": "2.0", "id": 5, "result": 9 }));

        // A denied host call surfaces as RpcError with kind + details.
        send(json!({ "jsonrpc": "2.0", "id": 6, "method": "count" }));
        let call = recv();
        send(json!({ "jsonrpc": "2.0", "id": call["id"], "error": { "code": -32000, "message": "denied",
            "data": { "code": "permission_denied", "details": { "permission": "x" } } } }));
        let r = recv();
        assert_eq!(r["error"]["data"]["code"], "permission_denied");

        send(json!({ "jsonrpc": "2.0", "id": 7, "method": "shutdown" }));
        assert_eq!(recv(), json!({ "jsonrpc": "2.0", "id": 7, "result": null }));
        send(json!({ "jsonrpc": "2.0", "method": "exit" }));
        t.join().unwrap().unwrap();
    }
}
