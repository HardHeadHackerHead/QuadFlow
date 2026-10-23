//! The chat endpoint for shell features that talk to it directly (title
//! generation). The endpoint + key belong to the chat domain (settings
//! namespace `chat`, secret `chat.apiKey`); the key never reaches the frontend.
//!
//! (The OpenAI key + text-to-speech settings that used to live here moved to
//! the youtube-live plugin, MIG-streamer: plugin secret `openai.apiKey`.)

use crate::commands::chat::secrets;
use crate::core_state::{blocking, CoreState};
use quadflow_core::domains::chat;

/// The configured chat endpoint and its API key (Rust-side only).
pub async fn chat_endpoint(core: &CoreState) -> Result<(String, Option<String>), String> {
    let sec = secrets(core).map_err(|e| e.message)?;
    let c = core.core.clone();
    blocking(move || {
        let db = c.app_db()?;
        let (cfg, _) = chat::request_config(&db, &sec)?;
        Ok((cfg.endpoint, cfg.api_key))
    })
    .await
    .map_err(|e| e.message)
}
