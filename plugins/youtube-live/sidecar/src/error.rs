//! Sidecar error type. Handlers turn it into an `RpcError` whose message is the
//! `Display` text (what the old Tauri commands returned as their `String` error).

#[derive(Debug)]
pub enum YouTubeLiveError {
    Sqlite(String),
    Http(String),
    Api(String),
    NotFound(String),
    NotConfigured(String),
    QuotaExceeded(String),
    Json(String),
}

impl std::fmt::Display for YouTubeLiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            YouTubeLiveError::Sqlite(e) => write!(f, "Database error: {}", e),
            YouTubeLiveError::Http(e) => write!(f, "HTTP error: {}", e),
            YouTubeLiveError::Api(e) => write!(f, "YouTube API error: {}", e),
            YouTubeLiveError::NotFound(e) => write!(f, "Not found: {}", e),
            YouTubeLiveError::NotConfigured(e) => write!(f, "Not configured: {}", e),
            YouTubeLiveError::QuotaExceeded(e) => write!(f, "Quota exceeded: {}", e),
            YouTubeLiveError::Json(e) => write!(f, "JSON error: {}", e),
        }
    }
}

impl std::error::Error for YouTubeLiveError {}

impl From<rusqlite::Error> for YouTubeLiveError {
    fn from(e: rusqlite::Error) -> Self {
        YouTubeLiveError::Sqlite(e.to_string())
    }
}

impl From<serde_json::Error> for YouTubeLiveError {
    fn from(e: serde_json::Error) -> Self {
        YouTubeLiveError::Json(e.to_string())
    }
}

impl From<quadflow_sidecar::RpcError> for YouTubeLiveError {
    fn from(e: quadflow_sidecar::RpcError) -> Self {
        YouTubeLiveError::Http(e.message)
    }
}

pub type Result<T> = std::result::Result<T, YouTubeLiveError>;
