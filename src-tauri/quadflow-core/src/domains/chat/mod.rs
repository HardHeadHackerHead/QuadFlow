//! Chat domain (data-layer.md §7.3): LLM conversations against any
//! OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, OpenAI, …).
//!
//! - conversations / messages: app DB tables `chat_conversations`, `chat_messages`
//! - endpoint + tuning: settings namespace `chat` ([`ChatSettings`])
//! - API key: secrets `plugin:chat:apiKey` (the Chat plugin), else `chat.apiKey`
//!   (§7.4) — never returned to the frontend
//! - streaming: [`send`] pushes [`ChatStreamEvent`]s into a [`ChatSink`]
//!   (the Tauri layer forwards them through a `Channel`)

pub mod client;
pub mod endpoint_discovery;
pub mod model;
pub mod service;

pub use endpoint_discovery::{check_endpoint, discover_endpoints};
pub use model::*;
pub use service::*;
