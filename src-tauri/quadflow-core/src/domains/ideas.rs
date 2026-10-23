//! Ideas — `ideas/<id>.json` (data-layer.md §6.2).
//!
//! One JSON file per idea. Suggestions and notes are embedded. Every mutation
//! is a locked read-modify-write through [`ProjectStore::write`]; every service
//! publishes one `ideas` change event per kind per transaction.

use crate::error::{CoreError, Result};
use crate::events::Domain;
use crate::ids::{new_id, Id};
use crate::model::{Actor, CorruptEntry, Ext, ListResult, Timestamp};
use crate::store::{Entity, ProjectStore, Tx};
use crate::time::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

// ------------------------------------------------------------------ model

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Idea {
    pub id: Id,
    pub content: String,
    /// The text at creation; `revert` restores it. Never modified afterwards.
    pub original_content: String,
    /// Lowercase, unique, sorted.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggestions: Vec<IdeaSuggestion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<IdeaNote>,
    pub created_at: Timestamp,
    pub created_by: Actor,
    pub updated_at: Timestamp,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[specta(type = BTreeMap<String, crate::model::JsonValue>)]
    pub ext: Ext,
}

impl Entity for Idea {
    const DOMAIN: Domain = Domain::Ideas;
    const DIR: &'static str = "ideas";
    fn id(&self) -> &Id {
        &self.id
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeaSuggestion {
    pub id: Id,
    pub kind: SuggestionKind,
    pub text: String,
    /// `null` = pending, `true` = accepted, `false` = rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted: Option<bool>,
    pub created_at: Timestamp,
    pub created_by: Actor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionKind {
    Reword,
    Expand,
    Clarify,
    Summarize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeaNote {
    pub id: Id,
    pub body: String,
    pub created_at: Timestamp,
    pub created_by: Actor,
}

/// Filter for [`list`]. Empty query = every non-archived idea.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeaQuery {
    /// Case-insensitive substring of the content or of a tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The idea must carry **all** of these tags.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default)]
    pub include_archived: bool,
    /// `createdAt >= from` (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Timestamp>,
    /// `createdAt <= to` (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewIdea {
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discovery_id: Option<Id>,
}

/// Absent = unchanged; `discoveryId: null` clears the link.
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeaPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "::serde_with::rust::double_option")]
    #[specta(type = Option<Id>)]
    pub discovery_id: Option<Option<Id>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdeaStats {
    pub total: u32,
    pub active: u32,
    pub archived: u32,
    pub by_tag: BTreeMap<String, u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Json,
    Markdown,
    Csv,
}

// ---------------------------------------------------------------- helpers

/// Lowercase + trim; rejects empty tags and tags containing `,` (the CLI list separator).
pub fn normalize_tag(tag: &str) -> Result<String> {
    let t = tag.trim().to_lowercase();
    if t.is_empty() {
        return Err(CoreError::invalid_input("tag must not be empty"));
    }
    if t.contains(',') {
        return Err(CoreError::invalid_input(format!("invalid tag {tag:?}: must not contain ','")));
    }
    Ok(t)
}

/// Normalize, dedupe and sort.
pub fn normalize_tags<S: AsRef<str>>(tags: &[S]) -> Result<Vec<String>> {
    let mut set = BTreeSet::new();
    for t in tags {
        set.insert(normalize_tag(t.as_ref())?);
    }
    Ok(set.into_iter().collect())
}

fn clean_content(content: &str) -> Result<String> {
    let c = content.trim();
    if c.is_empty() {
        return Err(CoreError::invalid_input("idea content must not be empty"));
    }
    Ok(c.to_string())
}

fn clean_text(what: &str, text: &str) -> Result<String> {
    let t = text.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input(format!("{what} must not be empty")));
    }
    Ok(t.to_string())
}

fn not_found_idea(id: &Id) -> CoreError {
    CoreError::not_found(format!("idea {id} not found"))
}

/// Read-modify-write one idea inside a transaction; sets `updatedAt`.
fn modify_in_tx(tx: &mut Tx, id: &Id, f: impl FnOnce(&mut Idea, &Actor) -> Result<()>) -> Result<Idea> {
    let mut idea: Idea = tx.get(id).map_err(|e| if e.code == crate::ErrorCode::NotFound { not_found_idea(id) } else { e })?;
    let actor = tx.actor().clone();
    f(&mut idea, &actor)?;
    idea.updated_at = now_ms();
    tx.put(&idea)?;
    Ok(idea)
}

