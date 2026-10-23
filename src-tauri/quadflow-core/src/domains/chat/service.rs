//! Chat services (data-layer.md §7.3): conversations and messages in the app
//! DB (`chat_conversations`, `chat_messages`), tuning in settings namespace
//! `chat`, the API key in secrets: the Chat plugin's `plugin:chat:apiKey`, else
//! `chat.apiKey` (`quadflow chat key set`).

use super::client::{self, ApiMessage, ChatRequestConfig};
use super::model::*;
use crate::domains::app::secrets::{Secrets, KEY_CHAT_API_KEY, KEY_CHAT_PLUGIN_API_KEY};
use crate::domains::app::settings;
use crate::error::{CoreError, ErrorCode, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::{params, OptionalExtension, Row};
use std::collections::BTreeMap;

pub const NS: &str = "chat";
pub const DEFAULT_ENDPOINT: &str = "http://localhost:11434/v1";
pub const DEFAULT_MODEL: &str = "llama3.2";
pub const DEFAULT_TEMPERATURE: f64 = 0.7;
pub const DEFAULT_MAX_TOKENS: u32 = 2048;
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 60;
pub const DEFAULT_TITLE: &str = "New conversation";
const MAX_TITLE_CHARS: usize = 200;

const K_ENDPOINT: &str = "endpoint";
const K_MODEL: &str = "defaultModel";
const K_TEMPERATURE: &str = "temperature";
const K_MAX_TOKENS: &str = "maxTokens";
const K_TIMEOUT: &str = "timeoutSeconds";
const K_SYSTEM_PROMPT: &str = "systemPrompt";

fn chat_change(op: ChangeKind, id: &Id) -> AppChange {
    AppChange::new(Domain::Chat, op, Some(id.as_str()))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn corrupt_setting(key: &str, expected: &str) -> CoreError {
    CoreError::new(ErrorCode::Corrupt, format!("setting chat/{key} is not {expected}"))
        .with_details(serde_json::json!({ "namespace": NS, "key": key }))
}

fn read_str(m: &BTreeMap<String, serde_json::Value>, key: &str) -> Result<Option<String>> {
    match m.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(corrupt_setting(key, "a string")),
    }
}

fn read_f64(m: &BTreeMap<String, serde_json::Value>, key: &str) -> Result<Option<f64>> {
    match m.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v.as_f64().map(Some).ok_or_else(|| corrupt_setting(key, "a number")),
    }
}

fn read_u32(m: &BTreeMap<String, serde_json::Value>, key: &str) -> Result<Option<u32>> {
    match m.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| corrupt_setting(key, "a non-negative integer")),
    }
}

/// The `chat` settings without the secrets lookup (`hasApiKey` = false).
fn settings_read(db: &AppDb) -> Result<ChatSettings> {
    let m = settings::get(db, NS)?;
    Ok(ChatSettings {
        endpoint: read_str(&m, K_ENDPOINT)?.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_ENDPOINT.into()),
        default_model: read_str(&m, K_MODEL)?.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| DEFAULT_MODEL.into()),
        temperature: read_f64(&m, K_TEMPERATURE)?.unwrap_or(DEFAULT_TEMPERATURE),
        max_tokens: read_u32(&m, K_MAX_TOKENS)?.unwrap_or(DEFAULT_MAX_TOKENS),
        timeout_seconds: read_u32(&m, K_TIMEOUT)?.unwrap_or(DEFAULT_TIMEOUT_SECONDS),
        system_prompt: read_str(&m, K_SYSTEM_PROMPT)?.filter(|s| !s.trim().is_empty()),
        has_api_key: false,
    })
}

/// The endpoint API key: the Chat plugin's secret (`plugin:chat:apiKey`, set
/// from its settings form), else `chat.apiKey` (the CLI's `quadflow chat key`).
/// An unavailable keystore reads as "no key".
pub fn api_key(secrets: &Secrets) -> Result<Option<String>> {
    match secrets.get_optional(KEY_CHAT_PLUGIN_API_KEY)? {
        Some(k) => Ok(Some(k)),
        None => secrets.get_optional(KEY_CHAT_API_KEY),
    }
}

