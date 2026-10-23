//! Chat types crossing IPC / CLI JSON (data-layer.md §7, §7.2, §7.3).

use crate::error::CoreError;
use crate::ids::Id;
use crate::model::Timestamp;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }

    pub fn parse(s: &str) -> Option<ChatRole> {
        match s {
            "system" => Some(ChatRole::System),
            "user" => Some(ChatRole::User),
            "assistant" => Some(ChatRole::Assistant),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub id: Id,
    /// Project this conversation belongs to (`root_key`), `null` = global.
    pub project_root_key: Option<String>,
    pub title: String,
    /// Model override; `null` = the `chat.defaultModel` setting at send time.
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Id,
    pub conversation_id: Id,
    pub role: ChatRole,
    pub content: String,
    pub token_count: Option<u32>,
    pub created_at: Timestamp,
}

/// `chat_conversations_create` input. Absent fields: title "New conversation",
/// model `null` (default model), system prompt = the `chat.systemPrompt` setting.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversationCreate {
    pub title: Option<String>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub project_root_key: Option<String>,
}

/// Settings namespace `chat` as one typed struct (§7.2). The API key is not
/// part of it — it lives in secrets (§7.4); `hasApiKey` only says whether one is set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    /// OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`.
    pub endpoint: String,
    pub default_model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub timeout_seconds: u32,
    /// Default system prompt for new conversations.
    pub system_prompt: Option<String>,
    pub has_api_key: bool,
}

/// Absent = unchanged; `systemPrompt: null` clears it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<String>)]
    pub system_prompt: Option<Option<String>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

/// Result of a completed `send`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendResult {
    pub user_message: ChatMessage,
    pub assistant_message: ChatMessage,
    pub usage: Option<ChatUsage>,
}

/// Events streamed while a message is being answered (Tauri `Channel`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    /// The user message was stored; the request to the endpoint starts now.
    #[serde(rename_all = "camelCase")]
    Started { user_message: ChatMessage },
    /// A piece of the assistant's answer.
    Delta { text: String },
    /// The answer is complete and stored.
    Done { result: ChatSendResult },
    /// The request failed; the user message stays stored, no assistant message.
    Failed { error: CoreError },
}

/// Receives stream events (`send`). Implementations must not block for long.
pub trait ChatSink {
    fn event(&self, e: ChatStreamEvent);
}

impl<F: Fn(ChatStreamEvent)> ChatSink for F {
    fn event(&self, e: ChatStreamEvent) {
        self(e)
    }
}

/// A sink that discards everything (CLI non-streaming, tests).
pub struct NoSink;
impl ChatSink for NoSink {
    fn event(&self, _: ChatStreamEvent) {}
}

/// An LLM server found on the network or probed directly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatEndpointInfo {
    pub host: String,
    pub hostname: Option<String>,
    pub port: u16,
    /// OpenAI-compatible base URL (`…/v1`) to use as `chat.endpoint`.
    pub endpoint_url: String,
    pub api_type: ChatApiType,
    pub models: Vec<String>,
    pub response_time_ms: u32,
    pub is_local: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ChatApiType {
    Ollama,
    OpenaiCompatible,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatDiscoveryResult {
    pub endpoints: Vec<ChatEndpointInfo>,
    pub local_ip: String,
    pub scanned_subnet: String,
    pub scan_duration_ms: u32,
    pub ips_scanned: u32,
}
