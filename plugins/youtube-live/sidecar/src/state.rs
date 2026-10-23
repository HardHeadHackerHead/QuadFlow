//! Process-wide state and the `App` handle every command / the poller gets:
//! the DB, the poller control channel, the live poll status and the host
//! connection (UI events, http, secrets).

use crate::db::YouTubeLiveDatabase;
use crate::http::Http;
use crate::models::PollStatus;
use crate::settings::SecretStore;
use quadflow_sidecar::{Host, Value};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};

pub enum PollerCommand {
    Stop,
    UpdateInterval(u64),
}

pub struct YouTubeLiveState {
    db_path: Option<PathBuf>,
    host: Option<Host>,
    /// Opened on first use (the host connection must be up for secrets).
    db: OnceLock<Mutex<YouTubeLiveDatabase>>,
    pub poller_control: Mutex<Option<mpsc::Sender<PollerCommand>>>,
    pub poll_status: Mutex<PollStatus>,
    active_project: Mutex<(Option<String>, Option<String>)>, // (project_id, project_name)
}

impl YouTubeLiveState {
    /// `db_path: None` = in-memory DB (tests).
    pub fn new(db_path: Option<PathBuf>, host: Option<Host>) -> Self {
        Self {
            db_path,
            host,
            db: OnceLock::new(),
            poller_control: Mutex::new(None),
            poll_status: Mutex::new(PollStatus {
                is_polling: false,
                stream_id: None,
                video_id: None,
                stream_title: None,
                messages_scanned: 0,
                ideas_captured: 0,
                poll_interval_ms: 0,
                last_poll_at: None,
            }),
            active_project: Mutex::new((None, None)),
        }
    }

    pub fn get_db(&self) -> MutexGuard<'_, YouTubeLiveDatabase> {
        self.db
            .get_or_init(|| {
                let secrets = SecretStore::new(self.host.clone());
                let db = match &self.db_path {
                    Some(p) => YouTubeLiveDatabase::open(p, secrets).unwrap_or_else(|e| {
                        if let Some(h) = &self.host {
                            h.log("error", format!("Failed to open the YouTube Live database, using an in-memory one: {e}"));
                        }
                        YouTubeLiveDatabase::open_in_memory(SecretStore::new(self.host.clone())).expect("in-memory sqlite")
                    }),
                    None => YouTubeLiveDatabase::open_in_memory(secrets).expect("in-memory sqlite"),
                };
                Mutex::new(db)
            })
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn get_active_project(&self) -> (Option<String>, Option<String>) {
        self.active_project.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn set_active_project(&self, project_id: Option<String>, project_name: Option<String>) {
        *self.active_project.lock().unwrap_or_else(|e| e.into_inner()) = (project_id, project_name);
    }

    pub fn get_poll_status(&self) -> PollStatus {
        self.poll_status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn status_mut(&self) -> MutexGuard<'_, PollStatus> {
        self.poll_status.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// What commands and the poller hold: cheap to clone, usable from any thread.
#[derive(Clone)]
pub struct App {
    state: Arc<YouTubeLiveState>,
    host: Option<Host>,
    http: Http,
    /// Every UI event, for tests (`None` in production).
    #[cfg(test)]
    pub events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl App {
    pub fn new(state: Arc<YouTubeLiveState>, host: Option<Host>) -> Self {
        Self {
            state,
            http: Http::new(host.clone()),
            host,
            #[cfg(test)]
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn state(&self) -> &YouTubeLiveState {
        &self.state
    }

    pub fn http(&self) -> &Http {
        &self.http
    }

    pub fn host(&self) -> Option<&Host> {
        self.host.as_ref()
    }

    /// Send a UI event: `"youtube:chat-idea"` → `ui/chat-idea`, received in every
    /// tile with `ctx.sidecar.onNotification('chat-idea', …)`.
    pub fn emit<T: Serialize + ?Sized>(&self, event: &str, payload: &T) {
        let name = event.strip_prefix("youtube:").unwrap_or(event);
        let value = serde_json::to_value(payload).unwrap_or(Value::Null);
        #[cfg(test)]
        self.events.lock().unwrap().push((name.to_string(), value.clone()));
        if let Some(h) = &self.host {
            h.ui(name, value);
        }
    }

    pub fn log(&self, level: &str, message: impl Into<String>) {
        let message = message.into();
        match &self.host {
            Some(h) => h.log(level, message),
            None => eprintln!("[{level}] {message}"),
        }
    }
}
