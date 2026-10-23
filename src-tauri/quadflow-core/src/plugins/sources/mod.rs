//! Plugin sources (plugin-system.md §12): source rows, refresh with ETag
//! caching, browsing cached indexes, and (in [`install`]) install / update /
//! rollback / uninstall of release archives.
//!
//! Network never happens on startup paths: the registry and every listing read
//! the DB + cached index bodies only. Refreshes run on demand or from the
//! background checker ([`start_background_checks`]); a failing source records
//! `last_error` and never blocks the others.

pub mod archive;
pub mod fetch;
pub mod index;
pub mod install;

pub use index::{
    parse_index, resolve_source_url, HostTarget, PluginIndex, PluginIndexDigest, PluginIndexEntry, PluginIndexSize,
    PluginIndexVersion, ResolvedVersion,
};
pub use install::{
    available_updates, check_updates, confirm, forget_plugin_secret, plan_install, plan_update, record_plugin_secret, rollback,
    uninstall, PluginInstallKind, PluginInstallPlan,
    PluginUninstallResult, PluginUpdateInfo,
};

use super::registry::{LoadOptions, PluginOrigin, PluginRegistry};
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::paths::{AppPaths, Profile};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Id of the built-in source row (cannot be removed, can be disabled).
pub const BUILTIN_SOURCE_ID: &str = "official";
/// Overrides the built-in source URL.
pub const ENV_PLUGIN_INDEX_URL: &str = "QUADFLOW_PLUGIN_INDEX_URL";
/// Index body cap (§12.3).
pub const INDEX_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Archive hard cap (§12.3).
pub const ARCHIVE_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// The built-in source spec: `github:<REPO>:plugins/index.json`.
pub fn builtin_source_spec() -> String {
    format!("github:{}:plugins/index.json", crate::urls::REPO)
}

/// Knobs for sources/install. `from_env` is what the GUI and CLI use.
#[derive(Clone, Debug)]
pub struct SourceOptions {
    /// Allow `file://` and `http://localhost|127.0.0.1` sources and archives
    /// (dev profile and tests only — never in release).
    pub allow_dev_urls: bool,
    /// Spec of the built-in source.
    pub builtin_url: String,
    pub index_timeout: Duration,
    pub download_timeout: Duration,
    /// Registry options (host API, platform, resource dir) for compatibility and reloads.
    pub load: LoadOptions,
}

impl SourceOptions {
    pub fn from_env(profile: Profile, var: impl Fn(&str) -> Option<String>) -> Self {
        Self {
            allow_dev_urls: profile == Profile::Dev,
            builtin_url: var(ENV_PLUGIN_INDEX_URL).filter(|v| !v.trim().is_empty()).unwrap_or_else(builtin_source_spec),
            index_timeout: Duration::from_secs(10),
            download_timeout: Duration::from_secs(300),
            load: LoadOptions::from_env(&var),
        }
    }

    pub fn host(&self) -> HostTarget {
        HostTarget { platform: self.load.platform, target: self.load.target.clone(), host_api: self.load.host_api.clone() }
    }
}

/// A source over IPC / CLI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSourceInfo {
    pub id: String,
    /// As entered (`github:…` or a URL).
    pub url: String,
    /// What is fetched.
    pub resolved_url: Option<String>,
    pub name: String,
    pub builtin: bool,
    pub enabled: bool,
    pub etag: Option<String>,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
    /// Plugins in the cached index (`None` = never fetched).
    pub plugin_count: Option<u32>,
}

/// One plugin offered by a source, resolved against this host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginAvailable {
    pub source_id: String,
    pub source_name: String,
    pub entry: PluginIndexEntry,
    /// Highest version installable here.
    pub latest_compatible: Option<String>,
    /// Why no version is installable here.
    pub incompatible_reason: Option<String>,
    pub installed_version: Option<String>,
    pub installed_origin: Option<PluginOrigin>,
    /// Permissions of `latest_compatible`.
    pub permissions: Vec<String>,
}

fn cache_dir(paths: &AppPaths) -> PathBuf {
    paths.cache_dir.join("sources")
}

pub fn cache_path(paths: &AppPaths, source_id: &str) -> PathBuf {
    cache_dir(paths).join(format!("{source_id}.json"))
}

