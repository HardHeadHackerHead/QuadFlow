//! `ProjectStore`: collections, singletons, JSONL logs and locked transactions
//! over `<root>/.quadflow/` (data-layer.md §4.3–§4.5).
//!
//! Reads are lock-free (writers only ever rename complete files into place).
//! Every mutation runs inside [`ProjectStore::write`], which holds the
//! in-process mutex and the cross-process [`ProjectLock`] for its duration and
//! publishes the buffered change events after the lock is released.

use super::atomic::{atomic_write_json, is_hidden_name, read_file};
use super::lock::{ProjectLock, DEFAULT_LOCK_TIMEOUT};
use super::recent::RecentWrites;
use crate::error::{CoreError, Result};
use crate::events::{watcher::classify_rel_path, ChangeKind, ChangeScope, Domain, EventBus, Origin};
use crate::ids::Id;
use crate::model::{Actor, CorruptEntry, ListResult};
use crate::paths::ProjectRoot;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// An entity stored as `<DIR>/<id>.json`.
pub trait Entity: Serialize + DeserializeOwned + specta::Type {
    const DOMAIN: Domain;
    /// Collection directory relative to the project folder, e.g. `"issues"`.
    const DIR: &'static str;
    fn id(&self) -> &Id;
}

/// A single file, e.g. `labels.json`. A missing file reads as `Default`.
pub trait Singleton: Serialize + DeserializeOwned + Default {
    const DOMAIN: Domain;
    /// Path relative to the project folder, e.g. `"labels.json"`, `"local/state.json"`.
    const FILE: &'static str;
}

/// Machine-local counters (`local/state.json`, §4.4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalState {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub counters: BTreeMap<String, u64>,
}

impl Singleton for LocalState {
    const DOMAIN: Domain = Domain::ProjectConfig;
    const FILE: &'static str = "local/state.json";
}

/// A validated path relative to the project folder: `/`-separated segments of
/// `[A-Za-z0-9._-]`, no empty / `.` / `..` segments.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RelPath(String);

