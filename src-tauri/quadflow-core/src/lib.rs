//! QuadFlow core: the one data layer (data-layer.md). The GUI (Tauri
//! commands), the CLI and the plugin host all call into this crate.

pub mod agents;
pub mod cli;
pub mod context;
pub mod core;
pub mod domains;
pub mod error;
pub mod events;
pub mod ids;
pub mod import_v1;
pub mod model;
pub mod paths;
pub mod plugins;
pub mod store;
pub mod time;
pub mod urls;

#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use crate::core::Core;
pub use error::{CoreError, ErrorCode, Result};
pub use ids::{new_id, Id};
pub use model::{Actor, ActorKind, CorruptEntry, Ext, ListResult, Timestamp};
pub use paths::{AppPaths, Profile, ProjectRoot};