/// Settings + whether an API key is stored.
pub fn settings_get(db: &AppDb, secrets: &Secrets) -> Result<ChatSettings> {
    let mut s = settings_read(db)?;
    s.has_api_key = api_key(secrets)?.is_some();
    Ok(s)
}

pub fn settings_update(db: &AppDb, secrets: &Secrets, patch: ChatSettingsPatch) -> Result<ChatSettings> {
    let mut rows: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    if let Some(e) = patch.endpoint {
        let e = e.trim().trim_end_matches('/').to_string();
        client::validate_endpoint(&e)?;
        rows.insert(K_ENDPOINT.into(), e.into());
    }
    if let Some(m) = patch.default_model {
        let m = m.trim().to_string();
        if m.is_empty() {
            return Err(CoreError::invalid_input("defaultModel must not be empty"));
        }
        rows.insert(K_MODEL.into(), m.into());
    }
    if let Some(t) = patch.temperature {
        if !(0.0..=2.0).contains(&t) || t.is_nan() {
            return Err(CoreError::invalid_input("temperature must be between 0.0 and 2.0"));
        }
        rows.insert(K_TEMPERATURE.into(), t.into());
    }
    if let Some(n) = patch.max_tokens {
        if !(1..=128_000).contains(&n) {
            return Err(CoreError::invalid_input("maxTokens must be between 1 and 128000"));
        }
        rows.insert(K_MAX_TOKENS.into(), n.into());
    }
    if let Some(n) = patch.timeout_seconds {
        if !(1..=600).contains(&n) {
            return Err(CoreError::invalid_input("timeoutSeconds must be between 1 and 600"));
        }
        rows.insert(K_TIMEOUT.into(), n.into());
    }
    if let Some(p) = patch.system_prompt {
        let v = p.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        rows.insert(K_SYSTEM_PROMPT.into(), v.map(Into::into).unwrap_or(serde_json::Value::Null));
    }
    settings::set_many(db, NS, rows)?;
    settings_get(db, secrets)
}

/// Endpoint + key + tuning for one request (Rust-side only: carries the key).
pub fn request_config(db: &AppDb, secrets: &Secrets) -> Result<(ChatRequestConfig, ChatSettings)> {
    let s = settings_read(db)?;
    let api_key = api_key(secrets)?;
    let cfg = ChatRequestConfig {
        endpoint: s.endpoint.clone(),
        api_key: api_key.clone(),
        temperature: s.temperature,
        max_tokens: s.max_tokens,
        timeout_seconds: s.timeout_seconds,
    };
    Ok((cfg, ChatSettings { has_api_key: api_key.is_some(), ..s }))
}

/// Models offered by the configured endpoint.
pub fn models(db: &AppDb, secrets: &Secrets, timeout_ms: u64) -> Result<Vec<String>> {
    let (cfg, _) = request_config(db, secrets)?;
    client::list_models(&cfg.endpoint, cfg.api_key.as_deref(), timeout_ms)
}

/// A one-off completion with the configured endpoint (no conversation is stored).
/// `model: None` = the default model. Used by shell features (titles, polls).
pub fn complete(db: &AppDb, secrets: &Secrets, model: Option<&str>, messages: &[ApiMessage]) -> Result<client::Completion> {
    let (cfg, s) = request_config(db, secrets)?;
    client::complete(&cfg, model.unwrap_or(&s.default_model), messages)
}

/// One question to the configured endpoint, nothing stored (plugin `data.chat.ask`).
/// `system_prompt` goes first; `model: None` = the default model.
pub fn ask(db: &AppDb, secrets: &Secrets, question: &str, system_prompt: Option<&str>, model: Option<&str>) -> Result<String> {
    if question.trim().is_empty() {
        return Err(CoreError::invalid_input("question must not be empty"));
    }
    let mut api = Vec::new();
    if let Some(p) = system_prompt.filter(|p| !p.trim().is_empty()) {
        api.push(ApiMessage::new(ChatRole::System, p));
    }
    api.push(ApiMessage::new(ChatRole::User, question));
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let done = complete(db, secrets, model, &api)?;
    if done.content.trim().is_empty() {
        return Err(CoreError::external("The chat endpoint returned an empty answer"));
    }
    Ok(done.content)
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const CONV_COLS: &str = "id, project_root_key, title, model, system_prompt, created_at, updated_at";
const MSG_COLS: &str = "id, conversation_id, role, content, token_count, created_at";

fn parse_id(table: &str, raw: String) -> rusqlite::Result<Id> {
    Id::parse(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, format!("{table}: {}", e.message).into())
    })
}

