use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// A parsed message from an agent session transcript
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessage {
    pub role: String,
    pub content: String,
    pub turn_number: usize,
}

/// A chunk extracted from a session for embedding
#[derive(Debug, Clone)]
pub struct ContentChunk {
    pub content: String,
    pub role: Option<String>,
    pub turn_number: Option<usize>,
    pub chunk_index: usize,
}

/// A single entry of a session transcript (JSONL). Two common shapes are read:
/// `{"type":"user"|"assistant","message":{"role","content"}}` and
/// `{"type":"response_item","payload":{"type":"message","role","content"}}`.
#[derive(Debug, Deserialize)]
struct SessionEntry {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    message: Option<MessageContent>,
    payload: Option<PayloadContent>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MessageContent {
    role: Option<String>,
    content: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct PayloadContent {
    #[serde(rename = "type")]
    payload_type: Option<String>,
    role: Option<String>,
    content: Option<serde_json::Value>,
}

impl SessionEntry {
    /// `(role, content)` of a user/assistant message entry; `None` for metadata.
    fn into_message(self) -> Option<(String, Option<serde_json::Value>)> {
        if self.is_meta == Some(true) {
            return None;
        }
        let entry_type = self.entry_type.as_deref();
        if entry_type == Some("user") || entry_type == Some("assistant") {
            let m = self.message?;
            let role = m.role.unwrap_or_else(|| entry_type.unwrap_or("unknown").to_string());
            return Some((role, m.content));
        }
        let p = self.payload?;
        if p.payload_type.as_deref() != Some("message") {
            return None;
        }
        match p.role.as_deref() {
            Some(r @ ("user" | "assistant")) => Some((r.to_string(), p.content)),
            _ => None,
        }
    }

    fn is_user_turn(self) -> bool {
        matches!(self.into_message(), Some((role, _)) if role == "user")
    }
}

/// Parse a session transcript (JSONL) and extract messages
pub fn parse_session_file(path: &Path) -> Result<Vec<SessionMessage>, String> {
    parse_session_file_from_line(path, 0, 0)
}

/// Parse a session transcript (JSONL) starting from a specific line
/// Used for incremental indexing - only parse new lines
pub fn parse_session_file_from_line(
    path: &Path,
    start_line: usize,
    start_turn: usize,
) -> Result<Vec<SessionMessage>, String> {
    log::debug!("Parsing session file: {:?} (from line {}, turn {})", path, start_line, start_turn);

    // Get file size for progress logging
    let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    log::debug!("File size: {} bytes ({:.1} KB)", file_size, file_size as f64 / 1024.0);

    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);

    let start_time = std::time::Instant::now();

    let mut messages: Vec<SessionMessage> = Vec::new();
    let mut turn_number = start_turn;
    let mut line_count = 0;
    let mut message_entries = 0;

    for line in reader.lines() {
        line_count += 1;

        // Log progress every 1000 lines for large files
        if line_count % 1000 == 0 {
            log::debug!("Parsing progress: {} lines processed, {} messages found ({:?} elapsed)",
                       line_count, messages.len(), start_time.elapsed());
        }

        // Skip lines before the start line
        if line_count <= start_line {
            // But we need to track turn numbers to maintain continuity
            let line = line.map_err(|e| format!("Failed to read line: {}", e))?;
            if !line.trim().is_empty() {
                if let Ok(entry) = serde_json::from_str::<SessionEntry>(&line) {
                    if entry.is_user_turn() {
                        turn_number += 1;
                    }
                }
            }
            continue;
        }

        let line = line.map_err(|e| format!("Failed to read line: {}", e))?;
        if line.trim().is_empty() {
            continue;
        }

        // Try to parse as JSON
        let entry: Result<SessionEntry, _> = serde_json::from_str(&line);
        match entry {
            Ok(entry) => {
                let Some((role, content)) = entry.into_message() else { continue };
                message_entries += 1;
                let content = extract_content_text(&content);

                // Skip empty content and system/command messages
                if content.is_empty() {
                    continue;
                }

                // Skip messages that are just command outputs or interruptions
                if content.starts_with("<local-command") ||
                   content.starts_with("<command-") ||
                   content.starts_with("<environment_context>") ||
                   content.contains("[Request interrupted by user]") {
                    continue;
                }

                // Increment turn number on user messages
                if role == "user" {
                    turn_number += 1;
                }

                messages.push(SessionMessage {
                    role,
                    content,
                    turn_number,
                });
            }
            Err(e) => {
                log::debug!("Failed to parse line {} as JSON: {} (first 100 chars: {})", line_count, e, &line[..line.len().min(100)]);
            }
        }
    }

    let elapsed = start_time.elapsed();
    log::debug!(
        "Parsed session file in {:?}: {} total lines, {} message entries, {} messages extracted (incremental from line {})",
        elapsed, line_count, message_entries, messages.len(), start_line
    );

    Ok(messages)
}

/// Extract text content from the content field (can be string or array)
fn extract_content_text(content: &Option<serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => {
            let mut texts = Vec::new();
            for item in arr {
                if let Some(obj) = item.as_object() {
                    if let Some(serde_json::Value::String(text)) = obj.get("text") {
                        texts.push(text.clone());
                    }
                } else if let Some(s) = item.as_str() {
                    texts.push(s.to_string());
                }
            }
            texts.join("\n")
        }
        _ => String::new(),
    }
}

