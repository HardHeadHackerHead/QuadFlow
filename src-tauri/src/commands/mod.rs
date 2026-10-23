//! Typed Tauri commands (data-layer.md §10). One file per domain; no logic here —
//! every command calls a `quadflow_core` service via `spawn_blocking`.
//!
//! Shared registration point (§13): append `pub mod <domain>;`, alphabetical.

pub mod agents;
pub mod chat;
pub mod discovery;
pub mod ideas;
pub mod import_v1;
pub mod plugins;
pub mod plugin_sidecars;
pub mod plugin_dev;
pub mod issues;
pub mod plans;
pub mod missions;
pub mod app;
pub mod project;
pub mod scripts;
pub mod ship;
