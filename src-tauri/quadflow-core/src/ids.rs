//! Entity ids (data-layer.md §3.3).
//!
//! Every entity id is a lowercase ULID (26 chars, Crockford base32). Built-in
//! entities that ship as Rust consts use `builtin-<segment>` ids. Ids are
//! validated on parse **and** on deserialization, so an id read from disk or
//! IPC can never smuggle a path separator into a filesystem path.

use crate::error::{CoreError, Result};
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, specta::Type)]
#[serde(transparent)]
pub struct Id(String);

const BUILTIN_PREFIX: &str = "builtin-";

fn ulid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9a-hjkmnp-tv-z]{26}$").unwrap())
}

fn segment_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").unwrap())
}

/// A fresh lowercase ULID.
pub fn new_id() -> Id {
    Id(ulid::Ulid::new().to_string().to_lowercase())
}

impl Id {
    /// Parse and validate an id: a lowercase ULID, or `builtin-<segment>`.
    /// Uppercase ULIDs are accepted and normalized to lowercase.
    pub fn parse(s: &str) -> Result<Id> {
        if let Some(rest) = s.strip_prefix(BUILTIN_PREFIX) {
            validate_segment(rest)?;
            return Ok(Id(s.to_string()));
        }
        let lower = s.to_ascii_lowercase();
        if ulid_re().is_match(&lower) {
            Ok(Id(lower))
        } else {
            Err(CoreError::invalid_input(format!("invalid id {s:?}: expected a 26-character ULID")))
        }
    }

    /// Id for a built-in entity shipped as a Rust const, e.g. `builtin-feature-build`.
    pub fn builtin(name: &str) -> Id {
        assert!(segment_re().is_match(name), "invalid builtin id segment {name:?}");
        Id(format!("{BUILTIN_PREFIX}{name}"))
    }

    pub fn is_builtin(&self) -> bool {
        self.0.starts_with(BUILTIN_PREFIX)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for Id {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl FromStr for Id {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Id> {
        Id::parse(s)
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Id, D::Error> {
        let s = String::deserialize(d)?;
        Id::parse(&s).map_err(|e| serde::de::Error::custom(e.message))
    }
}

/// Validate a non-ULID path segment (plugin ids, file names):
/// `^[a-z0-9][a-z0-9._-]{0,63}$`, and never `.` / `..`.
pub fn validate_segment(s: &str) -> Result<()> {
    if s == "." || s == ".." || !segment_re().is_match(s) {
        return Err(CoreError::invalid_input(format!(
            "invalid name {s:?}: expected lowercase letters, digits, '.', '_' or '-' (max 64)"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_are_valid_sortable_ulids() {
        let a = new_id();
        let b = new_id();
        assert_eq!(a.as_str().len(), 26);
        assert!(Id::parse(a.as_str()).is_ok());
        assert_eq!(a.as_str(), a.as_str().to_lowercase());
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_traversal_and_garbage() {
        for bad in ["", "..", "../etc/passwd", "a/b", "01ARZ3NDEKTSV4RRFFQ69G5FA", "01arz3ndektsv4rrffq69g5fai", "x\\y"] {
            assert!(Id::parse(bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(Id::parse("builtin-../x").is_err());
    }

    #[test]
    fn accepts_uppercase_and_builtins() {
        let id = Id::parse("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert_eq!(id.as_str(), "01arz3ndektsv4rrffq69g5fav");
        let b = Id::builtin("feature-build");
        assert_eq!(b.as_str(), "builtin-feature-build");
        assert!(b.is_builtin());
        assert_eq!(Id::parse("builtin-feature-build").unwrap(), b);
    }

    #[test]
    fn deserialization_validates() {
        assert!(serde_json::from_str::<Id>("\"../../x\"").is_err());
        let id: Id = serde_json::from_str("\"01arz3ndektsv4rrffq69g5fav\"").unwrap();
        assert_eq!(serde_json::to_string(&id).unwrap(), "\"01arz3ndektsv4rrffq69g5fav\"");
    }

    #[test]
    fn segments() {
        assert!(validate_segment("my-plugin.v2").is_ok());
        for bad in [".", "..", "", "A", "-x", "a/b", &"x".repeat(65)] {
            assert!(validate_segment(bad).is_err(), "{bad:?}");
        }
    }
}