/// The cached index of a source, if any (and still valid).
pub fn cached_index(paths: &AppPaths, source_id: &str) -> Option<PluginIndex> {
    let bytes = std::fs::read(cache_path(paths, source_id)).ok()?;
    parse_index(&bytes).ok()
}

#[derive(Clone, Debug)]
pub(crate) struct SourceRow {
    pub id: String,
    pub url: String,
    pub name: String,
    pub builtin: bool,
    pub enabled: bool,
    pub etag: Option<String>,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
}

pub(crate) fn read_sources(db: &AppDb) -> Result<Vec<SourceRow>> {
    db.read(|c| {
        let mut s = c.prepare(
            "SELECT id, url, name, builtin, enabled, etag, last_checked_at, last_error FROM plugin_sources
             ORDER BY builtin DESC, created_at, id",
        )?;
        let rows = s.query_map([], |r| {
            Ok(SourceRow {
                id: r.get(0)?,
                url: r.get(1)?,
                name: r.get(2)?,
                builtin: r.get::<_, i64>(3)? != 0,
                enabled: r.get::<_, i64>(4)? != 0,
                etag: r.get(5)?,
                last_checked_at: r.get(6)?,
                last_error: r.get(7)?,
            })
        })?;
        rows.collect()
    })
}

pub(crate) fn read_source(db: &AppDb, id: &str) -> Result<SourceRow> {
    read_sources(db)?
        .into_iter()
        .find(|s| s.id == id || s.url == id)
        .ok_or_else(|| CoreError::not_found(format!("plugin source {id:?}")))
}

fn change(id: &str, op: ChangeKind) -> AppChange {
    AppChange::new(Domain::Plugins, op, Some(format!("source:{id}")))
}

/// Create the built-in source row, or point it at the configured URL.
pub fn ensure_builtin(db: &AppDb, opts: &SourceOptions) -> Result<()> {
    let existing: Option<String> = db.read(|c| {
        c.query_row("SELECT url FROM plugin_sources WHERE id = ?1", [BUILTIN_SOURCE_ID], |r| r.get(0)).optional()
    })?;
    match existing {
        Some(u) if u == opts.builtin_url => Ok(()),
        Some(_) => {
            db.write(&[change(BUILTIN_SOURCE_ID, ChangeKind::Updated)], |tx| {
                tx.execute("DELETE FROM plugin_sources WHERE url = ?1 AND id <> ?2", rusqlite::params![opts.builtin_url, BUILTIN_SOURCE_ID])?;
                tx.execute(
                    "UPDATE plugin_sources SET url = ?2, etag = NULL, last_checked_at = NULL, last_error = NULL WHERE id = ?1",
                    rusqlite::params![BUILTIN_SOURCE_ID, opts.builtin_url],
                )
            })?;
            Ok(())
        }
        None => {
            db.write(&[change(BUILTIN_SOURCE_ID, ChangeKind::Created)], |tx| {
                tx.execute("DELETE FROM plugin_sources WHERE url = ?1", [&opts.builtin_url])?;
                tx.execute(
                    "INSERT INTO plugin_sources (id, url, name, builtin, enabled, created_at) VALUES (?1, ?2, 'QuadFlow', 1, 1, ?3)",
                    rusqlite::params![BUILTIN_SOURCE_ID, opts.builtin_url, now_ms()],
                )
            })?;
            Ok(())
        }
    }
}

fn info(paths: &AppPaths, r: &SourceRow, opts: &SourceOptions) -> PluginSourceInfo {
    PluginSourceInfo {
        id: r.id.clone(),
        url: r.url.clone(),
        resolved_url: resolve_source_url(&r.url, opts.allow_dev_urls).ok(),
        name: r.name.clone(),
        builtin: r.builtin,
        enabled: r.enabled,
        etag: r.etag.clone(),
        last_checked_at: r.last_checked_at,
        last_error: r.last_error.clone(),
        plugin_count: cached_index(paths, &r.id).map(|i| i.plugins.len() as u32),
    }
}

/// All sources (built-in first). No network.
pub fn list(db: &AppDb, paths: &AppPaths, opts: &SourceOptions) -> Result<Vec<PluginSourceInfo>> {
    ensure_builtin(db, opts)?;
    Ok(read_sources(db)?.iter().map(|r| info(paths, r, opts)).collect())
}

pub fn get(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: &str) -> Result<PluginSourceInfo> {
    ensure_builtin(db, opts)?;
    Ok(info(paths, &read_source(db, id)?, opts))
}

