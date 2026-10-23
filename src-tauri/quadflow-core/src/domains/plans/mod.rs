//! Plans, steps, comments, promotion (data-layer.md §6.4).
//!
//! Issues call back into this module from inside their own transactions:
//! [`sync_step_from_issue_in_tx`] (status sync) and [`unlink_issue_in_tx`]
//! (issue deleted).

pub mod model;
pub mod promote;
pub mod service;

pub use model::*;
pub use promote::{promote_all, promote_step};
pub use service::*;

#[cfg(test)]
mod tests;
