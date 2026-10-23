//! Install / update / rollback / uninstall of plugin release archives
//! (plugin-system.md §11.2, §12.3).
//!
//! Two-step flow: `plan_install` / `plan_update` resolve what would be
//! installed (version, archive, permissions, permission diff) without touching
//! disk; the UI or CLI shows the consent dialog; `confirm` downloads, verifies
//! (size + SHA-256), extracts safely, validates the manifest against the index
//! and switches the plugin over. An update whose permission diff is non-empty
//! is refused by `confirm` unless every added permission is granted — the old
//! version keeps running until then.

use super::archive::extract_zip;
use super::fetch::{download_verified, integrity_error};
use super::index::{check_archive_url, PluginIndexEntry, ResolvedVersion};
use super::{cached_index, read_source, read_sources, refresh, SourceOptions, SourceRow, ARCHIVE_MAX_BYTES};
use crate::domains::app::secrets::Secrets;
use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::paths::AppPaths;
use crate::plugins::permissions::{self, Permission, Risk};
use crate::plugins::registry::{validate_plugin_dir, Isolation, PermissionInfo, PluginInfo, PluginOrigin, PluginRegistry};
use crate::plugins::{is_bare_id, MANIFEST_FILE};
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Settings namespace indexing each plugin's secret names (key = plugin id,
/// value = JSON string[]). The OS keystore cannot enumerate entries, so the
/// host's `secrets.set` records names here and uninstall deletes them.
pub const SECRET_INDEX_NAMESPACE: &str = "plugins.secrets";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum PluginInstallKind {
    Install,
    Update,
}

/// What `confirm` would do; shown in the consent dialog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallPlan {
    pub plan_id: String,
    pub kind: PluginInstallKind,
    pub plugin_id: String,
    pub name: String,
    pub description: Option<String>,
    pub source_id: String,
    pub source_name: String,
    pub version: String,
    /// Installed (or bundled) version being replaced.
    pub from_version: Option<String>,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub api_version: String,
    pub isolation: Isolation,
    /// Permissions the new version requests; `granted` = already granted.
    pub permissions: Vec<PermissionInfo>,
    /// Requested by the new version and not granted yet (update consent).
    pub added_permissions: Vec<Permission>,
    /// Granted but no longer requested (revoked automatically).
    pub removed_permissions: Vec<Permission>,
    /// The user must approve before `confirm` (always for installs; for updates
    /// only when permissions are added).
    pub needs_consent: bool,
    /// A critical permission is requested: the dialog needs "I trust this plugin".
    pub requires_trust: bool,
    pub notes: Option<String>,
}

/// A newer compatible version in the plugin's source (`plugins.available_update`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub plugin_id: String,
    pub current_version: String,
    pub version: String,
    pub source_id: String,
    pub url: String,
    pub sha256: String,
    pub permissions: Vec<Permission>,
    pub added_permissions: Vec<Permission>,
    pub removed_permissions: Vec<Permission>,
    /// Adding permissions: "Update needs approval".
    pub needs_consent: bool,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginUninstallResult {
    pub plugin_id: String,
    /// An installed override of a bundled plugin was removed; the bundled copy
    /// is active again and its data was kept.
    pub reverted_to_bundled: bool,
    pub removed_tool_configs: u32,
    pub removed_kv_entries: u32,
    pub removed_settings: u32,
    pub removed_secrets: u32,
    pub deleted_data_dir: bool,
}

// ---------------------------------------------------------------------------
// plugins rows
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Row {
    source_id: Option<String>,
    origin: String,
    install_path: String,
    granted: BTreeSet<Permission>,
    available_update: Option<String>,
}

fn read_row(db: &AppDb, id: &str) -> Result<Option<Row>> {
    db.read(|c| {
        c.query_row(
            "SELECT source_id, origin, version, install_path, granted_permissions, available_update FROM plugins WHERE id = ?1",
            [id],
            |r| {
                let granted: String = r.get(4)?;
                Ok(Row {
                    source_id: r.get(0)?,
                    origin: r.get(1)?,
                    install_path: r.get(3)?,
                    granted: parse_perms(&granted),
                    available_update: r.get(5)?,
                })
            },
        )
        .optional()
    })
}

fn parse_perms(raw: &str) -> BTreeSet<Permission> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default().iter().filter_map(|s| Permission::parse(s).ok()).collect()
}

fn perms_json(p: &BTreeSet<Permission>) -> String {
    serde_json::to_string(&p.iter().map(Permission::as_str).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into())
}

fn change(id: &str) -> AppChange {
    AppChange::new(Domain::Plugins, ChangeKind::Updated, Some(id))
}