/// Add a source and fetch it once (a fetch failure is recorded, not returned).
pub fn add(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, url: &str) -> Result<PluginSourceInfo> {
    ensure_builtin(db, opts)?;
    let url = url.trim().to_string();
    resolve_source_url(&url, opts.allow_dev_urls)?;
    if read_sources(db)?.iter().any(|s| s.url == url) {
        return Err(CoreError::conflict(format!("source {url:?} is already added")));
    }
    let id = crate::new_id().to_string();
    db.write(&[change(&id, ChangeKind::Created)], |tx| {
        tx.execute(
            "INSERT INTO plugin_sources (id, url, name, builtin, enabled, created_at) VALUES (?1, ?2, ?2, 0, 1, ?3)",
            rusqlite::params![id, url, now_ms()],
        )
    })?;
    refresh_one(db, paths, opts, &read_source(db, &id)?);
    get(db, paths, opts, &id)
}

/// Remove a non-built-in source (installed plugins keep working; they lose updates).
pub fn remove(db: &AppDb, paths: &AppPaths, id: &str) -> Result<()> {
    let r = read_source(db, id)?;
    if r.builtin {
        return Err(CoreError::invalid_input("the built-in source cannot be removed (disable it instead)"));
    }
    db.write(&[change(&r.id, ChangeKind::Deleted)], |tx| tx.execute("DELETE FROM plugin_sources WHERE id = ?1", [&r.id]))?;
    let _ = std::fs::remove_file(cache_path(paths, &r.id));
    Ok(())
}

pub fn set_enabled(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: &str, enabled: bool) -> Result<PluginSourceInfo> {
    ensure_builtin(db, opts)?;
    let r = read_source(db, id)?;
    db.write(&[change(&r.id, ChangeKind::Updated)], |tx| {
        tx.execute("UPDATE plugin_sources SET enabled = ?2 WHERE id = ?1", rusqlite::params![r.id, enabled as i64])
    })?;
    get(db, paths, opts, &r.id)
}

/// Refresh one source, recording the outcome on its row. Never fails: errors go
/// to `last_error`. Returns the error message, if any.
fn refresh_one(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, r: &SourceRow) -> Option<String> {
    let cache = cache_path(paths, &r.id);
    let outcome = (|| -> Result<(Option<String>, Option<String>)> {
        let url = resolve_source_url(&r.url, opts.allow_dev_urls)?;
        let etag = if cache.is_file() { r.etag.as_deref() } else { None };
        match fetch::fetch_index(&url, etag, opts.index_timeout, INDEX_MAX_BYTES)? {
            fetch::Fetched::NotModified => Ok((r.etag.clone(), None)),
            fetch::Fetched::Body { bytes, etag } => {
                let idx = parse_index(&bytes)?;
                std::fs::create_dir_all(cache_dir(paths)).map_err(|e| CoreError::io(&cache_dir(paths), e))?;
                crate::store::atomic_write(&cache, &bytes)?;
                Ok((etag, Some(idx.name)))
            }
        }
    })();
    let now = now_ms();
    let (etag, name, err) = match outcome {
        Ok((etag, name)) => (etag, name, None),
        Err(e) => (r.etag.clone(), None, Some(e.message)),
    };
    let res = db.write(&[change(&r.id, ChangeKind::Updated)], |tx| {
        tx.execute(
            "UPDATE plugin_sources SET etag = ?2, last_checked_at = ?3, last_error = ?4,
                    name = CASE WHEN ?5 IS NOT NULL AND builtin = 0 THEN ?5 ELSE name END
             WHERE id = ?1",
            rusqlite::params![r.id, etag, now, err, name],
        )
    });
    if let Err(e) = res {
        tracing::warn!("plugin source {}: could not record refresh: {e}", r.id);
    }
    err
}

/// Refresh one source (`Some(id)`) or every enabled source. One failing source
/// never stops the others; failures are in each source's `lastError`.
pub fn refresh(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: Option<&str>) -> Result<Vec<PluginSourceInfo>> {
    ensure_builtin(db, opts)?;
    let targets: Vec<SourceRow> = match id {
        Some(id) => vec![read_source(db, id)?],
        None => read_sources(db)?.into_iter().filter(|s| s.enabled).collect(),
    };
    // Sources are independent: fetch them in parallel so one slow source
    // doesn't delay the rest.
    std::thread::scope(|s| {
        for r in &targets {
            s.spawn(move || refresh_one(db, paths, opts, r));
        }
    });
    let ids: Vec<&str> = targets.iter().map(|t| t.id.as_str()).collect();
    Ok(read_sources(db)?.iter().filter(|r| ids.contains(&r.id.as_str())).map(|r| info(paths, r, opts)).collect())
}

