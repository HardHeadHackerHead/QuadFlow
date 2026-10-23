//! Connection settings: host/port in `<plugin data dir>/connection.json`, the
//! OBS WebSocket password as the secret `obs.password` (OS keystore through
//! the host). The UI only sees a masked password.

use quadflow_sidecar::{json, Host};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PASSWORD_SECRET: &str = "obs.password";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObsConnectionSettings {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
}

impl Default for ObsConnectionSettings {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 4455, password: None }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct UpdateObsConnectionSettingsRequest {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub password: Option<String>,
    pub clear_password: Option<bool>,
}

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    host: Option<String>,
    port: Option<u16>,
}

/// `ab...yz` for long passwords, `****` for short ones. Counts characters, not
/// bytes (the old code sliced bytes and panicked on non-ASCII passwords).
pub fn mask_password(pw: &str) -> String {
    let chars: Vec<char> = pw.chars().collect();
    match chars.len() {
        0 => String::new(),
        n if n > 4 => format!("{}...{}", chars[..2].iter().collect::<String>(), chars[n - 2..].iter().collect::<String>()),
        _ => "****".to_string(),
    }
}

pub fn masked(mut s: ObsConnectionSettings) -> ObsConnectionSettings {
    s.password = s.password.as_deref().map(mask_password);
    s
}

pub struct SettingsStore {
    path: PathBuf,
    host: Option<Host>,
}

impl SettingsStore {
    pub fn new(dir: &Path, host: Option<Host>) -> Self {
        Self { path: dir.join("connection.json"), host }
    }

    fn read_stored(&self) -> Stored {
        std::fs::read_to_string(&self.path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn password(&self) -> Option<String> {
        let h = self.host.as_ref()?;
        h.call("secrets.get", json!({ "name": PASSWORD_SECRET })).ok()?.as_str().map(str::to_string).filter(|p| !p.is_empty())
    }

    /// Full settings (password unmasked; for connecting).
    pub fn get(&self) -> ObsConnectionSettings {
        let d = ObsConnectionSettings::default();
        let s = self.read_stored();
        ObsConnectionSettings { host: s.host.unwrap_or(d.host), port: s.port.unwrap_or(d.port), password: self.password() }
    }

    pub fn update(&self, r: &UpdateObsConnectionSettingsRequest) -> Result<ObsConnectionSettings, String> {
        let mut s = self.read_stored();
        if let Some(h) = r.host.as_ref().filter(|h| !h.trim().is_empty()) {
            s.host = Some(h.trim().to_string());
        }
        if let Some(p) = r.port {
            s.port = Some(p);
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.path, serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(h) = &self.host {
            if r.clear_password.unwrap_or(false) {
                h.call("secrets.delete", json!({ "name": PASSWORD_SECRET })).map_err(|e| e.to_string())?;
            } else if let Some(pw) = r.password.as_ref().filter(|p| !p.is_empty()) {
                h.call("secrets.set", json!({ "name": PASSWORD_SECRET, "value": pw })).map_err(|e| e.to_string())?;
            }
        }
        Ok(self.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masking_is_char_safe() {
        assert_eq!(mask_password("secret123"), "se...23");
        assert_eq!(mask_password("abcd"), "****");
        assert_eq!(mask_password(""), "");
        assert_eq!(mask_password("ñandú-ñandú"), "ña...dú");
        assert_eq!(mask_password("🔒🔒🔒🔒🔒"), "🔒🔒...🔒🔒");
    }

    #[test]
    fn host_and_port_persist_in_the_data_dir() {
        let dir = std::env::temp_dir().join(format!("obs-tracker-test-{}", std::process::id()));
        let store = SettingsStore::new(&dir, None);
        assert_eq!(store.get(), ObsConnectionSettings::default());
        let s = store
            .update(&UpdateObsConnectionSettingsRequest { host: Some("192.168.1.5".into()), port: Some(4456), ..Default::default() })
            .unwrap();
        assert_eq!((s.host.as_str(), s.port), ("192.168.1.5", 4456));
        assert_eq!(SettingsStore::new(&dir, None).get().port, 4456);
        let _ = std::fs::remove_dir_all(dir);
    }
}