fn conv_row(r: &Row) -> rusqlite::Result<ChatConversation> {
    Ok(ChatConversation {
        id: parse_id("chat_conversations", r.get(0)?)?,
        project_root_key: r.get(1)?,
        title: r.get(2)?,
        model: r.get(3)?,
        system_prompt: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

fn msg_row(r: &Row) -> rusqlite::Result<ChatMessage> {
    let role: String = r.get(2)?;
    Ok(ChatMessage {
        id: parse_id("chat_messages", r.get(0)?)?,
        conversation_id: parse_id("chat_messages", r.get(1)?)?,
        role: ChatRole::parse(&role).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, format!("unknown chat role {role:?}").into())
        })?,
        content: r.get(3)?,
        token_count: r.get::<_, Option<i64>>(4)?.and_then(|n| u32::try_from(n).ok()),
        created_at: r.get(5)?,
    })
}

fn sql_err(e: rusqlite::Error) -> CoreError {
    match e {
        rusqlite::Error::FromSqlConversionFailure(_, _, inner) => CoreError::new(ErrorCode::Corrupt, inner.to_string()),
        other => other.into(),
    }
}

fn not_found(id: &Id) -> CoreError {
    CoreError::not_found(format!("chat conversation {id} not found"))
}

fn clean_title(title: &str) -> Result<String> {
    let t: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err(CoreError::invalid_input("title must not be empty"));
    }
    Ok(t.chars().take(MAX_TITLE_CHARS).collect())
}

fn opt_trim(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Newest activity first. `project_root_key: Some(k)` = only that project's conversations.
pub fn conversations_list(db: &AppDb, project_root_key: Option<&str>) -> Result<Vec<ChatConversation>> {
    db.read(|c| {
        let rows = match project_root_key {
            Some(k) => {
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT {CONV_COLS} FROM chat_conversations WHERE project_root_key = ?1 ORDER BY updated_at DESC, id DESC"
                ))?;
                let r = stmt.query_map([k], conv_row)?.collect::<rusqlite::Result<Vec<_>>>();
                r
            }
            None => {
                let mut stmt = c.prepare_cached(&format!(
                    "SELECT {CONV_COLS} FROM chat_conversations ORDER BY updated_at DESC, id DESC"
                ))?;
                let r = stmt.query_map([], conv_row)?.collect::<rusqlite::Result<Vec<_>>>();
                r
            }
        };
        Ok(rows)
    })?
    .map_err(sql_err)
}

fn get_in(c: &rusqlite::Connection, id: &Id) -> Result<ChatConversation> {
    c.query_row(&format!("SELECT {CONV_COLS} FROM chat_conversations WHERE id = ?1"), [id.as_str()], conv_row)
        .optional()
        .map_err(sql_err)?
        .ok_or_else(|| not_found(id))
}

pub fn conversation_get(db: &AppDb, id: &Id) -> Result<ChatConversation> {
    db.read(|c| Ok(get_in(c, id)))?
}

pub fn conversation_create(db: &AppDb, input: ChatConversationCreate) -> Result<ChatConversation> {
    let title = match opt_trim(input.title) {
        Some(t) => clean_title(&t)?,
        None => DEFAULT_TITLE.to_string(),
    };
    let system_prompt = match opt_trim(input.system_prompt) {
        Some(p) => Some(p),
        None => settings_read(db)?.system_prompt,
    };
    let now = now_ms();
    let conv = ChatConversation {
        id: new_id(),
        project_root_key: opt_trim(input.project_root_key),
        title,
        model: opt_trim(input.model),
        system_prompt,
        created_at: now,
        updated_at: now,
    };
    db.transact(|tx, ch| {
        tx.execute(
            "INSERT INTO chat_conversations (id, project_root_key, title, model, system_prompt, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![conv.id.as_str(), conv.project_root_key, conv.title, conv.model, conv.system_prompt, now, now],
        )?;
        ch.push(chat_change(ChangeKind::Created, &conv.id));
        Ok(())
    })?;
    Ok(conv)
}

