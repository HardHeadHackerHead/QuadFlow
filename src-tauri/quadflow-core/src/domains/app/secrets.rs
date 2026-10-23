//! Secrets (data-layer.md §7.4): API keys and other credentials live in the OS
//! keystore (Windows Credential Manager, macOS Keychain, Secret Service on
//! Linux) through the `keyring` crate — never in the app DB, never in a
//! settings row, and there is **no plaintext fallback**.
//!
//! Service name = the profile's app identifier (`io.quadslab.quadflow`, or
//! `io.quadslab.quadflow.dev` for dev builds, so a dev build never reads or
//! overwrites the installed app's keys); account = the secret key
//! (`chat.apiKey`, `plugin:<id>:<name>`).
//!
//! Values are readable only inside Rust (`Secrets::get`). The Tauri surface is
//! `secrets_set` / `secrets_delete` / `secrets_exists`: a secret is never
//! returned to the frontend.

use crate::error::{CoreError, Result};
use crate::paths::Profile;
use parking_lot::Mutex;
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

/// Secret holding the API key of the chat endpoint.
pub const KEY_CHAT_API_KEY: &str = "chat.apiKey";
/// The same key as stored by the Chat plugin's settings form (`ctx.secrets.set('apiKey')`);
/// chat reads it first (`chat::api_key`).
pub const KEY_CHAT_PLUGIN_API_KEY: &str = "plugin:chat:apiKey";

/// Env var selecting the backend: unset / `keyring` = OS keystore; `memory` =
/// an in-process map that is never persisted (tests, CI, headless runs).
pub const ENV_SECRETS_BACKEND: &str = "QUADFLOW_SECRETS_BACKEND";

/// Max length of a secret value in bytes (Windows credentials cap at 2560).
pub const MAX_SECRET_LEN: usize = 2048;

/// Storage behind [`Secrets`].
pub trait SecretBackend: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    /// `true` if something was deleted.
    fn delete(&self, key: &str) -> Result<bool>;
}

/// Handle to the secret store. Cheap to clone.
#[derive(Clone)]
pub struct Secrets {
    backend: Arc<dyn SecretBackend>,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secrets(..)")
    }
}

fn key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$").unwrap())
}

/// Keys look like `chat.apiKey` or `plugin:<id>:<name>`.
pub fn validate_key(key: &str) -> Result<()> {
    if key_re().is_match(key) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!(
            "invalid secret key {key:?}: expected letters, digits, '.', '_', ':' or '-' (max 200)"
        )))
    }
}

fn validate_value(value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(CoreError::invalid_input("secret value must not be empty (use delete to remove it)"));
    }
    if value.len() > MAX_SECRET_LEN {
        return Err(CoreError::invalid_input(format!("secret value is longer than {MAX_SECRET_LEN} bytes")));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(CoreError::invalid_input("secret value must not contain control characters"));
    }
    Ok(())
}

impl Secrets {
    pub fn new(backend: Arc<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    /// The OS keystore, service = the profile's app identifier.
    pub fn keyring(profile: Profile) -> Self {
        Self::new(Arc::new(KeyringBackend { service: profile.app_identifier().to_string() }))
    }

    /// A fresh, empty in-memory store (never persisted).
    pub fn memory() -> Self {
        Self::new(Arc::new(MemoryBackend::default()))
    }

    /// The process-wide in-memory store used when `QUADFLOW_SECRETS_BACKEND=memory`.
    pub fn shared_memory() -> Self {
        static SHARED: OnceLock<Secrets> = OnceLock::new();
        SHARED.get_or_init(Secrets::memory).clone()
    }

    /// Backend chosen by [`ENV_SECRETS_BACKEND`] (`var` reads the environment).
    pub fn from_env(profile: Profile, var: impl Fn(&str) -> Option<String>) -> Result<Self> {
        match var(ENV_SECRETS_BACKEND).as_deref().map(str::trim) {
            None | Some("") | Some("keyring") => Ok(Self::keyring(profile)),
            Some("memory") => Ok(Self::shared_memory()),
            Some(other) => Err(CoreError::invalid_input(format!(
                "{ENV_SECRETS_BACKEND}={other:?}: expected \"keyring\" or \"memory\""
            ))),
        }
    }

    /// Read a secret (Rust-side only; never exposed over IPC).
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        validate_key(key)?;
        self.backend.get(key)
    }

    /// Like [`Secrets::get`], but a keystore that is unavailable counts as "no
    /// secret" (nobody could have stored one there). Other errors propagate.
    pub fn get_optional(&self, key: &str) -> Result<Option<String>> {
        match self.get(key) {
            Err(e) if e.code == crate::error::ErrorCode::Unsupported => Ok(None),
            other => other,
        }
    }

