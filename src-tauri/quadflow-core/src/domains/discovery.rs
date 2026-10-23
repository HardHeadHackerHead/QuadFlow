//! Discovery — `discovery/<id>.json` (data-layer.md §6.5).
//!
//! Big-picture discovery containers (goals, success criteria, research,
//! requirements, open questions, references, decisions, notes). Items are
//! embedded. Ideas and plans link to a discovery project through their own
//! `discoveryId`; deleting a discovery project clears those links in the same
//! transaction. The UI may label this domain "Projects"; code, CLI and storage
//! never call it a project.

use crate::domains::ideas::Idea;
use crate::error::{CoreError, ErrorCode, Result};
use crate::events::Domain;
use crate::ids::{new_id, Id};
use crate::model::{Actor, CorruptEntry, Ext, ListResult, Timestamp};
use crate::store::{Entity, ProjectStore, RelPath};
use crate::time::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ------------------------------------------------------------------ model

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryProject {
    pub id: Id,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goals: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    pub status: DiscoveryStatus,
    /// Sorted by `order`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<DiscoveryItem>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for DiscoveryProject {
    const DOMAIN: Domain = Domain::Discovery;
    const DIR: &'static str = "discovery";
    fn id(&self) -> &Id {
        &self.id
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
pub enum DiscoveryStatus {
    #[default]
    Discovery,
    Planning,
    #[value(alias = "in-progress")]
    InProgress,
    Completed,
    Archived,
}

impl DiscoveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::Planning => "planning",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Archived => "archived",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryItem {
    pub id: Id,
    pub kind: DiscoveryItemKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Free-form, e.g. `pending`, `answered`, `must_have`, `nice_to_have`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub metadata: Option<serde_json::Value>,
    pub order: u32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryItemKind {
    Research,
    Requirement,
    Question,
    Reference,
    Decision,
    Note,
}

impl DiscoveryItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Research => "research",
            Self::Requirement => "requirement",
            Self::Question => "question",
            Self::Reference => "reference",
            Self::Decision => "decision",
            Self::Note => "note",
        }
    }
}

/// Filter for [`list`]. Empty query = every discovery project (archived included).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryQuery {
    /// Case-insensitive substring of the title or overview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DiscoveryStatus>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewDiscoveryProject {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goals: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub success_criteria: Vec<String>,
    /// Default `discovery`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DiscoveryStatus>,
}

/// Absent = unchanged; `overview: null` clears; lists replace (empty clears).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<String>)]
    pub overview: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goals: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_criteria: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<DiscoveryStatus>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewDiscoveryItem {
    pub kind: DiscoveryItemKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub metadata: Option<serde_json::Value>,
}

/// Absent = unchanged; `content` / `status` / `metadata: null` clear.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryItemPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<DiscoveryItemKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<String>)]
    pub content: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<String>)]
    pub status: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<crate::model::JsonValue>)]
    pub metadata: Option<Option<serde_json::Value>>,
}

/// A plan linked to a discovery project, as read from `plans/<id>.json`.
/// (A summary, not the full `Plan`: the plans domain is owned by DL-4.)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryLinkedPlan {
    pub id: Id,
    pub title: String,
    pub status: String,
    pub steps_total: u32,
    pub steps_completed: u32,
}

/// Everything that links to one discovery project (`linked`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryLinks {
    pub ideas: Vec<Idea>,
    pub plans: Vec<DiscoveryLinkedPlan>,
    /// Idea / plan files that could not be read.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<CorruptEntry>,
}

// ---------------------------------------------------------------- helpers

fn clean_title(what: &str, t: &str) -> Result<String> {
    let t = t.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input(format!("{what} must not be empty")));
    }
    Ok(t.to_string())
}

/// Trim; empty → `None`.
fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Trim each entry, drop empty ones.
fn clean_list(v: Vec<String>) -> Vec<String> {
    v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn not_found(id: &Id) -> CoreError {
    CoreError::not_found(format!("discovery project {id} not found"))
}

fn map_nf(id: &Id) -> impl FnOnce(CoreError) -> CoreError + '_ {
    move |e| if e.code == ErrorCode::NotFound { not_found(id) } else { e }
}