fn modify(s: &ProjectStore, actor: &Actor, id: &Id, f: impl FnOnce(&mut Idea, &Actor) -> Result<()>) -> Result<Idea> {
    s.write(actor, |tx| modify_in_tx(tx, id, f))
}

fn matches(idea: &Idea, q: &IdeaQuery, text: Option<&str>, tags: &[String]) -> bool {
    if idea.archived && !q.include_archived {
        return false;
    }
    if let Some(t) = text {
        if !idea.content.to_lowercase().contains(t) && !idea.tags.iter().any(|g| g.contains(t)) {
            return false;
        }
    }
    if !tags.iter().all(|t| idea.tags.contains(t)) {
        return false;
    }
    if q.from.is_some_and(|f| idea.created_at < f) || q.to.is_some_and(|t| idea.created_at > t) {
        return false;
    }
    if q.discovery_id.as_ref().is_some_and(|d| idea.discovery_id.as_ref() != Some(d)) {
        return false;
    }
    true
}

// --------------------------------------------------------------- services

/// Matching ideas, **newest first**. Unreadable files are reported in `errors`.
pub fn list(s: &ProjectStore, q: &IdeaQuery) -> Result<ListResult<Idea>> {
    let text = q.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
    let tags = normalize_tags(&q.tags)?;
    let mut r = s.list::<Idea>()?;
    r.items.retain(|i| matches(i, q, text.as_deref(), &tags));
    r.items.reverse();
    Ok(r)
}

pub fn get(s: &ProjectStore, id: &Id) -> Result<Idea> {
    s.get(id).map_err(|e| if e.code == crate::ErrorCode::NotFound { not_found_idea(id) } else { e })
}

pub fn create(s: &ProjectStore, actor: &Actor, new: NewIdea) -> Result<Idea> {
    let content = clean_content(&new.content)?;
    let tags = normalize_tags(&new.tags)?;
    let now = now_ms();
    let idea = Idea {
        id: new_id(),
        original_content: content.clone(),
        content,
        tags,
        archived: false,
        discovery_id: new.discovery_id,
        suggestions: Vec::new(),
        notes: Vec::new(),
        created_at: now,
        created_by: actor.clone(),
        updated_at: now,
        ext: Ext::new(),
    };
    s.write(actor, |tx| tx.put(&idea))?;
    Ok(idea)
}

pub fn update(s: &ProjectStore, actor: &Actor, id: &Id, patch: IdeaPatch) -> Result<Idea> {
    let content = patch.content.as_deref().map(clean_content).transpose()?;
    let tags = patch.tags.as_deref().map(normalize_tags).transpose()?;
    modify(s, actor, id, |idea, _| {
        if let Some(c) = content {
            idea.content = c;
        }
        if let Some(t) = tags {
            idea.tags = t;
        }
        if let Some(a) = patch.archived {
            idea.archived = a;
        }
        if let Some(d) = patch.discovery_id {
            idea.discovery_id = d;
        }
        Ok(())
    })
}

pub fn delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    s.write(actor, |tx| {
        tx.delete::<Idea>(id).map_err(|e| if e.code == crate::ErrorCode::NotFound { not_found_idea(id) } else { e })
    })
}

pub fn add_tag(s: &ProjectStore, actor: &Actor, id: &Id, tag: &str) -> Result<Idea> {
    let tag = normalize_tag(tag)?;
    modify(s, actor, id, |idea, _| {
        if let Err(pos) = idea.tags.binary_search(&tag) {
            idea.tags.insert(pos, tag);
        }
        Ok(())
    })
}

pub fn remove_tag(s: &ProjectStore, actor: &Actor, id: &Id, tag: &str) -> Result<Idea> {
    let tag = normalize_tag(tag)?;
    modify(s, actor, id, |idea, _| {
        idea.tags.retain(|t| t != &tag);
        Ok(())
    })
}