pub fn conversation_rename(db: &AppDb, id: &Id, title: &str) -> Result<ChatConversation> {
    let title = clean_title(title)?;
    db.transact(|tx, ch| {
        let n = tx.execute(
            "UPDATE chat_conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now_ms(), id.as_str()],
        )?;
        if n == 0 {
            return Err(not_found(id));
        }
        ch.push(chat_change(ChangeKind::Updated, id));
        get_in(tx, id)
    })
}

/// Deletes the conversation and (cascade) its messages.
pub fn conversation_delete(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        if tx.execute("DELETE FROM chat_conversations WHERE id = ?1", [id.as_str()])? == 0 {
            return Err(not_found(id));
        }
        ch.push(chat_change(ChangeKind::Deleted, id));
        Ok(())
    })
}

fn messages_in(c: &rusqlite::Connection, id: &Id) -> Result<Vec<ChatMessage>> {
    get_in(c, id)?;
    let mut stmt = c.prepare_cached(&format!(
        "SELECT {MSG_COLS} FROM chat_messages WHERE conversation_id = ?1 ORDER BY created_at, rowid"
    ))?;
    let rows = stmt.query_map([id.as_str()], msg_row)?.collect::<rusqlite::Result<Vec<_>>>();
    rows.map_err(sql_err)
}

/// Oldest first.
pub fn messages_list(db: &AppDb, conversation_id: &Id) -> Result<Vec<ChatMessage>> {
    db.read(|c| Ok(messages_in(c, conversation_id)))?
}

/// Append one message (also bumps the conversation's `updatedAt`).
pub fn message_add(db: &AppDb, conversation_id: &Id, role: ChatRole, content: &str, token_count: Option<u32>) -> Result<ChatMessage> {
    let now = now_ms();
    let msg = ChatMessage {
        id: new_id(),
        conversation_id: conversation_id.clone(),
        role,
        content: content.to_string(),
        token_count,
        created_at: now,
    };
    db.transact(|tx, ch| {
        if tx.execute("UPDATE chat_conversations SET updated_at = ?1 WHERE id = ?2", params![now, conversation_id.as_str()])? == 0 {
            return Err(not_found(conversation_id));
        }
        tx.execute(
            "INSERT INTO chat_messages (id, conversation_id, role, content, token_count, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![msg.id.as_str(), conversation_id.as_str(), role.as_str(), msg.content, token_count.map(i64::from), now],
        )?;
        ch.push(chat_change(ChangeKind::Updated, conversation_id));
        Ok(())
    })?;
    Ok(msg)
}

