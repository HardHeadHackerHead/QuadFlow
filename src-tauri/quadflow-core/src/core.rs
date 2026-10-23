//! `Core` facade: owns the event bus, app paths, the app DB and the registry of
//! open projects (one `ProjectStore` + optional watcher per project root).
//! The Tauri shell keeps one `Core`; the CLI builds one per invocation.

use crate::error::Result;
use crate::events::app_changes::AppChangesWatcher;
use crate::events::watcher::ProjectWatcher;
use crate::events::EventBus;
use crate::paths::{AppPaths, Profile, ProjectRoot};
use crate::store::{AppDb, ProjectStore};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

pub struct Core {
    pub paths: AppPaths,
    pub bus: EventBus,
    app_db: OnceLock<std::result::Result<Arc<AppDb>, crate::error::CoreError>>,
    projects: ProjectRegistry,
    app_watcher: Mutex<Option<AppChangesWatcher>>,
}

impl Core {
    pub fn new(paths: AppPaths) -> Self {
        Self {
            paths,
            bus: EventBus::new(),
            app_db: OnceLock::new(),
            projects: ProjectRegistry::default(),
            app_watcher: Mutex::new(None),
        }
    }

    /// Resolve paths for this process (profile + `QUADFLOW_DATA_DIR`).
    pub fn from_env() -> Result<Self> {
        Ok(Self::new(AppPaths::resolve()?))
    }

    pub fn profile(&self) -> Profile {
        self.paths.profile
    }

    /// The app DB, opened lazily on first use (error is cached).
    pub fn app_db(&self) -> Result<Arc<AppDb>> {
        self.app_db
            .get_or_init(|| AppDb::open(&self.paths, self.bus.clone()).map(Arc::new))
            .clone()
    }

    /// Start following app-DB writes from other processes (GUI only).
    pub fn watch_app_db(&self) -> Result<()> {
        let db = self.app_db()?;
        let mut w = self.app_watcher.lock();
        if w.is_none() {
            *w = Some(AppChangesWatcher::start(db.path(), self.bus.clone())?);
        }
        Ok(())
    }

    /// The shared store for the project at exactly `path` (must be initialized).
    pub fn project(&self, path: &Path) -> Result<Arc<ProjectStore>> {
        let root = ProjectRoot::open_with(path, self.profile())?;
        Ok(self.projects.get_or_open(root, &self.bus)?)
    }

    /// Register an already-open store (e.g. right after `init`).
    pub fn adopt_project(&self, store: ProjectStore) -> Arc<ProjectStore> {
        self.projects.adopt(store)
    }

    /// Start watching a project's folder for external changes (idempotent).
    pub fn watch_project(&self, path: &Path) -> Result<()> {
        let store = self.project(path)?;
        self.projects.watch(&store, &self.bus)
    }

    pub fn unwatch_project(&self, root_key: &str) {
        self.projects.watchers.lock().remove(root_key);
    }

    pub fn watched_projects(&self) -> Vec<String> {
        self.projects.watchers.lock().keys().cloned().collect()
    }
}

#[derive(Default)]
struct ProjectRegistry {
    stores: Mutex<HashMap<String, Arc<ProjectStore>>>,
    watchers: Mutex<HashMap<String, ProjectWatcher>>,
}

impl ProjectRegistry {
    fn get_or_open(&self, root: ProjectRoot, bus: &EventBus) -> Result<Arc<ProjectStore>> {
        let mut m = self.stores.lock();
        if let Some(s) = m.get(&root.key) {
            return Ok(s.clone());
        }
        let key = root.key.clone();
        let s = Arc::new(ProjectStore::open(root, bus.clone())?);
        m.insert(key, s.clone());
        Ok(s)
    }

    fn adopt(&self, store: ProjectStore) -> Arc<ProjectStore> {
        let key = store.root().key.clone();
        self.stores.lock().entry(key).or_insert_with(|| Arc::new(store)).clone()
    }

    fn watch(&self, store: &ProjectStore, bus: &EventBus) -> Result<()> {
        let mut w = self.watchers.lock();
        if !w.contains_key(&store.root().key) {
            let watcher = ProjectWatcher::start(store.root(), bus.clone(), store.recent_writes().clone())?;
            w.insert(store.root().key.clone(), watcher);
        }
        Ok(())
    }
}