/// Add `tag` to every idea in `ids` in one transaction (all or nothing on a missing id).
pub fn bulk_tag(s: &ProjectStore, actor: &Actor, ids: &[Id], tag: &str) -> Result<Vec<Idea>> {
    let tag = normalize_tag(tag)?;
    if ids.is_empty() {
        return Err(CoreError::invalid_input("no idea ids given"));
    }
    let unique: BTreeSet<&Id> = ids.iter().collect();
    s.write(actor, |tx| {
        // Validate every id first so a missing one writes nothing.
        let mut ideas = Vec::with_capacity(unique.len());
        for id in &unique {
            ideas.push(tx.get::<Idea>(id).map_err(|e| if e.code == crate::ErrorCode::NotFound { not_found_idea(id) } else { e })?);
        }
        let now = now_ms();
        for idea in &mut ideas {
            if let Err(pos) = idea.tags.binary_search(&tag) {
                idea.tags.insert(pos, tag.clone());
                idea.updated_at = now;
                tx.put(&*idea)?;
            }
        }
        Ok(ideas)
    })
}

/// Merge `ids` into `keep`: `keep`'s content followed by the others' (in the
/// order given, separated by a blank line), tags and notes unioned, the others
/// deleted. `keep` must be one of `ids`; at least two distinct ids.
pub fn merge(s: &ProjectStore, actor: &Actor, ids: &[Id], keep: &Id) -> Result<Idea> {
    let mut order: Vec<&Id> = Vec::new();
    for id in ids {
        if !order.contains(&id) {
            order.push(id);
        }
    }
    if !order.contains(&keep) {
        return Err(CoreError::invalid_input(format!("keep id {keep} is not in the list of ideas to merge")));
    }
    if order.len() < 2 {
        return Err(CoreError::invalid_input("merge needs at least two distinct ideas"));
    }
    s.write(actor, |tx| {
        let load = |tx: &Tx, id: &Id| {
            tx.get::<Idea>(id).map_err(|e| if e.code == crate::ErrorCode::NotFound { not_found_idea(id) } else { e })
        };
        let mut target = load(tx, keep)?;
        let others: Vec<Idea> = order.iter().filter(|id| **id != keep).map(|id| load(tx, id)).collect::<Result<_>>()?;
        let mut tags: BTreeSet<String> = target.tags.iter().cloned().collect();
        for o in &others {
            target.content.push_str("\n\n");
            target.content.push_str(&o.content);
            tags.extend(o.tags.iter().cloned());
            target.notes.extend(o.notes.iter().cloned());
            if target.discovery_id.is_none() {
                target.discovery_id = o.discovery_id.clone();
            }
        }
        target.tags = tags.into_iter().collect();
        target.notes.sort_by(|a, b| a.id.cmp(&b.id));
        target.updated_at = now_ms();
        // Write the survivor first: a failure midway leaves duplicates, never lost content.
        tx.put(&target)?;
        for o in &others {
            tx.delete::<Idea>(&o.id)?;
        }
        Ok(target)
    })
}

pub fn add_note(s: &ProjectStore, actor: &Actor, id: &Id, body: &str) -> Result<Idea> {
    let body = clean_text("note body", body)?;
    modify(s, actor, id, |idea, actor| {
        idea.notes.push(IdeaNote { id: new_id(), body, created_at: now_ms(), created_by: actor.clone() });
        Ok(())
    })
}

pub fn delete_note(s: &ProjectStore, actor: &Actor, id: &Id, note_id: &Id) -> Result<Idea> {
    modify(s, actor, id, |idea, _| {
        let before = idea.notes.len();
        idea.notes.retain(|n| &n.id != note_id);
        if idea.notes.len() == before {
            return Err(CoreError::not_found(format!("note {note_id} not found on idea {}", idea.id)));
        }
        Ok(())
    })
}

pub fn add_suggestion(s: &ProjectStore, actor: &Actor, id: &Id, kind: SuggestionKind, text: &str) -> Result<Idea> {
    let text = clean_text("suggestion text", text)?;
    modify(s, actor, id, |idea, actor| {
        idea.suggestions.push(IdeaSuggestion {
            id: new_id(),
            kind,
            text,
            accepted: None,
            created_at: now_ms(),
            created_by: actor.clone(),
        });
        Ok(())
    })
}

/// Accept (content = suggestion text) or reject a pending suggestion.
/// Resolving an already-resolved suggestion is a `conflict`.
pub fn resolve_suggestion(s: &ProjectStore, actor: &Actor, id: &Id, suggestion_id: &Id, accept: bool) -> Result<Idea> {
    modify(s, actor, id, |idea, _| {
        let sug = idea
            .suggestions
            .iter_mut()
            .find(|x| &x.id == suggestion_id)
            .ok_or_else(|| CoreError::not_found(format!("suggestion {suggestion_id} not found on idea {id}")))?;
        if sug.accepted.is_some() {
            return Err(CoreError::conflict(format!("suggestion {suggestion_id} is already resolved")));
        }
        sug.accepted = Some(accept);
        if accept {
            idea.content = sug.text.clone();
        }
        Ok(())
    })
}