impl RelPath {
    pub fn new(s: impl Into<String>) -> Result<RelPath> {
        let s = s.into();
        let ok = !s.is_empty()
            && s.split('/').all(|seg| {
                !seg.is_empty()
                    && seg != "."
                    && seg != ".."
                    && seg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            });
        if ok {
            Ok(RelPath(s))
        } else {
            Err(CoreError::invalid_input(format!("invalid project-relative path {s:?}")))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub struct ProjectStore {
    root: ProjectRoot,
    inner: Mutex<()>,
    bus: EventBus,
    recent: RecentWrites,
    lock_timeout: Duration,
}

impl ProjectStore {
    /// Open an existing project (requires `config.json`).
    pub fn open(root: ProjectRoot, bus: EventBus) -> Result<Self> {
        if !root.config_path().is_file() {
            return Err(CoreError::project_not_found(format!(
                "{} is not a QuadFlow project (no {})",
                root.path.display(),
                root.config_path().display()
            )));
        }
        Ok(Self::new_unchecked(root, bus))
    }

    pub(crate) fn new_unchecked(root: ProjectRoot, bus: EventBus) -> Self {
        Self { root, inner: Mutex::new(()), bus, recent: RecentWrites::new(), lock_timeout: DEFAULT_LOCK_TIMEOUT }
    }

    pub fn with_lock_timeout(mut self, t: Duration) -> Self {
        self.lock_timeout = t;
        self
    }

    pub fn root(&self) -> &ProjectRoot {
        &self.root
    }

    pub fn bus(&self) -> &EventBus {
        &self.bus
    }

    pub fn recent_writes(&self) -> &RecentWrites {
        &self.recent
    }

    pub fn data_dir(&self) -> PathBuf {
        self.root.data_dir()
    }

    fn abs(&self, rel: &str) -> PathBuf {
        let mut p = self.root.data_dir();
        for seg in rel.split('/') {
            p.push(seg);
        }
        p
    }

    fn entity_path<T: Entity>(&self, id: &Id) -> PathBuf {
        self.abs(T::DIR).join(format!("{id}.json"))
    }

    // ------------------------------------------------------------------ reads

    pub fn get<T: Entity>(&self, id: &Id) -> Result<T> {
        let path = self.entity_path::<T>(id);
        match read_json::<T>(&path)? {
            Some(v) => Ok(v),
            None => Err(CoreError::not_found(format!("{} {id} not found", T::DIR))),
        }
    }

    /// All entities of a collection, sorted by id. Unparseable files are
    /// reported in `errors`, never skipped silently. A missing dir is empty.
    pub fn list<T: Entity>(&self) -> Result<ListResult<T>> {
        let dir = self.abs(T::DIR);
        let mut out = ListResult::default();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(CoreError::io(&dir, e)),
        };
        for entry in entries {
            let entry = entry.map_err(|e| CoreError::io(&dir, e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden_name(&name) || !name.ends_with(".json") {
                continue;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let corrupt = |message: String| CorruptEntry { path: path.display().to_string(), message };
            let stem = &name[..name.len() - ".json".len()];
            let Ok(file_id) = Id::parse(stem) else {
                out.errors.push(corrupt("file name is not a valid id".into()));
                continue;
            };
            match read_json::<T>(&path) {
                Ok(Some(v)) if v.id() == &file_id => out.items.push(v),
                Ok(Some(v)) => out.errors.push(corrupt(format!("id {} does not match file name", v.id()))),
                Ok(None) => {} // deleted between read_dir and read
                Err(e) => out.errors.push(corrupt(e.message)),
            }
        }
        out.items.sort_by(|a, b| a.id().cmp(b.id()));
        Ok(out)
    }

    /// Missing → `T::default()`; unparseable → `corrupt`.
    pub fn read_singleton<T: Singleton>(&self) -> Result<T> {
        Ok(read_json::<T>(&self.abs(T::FILE))?.unwrap_or_default())
    }

    /// Read any JSON file under the project folder (`None` if missing).
    pub fn read_json<T: DeserializeOwned>(&self, rel: &RelPath) -> Result<Option<T>> {
        read_json(&self.abs(rel.as_str()))
    }

    /// Read a JSONL log. Bad lines are reported in `errors`; a final line without
    /// a trailing newline is an append in progress and is ignored.
    pub fn read_jsonl<T: DeserializeOwned>(&self, rel: &RelPath) -> Result<ListResult<T>> {
        let path = self.abs(rel.as_str());
        let mut out = ListResult::default();
        let Some(bytes) = read_file(&path)? else { return Ok(out) };
        let complete = match bytes.iter().rposition(|b| *b == b'\n') {
            Some(i) => &bytes[..=i],
            None => return Ok(out),
        };
        for (n, line) in complete.split(|b| *b == b'\n').enumerate() {
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            match serde_json::from_slice::<T>(line) {
                Ok(v) => out.items.push(v),
                Err(e) => out.errors.push(CorruptEntry {
                    path: format!("{}:{}", path.display(), n + 1),
                    message: e.to_string(),
                }),
            }
        }
        Ok(out)
    }

    // ----------------------------------------------------------------- writes

    /// Run `f` as one locked transaction. On `Ok` the buffered change events are
    /// published after the lock is released; on `Err` nothing is published.
    /// Not re-entrant: never call `write` from inside `f`.
    pub fn write<R>(&self, actor: &Actor, f: impl FnOnce(&mut Tx) -> Result<R>) -> Result<R> {
        let guard = self.inner.lock();
        let lock = ProjectLock::acquire(&self.root, self.lock_timeout)?;
        let mut tx = Tx { store: self, actor, _lock: lock, events: BTreeMap::new() };
        let result = f(&mut tx);
        let events = std::mem::take(&mut tx.events);
        drop(tx);
        drop(guard);
        let value = result?;
        let scope = ChangeScope::Project { root_key: self.root.key.clone() };
        for ((domain, kind), ids) in events {
            self.bus.emit(scope.clone(), domain, kind, ids.into_iter().collect(), Origin::Local);
        }
        Ok(value)
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match read_file(path)? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| CoreError::corrupt(path, e)),
    }
}

/// A write transaction. Holds the project lock; buffers change events.
pub struct Tx<'a> {
    store: &'a ProjectStore,
    actor: &'a Actor,
    _lock: ProjectLock,
    events: BTreeMap<(Domain, ChangeKind), BTreeSet<String>>,
}

impl Tx<'_> {
    pub fn actor(&self) -> &Actor {
        self.actor
    }

    pub fn store(&self) -> &ProjectStore {
        self.store
    }

    /// Record a change event to publish on commit (services normally don't
    /// need this; `put`/`delete`/… record their own).
    pub fn record(&mut self, domain: Domain, kind: ChangeKind, id: Option<String>) {
        let ids = self.events.entry((domain, kind)).or_default();
        if let Some(id) = id {
            ids.insert(id);
        }
    }

    pub fn get<T: Entity>(&self, id: &Id) -> Result<T> {
        self.store.get(id)
    }

    pub fn list<T: Entity>(&self) -> Result<ListResult<T>> {
        self.store.list()
    }

    pub fn read_singleton<T: Singleton>(&self) -> Result<T> {
        self.store.read_singleton()
    }

    /// Create or replace.
    pub fn put<T: Entity>(&mut self, entity: &T) -> Result<()> {
        let path = self.store.entity_path::<T>(entity.id());
        let existed = path.exists();
        atomic_write_json(&path, entity)?;
        self.store.recent.record_write(&path);
        let kind = if existed { ChangeKind::Updated } else { ChangeKind::Created };
        self.record(T::DOMAIN, kind, Some(entity.id().to_string()));
        Ok(())
    }

    pub fn delete<T: Entity>(&mut self, id: &Id) -> Result<()> {
        let path = self.store.entity_path::<T>(id);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(CoreError::not_found(format!("{} {id} not found", T::DIR)))
            }
            Err(e) => return Err(CoreError::io(&path, e)),
        }
        self.store.recent.record_delete(&path);
        self.record(T::DOMAIN, ChangeKind::Deleted, Some(id.to_string()));
        Ok(())
    }