    /// Store a secret. Surrounding whitespace is trimmed.
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        validate_key(key)?;
        let value = value.trim();
        validate_value(value)?;
        self.backend.set(key, value)
    }

    /// Remove a secret; removing a missing one is not an error.
    pub fn delete(&self, key: &str) -> Result<bool> {
        validate_key(key)?;
        self.backend.delete(key)
    }

    pub fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.get(key)?.is_some())
    }
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct MemoryBackend {
    map: Mutex<BTreeMap<String, String>>,
}

impl SecretBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.map.lock().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.map.lock().insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<bool> {
        Ok(self.map.lock().remove(key).is_some())
    }
}

pub struct KeyringBackend {
    service: String,
}

fn map_keyring_error(key: &str, e: keyring::Error) -> CoreError {
    use keyring::Error as K;
    match e {
        K::NoStorageAccess(err) | K::PlatformFailure(err) => CoreError::unsupported(format!(
            "the system keystore is not available ({err}); QuadFlow stores secrets only in the OS \
             keystore (Credential Manager / Keychain / Secret Service) and has no plaintext fallback"
        ))
        .with_details(serde_json::json!({ "key": key })),
        K::TooLong(attr, max) => CoreError::invalid_input(format!("secret {attr} is too long (max {max})")),
        K::Invalid(attr, reason) => CoreError::invalid_input(format!("invalid secret {attr}: {reason}")),
        K::BadEncoding(_) => CoreError::new(crate::error::ErrorCode::Corrupt, format!("secret {key:?} is not UTF-8")),
        other => CoreError::internal(format!("keystore error for {key:?}: {other}")),
    }
}

impl KeyringBackend {
    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, key).map_err(|e| map_keyring_error(key, e))
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self, key: &str) -> Result<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring_error(key, e)),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.entry(key)?.set_password(value).map_err(|e| map_keyring_error(key, e))
    }
    fn delete(&self, key: &str) -> Result<bool> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(map_keyring_error(key, e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn memory_round_trip() {
        let s = Secrets::memory();
        assert_eq!(s.get(KEY_CHAT_API_KEY).unwrap(), None);
        assert!(!s.exists(KEY_CHAT_API_KEY).unwrap());
        s.set(KEY_CHAT_API_KEY, "  sk-test-123  ").unwrap();
        assert_eq!(s.get(KEY_CHAT_API_KEY).unwrap().as_deref(), Some("sk-test-123"));
        assert!(s.exists(KEY_CHAT_API_KEY).unwrap());
        assert!(s.delete(KEY_CHAT_API_KEY).unwrap());
        assert!(!s.delete(KEY_CHAT_API_KEY).unwrap());
        assert_eq!(s.get(KEY_CHAT_API_KEY).unwrap(), None);
    }

    #[test]
    fn validates_keys_and_values() {
        let s = Secrets::memory();
        for bad in ["", "../x", "a b", "a/b", "\u{7}"] {
            assert_eq!(s.set(bad, "v").unwrap_err().code, ErrorCode::InvalidInput, "{bad:?}");
        }
        s.set("plugin:github:token", "v").unwrap();
        assert_eq!(s.set("chat.apiKey", "   ").unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(s.set("chat.apiKey", "a\nb").unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(s.set("chat.apiKey", &"x".repeat(MAX_SECRET_LEN + 1)).unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[test]
    fn env_selects_backend() {
        let mem = Secrets::from_env(Profile::Dev, |_| Some("memory".into())).unwrap();
        mem.set("test.envSelect", "1").unwrap();
        // shared: a second handle sees the same store
        let again = Secrets::from_env(Profile::Dev, |_| Some("memory".into())).unwrap();
        assert!(again.exists("test.envSelect").unwrap());
        again.delete("test.envSelect").unwrap();
        assert_eq!(
            Secrets::from_env(Profile::Dev, |_| Some("plaintext".into())).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    struct Unavailable;
    impl SecretBackend for Unavailable {
        fn get(&self, _: &str) -> Result<Option<String>> {
            Err(CoreError::unsupported("no keystore"))
        }
        fn set(&self, _: &str, _: &str) -> Result<()> {
            Err(CoreError::unsupported("no keystore"))
        }
        fn delete(&self, _: &str) -> Result<bool> {
            Err(CoreError::unsupported("no keystore"))
        }
    }

    #[test]
    fn unavailable_keystore_is_unsupported_not_plaintext() {
        let s = Secrets::new(Arc::new(Unavailable));
        assert_eq!(s.set(KEY_CHAT_API_KEY, "v").unwrap_err().code, ErrorCode::Unsupported);
        assert_eq!(s.get(KEY_CHAT_API_KEY).unwrap_err().code, ErrorCode::Unsupported);
        assert_eq!(s.get_optional(KEY_CHAT_API_KEY).unwrap(), None);
    }
}