fn reload(paths: &AppPaths, db: &AppDb, opts: &SourceOptions) -> Result<PluginRegistry> {
    PluginRegistry::load_with(paths, db, &opts.load)
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

/// Find `plugin_id` in `source` (or the first enabled source listing it,
/// built-in first). Fetches a source once if it has no cached index yet.
fn find_entry(
    db: &AppDb,
    paths: &AppPaths,
    opts: &SourceOptions,
    source: Option<&str>,
    plugin_id: &str,
) -> Result<(SourceRow, PluginIndexEntry)> {
    super::ensure_builtin(db, opts)?;
    let sources: Vec<SourceRow> = match source {
        Some(s) => vec![read_source(db, s)?],
        None => read_sources(db)?.into_iter().filter(|s| s.enabled).collect(),
    };
    let mut errors = Vec::new();
    for s in sources {
        if cached_index(paths, &s.id).is_none() {
            refresh(db, paths, opts, Some(&s.id))?;
        }
        match cached_index(paths, &s.id) {
            Some(idx) => {
                if let Some(e) = idx.plugins.into_iter().find(|p| p.id == plugin_id) {
                    let s = read_source(db, &s.id)?;
                    return Ok((s, e));
                }
            }
            None => {
                let s = read_source(db, &s.id)?;
                errors.push(format!("{}: {}", s.url, s.last_error.unwrap_or_else(|| "no index".into())));
            }
        }
    }
    let mut e = CoreError::not_found(format!("plugin {plugin_id:?} is not offered by any enabled source"));
    if !errors.is_empty() {
        e = e.with_details(serde_json::json!({ "sourceErrors": errors }));
    }
    Err(e)
}

fn isolation_for(id: &str, source: &SourceRow) -> Isolation {
    if is_bare_id(id) && source.builtin {
        Isolation::Trusted
    } else {
        Isolation::Sandboxed
    }
}

fn permission_infos(requested: &BTreeSet<Permission>, granted: &BTreeSet<Permission>) -> Vec<PermissionInfo> {
    let missing = permissions::missing(requested, granted);
    let mut v: Vec<PermissionInfo> = requested
        .iter()
        .map(|p| PermissionInfo { permission: p.clone(), risk: p.risk(), description: p.describe(), granted: !missing.contains(p) })
        .collect();
    v.sort_by(|a, b| b.risk.cmp(&a.risk).then(a.permission.cmp(&b.permission)));
    v
}

#[allow(clippy::too_many_arguments)]
fn build_plan(
    kind: PluginInstallKind,
    entry: &PluginIndexEntry,
    source: &SourceRow,
    resolved: ResolvedVersion,
    from_version: Option<String>,
    granted: &BTreeSet<Permission>,
    opts: &SourceOptions,
) -> Result<PluginInstallPlan> {
    check_archive_url(&resolved.url, opts.allow_dev_urls)?;
    if is_bare_id(&entry.id) && !source.builtin {
        return Err(CoreError::invalid_input(format!(
            "plugin id {:?} is reserved for official plugins; source {} may only offer \"<publisher>.<name>\" ids",
            entry.id, source.url
        )));
    }
    let isolation = isolation_for(&entry.id, source);
    if isolation == Isolation::Sandboxed {
        let forbidden: Vec<String> =
            resolved.permissions.iter().filter(|p| p.forbidden_for_sandbox()).map(|p| p.to_string()).collect();
        if !forbidden.is_empty() {
            return Err(CoreError::permission_denied(format!(
                "{} requests {} which third-party plugins may not hold; install refused",
                entry.id,
                forbidden.join(", ")
            )));
        }
    }
    let added = permissions::missing(&resolved.permissions, granted);
    let removed: BTreeSet<Permission> =
        granted.iter().filter(|g| !resolved.permissions.iter().any(|q| g.satisfies(q))).cloned().collect();
    let needs_consent = match kind {
        PluginInstallKind::Install => true,
        PluginInstallKind::Update => !added.is_empty(),
    };
    Ok(PluginInstallPlan {
        plan_id: crate::new_id().to_string(),
        kind,
        plugin_id: entry.id.clone(),
        name: entry.name.clone(),
        description: Some(entry.description.clone()),
        source_id: source.id.clone(),
        source_name: source.name.clone(),
        version: resolved.version.clone(),
        from_version,
        url: resolved.url.clone(),
        sha256: resolved.sha256.clone(),
        size: resolved.size,
        api_version: resolved.api_version.clone(),
        isolation,
        requires_trust: resolved.permissions.iter().any(|p| p.risk() == Risk::Critical),
        permissions: permission_infos(&resolved.permissions, granted),
        added_permissions: added.into_iter().collect(),
        removed_permissions: removed.into_iter().collect(),
        needs_consent,
        notes: resolved.notes,
    })
}

/// Plan installing `plugin_id` (highest compatible version, or `version`).
pub fn plan_install(
    db: &AppDb,
    paths: &AppPaths,
    opts: &SourceOptions,
    source: Option<&str>,
    plugin_id: &str,
    version: Option<&str>,
) -> Result<PluginInstallPlan> {
    let reg = reload(paths, db, opts)?;
    let mut from_version = None;
    if let Some(p) = reg.get(plugin_id) {
        match p.origin {
            PluginOrigin::Installed => {
                return Err(CoreError::conflict(format!("plugin {plugin_id:?} is already installed; use update")))
            }
            PluginOrigin::Dev => {
                return Err(CoreError::conflict(format!("plugin {plugin_id:?} is loaded from a dev folder")))
            }
            // An installed copy of a bundled plugin overrides it (out-of-band update).
            PluginOrigin::Bundled => from_version = p.manifest.as_ref().map(|m| m.version.clone()),
        }
    }
    let (src, entry) = find_entry(db, paths, opts, source, plugin_id)?;
    let resolved = entry.select(version, &opts.host()).map_err(CoreError::incompatible)?;
    build_plan(PluginInstallKind::Install, &entry, &src, resolved, from_version, &BTreeSet::new(), opts)
}

/// The newest compatible version in `entry` newer than `current`, if any.
fn newer(entry: &PluginIndexEntry, current: &str, opts: &SourceOptions) -> Option<ResolvedVersion> {
    let r = entry.select(None, &opts.host()).ok()?;
    let cur = semver::Version::parse(current).ok();
    let new = semver::Version::parse(&r.version).ok()?;
    cur.is_none_or(|c| new > c).then_some(r)
}

/// The source an existing plugin updates from, plus its current version and grants.
fn update_source(
    db: &AppDb,
    reg: &PluginRegistry,
    opts: &SourceOptions,
    id: &str,
) -> Result<(SourceRow, String, BTreeSet<Permission>, PluginOrigin)> {
    super::ensure_builtin(db, opts)?;
    let p = reg.require(id)?;
    let current = p
        .manifest
        .as_ref()
        .map(|m| m.version.clone())
        .ok_or_else(|| CoreError::invalid_input(format!("plugin {id:?} has no valid manifest")))?;
    match p.origin {
        PluginOrigin::Installed => {
            let row = read_row(db, id)?.ok_or_else(|| CoreError::not_found(format!("plugin {id:?}")))?;
            let sid = row
                .source_id
                .ok_or_else(|| CoreError::invalid_input(format!("plugin {id:?} is not linked to a source (it was removed)")))?;
            Ok((read_source(db, &sid)?, current, p.granted.clone(), p.origin))
        }
        PluginOrigin::Bundled => Ok((read_source(db, super::BUILTIN_SOURCE_ID)?, current, p.granted.clone(), p.origin)),
        PluginOrigin::Dev => Err(CoreError::invalid_input(format!("plugin {id:?} is a dev plugin; it reloads from its folder"))),
    }
}

/// Plan updating `id` to the newest compatible version in its source.
/// `not_found` when it is up to date.
pub fn plan_update(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: &str) -> Result<PluginInstallPlan> {
    let reg = reload(paths, db, opts)?;
    let (src, current, granted, origin) = update_source(db, &reg, opts, id)?;
    let (src, entry) = find_entry(db, paths, opts, Some(&src.id), id)?;
    if origin == PluginOrigin::Bundled && !entry.bundled {
        return Err(CoreError::not_found(format!("no update for bundled plugin {id:?}")));
    }
    let resolved =
        newer(&entry, &current, opts).ok_or_else(|| CoreError::not_found(format!("plugin {id:?} is up to date ({current})")))?;
    build_plan(PluginInstallKind::Update, &entry, &src, resolved, Some(current), &granted, opts)
}

// ---------------------------------------------------------------------------
// confirm (download → verify → extract → validate → switch)
// ---------------------------------------------------------------------------

/// Apply a plan the user approved with `granted` permissions. Installs need every
/// requested permission; updates need every added one (else `permission_denied`
/// and nothing changes — the old version keeps running).
pub fn confirm(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, plan: &PluginInstallPlan, granted: &[String]) -> Result<PluginInfo> {
    let approved: BTreeSet<Permission> =
        granted.iter().map(|s| Permission::parse(s).map_err(CoreError::invalid_input)).collect::<Result<_>>()?;
    let requested: BTreeSet<Permission> = plan.permissions.iter().map(|p| p.permission.clone()).collect();
    let required: BTreeSet<Permission> = match plan.kind {
        PluginInstallKind::Install => requested.clone(),
        PluginInstallKind::Update => plan.added_permissions.iter().cloned().collect(),
    };
    let missing = permissions::missing(&required, &approved);
    if !missing.is_empty() {
        let list: Vec<String> = missing.iter().map(|p| p.to_string()).collect();
        return Err(CoreError::permission_denied(format!(
            "consent required: {} {} needs {}",
            plan.plugin_id,
            plan.version,
            list.join(", ")
        ))
        .with_details(serde_json::json!({ "missingPermissions": list })));
    }

    // The plugin must still be in the state the plan was made for.
    let row = read_row(db, &plan.plugin_id)?;
    let installed_row = row.as_ref().filter(|r| r.origin == "installed");
    if plan.kind == PluginInstallKind::Update {
        let reg = reload(paths, db, opts)?;
        let cur = reg.get(&plan.plugin_id).and_then(|p| p.manifest.as_ref()).map(|m| m.version.clone());
        if cur != plan.from_version {
            return Err(CoreError::conflict(format!("plugin {} changed since the update was planned", plan.plugin_id)));
        }
    } else if installed_row.is_some() {
        return Err(CoreError::conflict(format!("plugin {} is already installed", plan.plugin_id)));
    }
    let src = read_source(db, &plan.source_id)?;
    if isolation_for(&plan.plugin_id, &src) == Isolation::Sandboxed && requested.iter().any(Permission::forbidden_for_sandbox) {
        return Err(CoreError::permission_denied(format!("{} requests permissions sandboxed plugins may not hold", plan.plugin_id)));
    }

    let id_dir = paths.plugins_dir.join(&plan.plugin_id);
    std::fs::create_dir_all(&id_dir).map_err(|e| CoreError::io(&id_dir, e))?;
    let tag = crate::new_id().to_string();
    let zip = id_dir.join(format!(".download-{tag}.zip"));
    let staging = id_dir.join(format!(".staging-{}-{tag}", plan.version));
    let cleanup = |also_zip: bool| {
        let _ = std::fs::remove_dir_all(&staging);
        if also_zip {
            let _ = std::fs::remove_file(&zip);
        }
    };

    download_verified(&plan.url, &zip, &plan.sha256, plan.size, ARCHIVE_MAX_BYTES, opts.download_timeout)?;
    let staged = (|| -> Result<()> {
        extract_zip(&zip, &staging)?;
        if !staging.join(MANIFEST_FILE).is_file() {
            return Err(integrity_error(format!("archive root has no {MANIFEST_FILE}")));
        }
        let report = validate_plugin_dir(&staging, PluginOrigin::Installed, src.builtin, &opts.load);
        let Some(m) = report.manifest.as_ref().filter(|_| report.is_valid()) else {
            return Err(CoreError::invalid_input(format!("archive contains an invalid plugin: {}", report.summary()))
                .with_details(serde_json::to_value(&report.errors).unwrap_or_default()));
        };
        if m.id != plan.plugin_id || m.version != plan.version {
            return Err(integrity_error(format!(
                "archive contains {} {} but the index lists {} {}",
                m.id, m.version, plan.plugin_id, plan.version
            )));
        }
        if m.requested_permissions() != requested {
            return Err(integrity_error("manifest permissions differ from the index entry"));
        }
        Ok(())
    })();
    if let Err(e) = staged {
        cleanup(true);
        return Err(e);
    }
    let _ = std::fs::remove_file(&zip);

    let final_dir = id_dir.join(&plan.version);
    let previous = installed_row.map(|r| PathBuf::from(&r.install_path));
    if final_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&final_dir) {
            cleanup(false);
            return Err(CoreError::io(&final_dir, e));
        }
    }
    if let Err(e) = std::fs::rename(&staging, &final_dir) {
        cleanup(false);
        return Err(CoreError::io(&final_dir, e));
    }

    // Final grants: new requested ∩ (already granted ∪ approved); removed ones revoked.
    // (An update of a bundled plugin starts from the bundled grants in its row.)
    let old: BTreeSet<Permission> = match (plan.kind, row.as_ref()) {
        (PluginInstallKind::Update, Some(r)) => r.granted.clone(),
        _ => BTreeSet::new(),
    };
    let have: BTreeSet<Permission> = old.union(&approved).cloned().collect();
    let final_granted: BTreeSet<Permission> =
        requested.iter().filter(|q| have.iter().any(|g| g.satisfies(q))).cloned().collect();
    let now = now_ms();
    let install_path = final_dir.display().to_string();
    db.write(&[change(&plan.plugin_id)], |tx| {
        tx.execute(
            "INSERT INTO plugins (id, source_id, origin, version, install_path, enabled, status, status_detail, granted_permissions,
                                  available_update, installed_at, updated_at)
             VALUES (?1, ?2, 'installed', ?3, ?4, 1, 'active', NULL, ?5, NULL, ?6, ?6)
             ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, origin = 'installed', version = excluded.version,
                 install_path = excluded.install_path, granted_permissions = excluded.granted_permissions,
                 available_update = NULL, updated_at = excluded.updated_at",
            rusqlite::params![plan.plugin_id, plan.source_id, plan.version, install_path, perms_json(&final_granted), now],
        )
    })?;
    prune_versions(&id_dir, &final_dir, previous.as_deref());
    Ok(reload(paths, db, opts)?.require(&plan.plugin_id)?.info())
}

