//! Chat commands (data-layer.md §10.2 `chat.rs`). No logic here — every
//! command calls `quadflow_core::domains::chat`. `chat_send` streams
//! `ChatStreamEvent`s through a Tauri `Channel` and resolves with the final
//! result (or the error, which is also sent as a `failed` event).
//!
//! The API key is read from secrets inside core and never crosses IPC;
//! `ChatSettings.hasApiKey` only says whether one is stored.

use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::app::secrets::Secrets;
use quadflow_core::domains::chat::{
    self, ChatConversation, ChatConversationCreate, ChatDiscoveryResult, ChatEndpointInfo, ChatMessage, ChatSendResult,
    ChatSettings, ChatSettingsPatch, ChatStreamEvent,
};
use quadflow_core::{CoreError, Id};
use tauri::ipc::Channel;
use tauri::State;

/// The secret store for this process (`QUADFLOW_SECRETS_BACKEND`, default: OS keystore).
pub fn secrets(core: &CoreState) -> Result<Secrets, CoreError> {
    Secrets::from_env(core.core.profile(), |k| std::env::var(k).ok())
}

macro_rules! chat_call {
    ($core:expr, |$db:ident, $sec:ident| $body:expr) => {{
        let c = $core.core.clone();
        let $sec = secrets(&$core)?;
        blocking(move || {
            let $db = c.app_db()?;
            let $db = &*$db;
            let $sec = &$sec;
            $body
        })
        .await
    }};
}

#[tauri::command]
#[specta::specta]
pub async fn chat_conversations_list(
    core: State<'_, CoreState>,
    project_root_key: Option<String>,
) -> Result<Vec<ChatConversation>, CoreError> {
    chat_call!(core, |db, _s| chat::conversations_list(db, project_root_key.as_deref()))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_conversations_create(
    core: State<'_, CoreState>,
    input: ChatConversationCreate,
) -> Result<ChatConversation, CoreError> {
    chat_call!(core, |db, _s| chat::conversation_create(db, input))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_conversations_get(core: State<'_, CoreState>, id: Id) -> Result<ChatConversation, CoreError> {
    chat_call!(core, |db, _s| chat::conversation_get(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_conversations_rename(
    core: State<'_, CoreState>,
    id: Id,
    title: String,
) -> Result<ChatConversation, CoreError> {
    chat_call!(core, |db, _s| chat::conversation_rename(db, &id, &title))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_conversations_delete(core: State<'_, CoreState>, id: Id) -> Result<(), CoreError> {
    chat_call!(core, |db, _s| chat::conversation_delete(db, &id))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_messages_list(core: State<'_, CoreState>, conversation_id: Id) -> Result<Vec<ChatMessage>, CoreError> {
    chat_call!(core, |db, _s| chat::messages_list(db, &conversation_id))
}

/// Send `content` and stream the answer into `on_event`.
#[tauri::command]
#[specta::specta]
pub async fn chat_send(
    core: State<'_, CoreState>,
    conversation_id: Id,
    content: String,
    on_event: Channel<ChatStreamEvent>,
) -> Result<ChatSendResult, CoreError> {
    chat_call!(core, |db, sec| {
        let sink = |e: ChatStreamEvent| {
            if let Err(err) = on_event.send(e) {
                log::warn!("[chat] stream channel closed: {err}");
            }
        };
        chat::send(db, sec, &conversation_id, &content, &sink)
    })
}

#[tauri::command]
#[specta::specta]
pub async fn chat_settings_get(core: State<'_, CoreState>) -> Result<ChatSettings, CoreError> {
    chat_call!(core, |db, sec| chat::settings_get(db, sec))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_settings_update(core: State<'_, CoreState>, patch: ChatSettingsPatch) -> Result<ChatSettings, CoreError> {
    chat_call!(core, |db, sec| chat::settings_update(db, sec, patch))
}

/// Models offered by the configured endpoint.
#[tauri::command]
#[specta::specta]
pub async fn chat_models(core: State<'_, CoreState>, timeout_ms: Option<u32>) -> Result<Vec<String>, CoreError> {
    chat_call!(core, |db, sec| chat::models(db, sec, timeout_ms.unwrap_or(5000) as u64))
}

#[tauri::command]
#[specta::specta]
pub async fn chat_discover_endpoints(
    port: Option<u16>,
    timeout_ms: Option<u32>,
) -> Result<ChatDiscoveryResult, CoreError> {
    blocking(move || chat::discover_endpoints(port.unwrap_or(11434), timeout_ms.unwrap_or(2000) as u64)).await
}

/// `null` = nothing answering at that URL.
#[tauri::command]
#[specta::specta]
pub async fn chat_check_endpoint(url: String, timeout_ms: Option<u32>) -> Result<Option<ChatEndpointInfo>, CoreError> {
    blocking(move || chat::check_endpoint(&url, timeout_ms.unwrap_or(5000) as u64)).await
}
