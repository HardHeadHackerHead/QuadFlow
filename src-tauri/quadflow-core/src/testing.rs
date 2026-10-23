//! Test helpers (data-layer.md §12.1). Compiled for this crate's tests and,
//! with feature `testing`, for other crates' tests. Nothing here touches the
//! real user data dir.

use crate::domains::project_config::{init_with, InitOptions};
use crate::events::EventBus;
use crate::paths::{AppPaths, Profile};
use crate::store::{AppDb, ProjectStore};

/// A fresh, initialized project in a temp dir (current profile).
pub struct TempProject {
    pub store: ProjectStore,
    // Dropped last: the store must not outlive its directory.
    pub dir: tempfile::TempDir,
}

impl TempProject {
    pub fn new() -> Self {
        Self::with_profile(Profile::current())
    }

    pub fn with_profile(profile: Profile) -> Self {
        let dir = tempfile::Builder::new().prefix("qf-proj-").tempdir().expect("temp dir");
        let store = init_with(dir.path(), profile, InitOptions::default(), EventBus::new()).expect("init project");
        Self { store, dir }
    }
}

impl Default for TempProject {
    fn default() -> Self {
        Self::new()
    }
}

/// A fresh app DB in a temp dir.
pub struct TempApp {
    pub paths: AppPaths,
    pub db: AppDb,
    pub dir: tempfile::TempDir,
}

impl TempApp {
    pub fn new() -> Self {
        let dir = tempfile::Builder::new().prefix("qf-app-").tempdir().expect("temp dir");
        let paths = AppPaths::under(dir.path());
        let db = AppDb::open(&paths, EventBus::new()).expect("open app db");
        Self { paths, db, dir }
    }
}

impl Default for TempApp {
    fn default() -> Self {
        Self::new()
    }
}
