//! Sidecar of the `youtube-live` plugin (plugin-system.md §10).
//!
//! Owns the YouTube Live chat poller, the points / slot machine / polls data
//! (SQLite in the plugin data dir) and the OAuth flow. Every request method is
//! a former `youtube_*` Tauri command without the prefix (see `commands.rs`);
//! events go to the UI as `ui/<name>` notifications (`chat-idea`, `slot-pull`,
//! `alert`, `poll-status`, `settings-changed`, …). Network access goes through
//! the host's `http.fetch`, credentials through `secrets.*`.

mod ai;
mod commands;
mod creds;
mod db;
mod error;
mod http;
mod models;
mod oauth;
mod poller;
mod settings;
mod slots;
mod state;
mod util;
mod youtube_api;

use quadflow_sidecar::{json, Host, RpcError, Server, Value};
use state::{App, YouTubeLiveState};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

static APP: OnceLock<App> = OnceLock::new();

fn data_dir(host: &Host) -> PathBuf {
    host.init()
        .and_then(|i| i.pointer("/plugin/dataDir"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("QUADFLOW_PLUGIN_DATA").map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

fn app(host: &Host) -> &'static App {
    APP.get_or_init(|| {
        let state = YouTubeLiveState::new(Some(data_dir(host).join("youtube_live.db")), Some(host.clone()));
        App::new(Arc::new(state), Some(host.clone()))
    })
}

fn main() -> std::io::Result<()> {
    let mut server = Server::new()
        .on_initialize(|_h, _p| Ok(json!({ "capabilities": { "methods": commands::METHODS } })))
        .on_shutdown(|h, _| {
            if let Some(a) = APP.get() {
                commands::disconnect_stream(a);
            } else {
                let _ = h;
            }
            Ok(Value::Null)
        });
    for m in commands::METHODS {
        let name = *m;
        server = server.on_request(name, move |h, p| commands::dispatch(app(h), name, &p).map_err(RpcError::new));
    }
    server.run()
}