/// Plugins offered by one source or all enabled sources, from the cache (no network).
pub fn browse(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: Option<&str>) -> Result<Vec<PluginAvailable>> {
    ensure_builtin(db, opts)?;
    let sources: Vec<SourceRow> = match id {
        Some(id) => vec![read_source(db, id)?],
        None => read_sources(db)?.into_iter().filter(|s| s.enabled).collect(),
    };
    let reg = PluginRegistry::load_with(paths, db, &opts.load)?;
    let host = opts.host();
    let mut out = Vec::new();
    for s in &sources {
        let Some(idx) = cached_index(paths, &s.id) else { continue };
        let name = if s.builtin { s.name.clone() } else { idx.name.clone() };
        for e in idx.plugins {
            let sel = e.select(None, &host);
            let installed = reg.get(&e.id);
            out.push(PluginAvailable {
                source_id: s.id.clone(),
                source_name: name.clone(),
                latest_compatible: sel.as_ref().ok().map(|r| r.version.clone()),
                incompatible_reason: sel.as_ref().err().cloned(),
                permissions: sel.as_ref().map(|r| r.permissions.iter().map(|p| p.to_string()).collect()).unwrap_or_default(),
                installed_version: installed.and_then(|p| p.manifest.as_ref().map(|m| m.version.clone())),
                installed_origin: installed.map(|p| p.origin),
                entry: e,
            });
        }
    }
    Ok(out)
}

/// Background update checks (§12.3): after `initial_delay`, then every `interval`:
/// refresh enabled sources and recompute `available_update`. Runs on its own
/// thread; never blocks the caller. Stops when `stop` is set.
pub fn start_background_checks(
    paths: AppPaths,
    db: Arc<AppDb>,
    opts: SourceOptions,
    initial_delay: Duration,
    interval: Duration,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("plugin-update-checks".into())
        .spawn(move || {
            let sleep = |d: Duration| {
                let step = Duration::from_millis(200);
                let mut left = d;
                while !left.is_zero() {
                    if stop.load(std::sync::atomic::Ordering::Relaxed) {
                        return false;
                    }
                    let s = left.min(step);
                    std::thread::sleep(s);
                    left -= s;
                }
                !stop.load(std::sync::atomic::Ordering::Relaxed)
            };
            if !sleep(initial_delay) {
                return;
            }
            loop {
                if let Err(e) = refresh(&db, &paths, &opts, None) {
                    tracing::warn!("plugin source refresh failed: {e}");
                }
                if let Err(e) = check_updates(&db, &paths, &opts) {
                    tracing::warn!("plugin update check failed: {e}");
                }
                if !sleep(interval) {
                    return;
                }
            }
        })
        .expect("spawn plugin update checker")
}