fn modify(
    s: &ProjectStore,
    actor: &Actor,
    id: &Id,
    f: impl FnOnce(&mut DiscoveryProject) -> Result<()>,
) -> Result<DiscoveryProject> {
    s.write(actor, |tx| {
        let mut p: DiscoveryProject = tx.get(id).map_err(map_nf(id))?;
        f(&mut p)?;
        p.updated_at = now_ms();
        tx.put(&p)?;
        Ok(p)
    })
}

fn item_mut<'a>(p: &'a mut DiscoveryProject, item_id: &Id) -> Result<&'a mut DiscoveryItem> {
    let pid = p.id.clone();
    p.items
        .iter_mut()
        .find(|i| &i.id == item_id)
        .ok_or_else(|| CoreError::not_found(format!("item {item_id} not found on discovery project {pid}")))
}

/// Renumber `order` 0..n in the current vector order.
fn renumber(items: &mut [DiscoveryItem]) {
    for (n, i) in items.iter_mut().enumerate() {
        i.order = n as u32;
    }
}

// --------------------------------------------------------------- services

/// Matching discovery projects, **newest first**. Unreadable files are reported in `errors`.
pub fn list(s: &ProjectStore, q: &DiscoveryQuery) -> Result<ListResult<DiscoveryProject>> {
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
    let mut r = s.list::<DiscoveryProject>()?;
    r.items.retain(|p| {
        if q.status.is_some_and(|st| p.status != st) {
            return false;
        }
        if let Some(t) = &text {
            let hit = p.title.to_lowercase().contains(t)
                || p.overview.as_deref().is_some_and(|o| o.to_lowercase().contains(t));
            if !hit {
                return false;
            }
        }
        true
    });
    r.items.reverse();
    Ok(r)
}

pub fn get(s: &ProjectStore, id: &Id) -> Result<DiscoveryProject> {
    s.get(id).map_err(map_nf(id))
}

pub fn create(s: &ProjectStore, actor: &Actor, new: NewDiscoveryProject) -> Result<DiscoveryProject> {
    let title = clean_title("title", &new.title)?;
    let now = now_ms();
    let p = DiscoveryProject {
        id: new_id(),
        title,
        overview: clean_opt(new.overview),
        goals: clean_list(new.goals),
        success_criteria: clean_list(new.success_criteria),
        status: new.status.unwrap_or_default(),
        items: Vec::new(),
        created_at: now,
        created_by: actor.clone(),
        updated_at: now,
        ext: Ext::new(),
    };
    s.write(actor, |tx| tx.put(&p))?;
    Ok(p)
}

pub fn update(s: &ProjectStore, actor: &Actor, id: &Id, patch: DiscoveryPatch) -> Result<DiscoveryProject> {
    let title = patch.title.as_deref().map(|t| clean_title("title", t)).transpose()?;
    modify(s, actor, id, |p| {
        if let Some(t) = title {
            p.title = t;
        }
        if let Some(o) = patch.overview {
            p.overview = clean_opt(o);
        }
        if let Some(g) = patch.goals {
            p.goals = clean_list(g);
        }
        if let Some(c) = patch.success_criteria {
            p.success_criteria = clean_list(c);
        }
        if let Some(st) = patch.status {
            p.status = st;
        }
        Ok(())
    })
}

/// Delete the discovery project and clear `discoveryId` on every idea and plan
/// that pointed at it — one transaction. Unreadable idea/plan files are left
/// untouched (a dangling link is harmless; overwriting them is not).
pub fn delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    s.write(actor, |tx| {
        tx.delete::<DiscoveryProject>(id).map_err(map_nf(id))?;
        let now = now_ms();
        for mut idea in tx.list::<Idea>()?.items {
            if idea.discovery_id.as_ref() == Some(id) {
                idea.discovery_id = None;
                idea.updated_at = now;
                tx.put(&idea)?;
            }
        }
        for (rel, mut plan) in raw_plans(tx.store())?.0 {
            if plan.get("discoveryId").and_then(|v| v.as_str()) == Some(id.as_str()) {
                if let Some(obj) = plan.as_object_mut() {
                    obj.remove("discoveryId");
                    obj.insert("updatedAt".into(), now.into());
                }
                tx.put_json(&rel, &plan)?;
            }
        }
        Ok(())
    })
}