    /// Read-modify-write a singleton. A corrupt file is left untouched and
    /// returns `corrupt` (never reset to default); a missing file starts from `Default`.
    pub fn update_singleton<T: Singleton>(&mut self, f: impl FnOnce(&mut T)) -> Result<T> {
        let mut value: T = self.store.read_singleton()?;
        f(&mut value);
        let path = self.store.abs(T::FILE);
        atomic_write_json(&path, &value)?;
        self.store.recent.record_write(&path);
        if T::FILE != LocalState::FILE {
            self.record(T::DOMAIN, ChangeKind::Updated, None);
        }
        Ok(value)
    }

    /// Write any JSON file under the project folder (plugin data, doctor fixes).
    pub fn put_json<T: Serialize + ?Sized>(&mut self, rel: &RelPath, value: &T) -> Result<()> {
        let path = self.store.abs(rel.as_str());
        let existed = path.exists();
        atomic_write_json(&path, value)?;
        self.store.recent.record_write(&path);
        if let Some((domain, id)) = classify_rel_path(rel.as_str()) {
            self.record(domain, if existed { ChangeKind::Updated } else { ChangeKind::Created }, id);
        }
        Ok(())
    }

    /// Delete any file under the project folder. Missing is not an error.
    pub fn delete_file(&mut self, rel: &RelPath) -> Result<()> {
        let path = self.store.abs(rel.as_str());
        match std::fs::remove_file(&path) {
            Ok(()) => {
                self.store.recent.record_delete(&path);
                if let Some((domain, id)) = classify_rel_path(rel.as_str()) {
                    self.record(domain, ChangeKind::Deleted, id);
                }
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CoreError::io(&path, e)),
        }
    }

