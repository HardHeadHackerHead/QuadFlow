//! Timestamps: `i64` epoch milliseconds UTC everywhere (data-layer.md §0.7).

use crate::model::Timestamp;

pub fn now_ms() -> Timestamp {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