/// Chunk session messages for embedding
/// Groups by conversation turn and splits long content
/// Handles UTF-8 properly by ensuring all slices are on character boundaries
#[cfg(test)]
pub fn chunk_session(
    messages: &[SessionMessage],
    max_chunk_tokens: usize,
    overlap_tokens: usize,
) -> Vec<ContentChunk> {
    let mut chunks = Vec::new();
    let mut chunk_index = 0;

    // Approximate tokens as ~4 chars per token
    let chars_per_token = 4;
    let max_chunk_chars = max_chunk_tokens * chars_per_token;
    let overlap_chars = overlap_tokens * chars_per_token;

    for message in messages {
        let content = &message.content;

        if content.is_empty() {
            continue;
        }

        if content.len() <= max_chunk_chars {
            // Small enough to be a single chunk
            chunks.push(ContentChunk {
                content: content.clone(),
                role: Some(message.role.clone()),
                turn_number: Some(message.turn_number),
                chunk_index,
            });
            chunk_index += 1;
        } else {
            // Split into multiple chunks with overlap
            let mut start = 0;
            let mut iterations = 0;
            let max_iterations = (content.len() / max_chunk_chars.max(1)) + 10;

            while start < content.len() && iterations < max_iterations {
                iterations += 1;

                // Ensure start is on a character boundary
                start = ensure_char_boundary_forward(content, start);

                let end = (start + max_chunk_chars).min(content.len());
                let end = ensure_char_boundary(content, end);

                // Safety check
                if end <= start {
                    break;
                }

                // Try to break at a sentence or word boundary
                let actual_end = if end < content.len() {
                    let bp = find_break_point(content, start, end);
                    // Ensure forward progress
                    if bp <= start { end } else { bp }
                } else {
                    end
                };

                // Ensure actual_end is on a character boundary
                let actual_end = ensure_char_boundary(content, actual_end);

                // Safety: ensure we have valid bounds
                if actual_end <= start {
                    // Move to next character
                    let mut next_char = start + 1;
                    while next_char < content.len() && !content.is_char_boundary(next_char) {
                        next_char += 1;
                    }
                    start = next_char;
                    continue;
                }

                let chunk_content = content[start..actual_end].to_string();

                chunks.push(ContentChunk {
                    content: chunk_content,
                    role: Some(message.role.clone()),
                    turn_number: Some(message.turn_number),
                    chunk_index,
                });
                chunk_index += 1;

                // Move start with overlap, ensuring forward progress
                let new_start = if actual_end > overlap_chars && actual_end < content.len() {
                    ensure_char_boundary_forward(content, actual_end - overlap_chars)
                } else {
                    actual_end
                };

                // Ensure we always move forward
                start = if new_start <= start { actual_end } else { new_start };

                if actual_end >= content.len() {
                    break;
                }
            }

            if iterations >= max_iterations {
                log::error!("chunk_session: hit max iterations for message, possible infinite loop");
            }
        }
    }

    chunks
}