    /// Append one JSON line (append-only logs: mission messages / activity).
    pub fn append_jsonl<T: Serialize>(&mut self, rel: &RelPath, line: &T) -> Result<()> {
        let path = self.store.abs(rel.as_str());
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| CoreError::io(dir, e))?;
        }
        let mut bytes = serde_json::to_vec(line).map_err(|e| CoreError::internal(format!("serialize: {e}")))?;
        bytes.push(b'\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| CoreError::io(&path, e))?;
        f.write_all(&bytes).map_err(|e| CoreError::io(&path, e))?;
        f.sync_all().map_err(|e| CoreError::io(&path, e))?;
        drop(f);
        self.store.recent.record_write(&path);
        if let Some((domain, id)) = classify_rel_path(rel.as_str()) {
            self.record(domain, ChangeKind::Updated, id);
        }
        Ok(())
    }

    /// Allocate the next display number for counter `name` (§4.4):
    /// `max(counters[name], max "number" of every file in scan_dir) + 1`.
    /// Files are read leniently, so an unparseable file with a readable
    /// `"number"` still counts.
    pub fn next_counter(&mut self, name: &str, scan_dir: Option<&str>) -> Result<u64> {
        let state: LocalState = self.store.read_singleton()?;
        let mut max = state.counters.get(name).copied().unwrap_or(0);
        if let Some(dir) = scan_dir {
            max = max.max(max_number_in_dir(&self.store.abs(dir))?);
        }
        let n = max + 1;
        self.update_singleton::<LocalState>(|s| {
            s.counters.insert(name.to_string(), n);
        })?;
        Ok(n)
    }
}

/// Largest `"number"` field among `<dir>/*.json`, read leniently.
pub(crate) fn max_number_in_dir(dir: &Path) -> Result<u64> {
    Ok(numbers_in_dir(dir)?.into_iter().map(|(_, n)| n).max().unwrap_or(0))
}

/// `(file path, number)` for every `<dir>/*.json` with a readable `"number"`.
pub(crate) fn numbers_in_dir(dir: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(CoreError::io(dir, e)),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden_name(&name) || !name.ends_with(".json") {
            continue;
        }
        let path = entry.path();
        let Some(bytes) = read_file(&path)? else { continue };
        if let Some(n) = lenient_number(&bytes) {
            out.push((path, n));
        }
    }
    Ok(out)
}

