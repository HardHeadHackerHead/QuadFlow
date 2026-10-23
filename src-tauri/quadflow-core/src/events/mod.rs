//! Change events (data-layer.md §8): one in-process bus fed by core writes
//! (`Origin::Local`), the project file watcher and the app-DB change cursor
//! (`Origin::External`).

pub mod app_changes;
pub mod watcher;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    /// Per-process monotonic sequence number (assigned by [`EventBus::publish`]).
    pub seq: u64,
    pub scope: ChangeScope,
    pub domain: Domain,
    pub kind: ChangeKind,
    /// Affected entity ids; empty with `kind = invalidated`.
    pub ids: Vec<String>,
    pub origin: Origin,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChangeScope {
    Project {
        #[serde(rename = "rootKey")]
        root_key: String,
    },
    App,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Domain {
    ProjectConfig,
    Ideas,
    Issues,
    Epics,
    Labels,
    Plans,
    Discovery,
    Scripts,
    ScriptGroups,
    Ship,
    ShipRuns,
    MissionTemplates,
    Missions,
    MissionMessages,
    MissionActivity,
    Projects,
    Workspaces,
    ToolConfigs,
    Settings,
    StoredPrompts,
    AgentDefinitions,
    Environments,
    Chat,
    Plugins,
    PluginData,
}

impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::ProjectConfig => "project_config",
            Domain::Ideas => "ideas",
            Domain::Issues => "issues",
            Domain::Epics => "epics",
            Domain::Labels => "labels",
            Domain::Plans => "plans",
            Domain::Discovery => "discovery",
            Domain::Scripts => "scripts",
            Domain::ScriptGroups => "script_groups",
            Domain::Ship => "ship",
            Domain::ShipRuns => "ship_runs",
            Domain::MissionTemplates => "mission_templates",
            Domain::Missions => "missions",
            Domain::MissionMessages => "mission_messages",
            Domain::MissionActivity => "mission_activity",
            Domain::Projects => "projects",
            Domain::Workspaces => "workspaces",
            Domain::ToolConfigs => "tool_configs",
            Domain::Settings => "settings",
            Domain::StoredPrompts => "stored_prompts",
            Domain::AgentDefinitions => "agent_definitions",
            Domain::Environments => "environments",
            Domain::Chat => "chat",
            Domain::Plugins => "plugins",
            Domain::PluginData => "plugin_data",
        }
    }

    pub fn parse(s: &str) -> Option<Domain> {
        Self::ALL.iter().copied().find(|d| d.as_str() == s)
    }

    pub const ALL: &'static [Domain] = &[
        Domain::ProjectConfig, Domain::Ideas, Domain::Issues, Domain::Epics, Domain::Labels,
        Domain::Plans, Domain::Discovery, Domain::Scripts, Domain::ScriptGroups, Domain::Ship,
        Domain::ShipRuns, Domain::MissionTemplates, Domain::Missions, Domain::MissionMessages,
        Domain::MissionActivity, Domain::Projects, Domain::Workspaces, Domain::ToolConfigs,
        Domain::Settings, Domain::StoredPrompts, Domain::AgentDefinitions, Domain::Environments,
        Domain::Chat, Domain::Plugins, Domain::PluginData,
    ];

    /// Domains stored in the project store (`.quadflow/`).
    pub const PROJECT: &'static [Domain] = &[
        Domain::ProjectConfig, Domain::Ideas, Domain::Issues, Domain::Epics, Domain::Labels,
        Domain::Plans, Domain::Discovery, Domain::Scripts, Domain::ScriptGroups, Domain::Ship,
        Domain::ShipRuns, Domain::MissionTemplates, Domain::Missions, Domain::MissionMessages,
        Domain::MissionActivity, Domain::PluginData,
    ];

    /// Collection directory (one `<id>.json` per entity) → domain.
    pub fn for_collection_dir(dir: &str) -> Option<Domain> {
        Some(match dir {
            "ideas" => Domain::Ideas,
            "issues" => Domain::Issues,
            "epics" => Domain::Epics,
            "plans" => Domain::Plans,
            "discovery" => Domain::Discovery,
            "scripts" => Domain::Scripts,
            "script-groups" => Domain::ScriptGroups,
            "mission-templates" => Domain::MissionTemplates,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
    Invalidated,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Created => "created",
            ChangeKind::Updated => "updated",
            ChangeKind::Deleted => "deleted",
            ChangeKind::Invalidated => "invalidated",
        }
    }
    pub fn parse(s: &str) -> Option<ChangeKind> {
        [ChangeKind::Created, ChangeKind::Updated, ChangeKind::Deleted, ChangeKind::Invalidated]
            .into_iter()
            .find(|k| k.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// Written by this process.
    Local,
    /// Seen by the watcher / written by another process.
    External,
}

pub type SubscriptionId = u64;
type Listener = Arc<dyn Fn(&ChangeEvent) + Send + Sync>;

/// Cheap-to-clone handle to the process-wide event bus.
#[derive(Clone, Default)]
pub struct EventBus {
    inner: Arc<BusInner>,
}

#[derive(Default)]
struct BusInner {
    seq: AtomicU64,
    next_sub: AtomicU64,
    subs: RwLock<Vec<(SubscriptionId, Listener)>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self, f: impl Fn(&ChangeEvent) + Send + Sync + 'static) -> SubscriptionId {
        let id = self.inner.next_sub.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner.subs.write().push((id, Arc::new(f)));
        id
    }

    pub fn unsubscribe(&self, id: SubscriptionId) {
        self.inner.subs.write().retain(|(sid, _)| *sid != id);
    }

    /// Publish an event; `seq` is (re)assigned here. Listeners run synchronously on
    /// the publishing thread, outside the bus lock.
    pub fn publish(&self, mut e: ChangeEvent) {
        e.seq = self.inner.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let subs: Vec<Listener> = self.inner.subs.read().iter().map(|(_, f)| f.clone()).collect();
        for f in subs {
            f(&e);
        }
    }

    /// Convenience constructor + publish.
    pub fn emit(&self, scope: ChangeScope, domain: Domain, kind: ChangeKind, ids: Vec<String>, origin: Origin) {
        self.publish(ChangeEvent { seq: 0, scope, domain, kind, ids, origin });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn bus_delivers_and_unsubscribes() {
        let bus = EventBus::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let id = bus.subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        bus.emit(ChangeScope::App, Domain::Settings, ChangeKind::Updated, vec!["k".into()], Origin::Local);
        bus.unsubscribe(id);
        bus.emit(ChangeScope::App, Domain::Settings, ChangeKind::Updated, vec![], Origin::Local);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].seq, 1);
    }

    #[test]
    fn event_wire_shape() {
        let e = ChangeEvent {
            seq: 3,
            scope: ChangeScope::Project { root_key: "c:/p".into() },
            domain: Domain::ScriptGroups,
            kind: ChangeKind::Updated,
            ids: vec!["x".into()],
            origin: Origin::External,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({"seq":3,"scope":{"type":"project","rootKey":"c:/p"},"domain":"script_groups",
                               "kind":"updated","ids":["x"],"origin":"external"})
        );
        for d in Domain::ALL {
            assert_eq!(serde_json::to_value(d).unwrap(), serde_json::json!(d.as_str()));
            assert_eq!(Domain::parse(d.as_str()), Some(*d));
        }
    }
}