/// Ensure a byte index is on a valid UTF-8 character boundary
/// If not, move backwards to find one
fn ensure_char_boundary(text: &str, mut idx: usize) -> usize {
    while idx > 0 && !text.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// Ensure a byte index is on a valid UTF-8 character boundary
/// If not, move forwards to find one
fn ensure_char_boundary_forward(text: &str, mut idx: usize) -> usize {
    while idx < text.len() && !text.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Find a good break point (sentence end, paragraph, or word boundary)
/// Returns a valid UTF-8 character boundary
fn find_break_point(text: &str, start: usize, max_end: usize) -> usize {
    // Ensure start and max_end are on character boundaries
    let start = ensure_char_boundary_forward(text, start);
    let max_end = ensure_char_boundary(text, max_end.min(text.len()));

    if max_end <= start {
        return max_end;
    }

    let search_text = &text[start..max_end];

    // First try to find sentence end (. ! ?)
    if let Some(pos) = search_text.rfind(|c| c == '.' || c == '!' || c == '?') {
        // pos is a character index in search_text, convert to byte offset
        let byte_pos = search_text[..=pos].len();
        let absolute_pos = start + byte_pos;
        // Make sure we're not too close to start and it's a valid boundary
        if absolute_pos > start + (max_end - start) / 2 && text.is_char_boundary(absolute_pos) {
            return absolute_pos;
        }
    }

    // Try paragraph break
    if let Some(pos) = search_text.rfind("\n\n") {
        let absolute_pos = start + pos + 2;
        if absolute_pos > start + (max_end - start) / 2 && text.is_char_boundary(absolute_pos) {
            return absolute_pos;
        }
    }

    // Try line break
    if let Some(pos) = search_text.rfind('\n') {
        let absolute_pos = start + pos + 1;
        if absolute_pos > start + (max_end - start) / 2 && text.is_char_boundary(absolute_pos) {
            return absolute_pos;
        }
    }

    // Fall back to word boundary
    if let Some(pos) = search_text.rfind(' ') {
        let absolute_pos = start + pos + 1;
        if text.is_char_boundary(absolute_pos) {
            return absolute_pos;
        }
    }

    // Last resort: use max_end (already ensured to be a char boundary)
    max_end
}

/// Create chunks that group related turns together for better context
pub fn chunk_by_turns(
    messages: &[SessionMessage],
    max_chunk_tokens: usize,
    overlap_tokens: usize,
) -> Vec<ContentChunk> {
    chunk_by_turns_from_index(messages, max_chunk_tokens, overlap_tokens, 0)
}

/// Create chunks starting from a specific chunk index (for incremental indexing)
pub fn chunk_by_turns_from_index(
    messages: &[SessionMessage],
    max_chunk_tokens: usize,
    overlap_tokens: usize,
    start_chunk_index: usize,
) -> Vec<ContentChunk> {
    let start_time = std::time::Instant::now();
    log::debug!("chunk_by_turns: {} messages, max_tokens={}, overlap={}, start_index={}",
               messages.len(), max_chunk_tokens, overlap_tokens, start_chunk_index);

    // Calculate total content size for progress tracking
    let total_content_size: usize = messages.iter().map(|m| m.content.len()).sum();
    log::debug!("Total content size: {} chars ({:.1} KB)", total_content_size, total_content_size as f64 / 1024.0);

    let mut chunks = Vec::new();
    let mut chunk_index = start_chunk_index;

    let chars_per_token = 4;
    let max_chunk_chars = max_chunk_tokens * chars_per_token;
    log::debug!("max_chunk_chars={}", max_chunk_chars);

    // Group messages by turn
    let mut current_turn = 0;
    let mut turn_messages: Vec<&SessionMessage> = Vec::new();
    let mut messages_processed = 0;

    for message in messages {
        messages_processed += 1;

        // Log progress every 100 messages
        if messages_processed % 100 == 0 {
            log::debug!("Chunking progress: {}/{} messages, {} chunks created ({:?} elapsed)",
                       messages_processed, messages.len(), chunks.len(), start_time.elapsed());
        }
        if message.turn_number != current_turn {
            // Process previous turn
            if !turn_messages.is_empty() {
                let turn_text = turn_messages
                    .iter()
                    .map(|m| format!("[{}]: {}", m.role, m.content))
                    .collect::<Vec<_>>()
                    .join("\n\n");

                // Chunk the turn text
                let turn_chunks = chunk_text(&turn_text, max_chunk_chars, overlap_tokens * chars_per_token);
                for chunk_content in turn_chunks {
                    chunks.push(ContentChunk {
                        content: chunk_content,
                        role: None, // Mixed roles in a turn
                        turn_number: Some(current_turn),
                        chunk_index,
                    });
                    chunk_index += 1;
                }
            }

            current_turn = message.turn_number;
            turn_messages.clear();
        }

        turn_messages.push(message);
    }

    // Don't forget the last turn
    if !turn_messages.is_empty() {
        let turn_text = turn_messages
            .iter()
            .map(|m| format!("[{}]: {}", m.role, m.content))
            .collect::<Vec<_>>()
            .join("\n\n");

        let turn_chunks = chunk_text(&turn_text, max_chunk_chars, overlap_tokens * chars_per_token);
        for chunk_content in turn_chunks {
            chunks.push(ContentChunk {
                content: chunk_content,
                role: None,
                turn_number: Some(current_turn),
                chunk_index,
            });
            chunk_index += 1;
        }
    }

    log::debug!("chunk_by_turns: created {} chunks in {:?}", chunks.len(), start_time.elapsed());
    chunks
}

/// Simple text chunking with overlap
/// Handles UTF-8 properly by ensuring all slices are on character boundaries
fn chunk_text(text: &str, max_chars: usize, overlap_chars: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }

    if text.len() <= max_chars {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut start = 0;
    let mut iterations = 0;
    let max_iterations = (text.len() / max_chars.max(1)) + 10; // Safety limit

    while start < text.len() && iterations < max_iterations {
        iterations += 1;

        // Ensure start is on a character boundary
        start = ensure_char_boundary_forward(text, start);

        let end = (start + max_chars).min(text.len());
        // Ensure end is on a character boundary
        let end = ensure_char_boundary(text, end);

        // Safety: ensure we have a valid range
        if end <= start {
            log::warn!("chunk_text: invalid range start={} end={}, breaking", start, end);
            break;
        }

        let actual_end = if end < text.len() {
            let break_point = find_break_point(text, start, end);
            // Ensure we always make forward progress
            if break_point <= start {
                log::warn!("chunk_text: break_point {} <= start {}, using end {}", break_point, start, end);
                end
            } else {
                break_point
            }
        } else {
            end
        };

        // Ensure actual_end is on a character boundary
        let actual_end = ensure_char_boundary(text, actual_end);

        // Safety: ensure actual_end > start
        if actual_end <= start {
            log::warn!("chunk_text: actual_end {} <= start {}, forcing progress", actual_end, start);
            // Find the next character boundary after start
            let mut next_char = start + 1;
            while next_char < text.len() && !text.is_char_boundary(next_char) {
                next_char += 1;
            }
            if next_char <= text.len() && next_char > start {
                chunks.push(text[start..next_char].to_string());
                start = next_char;
            } else {
                break;
            }
            continue;
        }

        chunks.push(text[start..actual_end].to_string());

        // Calculate next start with overlap
        let new_start = if actual_end > overlap_chars && actual_end < text.len() {
            ensure_char_boundary_forward(text, actual_end - overlap_chars)
        } else {
            actual_end
        };

        // Ensure we always make forward progress
        if new_start <= start {
            start = actual_end;
        } else {
            start = new_start;
        }

        // Final safety check
        if actual_end >= text.len() {
            break;
        }
    }

    if iterations >= max_iterations {
        log::error!("chunk_text: hit max iterations limit ({}) - possible infinite loop detected", max_iterations);
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_both_transcript_shapes() {
        let dir = std::env::temp_dir().join(format!("qf-semantic-chunker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.jsonl");
        std::fs::write(&a, concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"fix the login bug\"}}
",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"meta\"}}
",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}
",
        )).unwrap();
        let b = dir.join("b.jsonl");
        std::fs::write(&b, concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}
",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"add a parser\"}]}}
",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"added\"}]}}
",
        )).unwrap();
        let ma = parse_session_file(&a).unwrap();
        assert_eq!(ma.iter().map(|m| (m.role.as_str(), m.content.as_str())).collect::<Vec<_>>(), [("user", "fix the login bug"), ("assistant", "done")]);
        let mb = parse_session_file(&b).unwrap();
        assert_eq!(mb.iter().map(|m| (m.role.as_str(), m.content.as_str())).collect::<Vec<_>>(), [("user", "add a parser"), ("assistant", "added")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_chunk_small_message() {
        let messages = vec![SessionMessage {
            role: "user".to_string(),
            content: "Hello, how are you?".to_string(),
            turn_number: 1,
        }];

        let chunks = chunk_session(&messages, 512, 50);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "Hello, how are you?");
    }

    #[test]
    fn test_chunk_large_message() {
        let long_content = "x".repeat(5000);
        let messages = vec![SessionMessage {
            role: "assistant".to_string(),
            content: long_content,
            turn_number: 1,
        }];

        let chunks = chunk_session(&messages, 512, 50);
        assert!(chunks.len() > 1);
    }

    #[test]
    fn test_find_break_point() {
        let text = "Hello world. This is a test. Another sentence here.";
        let break_point = find_break_point(text, 0, 30);
        // Should break after "This is a test."
        assert!(text[..break_point].ends_with('.') || text[..break_point].ends_with(' '));
    }
}