fn lenient_number(bytes: &[u8]) -> Option<u64> {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
        return v.get("number").and_then(|n| n.as_u64());
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#""number"\s*:\s*(\d+)"#).unwrap());
    let text = String::from_utf8_lossy(bytes);
    re.captures(&text).and_then(|c| c[1].parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::new_id;
    use crate::testing::TempProject;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
    #[serde(rename_all = "camelCase")]
    struct Note {
        id: Id,
        number: u64,
        text: String,
    }
    impl Entity for Note {
        const DOMAIN: Domain = Domain::Ideas;
        const DIR: &'static str = "ideas";
        fn id(&self) -> &Id {
            &self.id
        }
    }

    #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Tags {
        tags: Vec<String>,
    }
    impl Singleton for Tags {
        const DOMAIN: Domain = Domain::Labels;
        const FILE: &'static str = "labels.json";
    }

    #[test]
    fn crud_round_trip_and_events() {
        let tp = TempProject::new();
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let s2 = seen.clone();
        tp.store.bus().subscribe(move |e| s2.lock().unwrap().push(e.clone()));
        let actor = Actor::system();

        let n = tp
            .store
            .write(&actor, |tx| {
                let number = tx.next_counter("note", Some("ideas"))?;
                let n = Note { id: new_id(), number, text: "a".into() };
                tx.put(&n)?;
                Ok(n)
            })
            .unwrap();
        assert_eq!(n.number, 1);
        assert_eq!(tp.store.get::<Note>(&n.id).unwrap(), n);
        let l = tp.store.list::<Note>().unwrap();
        assert_eq!(l.items.len(), 1);
        assert!(l.errors.is_empty());

        {
            let ev = seen.lock().unwrap();
            assert_eq!(ev.len(), 1, "{ev:?}");
            assert_eq!(ev[0].domain, Domain::Ideas);
            assert_eq!(ev[0].kind, ChangeKind::Created);
            assert_eq!(ev[0].ids, vec![n.id.to_string()]);
            assert_eq!(ev[0].origin, Origin::Local);
        }

        tp.store.write(&actor, |tx| tx.delete::<Note>(&n.id)).unwrap();
        assert_eq!(tp.store.get::<Note>(&n.id).unwrap_err().code, crate::error::ErrorCode::NotFound);
        // Counter stays monotonic even after deletion.
        let k = tp.store.write(&actor, |tx| tx.next_counter("note", Some("ideas"))).unwrap();
        assert_eq!(k, 2);

        // Errors publish nothing.
        let before = seen.lock().unwrap().len();
        let r: Result<()> = tp.store.write(&actor, |tx| {
            tx.put(&Note { id: new_id(), number: 9, text: "x".into() })?;
            Err(CoreError::conflict("nope"))
        });
        assert!(r.is_err());
        assert_eq!(seen.lock().unwrap().len(), before);
    }

    #[test]
    fn corrupt_files_are_reported_and_never_overwritten() {
        let tp = TempProject::new();
        let dir = tp.store.data_dir().join("ideas");
        std::fs::create_dir_all(&dir).unwrap();
        let bad_id = new_id();
        std::fs::write(dir.join(format!("{bad_id}.json")), "{ not json \"number\": 41").unwrap();
        std::fs::write(dir.join("not-an-id.json"), "{}").unwrap();
        std::fs::write(dir.join(".abc.tmp"), "junk").unwrap();
        let l = tp.store.list::<Note>().unwrap();
        assert!(l.items.is_empty());
        assert_eq!(l.errors.len(), 2, "{:?}", l.errors);
        assert_eq!(tp.store.get::<Note>(&bad_id).unwrap_err().code, crate::error::ErrorCode::Corrupt);
        // Lenient counter read sees number 41 in the corrupt file.
        let n = tp.store.write(&Actor::system(), |tx| tx.next_counter("note", Some("ideas"))).unwrap();
        assert_eq!(n, 42);

        let labels = tp.store.data_dir().join("labels.json");
        std::fs::write(&labels, "[broken").unwrap();
        let e = tp.store.write(&Actor::system(), |tx| tx.update_singleton::<Tags>(|t| t.tags.push("x".into()))).unwrap_err();
        assert_eq!(e.code, crate::error::ErrorCode::Corrupt);
        assert_eq!(std::fs::read_to_string(&labels).unwrap(), "[broken");
    }

    #[test]
    fn singleton_and_jsonl() {
        let tp = TempProject::new();
        assert_eq!(tp.store.read_singleton::<Tags>().unwrap(), Tags::default());
        tp.store.write(&Actor::system(), |tx| tx.update_singleton::<Tags>(|t| t.tags.push("x".into()))).unwrap();
        assert_eq!(tp.store.read_singleton::<Tags>().unwrap().tags, vec!["x"]);

        let rel = RelPath::new(format!("local/missions/{}/messages.jsonl", new_id())).unwrap();
        tp.store
            .write(&Actor::system(), |tx| {
                tx.append_jsonl(&rel, &serde_json::json!({"n": 1}))?;
                tx.append_jsonl(&rel, &serde_json::json!({"n": 2}))
            })
            .unwrap();
        // Simulate an in-progress append.
        let p = tp.store.data_dir().join(rel.as_str().replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"{\"n\": 3").unwrap();
        let l = tp.store.read_jsonl::<serde_json::Value>(&rel).unwrap();
        assert_eq!(l.items.len(), 2);
        assert!(l.errors.is_empty());
    }

    #[test]
    fn rel_paths_validated() {
        assert!(RelPath::new("plugins/my-plugin/data.json").is_ok());
        for bad in ["", "/abs", "a//b", "../x", "a/./b", "a\\b", "a/b/"] {
            assert!(RelPath::new(bad).is_err(), "{bad:?}");
        }
    }
}