/// Store `content` as a user message, stream the answer from the configured
/// endpoint into `sink`, store the assistant message. On failure the user
/// message stays, `sink` gets `Failed`, and the error is returned.
pub fn send(db: &AppDb, secrets: &Secrets, conversation_id: &Id, content: &str, sink: &dyn ChatSink) -> Result<ChatSendResult> {
    if content.trim().is_empty() {
        return Err(CoreError::invalid_input("message must not be empty"));
    }
    let conv = conversation_get(db, conversation_id)?;
    let (cfg, s) = request_config(db, secrets)?;
    let user_message = message_add(db, conversation_id, ChatRole::User, content, None)?;
    sink.event(ChatStreamEvent::Started { user_message: user_message.clone() });

    let run = || -> Result<ChatSendResult> {
        let mut api = Vec::new();
        if let Some(p) = conv.system_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
            api.push(ApiMessage::new(ChatRole::System, p));
        }
        for m in messages_list(db, conversation_id)? {
            api.push(ApiMessage::new(m.role, m.content));
        }
        let model = conv.model.clone().unwrap_or(s.default_model.clone());
        let done = client::stream(&cfg, &model, &api, &mut |d| sink.event(ChatStreamEvent::Delta { text: d.to_string() }))?;
        if done.content.trim().is_empty() {
            return Err(CoreError::external(format!("The chat endpoint at {} returned an empty answer", cfg.endpoint)));
        }
        let tokens = done.usage.and_then(|u| u.completion_tokens);
        let assistant_message = message_add(db, conversation_id, ChatRole::Assistant, &done.content, tokens)?;
        Ok(ChatSendResult { user_message: user_message.clone(), assistant_message, usage: done.usage })
    };
    match run() {
        Ok(result) => {
            sink.event(ChatStreamEvent::Done { result: result.clone() });
            Ok(result)
        }
        Err(error) => {
            sink.event(ChatStreamEvent::Failed { error: error.clone() });
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// A one-shot HTTP server answering every request with `response`;
    /// returns its base URL and the raw requests it received.
    fn serve(response: String, requests: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let (mut s, _) = l.accept().unwrap();
                let mut buf = vec![0u8; 65536];
                let mut req = Vec::new();
                loop {
                    let n = s.read(&mut buf).unwrap();
                    req.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&req).to_string();
                    if let Some(p) = text.find("\r\n\r\n") {
                        let len = text[..p]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if req.len() >= p + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&req).to_string());
                s.write_all(response.as_bytes()).unwrap();
            }
            seen
        });
        (url, h)
    }

    fn sse_response(chunks: &[&str]) -> String {
        let mut body = String::new();
        for c in chunks {
            body.push_str(&format!("data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n", serde_json::to_string(c).unwrap()));
        }
        body.push_str("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"total_tokens\":9}}\n\ndata: [DONE]\n\n");
        format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }

    #[test]
    fn settings_defaults_patch_and_validation() {
        let a = app();
        let sec = Secrets::memory();
        let s = settings_get(&a.db, &sec).unwrap();
        assert_eq!(s.endpoint, DEFAULT_ENDPOINT);
        assert!(!s.has_api_key);
        let s = settings_update(
            &a.db,
            &sec,
            ChatSettingsPatch {
                endpoint: Some(" http://127.0.0.1:9/v1/ ".into()),
                temperature: Some(1.5),
                system_prompt: Some(Some("Be brief.".into())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.endpoint, "http://127.0.0.1:9/v1");
        assert_eq!(s.temperature, 1.5);
        assert_eq!(s.system_prompt.as_deref(), Some("Be brief."));
        let s = settings_update(&a.db, &sec, ChatSettingsPatch { system_prompt: Some(None), ..Default::default() }).unwrap();
        assert_eq!(s.system_prompt, None);
        for bad in [
            ChatSettingsPatch { endpoint: Some("nope".into()), ..Default::default() },
            ChatSettingsPatch { temperature: Some(3.0), ..Default::default() },
            ChatSettingsPatch { max_tokens: Some(0), ..Default::default() },
            ChatSettingsPatch { timeout_seconds: Some(601), ..Default::default() },
            ChatSettingsPatch { default_model: Some(" ".into()), ..Default::default() },
        ] {
            assert_eq!(settings_update(&a.db, &sec, bad).unwrap_err().code, ErrorCode::InvalidInput);
        }
        sec.set(KEY_CHAT_API_KEY, "sk-x").unwrap();
        assert!(settings_get(&a.db, &sec).unwrap().has_api_key);
        // The key is never in the settings rows.
        let raw = settings::get(&a.db, NS).unwrap();
        assert!(!serde_json::to_string(&raw).unwrap().contains("sk-x"));
    }

    #[test]
    fn conversation_crud_and_events() {
        let a = app();
        let c = conversation_create(&a.db, ChatConversationCreate { title: Some("  Hello   world ".into()), ..Default::default() }).unwrap();
        assert_eq!(c.title, "Hello world");
        assert_eq!(c.model, None);
        let ev = a.take_events();
        assert!(ev.iter().any(|e| e.domain == Domain::Chat && e.kind == ChangeKind::Created && e.ids == vec![c.id.to_string()]));
        let other = conversation_create(&a.db, ChatConversationCreate { project_root_key: Some("rk1".into()), ..Default::default() }).unwrap();
        assert_eq!(other.title, DEFAULT_TITLE);
        assert_eq!(conversations_list(&a.db, None).unwrap().len(), 2);
        assert_eq!(conversations_list(&a.db, Some("rk1")).unwrap(), vec![other.clone()]);

        let r = conversation_rename(&a.db, &c.id, "Renamed").unwrap();
        assert_eq!(r.title, "Renamed");
        assert_eq!(conversation_rename(&a.db, &c.id, "  ").unwrap_err().code, ErrorCode::InvalidInput);

        std::thread::sleep(std::time::Duration::from_millis(5)); // distinct updatedAt from `other`
        message_add(&a.db, &c.id, ChatRole::User, "one", None).unwrap();
        message_add(&a.db, &c.id, ChatRole::Assistant, "two", Some(3)).unwrap();
        let msgs = messages_list(&a.db, &c.id).unwrap();
        assert_eq!(msgs.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(), vec!["one", "two"]);
        assert_eq!(conversations_list(&a.db, None).unwrap()[0].id, c.id, "most recently active first");

        conversation_delete(&a.db, &c.id).unwrap();
        assert_eq!(conversation_get(&a.db, &c.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(conversation_delete(&a.db, &c.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(messages_list(&a.db, &c.id).unwrap_err().code, ErrorCode::NotFound);
        let n: i64 = a.db.read(|c| c.query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 0, "messages cascade");
    }

    #[test]
    fn send_streams_and_stores_with_api_key_header() {
        let a = app();
        let sec = Secrets::memory();
        sec.set(KEY_CHAT_API_KEY, "sk-test-key").unwrap();
        let (url, server) = serve(sse_response(&["Hi", " there"]), 1);
        settings_update(&a.db, &sec, ChatSettingsPatch { endpoint: Some(url), ..Default::default() }).unwrap();
        let c = conversation_create(
            &a.db,
            ChatConversationCreate { model: Some("m1".into()), system_prompt: Some("sys".into()), ..Default::default() },
        )
        .unwrap();
        let events = Mutex::new(Vec::new());
        let sink = |e: ChatStreamEvent| events.lock().unwrap().push(e);
        let r = send(&a.db, &sec, &c.id, "hello?", &sink).unwrap();
        assert_eq!(r.assistant_message.content, "Hi there");
        assert_eq!(r.assistant_message.token_count, Some(2));
        assert_eq!(r.usage.unwrap().total_tokens, Some(9));
        let ev = events.into_inner().unwrap();
        assert!(matches!(&ev[0], ChatStreamEvent::Started { user_message } if user_message.content == "hello?"));
        assert!(matches!(&ev[1], ChatStreamEvent::Delta { text } if text == "Hi"));
        assert!(matches!(&ev[2], ChatStreamEvent::Delta { text } if text == " there"));
        assert!(matches!(&ev[3], ChatStreamEvent::Done { .. }));
        let req = server.join().unwrap().remove(0);
        assert!(req.to_ascii_lowercase().contains("authorization: bearer sk-test-key"));
        let body: serde_json::Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], "m1");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0], serde_json::json!({"role": "system", "content": "sys"}));
        assert_eq!(body["messages"][1], serde_json::json!({"role": "user", "content": "hello?"}));
        assert_eq!(messages_list(&a.db, &c.id).unwrap().len(), 2);
    }

    #[test]
    fn ask_prefers_the_plugin_key_and_stores_nothing() {
        let a = app();
        let sec = Secrets::memory();
        assert!(!settings_get(&a.db, &sec).unwrap().has_api_key);
        sec.set(KEY_CHAT_API_KEY, "sk-cli").unwrap();
        sec.set(KEY_CHAT_PLUGIN_API_KEY, "sk-plugin").unwrap();
        assert!(settings_get(&a.db, &sec).unwrap().has_api_key);
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"Fine."}}]}"#;
        let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (url, server) = serve(resp, 1);
        settings_update(&a.db, &sec, ChatSettingsPatch { endpoint: Some(url), ..Default::default() }).unwrap();
        assert_eq!(ask(&a.db, &sec, "How is it?", Some("Be brief."), Some("m2")).unwrap(), "Fine.");
        let req = server.join().unwrap().remove(0);
        assert!(req.to_ascii_lowercase().contains("authorization: bearer sk-plugin"), "{req}");
        let body: serde_json::Value = serde_json::from_str(&req[req.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body["model"], "m2");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1], serde_json::json!({"role": "user", "content": "How is it?"}));
        assert!(conversations_list(&a.db, None).unwrap().is_empty(), "no conversation is stored");
        // Without the plugin's key the CLI's is used.
        sec.delete(KEY_CHAT_PLUGIN_API_KEY).unwrap();
        assert_eq!(api_key(&sec).unwrap().as_deref(), Some("sk-cli"));
        assert_eq!(ask(&a.db, &sec, "  ", None, None).unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[test]
    fn send_to_unreachable_endpoint_fails_cleanly() {
        let a = app();
        let sec = Secrets::memory();
        // Bind then drop: nothing listens on this port.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        settings_update(
            &a.db,
            &sec,
            ChatSettingsPatch { endpoint: Some(format!("http://127.0.0.1:{port}/v1")), timeout_seconds: Some(5), ..Default::default() },
        )
        .unwrap();
        let c = conversation_create(&a.db, ChatConversationCreate::default()).unwrap();
        let events = Mutex::new(Vec::new());
        let sink = |e: ChatStreamEvent| events.lock().unwrap().push(e);
        let err = send(&a.db, &sec, &c.id, "hi", &sink).unwrap_err();
        assert_eq!(err.code, ErrorCode::External);
        assert!(err.message.contains("Could not connect"), "{}", err.message);
        let ev = events.into_inner().unwrap();
        assert!(matches!(ev.last(), Some(ChatStreamEvent::Failed { error }) if error.code == ErrorCode::External));
        let msgs = messages_list(&a.db, &c.id).unwrap();
        assert_eq!(msgs.len(), 1, "user message kept, no assistant message");
        assert_eq!(msgs[0].role, ChatRole::User);
    }

    #[test]
    fn send_http_error_is_external_with_hint() {
        let a = app();
        let sec = Secrets::memory();
        sec.set(KEY_CHAT_API_KEY, "sk-wrong").unwrap();
        let body = r#"{"error":{"message":"Incorrect API key"}}"#;
        let resp = format!("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (url, server) = serve(resp, 1);
        settings_update(&a.db, &sec, ChatSettingsPatch { endpoint: Some(url), ..Default::default() }).unwrap();
        let c = conversation_create(&a.db, ChatConversationCreate::default()).unwrap();
        let err = send(&a.db, &sec, &c.id, "hi", &NoSink).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.code, ErrorCode::External);
        assert!(err.message.contains("HTTP 401") && err.message.contains("Incorrect API key"), "{}", err.message);
        assert!(!err.message.contains("sk-wrong"));
    }

    #[test]
    fn send_rejects_empty_and_unknown() {
        let a = app();
        let sec = Secrets::memory();
        let c = conversation_create(&a.db, ChatConversationCreate::default()).unwrap();
        assert_eq!(send(&a.db, &sec, &c.id, "  ", &NoSink).unwrap_err().code, ErrorCode::InvalidInput);
        assert_eq!(send(&a.db, &sec, &new_id(), "x", &NoSink).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn stream_event_wire_shape() {
        let v = serde_json::to_value(ChatStreamEvent::Delta { text: "x".into() }).unwrap();
        assert_eq!(v, serde_json::json!({"type": "delta", "text": "x"}));
        let a = app();
        let c = conversation_create(&a.db, ChatConversationCreate::default()).unwrap();
        let m = message_add(&a.db, &c.id, ChatRole::User, "u", None).unwrap();
        let v = serde_json::to_value(ChatStreamEvent::Started { user_message: m }).unwrap();
        assert_eq!(v["type"], "started");
        assert_eq!(v["userMessage"]["conversationId"], c.id.to_string());
    }
}
