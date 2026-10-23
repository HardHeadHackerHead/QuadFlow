//! Missions, mission templates and agent-definition built-ins (data-layer.md §6.8, §6.9).
//!
//! Missions are machine-local runtime state under `.quadflow/local/missions/<id>/`;
//! custom templates are shared project content (`mission-templates/<id>.json`);
//! built-in templates and agent definitions are Rust consts merged at read time.

pub mod builtins;
pub mod model;
pub mod service;

pub use builtins::{builtin_agent_definitions, builtin_templates, BUILTIN_AGENT_PROVIDER};
pub use model::*;
pub use service::*;

#[cfg(test)]
mod tests;