/// Keep `current` and at most one `previous` version directory; delete the rest
/// and stale download/staging leftovers.
fn prune_versions(id_dir: &Path, current: &Path, previous: Option<&Path>) {
    let Ok(rd) = std::fs::read_dir(id_dir) else { return };
    let same = |a: &Path, b: &Path| dunce::canonicalize(a).ok().zip(dunce::canonicalize(b).ok()).is_some_and(|(x, y)| x == y);
    for e in rd.flatten() {
        let p = e.path();
        if same(&p, current) || previous.is_some_and(|prev| same(&p, prev)) {
            continue;
        }
        let r = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        if let Err(err) = r {
            tracing::warn!("could not remove old plugin files {}: {err}", p.display());
        }
    }
}

/// Switch an installed plugin back to its previous version directory.
pub fn rollback(db: &AppDb, paths: &AppPaths, opts: &SourceOptions, id: &str) -> Result<PluginInfo> {
    let row = read_row(db, id)?
        .filter(|r| r.origin == "installed")
        .ok_or_else(|| CoreError::invalid_input(format!("plugin {id:?} is not an installed plugin")))?;
    let id_dir = paths.plugins_dir.join(id);
    let current = PathBuf::from(&row.install_path);
    let official = match &row.source_id {
        Some(s) => read_source(db, s).map(|s| s.builtin).unwrap_or(false),
        None => false,
    };
    let mut best: Option<(semver::Version, PathBuf, BTreeSet<Permission>)> = None;
    for e in std::fs::read_dir(&id_dir).map_err(|e| CoreError::io(&id_dir, e))?.flatten() {
        let p = e.path();
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let Ok(v) = semver::Version::parse(&name) else { continue };
        if p == current || !p.join(MANIFEST_FILE).is_file() {
            continue;
        }
        let report = validate_plugin_dir(&p, PluginOrigin::Installed, official, &opts.load);
        let Some(m) = report.manifest.as_ref().filter(|m| report.is_valid() && m.id == id) else { continue };
        if best.as_ref().is_none_or(|(b, _, _)| v > *b) {
            best = Some((v, p.clone(), m.requested_permissions()));
        }
    }
    let (v, dir, requested) =
        best.ok_or_else(|| CoreError::not_found(format!("plugin {id:?} has no previous version to roll back to")))?;
    let granted: BTreeSet<Permission> = row.granted.iter().filter(|g| requested.iter().any(|q| g.satisfies(q))).cloned().collect();
    let now = now_ms();
    db.write(&[change(id)], |tx| {
        tx.execute(
            "UPDATE plugins SET version = ?2, install_path = ?3, granted_permissions = ?4, available_update = NULL, updated_at = ?5 WHERE id = ?1",
            rusqlite::params![id, v.to_string(), dir.display().to_string(), perms_json(&granted), now],
        )
    })?;
    Ok(reload(paths, db, opts)?.require(id)?.info())
}

