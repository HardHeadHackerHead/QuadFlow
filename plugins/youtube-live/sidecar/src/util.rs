//! Small helpers: chat command parsing, video id extraction, time, ids.

// ============ Command Parser ============

#[derive(Debug)]
pub struct ParsedChatCommand {
    pub content: String,
}

/// `message` without a case-insensitive `prefix`, compared char by char (so a
/// multi-byte character never makes us slice inside a code point).
pub fn strip_prefix_ci<'a>(message: &'a str, prefix: &str) -> Option<&'a str> {
    let mut chars = message.char_indices();
    for p in prefix.chars() {
        let (_, m) = chars.next()?;
        if !m.to_lowercase().eq(p.to_lowercase()) {
            return None;
        }
    }
    Some(match chars.next() {
        Some((i, _)) => &message[i..],
        None => "",
    })
}

/// `!idea some text` → `some text` (case-insensitive prefix; empty content → None).
pub fn parse_chat_command(message: &str, prefix: &str) -> Option<ParsedChatCommand> {
    let content = strip_prefix_ci(message, prefix)?.trim().to_string();
    if content.is_empty() {
        return None;
    }
    Some(ParsedChatCommand { content })
}

/// Is `message` the command `prefix` on its own or followed by a space?
pub fn is_command(message: &str, prefix: &str) -> bool {
    match strip_prefix_ci(message, prefix) {
        Some(rest) => rest.is_empty() || rest.starts_with(' '),
        None => false,
    }
}

// ============ Video ID Extraction ============

pub fn extract_video_id(input: &str) -> Option<String> {
    let input = input.trim();

    // Direct video ID (11 characters, alphanumeric + dash + underscore)
    if input.len() == 11 && input.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Some(input.to_string());
    }

    // YouTube URL patterns
    if input.contains("youtube.com") || input.contains("youtu.be") {
        // youtu.be/VIDEO_ID
        if input.contains("youtu.be/") {
            if let Some(id) = input.split("youtu.be/").nth(1) {
                let id = id.split('?').next().unwrap_or(id);
                let id = id.split('&').next().unwrap_or(id);
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }

        // youtube.com/watch?v=VIDEO_ID
        if let Some(query) = input.split('?').nth(1) {
            for param in query.split('&') {
                if let Some(id) = param.strip_prefix("v=") {
                    let id = id.split('&').next().unwrap_or(id);
                    if !id.is_empty() {
                        return Some(id.to_string());
                    }
                }
            }
        }

        // youtube.com/live/VIDEO_ID
        if input.contains("/live/") {
            if let Some(id) = input.split("/live/").nth(1) {
                let id = id.split('?').next().unwrap_or(id);
                let id = id.split('&').next().unwrap_or(id);
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }

    // Fallback: if it looks like it could be a video ID
    if input.len() >= 10 && input.len() <= 12 && input.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Some(input.to_string());
    }

    None
}

// ============ Helper Functions ============

pub fn chrono_now() -> String {
    // Simple UTC datetime string
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, m, d) = civil_from_days((now / 86400) as i64);
    let secs_in_day = now % 86400;
    let h = secs_in_day / 3600;
    let min = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, h, min, s)
}

pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn today_pst() -> String {
    // Use UTC-8 as an approximation for PST (YouTube quota resets at midnight PST)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let pst_secs = now.saturating_sub(8 * 3600);
    let days = pst_secs / 86400;
    // Calculate year-month-day from unix days
    let (y, m, d) = civil_from_days(days as i64);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Convert days since epoch to civil date (year, month, day)
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

pub fn chrono_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let min = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, h, min, s)
}

pub fn gen_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// RFC 3339 timestamp (`2024-01-01T00:00:00.000Z`, as the YouTube API sends) → unix millis.
pub fn parse_iso_timestamp(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_parsing_is_case_insensitive_and_utf8_safe() {
        assert_eq!(parse_chat_command("!IDEA dark mode", "!idea").unwrap().content, "dark mode");
        assert!(parse_chat_command("!idea", "!idea").is_none());
        assert!(parse_chat_command("hello", "!idea").is_none());
        // Multi-byte text right after / instead of the prefix must not panic.
        assert!(parse_chat_command("é!idea x", "!idea").is_none());
        assert_eq!(parse_chat_command("!ideaé", "!idea").unwrap().content, "é");
        assert!(parse_chat_command("!i", "!idea").is_none());
        assert!(is_command("!PULL", "!pull"));
        assert!(is_command("!pull now", "!pull"));
        assert!(!is_command("!pullé", "!pull"));
        assert!(!is_command("!pul", "!pull"));
    }

    #[test]
    fn video_ids() {
        assert_eq!(extract_video_id("dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(extract_video_id("https://youtu.be/dQw4w9WgXcQ?si=x").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(extract_video_id("https://www.youtube.com/live/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(extract_video_id("not a video"), None);
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(parse_iso_timestamp("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_iso_timestamp("2024-03-01T00:00:00Z"), Some(1_709_251_200_000));
        assert_eq!(parse_iso_timestamp("garbage"), None);
    }
}