pub fn item_add(s: &ProjectStore, actor: &Actor, id: &Id, new: NewDiscoveryItem) -> Result<DiscoveryProject> {
    let title = clean_title("item title", &new.title)?;
    modify(s, actor, id, |p| {
        let now = now_ms();
        let order = p.items.iter().map(|i| i.order + 1).max().unwrap_or(0);
        p.items.push(DiscoveryItem {
            id: new_id(),
            kind: new.kind,
            title,
            content: clean_opt(new.content),
            status: clean_opt(new.status),
            metadata: new.metadata.filter(|m| !m.is_null()),
            order,
            created_at: now,
            updated_at: now,
        });
        Ok(())
    })
}

pub fn item_update(
    s: &ProjectStore,
    actor: &Actor,
    id: &Id,
    item_id: &Id,
    patch: DiscoveryItemPatch,
) -> Result<DiscoveryProject> {
    let title = patch.title.as_deref().map(|t| clean_title("item title", t)).transpose()?;
    modify(s, actor, id, |p| {
        let it = item_mut(p, item_id)?;
        if let Some(k) = patch.kind {
            it.kind = k;
        }
        if let Some(t) = title {
            it.title = t;
        }
        if let Some(c) = patch.content {
            it.content = clean_opt(c);
        }
        if let Some(st) = patch.status {
            it.status = clean_opt(st);
        }
        if let Some(m) = patch.metadata {
            it.metadata = m.filter(|m| !m.is_null());
        }
        it.updated_at = now_ms();
        Ok(())
    })
}

pub fn item_delete(s: &ProjectStore, actor: &Actor, id: &Id, item_id: &Id) -> Result<DiscoveryProject> {
    modify(s, actor, id, |p| {
        item_mut(p, item_id)?;
        p.items.retain(|i| &i.id != item_id);
        renumber(&mut p.items);
        Ok(())
    })
}

/// `item_ids` first, in the given order; items not listed keep their relative
/// order after them. Every listed id must exist on the project.
pub fn items_reorder(s: &ProjectStore, actor: &Actor, id: &Id, item_ids: &[Id]) -> Result<DiscoveryProject> {
    modify(s, actor, id, |p| {
        let mut rest = std::mem::take(&mut p.items);
        let mut ordered = Vec::with_capacity(rest.len());
        for iid in item_ids {
            match rest.iter().position(|i| &i.id == iid) {
                Some(pos) => ordered.push(rest.remove(pos)),
                None if ordered.iter().any(|i: &DiscoveryItem| &i.id == iid) => {}
                None => {
                    // Nothing is written on Err.
                    return Err(CoreError::not_found(format!("item {iid} not found on discovery project {}", p.id)));
                }
            }
        }
        ordered.extend(rest);
        let now = now_ms();
        for (n, i) in ordered.iter_mut().enumerate() {
            if i.order != n as u32 {
                i.order = n as u32;
                i.updated_at = now;
            }
        }
        p.items = ordered;
        Ok(())
    })
}

/// Ideas (newest first) and plans (by id) whose `discoveryId` is `id`.
pub fn linked(s: &ProjectStore, id: &Id) -> Result<DiscoveryLinks> {
    get(s, id)?;
    let ideas = s.list::<Idea>()?;
    let mut out = DiscoveryLinks { errors: ideas.errors, ..Default::default() };
    out.ideas = ideas.items.into_iter().filter(|i| i.discovery_id.as_ref() == Some(id)).rev().collect();
    let (plans, errors) = raw_plans(s)?;
    out.errors.extend(errors);
    for (_, plan) in plans {
        if plan.get("discoveryId").and_then(|v| v.as_str()) != Some(id.as_str()) {
            continue;
        }
        let Some(pid) = plan.get("id").and_then(|v| v.as_str()).and_then(|v| Id::parse(v).ok()) else { continue };
        let steps: &[serde_json::Value] = plan.get("steps").and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or(&[]);
        out.plans.push(DiscoveryLinkedPlan {
            id: pid,
            title: plan.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            status: plan.get("status").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            steps_total: steps.len() as u32,
            steps_completed: steps
                .iter()
                .filter(|st| st.get("status").and_then(|v| v.as_str()) == Some("completed"))
                .count() as u32,
        });
    }
    Ok(out)
}

