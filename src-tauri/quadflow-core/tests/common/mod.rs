//! Shared helpers for integration tests (data-layer.md §12.1). Nothing here
//! touches the real user data dir: every store lives in a temp dir.
#![allow(dead_code)]

use quadflow_core::domains::project_config::{init_with, InitOptions};
use quadflow_core::events::{Domain, EventBus};
use quadflow_core::store::{Entity, ProjectStore, Singleton};
use quadflow_core::{Id, Profile};
use serde::{Deserialize, Serialize};

/// Tests pin the profile so they behave the same in debug and release builds.
pub const PROFILE: Profile = Profile::Dev;

pub struct TempProject {
    pub store: ProjectStore,
    pub dir: tempfile::TempDir,
}

impl TempProject {
    pub fn new() -> Self {
        let dir = tempfile::Builder::new().prefix("qf-it-").tempdir().unwrap();
        let store = init_with(dir.path(), PROFILE, InitOptions::default(), EventBus::new()).unwrap();
        Self { store, dir }
    }
}

/// Dummy numbered entity standing in for issues in the foundation tests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestEntity {
    pub id: Id,
    pub number: u64,
    pub title: String,
}

impl Entity for TestEntity {
    const DOMAIN: Domain = Domain::Issues;
    const DIR: &'static str = "issues";
    fn id(&self) -> &Id {
        &self.id
    }
}

/// Entity that accumulates comments (read-modify-write under the lock).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestThread {
    pub id: Id,
    pub comments: Vec<String>,
}

impl Entity for TestThread {
    const DOMAIN: Domain = Domain::Epics;
    const DIR: &'static str = "epics";
    fn id(&self) -> &Id {
        &self.id
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TestLabels {
    pub labels: Vec<String>,
}

impl Singleton for TestLabels {
    const DOMAIN: Domain = Domain::Labels;
    const FILE: &'static str = "labels.json";
}