#[cfg(test)]
pub(crate) mod testkit;

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use std::time::Instant;

    #[test]
    fn builtin_source_is_created_and_cannot_be_removed() {
        let env = Env::new();
        let list = list(&env.app.db, &env.app.paths, &env.opts).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].builtin);
        assert_eq!(list[0].id, BUILTIN_SOURCE_ID);
        assert!(remove(&env.app.db, &env.app.paths, BUILTIN_SOURCE_ID).is_err());
        // Disable works.
        assert!(!set_enabled(&env.app.db, &env.app.paths, &env.opts, BUILTIN_SOURCE_ID, false).unwrap().enabled);
        // Default spec points at the public repo constant.
        assert_eq!(builtin_source_spec(), format!("github:{}:plugins/index.json", crate::urls::REPO));
    }

    #[test]
    fn add_refresh_browse_remove_file_source() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &[], None);
        let s = add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        assert_eq!(s.last_error, None);
        assert_eq!(s.plugin_count, Some(1));
        assert_eq!(s.name, "Fake source");
        let avail = browse(&env.app.db, &env.app.paths, &env.opts, Some(&s.id)).unwrap();
        assert_eq!(avail.len(), 1);
        assert_eq!(avail[0].latest_compatible.as_deref(), Some("1.0.0"));
        assert!(add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap_err().code == crate::ErrorCode::Conflict);
        remove(&env.app.db, &env.app.paths, &s.id).unwrap();
        assert!(!cache_path(&env.app.paths, &s.id).exists());
    }

    #[test]
    fn https_only_outside_dev() {
        let mut env = Env::new();
        env.opts.allow_dev_urls = false;
        let e = add(&env.app.db, &env.app.paths, &env.opts, "file:///tmp/index.json").unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::InvalidInput);
    }

    #[test]
    fn etag_caching_over_http() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &[], None);
        let server = TestServer::serve_dir(src.dir.path());
        let s = add(&env.app.db, &env.app.paths, &env.opts, &server.url("index.json")).unwrap();
        assert_eq!(s.last_error, None, "{s:?}");
        assert!(s.etag.is_some());
        assert_eq!(server.hits_200(), 1);
        // Second refresh sends If-None-Match and gets 304; cache kept.
        let r = refresh(&env.app.db, &env.app.paths, &env.opts, Some(&s.id)).unwrap();
        assert_eq!(r[0].last_error, None);
        assert_eq!(server.hits_304(), 1);
        assert_eq!(r[0].plugin_count, Some(1));
        // Index changes → new body.
        src.publish("acme.other", "2.0.0", &[], None);
        let r = refresh(&env.app.db, &env.app.paths, &env.opts, Some(&s.id)).unwrap();
        assert_eq!(r[0].plugin_count, Some(2));
        assert_eq!(server.hits_200(), 2);
    }

    #[test]
    fn source_down_does_not_block_others_or_startup() {
        let mut env = Env::new();
        env.opts.index_timeout = Duration::from_millis(700);
        // A source that accepts connections but never answers, and one that refuses them.
        let hang = TestServer::hang();
        let dead = format!("http://127.0.0.1:{}/index.json", free_port());
        let good = env.fake_source();
        good.publish("acme.hello", "1.0.0", &[], None);

        let started = Instant::now();
        let h = add(&env.app.db, &env.app.paths, &env.opts, &hang.url("index.json")).unwrap();
        let d = add(&env.app.db, &env.app.paths, &env.opts, &dead).unwrap();
        let g = add(&env.app.db, &env.app.paths, &env.opts, &good.url()).unwrap();
        assert!(h.last_error.is_some() && d.last_error.is_some());
        assert_eq!(g.last_error, None);

        let t = Instant::now();
        let all = refresh(&env.app.db, &env.app.paths, &env.opts, None).unwrap();
        assert!(t.elapsed() < Duration::from_secs(5), "parallel refresh bounded by the timeout: {:?}", t.elapsed());
        let by_id = |id: &str| all.iter().find(|s| s.id == id).unwrap().clone();
        assert!(by_id(&h.id).last_error.is_some());
        assert!(by_id(&d.id).last_error.is_some());
        assert_eq!(by_id(&g.id).last_error, None);
        assert_eq!(by_id(&g.id).plugin_count, Some(1));
        // The built-in source (unreachable github in tests is never contacted:
        // it points at a dead local URL here) also just records an error.
        assert!(by_id(BUILTIN_SOURCE_ID).last_error.is_some());

        // Startup paths: registry load, listing and browsing do no network.
        let t = Instant::now();
        PluginRegistry::load_with(&env.app.paths, &env.app.db, &env.opts.load).unwrap();
        list(&env.app.db, &env.app.paths, &env.opts).unwrap();
        assert_eq!(browse(&env.app.db, &env.app.paths, &env.opts, None).unwrap().len(), 1);
        assert!(t.elapsed() < Duration::from_secs(2), "startup reads took {:?}", t.elapsed());

        // The background checker returns immediately and can be stopped.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let db = Arc::new(AppDb::open(&env.app.paths, crate::events::EventBus::new()).unwrap());
        let t = Instant::now();
        let handle = start_background_checks(
            env.app.paths.clone(),
            db,
            env.opts.clone(),
            Duration::from_secs(30),
            Duration::from_secs(24 * 3600),
            stop.clone(),
        );
        assert!(t.elapsed() < Duration::from_millis(500), "checker start blocked");
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        handle.join().unwrap();
        let _ = started;
    }
}
