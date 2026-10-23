//! Storage engine (data-layer.md §4): atomic writes, the per-project lock, the
//! project file store and the app SQLite database.

pub mod app_db;
pub mod atomic;
pub mod lock;
pub mod project;
pub mod recent;

pub use app_db::{AppChange, AppDb};
pub use atomic::{atomic_write, atomic_write_json, read_file};
pub use lock::{ProjectLock, DEFAULT_LOCK_TIMEOUT};
pub use project::{Entity, LocalState, ProjectStore, RelPath, Singleton, Tx};
pub use recent::RecentWrites;
