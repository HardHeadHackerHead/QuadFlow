//! Issues, epics and labels (data-layer.md §6.3).
//!
//! Other domains create issues and change their status from inside their own
//! transactions through [`create_in_tx`] and [`set_status_in_tx`].

pub mod epics;
pub mod labels;
pub mod model;
pub mod refs;
pub mod service;

pub use epics::{epic_create, epic_delete, epic_get, epic_update, epics_list};
pub use labels::{label_delete, label_upsert, labels_list};
pub use model::*;
pub use refs::{display_ref, format_ref};
pub use service::*;

#[cfg(test)]
mod tests;