// ---------------------------------------------------------------------------
// update checks
// ---------------------------------------------------------------------------

/// Recompute `available_update` for every installed (and bundled) plugin from
/// the cached indexes (no network; refresh sources first for fresh data).
pub fn check_updates(db: &AppDb, paths: &AppPaths, opts: &SourceOptions) -> Result<Vec<PluginUpdateInfo>> {
    super::ensure_builtin(db, opts)?;
    let reg = reload(paths, db, opts)?;
    let sources = read_sources(db)?;
    let mut writes: Vec<(String, Option<String>)> = Vec::new();
    let mut out = Vec::new();
    for p in reg.all() {
        let Some(m) = &p.manifest else { continue };
        let row = read_row(db, &p.id)?;
        let source = match p.origin {
            PluginOrigin::Installed => row.as_ref().and_then(|r| r.source_id.clone()),
            PluginOrigin::Bundled => Some(super::BUILTIN_SOURCE_ID.to_string()),
            PluginOrigin::Dev => None,
        };
        let src = source.and_then(|s| sources.iter().find(|x| x.id == s && x.enabled).cloned());
        let info = src.and_then(|s| {
            let entry = cached_index(paths, &s.id)?.plugins.into_iter().find(|e| e.id == p.id)?;
            if p.origin == PluginOrigin::Bundled && !entry.bundled {
                return None;
            }
            let r = newer(&entry, &m.version, opts)?;
            let added = permissions::missing(&r.permissions, &p.granted);
            let removed: Vec<Permission> =
                p.granted.iter().filter(|g| !r.permissions.iter().any(|q| g.satisfies(q))).cloned().collect();
            Some(PluginUpdateInfo {
                plugin_id: p.id.clone(),
                current_version: m.version.clone(),
                version: r.version,
                source_id: s.id.clone(),
                url: r.url,
                sha256: r.sha256,
                permissions: r.permissions.into_iter().collect(),
                needs_consent: !added.is_empty(),
                added_permissions: added.into_iter().collect(),
                removed_permissions: removed,
                notes: r.notes,
            })
        });
        let json = info.as_ref().and_then(|i| serde_json::to_string(i).ok());
        if let Some(r) = &row {
            if r.available_update != json {
                writes.push((p.id.clone(), json));
            }
        }
        out.extend(info);
    }
    if !writes.is_empty() {
        let changes: Vec<AppChange> = writes.iter().map(|(id, _)| change(id)).collect();
        db.write(&changes, |tx| {
            for (id, json) in &writes {
                tx.execute("UPDATE plugins SET available_update = ?2 WHERE id = ?1", rusqlite::params![id, json])?;
            }
            Ok(())
        })?;
    }
    Ok(out)
}