/// Every `plans/<id>.json` as raw JSON (the plans schema belongs to DL-4; only
/// `id`, `title`, `status`, `steps[].status` and `discoveryId` are read here, and
/// a rewrite preserves every other field). Unparseable files go to the errors list.
fn raw_plans(s: &ProjectStore) -> Result<(Vec<(RelPath, serde_json::Value)>, Vec<CorruptEntry>)> {
    let dir = s.data_dir().join("plans");
    let mut items = Vec::new();
    let mut errors = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((items, errors)),
        Err(e) => return Err(CoreError::io(&dir, e)),
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| CoreError::io(&dir, e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(stem) = name.strip_suffix(".json") {
            if Id::parse(stem).is_ok() && entry.path().is_file() {
                names.push(name);
            }
        }
    }
    names.sort();
    for name in names {
        let rel = RelPath::new(format!("plans/{name}"))?;
        match s.read_json::<serde_json::Value>(&rel) {
            Ok(Some(v)) if v.is_object() => items.push((rel, v)),
            Ok(Some(_)) => errors.push(CorruptEntry {
                path: dir.join(&name).display().to_string(),
                message: "not a JSON object".into(),
            }),
            Ok(None) => {}
            Err(e) => errors.push(CorruptEntry { path: dir.join(&name).display().to_string(), message: e.message }),
        }
    }
    Ok((items, errors))
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::ideas::{self, IdeaPatch, NewIdea};
    use crate::events::{ChangeEvent, ChangeKind};
    use crate::testing::TempProject;
    use std::sync::{Arc, Mutex};

    fn actor() -> Actor {
        Actor::human("tester")
    }

    fn mk(tp: &TempProject, title: &str) -> DiscoveryProject {
        create(&tp.store, &actor(), NewDiscoveryProject { title: title.into(), ..Default::default() }).unwrap()
    }

    fn item(kind: DiscoveryItemKind, title: &str) -> NewDiscoveryItem {
        NewDiscoveryItem { kind, title: title.into(), content: None, status: None, metadata: None }
    }

    fn record(tp: &TempProject) -> Arc<Mutex<Vec<ChangeEvent>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        tp.store.bus().subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        seen
    }

    #[test]
    fn create_get_list_round_trip() {
        let tp = TempProject::new();
        let seen = record(&tp);
        let a = create(
            &tp.store,
            &actor(),
            NewDiscoveryProject {
                title: "  Mobile app ".into(),
                overview: Some("  ".into()),
                goals: vec!["ship".into(), " ".into()],
                success_criteria: vec!["1k users".into()],
                status: None,
            },
        )
        .unwrap();
        assert_eq!(a.title, "Mobile app");
        assert_eq!(a.overview, None);
        assert_eq!(a.goals, vec!["ship"]);
        assert_eq!(a.status, DiscoveryStatus::Discovery);
        assert_eq!(get(&tp.store, &a.id).unwrap(), a);
        let b = mk(&tp, "Second");
        let l = list(&tp.store, &DiscoveryQuery::default()).unwrap();
        assert_eq!(l.items.iter().map(|p| &p.id).collect::<Vec<_>>(), vec![&b.id, &a.id], "newest first");

        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(tp.store.data_dir().join("discovery").join(format!("{}.json", a.id))).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["successCriteria"][0], "1k users");
        assert_eq!(raw["status"], "discovery");

        let ev = seen.lock().unwrap();
        assert_eq!(ev.len(), 2);
        assert!(ev.iter().all(|e| e.domain == Domain::Discovery && e.kind == ChangeKind::Created));
    }

    #[test]
    fn validation_and_not_found() {
        let tp = TempProject::new();
        let e = create(&tp.store, &actor(), NewDiscoveryProject { title: " ".into(), ..Default::default() }).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let missing = new_id();
        assert_eq!(get(&tp.store, &missing).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(delete(&tp.store, &actor(), &missing).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(linked(&tp.store, &missing).unwrap_err().code, ErrorCode::NotFound);
        let p = mk(&tp, "p");
        assert_eq!(
            item_add(&tp.store, &actor(), &p.id, item(DiscoveryItemKind::Note, "")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            item_delete(&tp.store, &actor(), &p.id, &new_id()).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn patch_set_and_clear_and_filters() {
        let tp = TempProject::new();
        let p = mk(&tp, "Alpha");
        let u = update(
            &tp.store,
            &actor(),
            &p.id,
            DiscoveryPatch {
                title: Some("Beta".into()),
                overview: Some(Some("An overview".into())),
                goals: Some(vec!["g1".into(), "g2".into()]),
                success_criteria: Some(vec!["c".into()]),
                status: Some(DiscoveryStatus::Planning),
            },
        )
        .unwrap();
        assert_eq!((u.title.as_str(), u.overview.as_deref(), u.goals.len(), u.status), ("Beta", Some("An overview"), 2, DiscoveryStatus::Planning));
        let patch: DiscoveryPatch = serde_json::from_str(r#"{"overview":null,"goals":[]}"#).unwrap();
        let u = update(&tp.store, &actor(), &p.id, patch).unwrap();
        assert_eq!(u.overview, None);
        assert!(u.goals.is_empty());
        assert_eq!(u.success_criteria, vec!["c"], "absent = unchanged");

        mk(&tp, "Gamma");
        let ids = |q: DiscoveryQuery| list(&tp.store, &q).unwrap().items.into_iter().map(|p| p.title).collect::<Vec<_>>();
        assert_eq!(ids(DiscoveryQuery { status: Some(DiscoveryStatus::Planning), ..Default::default() }), vec!["Beta"]);
        assert_eq!(ids(DiscoveryQuery { text: Some("GAM".into()), ..Default::default() }), vec!["Gamma"]);
    }

    #[test]
    fn items_add_update_delete_reorder() {
        let tp = TempProject::new();
        let p = mk(&tp, "p");
        let p1 = item_add(&tp.store, &actor(), &p.id, item(DiscoveryItemKind::Research, "r1")).unwrap();
        let p2 = item_add(
            &tp.store,
            &actor(),
            &p.id,
            NewDiscoveryItem {
                kind: DiscoveryItemKind::Reference,
                title: "docs".into(),
                content: Some("see link".into()),
                status: Some("pending".into()),
                metadata: Some(serde_json::json!({"url": "https://example.com"})),
            },
        )
        .unwrap();
        let p3 = item_add(&tp.store, &actor(), &p.id, item(DiscoveryItemKind::Question, "q")).unwrap();
        assert_eq!(p1.items.len(), 1);
        let (a, b, c) = (p3.items[0].id.clone(), p3.items[1].id.clone(), p3.items[2].id.clone());
        assert_eq!(p3.items.iter().map(|i| i.order).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(p2.items[1].metadata.as_ref().unwrap()["url"], "https://example.com");

        let patch: DiscoveryItemPatch = serde_json::from_str(r#"{"status":"answered","content":null,"metadata":null}"#).unwrap();
        let u = item_update(&tp.store, &actor(), &p.id, &b, patch).unwrap();
        let it = u.items.iter().find(|i| i.id == b).unwrap();
        assert_eq!((it.status.as_deref(), it.content.as_deref(), it.metadata.is_none(), it.title.as_str()), (Some("answered"), None, true, "docs"));

        let r = items_reorder(&tp.store, &actor(), &p.id, &[c.clone(), a.clone()]).unwrap();
        assert_eq!(r.items.iter().map(|i| &i.id).collect::<Vec<_>>(), vec![&c, &a, &b]);
        assert_eq!(r.items.iter().map(|i| i.order).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert_eq!(items_reorder(&tp.store, &actor(), &p.id, &[new_id()]).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(get(&tp.store, &p.id).unwrap().items[0].id, c, "failed reorder writes nothing");

        let d = item_delete(&tp.store, &actor(), &p.id, &a).unwrap();
        assert_eq!(d.items.iter().map(|i| (&i.id, i.order)).collect::<Vec<_>>(), vec![(&c, 0), (&b, 1)]);
    }

    #[test]
    fn delete_clears_links_and_linked_lists_them() {
        let tp = TempProject::new();
        let p = mk(&tp, "p");
        let other = mk(&tp, "other");
        let i1 = ideas::create(&tp.store, &actor(), NewIdea { content: "one".into(), tags: vec![], discovery_id: Some(p.id.clone()) }).unwrap();
        let i2 = ideas::create(&tp.store, &actor(), NewIdea { content: "two".into(), tags: vec![], discovery_id: Some(other.id.clone()) }).unwrap();
        let i3 = ideas::create(&tp.store, &actor(), NewIdea { content: "three".into(), ..Default::default() }).unwrap();
        ideas::update(&tp.store, &actor(), &i3.id, IdeaPatch { discovery_id: Some(Some(p.id.clone())), ..Default::default() }).unwrap();

        // A plan file in the DL-4 shape (only the fields read here matter).
        let plan_id = new_id();
        let plan_path = tp.store.data_dir().join("plans").join(format!("{plan_id}.json"));
        std::fs::create_dir_all(plan_path.parent().unwrap()).unwrap();
        let plan = serde_json::json!({
            "id": plan_id, "title": "Plan A", "status": "executing", "discoveryId": p.id,
            "steps": [{"status": "completed"}, {"status": "pending"}], "extra": {"keep": true}
        });
        std::fs::write(&plan_path, serde_json::to_string(&plan).unwrap()).unwrap();

        let l = linked(&tp.store, &p.id).unwrap();
        assert_eq!(l.ideas.iter().map(|i| &i.id).collect::<Vec<_>>(), vec![&i3.id, &i1.id]);
        assert_eq!(l.plans, vec![DiscoveryLinkedPlan { id: plan_id.clone(), title: "Plan A".into(), status: "executing".into(), steps_total: 2, steps_completed: 1 }]);
        assert!(l.errors.is_empty());

        let seen = record(&tp);
        delete(&tp.store, &actor(), &p.id).unwrap();
        assert_eq!(get(&tp.store, &p.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(ideas::get(&tp.store, &i1.id).unwrap().discovery_id, None);
        assert_eq!(ideas::get(&tp.store, &i3.id).unwrap().discovery_id, None);
        assert_eq!(ideas::get(&tp.store, &i2.id).unwrap().discovery_id, Some(other.id.clone()), "other links kept");
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&plan_path).unwrap()).unwrap();
        assert!(raw.get("discoveryId").is_none());
        assert_eq!(raw["extra"]["keep"], true, "plan rewrite preserves unknown fields");
        let ev = seen.lock().unwrap();
        assert!(ev.iter().any(|e| e.domain == Domain::Discovery && e.kind == ChangeKind::Deleted));
        assert!(ev.iter().any(|e| e.domain == Domain::Ideas && e.kind == ChangeKind::Updated && e.ids.len() == 2));
        assert!(ev.iter().any(|e| e.domain == Domain::Plans && e.kind == ChangeKind::Updated));
    }

    #[test]
    fn corrupt_file_listed_and_never_overwritten() {
        let tp = TempProject::new();
        mk(&tp, "good");
        let bad = new_id();
        let path = tp.store.data_dir().join("discovery").join(format!("{bad}.json"));
        std::fs::write(&path, "{ nope").unwrap();
        let l = list(&tp.store, &DiscoveryQuery::default()).unwrap();
        assert_eq!((l.items.len(), l.errors.len()), (1, 1));
        assert_eq!(get(&tp.store, &bad).unwrap_err().code, ErrorCode::Corrupt);
        assert_eq!(
            item_add(&tp.store, &actor(), &bad, item(DiscoveryItemKind::Note, "x")).unwrap_err().code,
            ErrorCode::Corrupt
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
    }
}
