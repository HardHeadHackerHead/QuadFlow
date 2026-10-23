//! `CoreError` — the one error type every core API, Tauri command and CLI
//! command returns (data-layer.md §10.1, §11).

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

/// Machine-readable error class. Serialized as `snake_case` strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    InvalidInput,
    Conflict,
    LockTimeout,
    Corrupt,
    Io,
    Incompatible,
    Unsupported,
    PermissionDenied,
    ProjectNotFound,
    External,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotFound => "not_found",
            ErrorCode::InvalidInput => "invalid_input",
            ErrorCode::Conflict => "conflict",
            ErrorCode::LockTimeout => "lock_timeout",
            ErrorCode::Corrupt => "corrupt",
            ErrorCode::Io => "io",
            ErrorCode::Incompatible => "incompatible",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::PermissionDenied => "permission_denied",
            ErrorCode::ProjectNotFound => "project_not_found",
            ErrorCode::External => "external",
            ErrorCode::Internal => "internal",
        }
    }

    /// CLI exit code (data-layer.md §11): 1 domain/internal, 2 usage/invalid
    /// argument, 3 not found, 4 conflict or lock timeout, 5 project not found.
    pub fn exit_code(self) -> i32 {
        match self {
            ErrorCode::InvalidInput => 2,
            ErrorCode::NotFound => 3,
            ErrorCode::Conflict | ErrorCode::LockTimeout => 4,
            ErrorCode::ProjectNotFound => 5,
            _ => 1,
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub details: Option<serde_json::Value>,
}

pub type Result<T, E = CoreError> = std::result::Result<T, E>;

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, what)
    }
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, msg)
    }
    pub fn lock_timeout(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::LockTimeout, msg)
    }
    pub fn corrupt(path: &Path, msg: impl fmt::Display) -> Self {
        Self::new(ErrorCode::Corrupt, format!("{}: {msg}", path.display()))
            .with_details(serde_json::json!({ "path": path.display().to_string() }))
    }
    pub fn io(path: &Path, err: impl fmt::Display) -> Self {
        Self::new(ErrorCode::Io, format!("{}: {err}", path.display()))
            .with_details(serde_json::json!({ "path": path.display().to_string() }))
    }
    pub fn incompatible(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Incompatible, msg)
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, msg)
    }
    pub fn permission_denied(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermissionDenied, msg)
    }
    pub fn project_not_found(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::ProjectNotFound, msg)
    }
    pub fn external(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::External, msg)
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, msg)
    }

    pub fn exit_code(&self) -> i32 {
        self.code.exit_code()
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => CoreError::not_found("no matching row"),
            rusqlite::Error::SqliteFailure(f, ref msg)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                CoreError::conflict(msg.clone().unwrap_or_else(|| e.to_string()))
            }
            rusqlite::Error::SqliteFailure(f, _)
                if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) =>
            {
                CoreError::lock_timeout(format!("database busy: {e}"))
            }
            other => CoreError::internal(format!("sqlite: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_with_snake_code() {
        let e = CoreError::not_found("issue QX-9");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "not_found", "message": "issue QX-9" }));
    }

    #[test]
    fn exit_codes_follow_contract() {
        assert_eq!(CoreError::internal("x").exit_code(), 1);
        assert_eq!(CoreError::invalid_input("x").exit_code(), 2);
        assert_eq!(CoreError::not_found("x").exit_code(), 3);
        assert_eq!(CoreError::conflict("x").exit_code(), 4);
        assert_eq!(CoreError::lock_timeout("x").exit_code(), 4);
        assert_eq!(CoreError::project_not_found("x").exit_code(), 5);
    }
}