/// Stored `available_update`s (no recomputation, no network).
pub fn available_updates(db: &AppDb) -> Result<Vec<PluginUpdateInfo>> {
    let raw: Vec<String> = db.read(|c| {
        let mut s = c.prepare("SELECT available_update FROM plugins WHERE available_update IS NOT NULL ORDER BY id")?;
        let rows = s.query_map([], |r| r.get(0))?;
        rows.collect()
    })?;
    Ok(raw.iter().filter_map(|s| serde_json::from_str(s).ok()).collect())
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/// Uninstall an installed plugin: delete its files, its `plugins` row, `plugin_kv`
/// rows, `plugin:<id>` settings, keychain entries `plugin:<id>:*` and tool configs
/// (tile instances cascade). `delete_data` also removes `<appData>/plugin-data/<id>/`.
/// Project-scoped `.quadflow/plugins/<id>/` is never touched. Bundled plugins can
/// only be disabled; removing an installed override of a bundled plugin reverts
/// to the bundled copy and keeps its data.
pub fn uninstall(
    db: &AppDb,
    paths: &AppPaths,
    secrets: &Secrets,
    opts: &SourceOptions,
    id: &str,
    delete_data: bool,
) -> Result<PluginUninstallResult> {
    let reg = reload(paths, db, opts)?;
    let p = reg.require(id)?;
    let row = read_row(db, id)?;
    let installed = row.as_ref().is_some_and(|r| r.origin == "installed");
    match p.origin {
        PluginOrigin::Dev if !installed => {
            return Err(CoreError::invalid_input(format!("plugin {id:?} is a dev plugin; remove its folder from the dev paths")))
        }
        PluginOrigin::Bundled if !installed => {
            return Err(CoreError::invalid_input(format!("plugin {id:?} is bundled with QuadFlow; it can be disabled, not uninstalled")))
        }
        _ => {}
    }
    let has_bundled = p.origin == PluginOrigin::Bundled || p.shadowed.iter().any(|s| s.origin == PluginOrigin::Bundled);
    let wipe = !has_bundled;

    let id_dir = paths.plugins_dir.join(id);
    if id_dir.exists() {
        std::fs::remove_dir_all(&id_dir).map_err(|e| CoreError::io(&id_dir, e))?;
    }
    let secret_names = if wipe { plugin_secret_names(db, id)? } else { vec![] };
    let settings_ns = format!("plugin:{id}");

    let (tool_configs, kv, settings) = db.transact(|tx, ch| {
        tx.execute("DELETE FROM plugins WHERE id = ?1", [id])?;
        ch.push(AppChange::new(Domain::Plugins, ChangeKind::Deleted, Some(id)));
        if !wipe {
            return Ok((0, 0, 0));
        }
        let kv = tx.execute("DELETE FROM plugin_kv WHERE plugin_id = ?1", [id])?;
        if kv > 0 {
            ch.push(AppChange::new(Domain::PluginData, ChangeKind::Deleted, Some(id)));
        }
        let keys: Vec<String> = {
            let mut s = tx.prepare("SELECT key FROM settings WHERE namespace = ?1")?;
            let rows = s.query_map([&settings_ns], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let settings = tx.execute("DELETE FROM settings WHERE namespace = ?1", [&settings_ns])?;
        for k in &keys {
            ch.push(AppChange::new(Domain::Settings, ChangeKind::Deleted, Some(format!("{settings_ns}/{k}"))));
        }
        if tx.execute("DELETE FROM settings WHERE namespace = ?1 AND key = ?2", rusqlite::params![SECRET_INDEX_NAMESPACE, id])? > 0 {
            ch.push(AppChange::new(Domain::Settings, ChangeKind::Deleted, Some(format!("{SECRET_INDEX_NAMESPACE}/{id}"))));
        }
        let ids: Vec<String> = {
            let mut s = tx.prepare("SELECT id FROM tool_configs WHERE plugin_id = ?1")?;
            let rows = s.query_map([id], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        tx.execute("DELETE FROM tool_configs WHERE plugin_id = ?1", [id])?;
        for t in &ids {
            ch.push(AppChange::new(Domain::ToolConfigs, ChangeKind::Deleted, Some(t.as_str())));
        }
        Ok((ids.len() as u32, kv as u32, settings as u32))
    })?;

    let mut removed_secrets = 0;
    for name in &secret_names {
        match secrets.delete(&secret_key(id, name)) {
            Ok(true) => removed_secrets += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("could not delete secret {}: {e}", secret_key(id, name)),
        }
    }
    let mut deleted_data_dir = false;
    if delete_data && wipe {
        let d = paths.plugin_data_dir.join(id);
        if d.exists() {
            std::fs::remove_dir_all(&d).map_err(|e| CoreError::io(&d, e))?;
            deleted_data_dir = true;
        }
    }
    reload(paths, db, opts)?;
    Ok(PluginUninstallResult {
        plugin_id: id.to_string(),
        reverted_to_bundled: !wipe,
        removed_tool_configs: tool_configs,
        removed_kv_entries: kv,
        removed_settings: settings,
        removed_secrets,
        deleted_data_dir,
    })
}

// ---------------------------------------------------------------------------
// plugin secret names index
// ---------------------------------------------------------------------------

/// Keychain key of a plugin secret: `plugin:<id>:<name>`.
pub fn secret_key(plugin_id: &str, name: &str) -> String {
    format!("plugin:{plugin_id}:{name}")
}

/// Names recorded for `plugin_id`.
pub fn plugin_secret_names(db: &AppDb, plugin_id: &str) -> Result<Vec<String>> {
    Ok(crate::domains::app::settings::get_value(db, SECRET_INDEX_NAMESPACE, plugin_id)?
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default())
}

/// Record that `plugin_id` stored secret `name` (call on every host `secrets.set`).
pub fn record_plugin_secret(db: &AppDb, plugin_id: &str, name: &str) -> Result<()> {
    let mut names = plugin_secret_names(db, plugin_id)?;
    if !names.iter().any(|n| n == name) {
        names.push(name.to_string());
        names.sort();
        crate::domains::app::settings::set(db, SECRET_INDEX_NAMESPACE, plugin_id, serde_json::json!(names))?;
    }
    Ok(())
}

/// Forget `name` (call on host `secrets.delete`).
pub fn forget_plugin_secret(db: &AppDb, plugin_id: &str, name: &str) -> Result<()> {
    let mut names = plugin_secret_names(db, plugin_id)?;
    let before = names.len();
    names.retain(|n| n != name);
    if names.len() != before {
        crate::domains::app::settings::set(db, SECRET_INDEX_NAMESPACE, plugin_id, serde_json::json!(names))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::testkit::*;
    use super::*;
    use crate::plugins::PluginStatus;
    use serde_json::json;

    fn installed_version(env: &Env, id: &str) -> Option<String> {
        reload(&env.app.paths, &env.app.db, &env.opts).unwrap().get(id).and_then(|p| p.manifest.as_ref().map(|m| m.version.clone()))
    }

    #[test]
    fn install_happy_path() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &["notifications", "network:api.example.com"], None);
        let s = super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, Some(&s.id), "acme.hello", None).unwrap();
        assert_eq!(plan.version, "1.0.0");
        assert_eq!(plan.isolation, Isolation::Sandboxed);
        assert!(plan.needs_consent);
        assert_eq!(plan.permissions.len(), 2);
        // Install without consent is refused and leaves nothing behind.
        let e = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::PermissionDenied);
        assert!(!env.app.paths.plugins_dir.join("acme.hello").join("1.0.0").exists());
        let all: Vec<String> = plan.permissions.iter().map(|p| p.permission.to_string()).collect();
        let info = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &all).unwrap();
        assert_eq!(info.status, PluginStatus::Active, "{info:?}");
        assert_eq!(info.origin, PluginOrigin::Installed);
        assert!(env.app.paths.plugins_dir.join("acme.hello/1.0.0").join(MANIFEST_FILE).is_file());
        // No leftovers.
        let leftovers: Vec<_> = std::fs::read_dir(env.app.paths.plugins_dir.join("acme.hello"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty());
        // Second install = conflict.
        assert_eq!(
            plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.hello", None).unwrap_err().code,
            crate::ErrorCode::Conflict
        );
    }

    #[test]
    fn tampered_archive_rejected() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &[], None);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.hello", None).unwrap();
        // Flip bytes in the published archive after the index was written (same size).
        let zip = src.archive_path("acme.hello", "1.0.0");
        let mut bytes = std::fs::read(&zip).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        std::fs::write(&zip, &bytes).unwrap();
        let e = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Corrupt, "{e}");
        assert!(e.message.contains("sha256"), "{e}");
        assert_eq!(e.details.as_ref().unwrap()["integrity"], json!(true));
        assert!(installed_version(&env, "acme.hello").is_none());
        let dir = env.app.paths.plugins_dir.join("acme.hello");
        assert!(std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0) == 0, "download deleted");

        // A plan whose digest was tampered with (index lies about the hash) fails too.
        let mut bad = plan.clone();
        bad.sha256 = "0".repeat(64);
        assert_eq!(confirm(&env.app.db, &env.app.paths, &env.opts, &bad, &[]).unwrap_err().code, crate::ErrorCode::Corrupt);
        // Wrong size.
        let mut bad = plan.clone();
        bad.size += 1;
        assert!(confirm(&env.app.db, &env.app.paths, &env.opts, &bad, &[]).unwrap_err().message.contains("integrity"));
    }

    #[test]
    fn zip_slip_archive_rejected_at_install() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish_files(
            "acme.evil",
            "1.0.0",
            &[],
            vec![("../../escape.txt".to_string(), b"x".to_vec())],
        );
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.evil", None).unwrap();
        let e = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap_err();
        assert!(e.message.contains("parent directory"), "{e}");
        assert!(!env.app.paths.plugins_dir.join("escape.txt").exists());
        assert!(!env.app.dir.path().join("escape.txt").exists());
    }

    #[test]
    fn manifest_must_match_index() {
        let env = Env::new();
        let src = env.fake_source();
        // Index says no permissions; the archive's manifest asks for terminal:spawn.
        src.publish_with_manifest_perms("acme.sneaky", "1.0.0", &[], &["terminal:spawn"]);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.sneaky", None).unwrap();
        let e = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap_err();
        assert!(e.message.contains("permissions differ"), "{e}");
        assert!(installed_version(&env, "acme.sneaky").is_none());
    }

    #[test]
    fn sandbox_forbidden_permissions_refused_at_plan() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.embed", "1.0.0", &["native:windows"], None);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let e = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.embed", None).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::PermissionDenied);
    }

    fn install(env: &Env, id: &str) -> PluginInfo {
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, None, id, None).unwrap();
        let all: Vec<String> = plan.permissions.iter().map(|p| p.permission.to_string()).collect();
        confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &all).unwrap()
    }

    #[test]
    fn permission_adding_update_requires_consent() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &["notifications"], None);
        let s = super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        install(&env, "acme.hello");

        // 1.1.0 adds a network permission.
        src.publish("acme.hello", "1.1.0", &["notifications", "network:api.example.com"], Some("adds sync"));
        super::super::refresh(&env.app.db, &env.app.paths, &env.opts, Some(&s.id)).unwrap();
        let ups = check_updates(&env.app.db, &env.app.paths, &env.opts).unwrap();
        assert_eq!(ups.len(), 1);
        assert!(ups[0].needs_consent);
        assert_eq!(ups[0].added_permissions[0].as_str(), "network:api.example.com");
        assert_eq!(available_updates(&env.app.db).unwrap(), ups, "stored for the Plugins page");

        let plan = plan_update(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap();
        assert_eq!(plan.kind, PluginInstallKind::Update);
        assert!(plan.needs_consent);
        assert_eq!(plan.from_version.as_deref(), Some("1.0.0"));
        // Declined (no grant for the added permission) → stays on 1.0.0, still active.
        let e = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &["notifications".into()]).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::PermissionDenied);
        assert_eq!(e.details.as_ref().unwrap()["missingPermissions"], json!(["network:api.example.com"]));
        let reg = reload(&env.app.paths, &env.app.db, &env.opts).unwrap();
        let p = reg.get("acme.hello").unwrap();
        assert_eq!(p.manifest.as_ref().unwrap().version, "1.0.0");
        assert_eq!(p.status, PluginStatus::Active);
        // Approved → switched; the grant includes the new permission.
        let info = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &["network:api.example.com".into()]).unwrap();
        assert_eq!(info.version.as_deref(), Some("1.1.0"));
        assert_eq!(info.status, PluginStatus::Active, "{info:?}");
        assert!(info.granted_permissions.iter().any(|p| p.as_str() == "network:api.example.com"));
        assert!(available_updates(&env.app.db).unwrap().is_empty());
    }

    #[test]
    fn update_without_new_permissions_needs_no_consent_and_revokes_removed() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &["notifications", "clipboard:write"], None);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        install(&env, "acme.hello");
        src.publish("acme.hello", "1.2.0", &["notifications"], None);
        super::super::refresh(&env.app.db, &env.app.paths, &env.opts, None).unwrap();
        let plan = plan_update(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap();
        assert!(!plan.needs_consent);
        assert_eq!(plan.removed_permissions[0].as_str(), "clipboard:write");
        let info = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap();
        assert_eq!(info.version.as_deref(), Some("1.2.0"));
        assert_eq!(info.granted_permissions.len(), 1);
        // Up to date now.
        assert_eq!(plan_update(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap_err().code, crate::ErrorCode::NotFound);

        // Rollback goes to 1.0.0 (the one kept previous version); clipboard stays revoked.
        let info = rollback(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap();
        assert_eq!(info.version.as_deref(), Some("1.0.0"));
        assert_eq!(info.status, PluginStatus::NeedsConsent, "clipboard:write was revoked by the update");

        // A third version prunes to exactly current + previous.
        rollback(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap(); // back to 1.2.0
        src.publish("acme.hello", "1.3.0", &["notifications"], None);
        super::super::refresh(&env.app.db, &env.app.paths, &env.opts, None).unwrap();
        let plan = plan_update(&env.app.db, &env.app.paths, &env.opts, "acme.hello").unwrap();
        confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &[]).unwrap();
        let mut dirs: Vec<String> = std::fs::read_dir(env.app.paths.plugins_dir.join("acme.hello"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        dirs.sort();
        assert_eq!(dirs, vec!["1.2.0", "1.3.0"]);
    }

    #[test]
    fn uninstall_removes_kv_settings_secrets_tool_configs() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &["secrets"], None);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        install(&env, "acme.hello");
        let db = &env.app.db;
        let secrets = Secrets::memory();
        let now = now_ms();
        db.write(&[], |tx| {
            tx.execute(
                "INSERT INTO plugin_kv (plugin_id, scope, key, value, updated_at) VALUES ('acme.hello','global','k','1',?1),
                 ('acme.hello','project:x','k2','2',?1), ('other.plugin','global','k','3',?1)",
                [now],
            )?;
            tx.execute(
                "INSERT INTO tool_configs (id, plugin_id, contribution_id, name, created_at, updated_at)
                 VALUES ('tc1','acme.hello','main','Hello',?1,?1), ('tc2','other.plugin','main','Other',?1,?1)",
                [now],
            )?;
            tx.execute(
                "INSERT INTO global_workspaces (id, name, created_at, updated_at) VALUES ('gw1', 'G', ?1, ?1)",
                [now],
            )?;
            tx.execute(
                "INSERT INTO tile_instances (id, global_workspace_id, tool_config_id, title, created_at)
                 VALUES ('ti1', 'gw1', 'tc1', 'Hello', ?1)",
                [now],
            )?;
            Ok(())
        })
        .unwrap();
        crate::domains::app::settings::set(db, "plugin:acme.hello", "color", json!("red")).unwrap();
        crate::domains::app::settings::set(db, "plugin:other.plugin", "color", json!("blue")).unwrap();
        secrets.set(&secret_key("acme.hello", "token"), "s3cret").unwrap();
        record_plugin_secret(db, "acme.hello", "token").unwrap();
        secrets.set(&secret_key("other.plugin", "token"), "keep").unwrap();
        let data = env.app.paths.plugin_data_dir.join("acme.hello");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("cache.bin"), b"x").unwrap();

        let r = uninstall(db, &env.app.paths, &secrets, &env.opts, "acme.hello", true).unwrap();
        assert!(!r.reverted_to_bundled);
        assert_eq!((r.removed_tool_configs, r.removed_kv_entries, r.removed_settings, r.removed_secrets), (1, 2, 1, 1));
        assert!(r.deleted_data_dir);
        let count = |sql: &str| -> i64 { db.read(|c| c.query_row(sql, [], |r| r.get(0))).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM plugins WHERE id='acme.hello'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM plugin_kv WHERE plugin_id='acme.hello'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM plugin_kv WHERE plugin_id='other.plugin'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM settings WHERE namespace='plugin:acme.hello'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM settings WHERE namespace='plugin:other.plugin'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM settings WHERE namespace='plugins.secrets'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tool_configs WHERE plugin_id='acme.hello'"), 0);
        assert_eq!(count("SELECT COUNT(*) FROM tool_configs WHERE plugin_id='other.plugin'"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM tile_instances"), 0, "tile instances cascade");
        assert_eq!(secrets.get(&secret_key("acme.hello", "token")).unwrap(), None);
        assert_eq!(secrets.get(&secret_key("other.plugin", "token")).unwrap().as_deref(), Some("keep"));
        assert!(!env.app.paths.plugins_dir.join("acme.hello").exists());
        assert!(!data.exists());
        assert!(reload(&env.app.paths, db, &env.opts).unwrap().get("acme.hello").is_none());
    }

    #[test]
    fn bundled_plugins_cannot_be_uninstalled_and_overrides_revert() {
        let env = Env::new();
        env.bundled_with("issues", "1.0.0", &["data:issues:write"]);
        let src = env.fake_source();
        src.publish("issues", "1.5.0", &["data:issues:write", "notifications"], None);
        src.mark_bundled("issues");
        // Bare ids need the built-in source.
        let mut env = env;
        env.opts.builtin_url = src.url();
        let secrets = Secrets::memory();
        let e = uninstall(&env.app.db, &env.app.paths, &secrets, &env.opts, "issues", false).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::InvalidInput);

        super::super::refresh(&env.app.db, &env.app.paths, &env.opts, None).unwrap();
        let ups = check_updates(&env.app.db, &env.app.paths, &env.opts).unwrap();
        assert_eq!(ups.len(), 1, "bundled plugin gets an out-of-band update from the built-in index");
        let plan = plan_update(&env.app.db, &env.app.paths, &env.opts, "issues").unwrap();
        assert_eq!(plan.isolation, Isolation::Trusted);
        assert_eq!(plan.added_permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(), vec!["notifications"]);
        let info = confirm(&env.app.db, &env.app.paths, &env.opts, &plan, &["notifications".into()]).unwrap();
        assert_eq!(info.origin, PluginOrigin::Installed);
        assert_eq!(info.version.as_deref(), Some("1.5.0"));
        assert_eq!(info.status, PluginStatus::Active, "bundled grants carry over: {info:?}");
        assert_eq!(info.granted_permissions.len(), 2);
        crate::domains::app::settings::set(&env.app.db, "plugin:issues", "x", json!(1)).unwrap();

        let r = uninstall(&env.app.db, &env.app.paths, &secrets, &env.opts, "issues", true).unwrap();
        assert!(r.reverted_to_bundled);
        let reg = reload(&env.app.paths, &env.app.db, &env.opts).unwrap();
        let p = reg.get("issues").unwrap();
        assert_eq!(p.origin, PluginOrigin::Bundled);
        assert_eq!(p.status, PluginStatus::Active);
        assert_eq!(crate::domains::app::settings::get_value(&env.app.db, "plugin:issues", "x").unwrap(), Some(json!(1)));
    }

    #[test]
    fn bare_ids_from_third_party_sources_refused() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("ideas", "1.0.0", &[], None);
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let e = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "ideas", None).unwrap_err();
        assert!(e.message.contains("reserved"), "{e}");
    }

    #[test]
    fn incompatible_versions_are_skipped() {
        let env = Env::new();
        let src = env.fake_source();
        src.publish("acme.hello", "1.0.0", &[], None);
        src.publish_api("acme.hello", "2.0.0", "^2.0.0");
        super::super::add(&env.app.db, &env.app.paths, &env.opts, &src.url()).unwrap();
        let plan = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.hello", None).unwrap();
        assert_eq!(plan.version, "1.0.0");
        let e = plan_install(&env.app.db, &env.app.paths, &env.opts, None, "acme.hello", Some("2.0.0")).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Incompatible);
    }

    #[test]
    fn secret_index_round_trip() {
        let env = Env::new();
        record_plugin_secret(&env.app.db, "a.b", "x").unwrap();
        record_plugin_secret(&env.app.db, "a.b", "y").unwrap();
        record_plugin_secret(&env.app.db, "a.b", "x").unwrap();
        assert_eq!(plugin_secret_names(&env.app.db, "a.b").unwrap(), vec!["x", "y"]);
        forget_plugin_secret(&env.app.db, "a.b", "x").unwrap();
        assert_eq!(plugin_secret_names(&env.app.db, "a.b").unwrap(), vec!["y"]);
    }
}
