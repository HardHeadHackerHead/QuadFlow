//! CLI JSON contract for `quadflow chat …` (data-layer.md §7.3, §11, §12.3).
//! Everything runs against a temp app data dir and the in-memory secrets
//! backend (`QUADFLOW_SECRETS_BACKEND=memory`) — the real OS keystore is never
//! touched. Snapshots live in `tests/snapshots/cli_chat__*.snap`.

use quadflow_core::cli::{run, CliEnv, Io};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

struct App {
    data: tempfile::TempDir,
    proj: PathBuf,
    extra: BTreeMap<String, String>,
}

impl App {
    fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let proj = data.path().join("chat-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let a = App { data, proj, extra: BTreeMap::new() };
        let (code, out, _) = a.raw(&["init", "--json"]);
        assert_eq!(code, 0, "{out}");
        a
    }

    fn raw(&self, args: &[&str]) -> (i32, String, String) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut vars = self.extra.clone();
        vars.insert("QUADFLOW_PROFILE".into(), "dev".into());
        vars.insert("QUADFLOW_DATA_DIR".into(), self.data.path().join("app").display().to_string());
        vars.insert("QUADFLOW_SECRETS_BACKEND".into(), "memory".into());
        let env = CliEnv { cwd: self.proj.clone(), vars };
        let code = {
            let mut io = Io { stdout: Box::new(&mut out), stderr: Box::new(&mut err) };
            let argv = std::iter::once("quadflow").chain(args.iter().copied()).map(Into::into).collect();
            run(argv, &mut io, &env)
        };
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    fn ok(&self, args: &[&str]) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (code, out, err) = self.raw(&a);
        assert_eq!(code, 0, "{args:?}\nstdout: {out}\nstderr: {err}");
        let v = json(&out);
        assert_eq!(v["ok"], true, "{out}");
        v["data"].clone()
    }

    fn fails(&self, args: &[&str], exit: i32, code: &str) -> Value {
        let mut a = args.to_vec();
        a.push("--json");
        let (c, out, _) = self.raw(&a);
        assert_eq!(c, exit, "{args:?}: {out}");
        let v = json(&out);
        assert_eq!(v["ok"], false, "{out}");
        assert_eq!(v["error"]["code"], code, "{out}");
        v["error"].clone()
    }
}