/// Remove a suggestion (pending or resolved). Not in data-layer.md §6.2; see §14 (DL-2).
pub fn delete_suggestion(s: &ProjectStore, actor: &Actor, id: &Id, suggestion_id: &Id) -> Result<Idea> {
    modify(s, actor, id, |idea, _| {
        let before = idea.suggestions.len();
        idea.suggestions.retain(|x| &x.id != suggestion_id);
        if idea.suggestions.len() == before {
            return Err(CoreError::not_found(format!("suggestion {suggestion_id} not found on idea {}", idea.id)));
        }
        Ok(())
    })
}

/// `content = originalContent`.
pub fn revert(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<Idea> {
    modify(s, actor, id, |idea, _| {
        idea.content = idea.original_content.clone();
        Ok(())
    })
}

/// Counts over every readable idea (archived included in `total` and `byTag`).
pub fn stats(s: &ProjectStore) -> Result<IdeaStats> {
    Ok(stats_report(s)?.0)
}

/// [`stats`] plus the files that could not be read (CLI warnings).
pub fn stats_report(s: &ProjectStore) -> Result<(IdeaStats, Vec<CorruptEntry>)> {
    let r = s.list::<Idea>()?;
    let mut st = IdeaStats::default();
    for i in &r.items {
        st.total += 1;
        if i.archived {
            st.archived += 1;
        } else {
            st.active += 1;
        }
        for t in &i.tags {
            *st.by_tag.entry(t.clone()).or_insert(0) += 1;
        }
    }
    Ok((st, r.errors))
}

/// Every readable idea (archived included), oldest first.
pub fn export(s: &ProjectStore, format: ExportFormat) -> Result<String> {
    Ok(export_report(s, format)?.0)
}

/// [`export`] plus the files that could not be read (CLI warnings).
pub fn export_report(s: &ProjectStore, format: ExportFormat) -> Result<(String, Vec<CorruptEntry>)> {
    let r = s.list::<Idea>()?;
    let text = match format {
        ExportFormat::Json => serde_json::to_string_pretty(&r.items)
            .map_err(|e| CoreError::internal(format!("encode JSON: {e}")))?,
        ExportFormat::Markdown => {
            let mut md = String::from("# Ideas\n");
            for i in &r.items {
                let _ = write!(md, "\n## {}\n\n", i.id);
                if !i.tags.is_empty() {
                    let _ = writeln!(md, "Tags: {}", i.tags.join(", "));
                }
                if i.archived {
                    md.push_str("Archived: yes\n");
                }
                let _ = writeln!(md, "Created: {}\n", fmt_ts(i.created_at));
                md.push_str(&i.content);
                md.push('\n');
                if !i.notes.is_empty() {
                    md.push_str("\n### Notes\n\n");
                    for n in &i.notes {
                        let _ = writeln!(md, "- {} ({}): {}", n.created_by.name, fmt_ts(n.created_at), n.body.replace('\n', " "));
                    }
                }
            }
            md
        }
        ExportFormat::Csv => {
            let mut csv = String::from("id,content,tags,archived,createdAt,updatedAt\n");
            for i in &r.items {
                let _ = writeln!(
                    csv,
                    "{},{},{},{},{},{}",
                    i.id,
                    csv_field(&i.content),
                    csv_field(&i.tags.join(";")),
                    i.archived,
                    i.created_at,
                    i.updated_at
                );
            }
            csv
        }
    };
    Ok((text, r.errors))
}

fn fmt_ts(ms: Timestamp) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| ms.to_string())
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::{ChangeEvent, ChangeKind};
    use crate::testing::TempProject;
    use std::sync::{Arc, Mutex};

    fn actor() -> Actor {
        Actor::human("tester")
    }

    fn mk(tp: &TempProject, content: &str, tags: &[&str]) -> Idea {
        create(
            &tp.store,
            &actor(),
            NewIdea { content: content.into(), tags: tags.iter().map(|t| t.to_string()).collect(), discovery_id: None },
        )
        .unwrap()
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
        let a = mk(&tp, "  first idea  ", &["UI", "ui", " backend "]);
        assert_eq!(a.content, "first idea");
        assert_eq!(a.original_content, "first idea");
        assert_eq!(a.tags, vec!["backend", "ui"]);
        assert_eq!(a.created_by, actor());
        assert_eq!(get(&tp.store, &a.id).unwrap(), a);

        let b = mk(&tp, "second", &[]);
        let l = list(&tp.store, &IdeaQuery::default()).unwrap();
        assert_eq!(l.items.iter().map(|i| &i.id).collect::<Vec<_>>(), vec![&b.id, &a.id], "newest first");

        // On-disk shape is camelCase with an `ideas/<id>.json` file.
        let raw: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(tp.store.data_dir().join("ideas").join(format!("{}.json", a.id))).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["originalContent"], "first idea");
        assert_eq!(raw["createdBy"]["kind"], "human");

        let ev = seen.lock().unwrap();
        assert_eq!(ev.len(), 2);
        assert!(ev.iter().all(|e| e.domain == Domain::Ideas && e.kind == ChangeKind::Created));
        assert_eq!(ev[0].ids, vec![a.id.to_string()]);
    }

    #[test]
    fn validation_and_not_found() {
        let tp = TempProject::new();
        let e = create(&tp.store, &actor(), NewIdea { content: "   ".into(), ..Default::default() }).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let e = create(&tp.store, &actor(), NewIdea { content: "x".into(), tags: vec!["".into()], discovery_id: None }).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let missing = new_id();
        assert_eq!(get(&tp.store, &missing).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(delete(&tp.store, &actor(), &missing).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(add_tag(&tp.store, &actor(), &missing, "x").unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(Id::parse("../evil").unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[test]
    fn patch_set_and_clear() {
        let tp = TempProject::new();
        let a = mk(&tp, "a", &["x"]);
        let d = new_id();
        let u = update(
            &tp.store,
            &actor(),
            &a.id,
            IdeaPatch { content: Some("b".into()), tags: Some(vec!["Z".into(), "y".into()]), archived: Some(true), discovery_id: Some(Some(d.clone())) },
        )
        .unwrap();
        assert_eq!((u.content.as_str(), u.tags.clone(), u.archived, u.discovery_id.clone()), ("b", vec!["y".into(), "z".into()], true, Some(d)));
        assert_eq!(u.original_content, "a");
        assert!(u.updated_at >= a.updated_at);
        // Absent fields unchanged; explicit null clears discoveryId.
        let patch: IdeaPatch = serde_json::from_str(r#"{"discoveryId":null}"#).unwrap();
        let u = update(&tp.store, &actor(), &a.id, patch).unwrap();
        assert_eq!(u.discovery_id, None);
        assert_eq!(u.content, "b");
        assert!(u.archived);
        let patch: IdeaPatch = serde_json::from_str("{}").unwrap();
        assert!(patch.discovery_id.is_none());

        // Archived ideas are hidden by default.
        assert!(list(&tp.store, &IdeaQuery::default()).unwrap().items.is_empty());
        assert_eq!(list(&tp.store, &IdeaQuery { include_archived: true, ..Default::default() }).unwrap().items.len(), 1);
    }

    #[test]
    fn query_filters() {
        let tp = TempProject::new();
        let d = new_id();
        let a = mk(&tp, "Dark mode toggle", &["ui", "theme"]);
        let b = mk(&tp, "Faster startup", &["perf"]);
        let c = create(&tp.store, &actor(), NewIdea { content: "Linked".into(), tags: vec!["ui".into()], discovery_id: Some(d.clone()) }).unwrap();
        let ids = |q: IdeaQuery| list(&tp.store, &q).unwrap().items.into_iter().map(|i| i.id).collect::<Vec<_>>();
        assert_eq!(ids(IdeaQuery { text: Some("DARK".into()), ..Default::default() }), vec![a.id.clone()]);
        assert_eq!(ids(IdeaQuery { text: Some("per".into()), ..Default::default() }), vec![b.id.clone()], "matches tags too");
        assert_eq!(ids(IdeaQuery { tags: vec!["UI".into()], ..Default::default() }), vec![c.id.clone(), a.id.clone()]);
        assert_eq!(ids(IdeaQuery { tags: vec!["ui".into(), "theme".into()], ..Default::default() }), vec![a.id.clone()]);
        assert_eq!(ids(IdeaQuery { discovery_id: Some(d), ..Default::default() }), vec![c.id.clone()]);
        assert_eq!(ids(IdeaQuery { from: Some(c.created_at + 1), ..Default::default() }), Vec::<Id>::new());
        assert_eq!(ids(IdeaQuery { to: Some(a.created_at - 1), ..Default::default() }), Vec::<Id>::new());
    }

    #[test]
    fn tags_add_remove_bulk() {
        let tp = TempProject::new();
        let a = mk(&tp, "a", &[]);
        let b = mk(&tp, "b", &["keep"]);
        assert_eq!(add_tag(&tp.store, &actor(), &a.id, "Beta").unwrap().tags, vec!["beta"]);
        assert_eq!(add_tag(&tp.store, &actor(), &a.id, "alpha").unwrap().tags, vec!["alpha", "beta"]);
        assert_eq!(add_tag(&tp.store, &actor(), &a.id, "alpha").unwrap().tags, vec!["alpha", "beta"], "idempotent");
        assert_eq!(remove_tag(&tp.store, &actor(), &a.id, "BETA").unwrap().tags, vec!["alpha"]);

        let seen = record(&tp);
        let out = bulk_tag(&tp.store, &actor(), &[a.id.clone(), b.id.clone(), a.id.clone()], "Sprint").unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|i| i.tags.contains(&"sprint".to_string())));
        {
            let ev = seen.lock().unwrap();
            assert_eq!(ev.len(), 1, "one event per transaction: {ev:?}");
            assert_eq!(ev[0].ids.len(), 2);
        }
        // A missing id writes nothing.
        let e = bulk_tag(&tp.store, &actor(), &[a.id.clone(), new_id()], "nope").unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert!(!get(&tp.store, &a.id).unwrap().tags.contains(&"nope".to_string()));
    }

    #[test]
    fn merge_concatenates_unions_and_deletes() {
        let tp = TempProject::new();
        let a = mk(&tp, "alpha", &["x"]);
        let b = mk(&tp, "beta", &["y", "x"]);
        let c = mk(&tp, "gamma", &["z"]);
        add_note(&tp.store, &actor(), &a.id, "note a").unwrap();
        add_note(&tp.store, &actor(), &c.id, "note c").unwrap();

        let seen = record(&tp);
        let m = merge(&tp.store, &actor(), &[c.id.clone(), b.id.clone(), a.id.clone()], &b.id).unwrap();
        assert_eq!(m.id, b.id);
        assert_eq!(m.content, "beta\n\ngamma\n\nalpha");
        assert_eq!(m.original_content, "beta");
        assert_eq!(m.tags, vec!["x", "y", "z"]);
        assert_eq!(m.notes.iter().map(|n| n.body.as_str()).collect::<Vec<_>>(), vec!["note a", "note c"]);
        let all = list(&tp.store, &IdeaQuery { include_archived: true, ..Default::default() }).unwrap();
        assert_eq!(all.items.iter().map(|i| &i.id).collect::<Vec<_>>(), vec![&b.id]);
        {
            let ev = seen.lock().unwrap();
            let deleted: Vec<_> = ev.iter().filter(|e| e.kind == ChangeKind::Deleted).flat_map(|e| e.ids.clone()).collect();
            assert_eq!(deleted.len(), 2);
            assert!(ev.iter().any(|e| e.kind == ChangeKind::Updated && e.ids == vec![b.id.to_string()]));
        }

        let e = merge(&tp.store, &actor(), &[b.id.clone()], &b.id).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let e = merge(&tp.store, &actor(), &[b.id.clone(), a.id.clone()], &c.id).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        // Missing member → not_found, survivor untouched.
        let e = merge(&tp.store, &actor(), &[b.id.clone(), a.id.clone()], &b.id).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert_eq!(get(&tp.store, &b.id).unwrap().content, m.content);
    }

    #[test]
    fn suggestions_accept_reject_and_revert() {
        let tp = TempProject::new();
        let a = mk(&tp, "orig", &[]);
        let i = add_suggestion(&tp.store, &actor(), &a.id, SuggestionKind::Reword, "better").unwrap();
        let s1 = i.suggestions[0].id.clone();
        assert_eq!(i.suggestions[0].accepted, None);
        let i = add_suggestion(&tp.store, &actor(), &a.id, SuggestionKind::Expand, "longer").unwrap();
        let s2 = i.suggestions[1].id.clone();

        let i = resolve_suggestion(&tp.store, &actor(), &a.id, &s1, true).unwrap();
        assert_eq!(i.content, "better");
        assert_eq!(i.suggestions[0].accepted, Some(true));
        let e = resolve_suggestion(&tp.store, &actor(), &a.id, &s1, false).unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict);

        let i = resolve_suggestion(&tp.store, &actor(), &a.id, &s2, false).unwrap();
        assert_eq!(i.content, "better", "reject leaves content");
        assert_eq!(i.suggestions[1].accepted, Some(false));
        assert_eq!(
            resolve_suggestion(&tp.store, &actor(), &a.id, &new_id(), true).unwrap_err().code,
            ErrorCode::NotFound
        );

        let i = revert(&tp.store, &actor(), &a.id).unwrap();
        assert_eq!(i.content, "orig");
        assert_eq!(i.original_content, "orig");

        let i = delete_suggestion(&tp.store, &actor(), &a.id, &s2).unwrap();
        assert_eq!(i.suggestions.len(), 1);
        assert_eq!(delete_suggestion(&tp.store, &actor(), &a.id, &s2).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn notes_add_delete() {
        let tp = TempProject::new();
        let a = mk(&tp, "a", &[]);
        let i = add_note(&tp.store, &Actor::plugin("check-implemented"), &a.id, " done in v2 ").unwrap();
        assert_eq!(i.notes[0].body, "done in v2");
        assert_eq!(i.notes[0].created_by.plugin_id.as_deref(), Some("check-implemented"));
        assert_eq!(add_note(&tp.store, &actor(), &a.id, "").unwrap_err().code, ErrorCode::InvalidInput);
        let nid = i.notes[0].id.clone();
        assert!(delete_note(&tp.store, &actor(), &a.id, &nid).unwrap().notes.is_empty());
        assert_eq!(delete_note(&tp.store, &actor(), &a.id, &nid).unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn delete_publishes_and_removes() {
        let tp = TempProject::new();
        let a = mk(&tp, "a", &[]);
        let seen = record(&tp);
        delete(&tp.store, &actor(), &a.id).unwrap();
        assert_eq!(get(&tp.store, &a.id).unwrap_err().code, ErrorCode::NotFound);
        let ev = seen.lock().unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!((ev[0].kind, ev[0].ids.clone()), (ChangeKind::Deleted, vec![a.id.to_string()]));
    }

    #[test]
    fn corrupt_file_listed_and_never_overwritten() {
        let tp = TempProject::new();
        let good = mk(&tp, "good", &["t"]);
        let bad = new_id();
        let path = tp.store.data_dir().join("ideas").join(format!("{bad}.json"));
        std::fs::write(&path, "{ not json").unwrap();
        let l = list(&tp.store, &IdeaQuery::default()).unwrap();
        assert_eq!(l.items.len(), 1);
        assert_eq!(l.errors.len(), 1);
        assert!(l.errors[0].path.contains(bad.as_str()));
        assert_eq!(get(&tp.store, &bad).unwrap_err().code, ErrorCode::Corrupt);
        assert_eq!(add_tag(&tp.store, &actor(), &bad, "x").unwrap_err().code, ErrorCode::Corrupt);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        let (st, errors) = stats_report(&tp.store).unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(st.total, 1);
        let _ = good;
    }

    #[test]
    fn stats_and_export() {
        let tp = TempProject::new();
        let a = mk(&tp, "one, \"quoted\"", &["x", "y"]);
        mk(&tp, "two", &["x"]);
        update(&tp.store, &actor(), &a.id, IdeaPatch { archived: Some(true), ..Default::default() }).unwrap();
        let st = stats(&tp.store).unwrap();
        assert_eq!((st.total, st.active, st.archived), (2, 1, 1));
        assert_eq!(st.by_tag, BTreeMap::from([("x".to_string(), 2), ("y".to_string(), 1)]));

        let json = export(&tp.store, ExportFormat::Json).unwrap();
        let v: Vec<Idea> = serde_json::from_str(&json).unwrap();
        assert_eq!(v.len(), 2);
        let csv = export(&tp.store, ExportFormat::Csv).unwrap();
        assert!(csv.starts_with("id,content,tags,archived,createdAt,updatedAt\n"));
        assert!(csv.contains("\"one, \"\"quoted\"\"\",x;y,true,"), "{csv}");
        let md = export(&tp.store, ExportFormat::Markdown).unwrap();
        assert!(md.starts_with("# Ideas\n"));
        assert!(md.contains("Tags: x, y") && md.contains("Archived: yes"));
    }
}