fn json(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or_else(|e| panic!("not one JSON document ({e}): {s}"))
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

macro_rules! snap {
    ($name:expr, $v:expr) => {
        insta::assert_json_snapshot!($name, $v, {
            ".id" => "[id]",
            ".**.id" => "[id]",
            "[].id" => "[id]",
            ".**.conversationId" => "[id]",
            ".**.projectRootKey" => "[rootKey]",
            ".**.createdAt" => "[ts]",
            ".**.updatedAt" => "[ts]",
        })
    };
}

/// One-request HTTP server answering with an SSE stream.
fn fake_llm(chunks: &[&str]) -> (String, std::thread::JoinHandle<String>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1", l.local_addr().unwrap());
    let mut body = String::new();
    for c in chunks {
        body.push_str(&format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n",
            serde_json::to_string(c).unwrap()
        ));
    }
    body.push_str("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\ndata: [DONE]\n\n");
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let h = std::thread::spawn(move || {
        let (mut s, _) = l.accept().unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = s.read(&mut buf).unwrap();
            req.extend_from_slice(&buf[..n]);
            let t = String::from_utf8_lossy(&req).to_string();
            if let Some(p) = t.find("\r\n\r\n") {
                let len = t[..p]
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                    .unwrap_or(0);
                if req.len() >= p + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        s.write_all(resp.as_bytes()).unwrap();
        String::from_utf8_lossy(&req).to_string()
    });
    (url, h)
}

#[test]
fn conversations_round_trip() {
    let app = App::new();
    let c = app.ok(&["chat", "create", "--title", "First chat", "--model", "llama3.2", "--system-prompt", "Be terse."]);
    snap!("create", &c);
    let cid = id(&c);

    let scoped = app.ok(&["chat", "create", "--this-project"]);
    assert!(scoped["projectRootKey"].is_string());
    assert_eq!(scoped["title"], "New conversation");

    snap!("get", &app.ok(&["chat", "get", &cid]));
    let all = app.ok(&["chat", "list"]);
    assert_eq!(all.as_array().unwrap().len(), 2);
    let mine = app.ok(&["chat", "list", "--this-project"]);
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(mine[0]["id"], scoped["id"]);

    snap!("rename", &app.ok(&["chat", "rename", &cid, "Renamed chat"]));
    snap!("messages_empty", &app.ok(&["chat", "messages", &cid]));
    snap!("delete", &app.ok(&["chat", "delete", &cid]));
    snap!("list", &app.ok(&["chat", "list"]));

    // Error contract.
    app.fails(&["chat", "get", &cid], 3, "not_found");
    app.fails(&["chat", "get", "nope"], 2, "invalid_input");
    app.fails(&["chat", "rename", &id(&scoped), " "], 2, "invalid_input");
    app.fails(&["chat", "bogus"], 2, "invalid_input");
}

#[test]
fn settings_and_key_never_printed() {
    let mut app = App::new();
    snap!("settings_default", &app.ok(&["chat", "settings"]));
    let s = app.ok(&["chat", "settings", "--endpoint", "http://127.0.0.1:9/v1/", "--model", "qwen", "--temperature", "0.2", "--max-tokens", "512", "--timeout-seconds", "30", "--system-prompt", "Hi"]);
    snap!("settings_set", &s);
    assert_eq!(s["endpoint"], "http://127.0.0.1:9/v1");
    let s = app.ok(&["chat", "settings", "--clear-system-prompt"]);
    assert_eq!(s["systemPrompt"], Value::Null);
    app.fails(&["chat", "settings", "--temperature", "9"], 2, "invalid_input");
    app.fails(&["chat", "settings", "--endpoint", "localhost"], 2, "invalid_input");

    assert_eq!(app.ok(&["chat", "key", "status"])["hasApiKey"], false);
    app.fails(&["chat", "key", "set", "--from-env", "QF_TEST_MISSING"], 2, "invalid_input");
    app.extra.insert("QF_TEST_CHAT_KEY".into(), "sk-cli-contract-secret".into());
    let (code, out, err) = app.raw(&["chat", "key", "set", "--from-env", "QF_TEST_CHAT_KEY", "--json"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(!out.contains("sk-cli-contract-secret") && !err.contains("sk-cli-contract-secret"));
    snap!("key_set", &json(&out)["data"]);
    let (_, out, _) = app.raw(&["chat", "settings", "--json"]);
    assert!(!out.contains("sk-cli-contract-secret"), "settings never contain the key: {out}");
    assert_eq!(json(&out)["data"]["hasApiKey"], true);
    let (_, human, _) = app.raw(&["chat", "settings"]);
    assert!(human.contains("apiKey:         set") && !human.contains("sk-cli"), "{human}");
    snap!("key_clear", &app.ok(&["chat", "key", "clear"]));
    assert_eq!(app.ok(&["chat", "key", "status"])["hasApiKey"], false);
}

#[test]
fn send_streams_against_fake_endpoint() {
    let app = App::new();
    let (url, server) = fake_llm(&["Hello", " world"]);
    app.ok(&["chat", "settings", "--endpoint", &url]);
    let cid = id(&app.ok(&["chat", "create", "--title", "Send test"]));
    let r = app.ok(&["chat", "send", &cid, "Say hello"]);
    let req = server.join().unwrap();
    assert!(req.starts_with("POST /v1/chat/completions"), "{req}");
    snap!("send", &r);
    let msgs = app.ok(&["chat", "messages", &cid]);
    snap!("messages", &msgs);

    // Human mode streams the deltas to stdout.
    let (url, server) = fake_llm(&["Second", " answer"]);
    app.ok(&["chat", "settings", "--endpoint", &url]);
    let (code, out, err) = app.raw(&["chat", "send", &cid, "Again"]);
    server.join().unwrap();
    assert_eq!(code, 0, "{err}");
    assert_eq!(out.trim(), "Second answer");
}

#[test]
fn send_to_unreachable_endpoint_is_external_error() {
    let app = App::new();
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    app.ok(&["chat", "settings", "--endpoint", &format!("http://127.0.0.1:{port}/v1"), "--timeout-seconds", "5"]);
    let cid = id(&app.ok(&["chat", "create"]));
    let e = app.fails(&["chat", "send", &cid, "hello"], 1, "external");
    assert!(e["message"].as_str().unwrap().contains("Could not connect"), "{e}");
    let msgs = app.ok(&["chat", "messages", &cid]);
    assert_eq!(msgs.as_array().unwrap().len(), 1, "the user message is kept");
    app.fails(&["chat", "send", &cid, "  "], 2, "invalid_input");
    app.fails(&["chat", "check", "not a url"], 2, "invalid_input");
    app.fails(&["chat", "check", &format!("http://127.0.0.1:{port}/v1"), "--timeout-ms", "300"], 1, "external");
}
