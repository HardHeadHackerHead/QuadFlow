//! Ship services: config CRUD + validation, init from templates, status,
//! readiness, bump, run (streaming, abortable), run records.

use super::checks;
use super::exec::{self, Exec, ShipContext, ShipSink};
use super::model::*;
use super::sys::{self, ShipCancel};
use super::templates;
use super::versions;
use crate::error::{CoreError, Result};
use crate::ids::{new_id, Id};
use crate::model::{Actor, ListResult};
use crate::store::{ProjectStore, RelPath};
use crate::time::now_ms;
use parking_lot::Mutex;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::OnceLock;

const CONFIG_REL: &str = "ship/config.json";
const CONFIG_BAK_REL: &str = "ship/config.json.bak";

fn config_rel() -> RelPath {
    RelPath::new(CONFIG_REL).expect("valid rel path")
}

pub fn config_path(s: &ProjectStore) -> std::path::PathBuf {
    s.data_dir().join("ship").join("config.json")
}

fn check_format(cfg: &ShipConfig) -> Result<()> {
    if cfg.format_version > SHIP_FORMAT_VERSION {
        return Err(CoreError::incompatible(format!(
            "ship config formatVersion {} was written by a newer QuadFlow (this build reads {SHIP_FORMAT_VERSION})",
            cfg.format_version
        )));
    }
    if cfg.format_version == 0 {
        return Err(CoreError::invalid_input("ship config formatVersion must be 1"));
    }
    Ok(())
}

/// The config, or `None` if the project has none. Unparseable → `corrupt`.
pub fn config_get(s: &ProjectStore) -> Result<Option<ShipConfig>> {
    let cfg: Option<ShipConfig> = s.read_json(&config_rel())?;
    if let Some(c) = &cfg {
        check_format(c)?;
    }
    Ok(cfg)
}

pub fn config_require(s: &ProjectStore) -> Result<ShipConfig> {
    config_get(s)?.ok_or_else(|| {
        CoreError::not_found(format!("no ship config at {}", config_path(s).display()))
            .with_details(serde_json::json!({ "hint": "run `quadflow ship init` (or /setup-ship)" }))
    })
}

/// Replace the config. Structural problems are reported by [`validate`], not here.
pub fn config_save(s: &ProjectStore, actor: &Actor, config: ShipConfig) -> Result<ShipConfig> {
    check_format(&config)?;
    s.write(actor, |tx| tx.put_json(&config_rel(), &config))?;
    Ok(config)
}

/// Move the config to `ship/config.json.bak` (replacing an older backup).
pub fn config_delete(s: &ProjectStore, actor: &Actor) -> Result<ShipConfigDeleteResult> {
    s.write(actor, |tx| {
        let path = config_path(tx.store());
        // Raw bytes, so even an unparseable config can be backed up and removed.
        let Some(bytes) = crate::store::read_file(&path)? else {
            return Ok(ShipConfigDeleteResult { deleted: false, backup_path: None });
        };
        let bak = tx.store().data_dir().join(CONFIG_BAK_REL);
        crate::store::atomic_write(&bak, &bytes)?;
        tx.delete_file(&config_rel())?;
        Ok(ShipConfigDeleteResult { deleted: true, backup_path: Some(bak.display().to_string()) })
    })
}

/// Lint a config: version files, phase names, check ids, required fields,
/// version sync.
pub fn validate_config(cfg: &ShipConfig, project_dir: &Path) -> ShipValidation {
    let mut errors = Vec::new();
    let mut versions_readable = true;
    if cfg.format_version != SHIP_FORMAT_VERSION {
        errors.push(format!("formatVersion must be {SHIP_FORMAT_VERSION}"));
    }
    if cfg.product_name.trim().is_empty() {
        errors.push("productName is empty".into());
    }
    for vf in &cfg.version_files {
        if !project_dir.join(&vf.path).is_file() {
            versions_readable = false;
            errors.push(format!("version file does not exist: {}", vf.path));
        } else if let Err(e) = versions::read_version(project_dir, vf) {
            versions_readable = false;
            errors.push(e.message);
        }
    }
    if cfg.phases.is_empty() {
        errors.push("no phases declared".into());
    }
    let mut names = BTreeSet::new();
    fn walk(phases: &[ShipPhase], cfg: &ShipConfig, names: &mut BTreeSet<String>, errors: &mut Vec<String>) {
        for p in phases {
            let n = p.name();
            if n.trim().is_empty() {
                errors.push(format!("a `{}` phase has an empty name", p.kind()));
            } else if !names.insert(n.to_string()) {
                errors.push(format!("duplicate phase name: {n}"));
            }
            match p {
                ShipPhase::Checks { checks: ids, .. } => {
                    for c in ids {
                        if !checks::is_known_check(c) {
                            errors.push(format!("phase `{n}`: unknown check `{c}`"));
                        }
                    }
                }
                ShipPhase::VersionBump { .. } if cfg.version_files.is_empty() => {
                    errors.push(format!("phase `{n}`: version_bump needs versionFiles"));
                }
                ShipPhase::SignAuthenticode { tool, files, .. } => {
                    if tool.as_deref().map(str::trim).unwrap_or("").is_empty() {
                        errors.push(format!("phase `{n}`: sign_authenticode needs a `tool` (no default)"));
                    }
                    if files.is_empty() {
                        errors.push(format!("phase `{n}`: no files to sign"));
                    }
                }
                ShipPhase::Build { command, .. } | ShipPhase::Shell { command, .. } if command.trim().is_empty() => {
                    errors.push(format!("phase `{n}`: empty command"));
                }
                ShipPhase::GhRelease { repo, .. } | ShipPhase::BuildLatestJson { repo, .. } if !repo.contains('/') => {
                    errors.push(format!("phase `{n}`: repo must be OWNER/NAME"));
                }
                ShipPhase::Parallel { children, .. } | ShipPhase::Sequence { children, .. } => {
                    if children.is_empty() {
                        errors.push(format!("phase `{n}`: no children"));
                    }
                    walk(children, cfg, names, errors);
                }
                _ => {}
            }
        }
    }
    walk(&cfg.phases, cfg, &mut names, &mut errors);
    if versions_readable {
        if let Err(e) = versions::canonical_version(project_dir, cfg) {
            errors.push(e.message);
        }
    }
    ShipValidation { valid: errors.is_empty(), errors }
}

pub fn validate(s: &ProjectStore) -> Result<ShipValidation> {
    Ok(validate_config(&config_require(s)?, &s.root().path))
}

/// Create the config from a template. An existing config is `conflict` unless `force`.
pub fn init(s: &ProjectStore, actor: &Actor, opts: ShipInitOptions) -> Result<ShipConfig> {
    let cfg = templates::build_from_template(&s.root().path, opts.template.as_deref(), &opts.params)?;
    s.write(actor, |tx| {
        if !opts.force && config_path(tx.store()).exists() {
            return Err(CoreError::conflict(format!("ship config already exists at {}", config_path(tx.store()).display()))
                .with_details(serde_json::json!({ "hint": "pass --force to overwrite" })));
        }
        tx.put_json(&config_rel(), &cfg)
    })?;
    Ok(cfg)
}

/// Preview what `init` would write (nothing is written).
pub fn template_preview(s: &ProjectStore, template: &str, params: &std::collections::BTreeMap<String, String>) -> Result<ShipConfig> {
    templates::build_from_template(&s.root().path, Some(template), params)
}

pub fn status(s: &ProjectStore) -> Result<ShipStatus> {
    let cfg = config_require(s)?;
    let dir = &s.root().path;
    let canonical = versions::canonical_version(dir, &cfg);
    Ok(ShipStatus {
        in_sync: canonical.is_ok(),
        canonical_version: canonical.ok().flatten(),
        version_files: versions::read_all(dir, &cfg),
        last_run: runs_list(s)?.items.into_iter().next(),
        branch: sys::git_branch(dir).ok(),
        git_clean: sys::git_clean(dir).ok(),
    })
}

/// Readiness report; a project without a config has no checks.
pub fn readiness(s: &ProjectStore) -> Result<Vec<ShipReadinessCheck>> {
    match config_get(s)? {
        None => Ok(Vec::new()),
        Some(cfg) => Ok(checks::evaluate_readiness(&s.root().path, &cfg)),
    }
}

pub fn readiness_one(s: &ProjectStore, check_id: &str) -> Result<ShipReadinessCheck> {
    let cfg = config_require(s)?;
    let from_config = checks::readiness_ids(&cfg).into_iter().any(|(id, fc)| id == check_id && fc);
    Ok(checks::evaluate(&s.root().path, check_id, &cfg, from_config))
}

/// Run a failing check's own `fixCommand` (never an arbitrary command),
/// streaming output to `on_line`, then re-evaluate the check.
pub fn run_fix(s: &ProjectStore, check_id: &str, on_line: &(dyn Fn(ShipLineEvent) + Sync)) -> Result<ShipReadinessCheck> {
    let before = readiness_one(s, check_id)?;
    if before.level == ShipCheckLevel::Pass {
        return Ok(before);
    }
    let cmd = before.fix_command.clone().ok_or_else(|| CoreError::invalid_input(format!("check `{check_id}` has no fix command")))?;
    let run_id = format!("fix:{check_id}");
    let emit = |stream: ShipLineStream, line: &str| {
        on_line(ShipLineEvent { run_id: run_id.clone(), phase: run_id.clone(), stream, line: line.to_string(), ts: now_ms() })
    };
    emit(ShipLineStream::Meta, &format!("$ {cmd}"));
    let r = sys::run_streaming(&cmd, &s.root().path, &Default::default(), &ShipCancel::new(), &|is_err, l| {
        emit(if is_err { ShipLineStream::Stderr } else { ShipLineStream::Stdout }, l)
    });
    emit(ShipLineStream::Meta, &format!("[exit {}]", r.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())));
    readiness_one(s, check_id)
}

pub fn bump(s: &ProjectStore, actor: &Actor, bump: ShipBumpType, dry_run: bool) -> Result<ShipBumpResult> {
    let cfg = config_require(s)?;
    let dir = s.root().path.clone();
    // The version files live outside .quadflow; the project lock still
    // serializes concurrent bumps from the GUI and the CLI.
    let (from, to) = s.write(actor, |_| versions::bump_all(&dir, &cfg, bump, dry_run))?;
    Ok(ShipBumpResult { from, to, dry_run, files: cfg.version_files.iter().map(|f| f.path.clone()).collect() })
}

pub fn restore_backups(s: &ProjectStore) -> Vec<String> {
    exec::restore_orphan_backups(&s.root().path).into_iter().map(|p| p.display().to_string()).collect()
}

pub fn diagnostics(s: &ProjectStore) -> Result<ShipDiagnostics> {
    let path = config_path(s);
    let exists = path.is_file();
    let (parse_error, phases, checks) = match config_get(s) {
        Ok(Some(c)) => {
            let n = c.phases.iter().find_map(|p| match p {
                ShipPhase::Checks { checks, .. } => Some(checks.len() as u32),
                _ => None,
            });
            (None, Some(c.phases.len() as u32), n)
        }
        Ok(None) => (None, None, None),
        Err(e) => (Some(e.message), None, None),
    };
    let runs = s.list::<ShipRun>()?;
    Ok(ShipDiagnostics {
        project_dir: s.root().path.display().to_string(),
        config_path: path.display().to_string(),
        config_exists: exists,
        config_size_bytes: std::fs::metadata(&path).ok().map(|m| m.len()),
        config_parse_error: parse_error,
        config_phase_count: phases,
        config_check_count: checks,
        project_kind: templates::detect_project_kind(&s.root().path).ok(),
        runs_dir: s.data_dir().join("local").join("ship").join("runs").display().to_string(),
        run_count: runs.items.len() as u32,
    })
}

// ------------------------------------------------------------------ runs

/// Newest first.
pub fn runs_list(s: &ProjectStore) -> Result<ListResult<ShipRun>> {
    let mut l = s.list::<ShipRun>()?;
    l.items.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.id.cmp(&a.id)));
    Ok(l)
}

pub fn runs_get(s: &ProjectStore, id: &Id) -> Result<ShipRun> {
    s.get::<ShipRun>(id)
}

/// The newest run that shipped `version`.
pub fn run_by_version(s: &ProjectStore, version: &str) -> Result<ShipRun> {
    let v = version.trim_start_matches('v');
    runs_list(s)?
        .items
        .into_iter()
        .find(|r| r.version == v)
        .ok_or_else(|| CoreError::not_found(format!("no ship run for version {v}")))
}

/// A run id, or a version (newest run of that version).
pub fn run_resolve(s: &ProjectStore, r: &str) -> Result<ShipRun> {
    match Id::parse(r) {
        Ok(id) => runs_get(s, &id),
        Err(_) => run_by_version(s, r),
    }
}

/// Live runs of this process: run id → cancel handle.
fn live_runs() -> &'static Mutex<HashMap<String, (String, ShipCancel)>> {
    static LIVE: OnceLock<Mutex<HashMap<String, (String, ShipCancel)>>> = OnceLock::new();
    LIVE.get_or_init(Default::default)
}

struct LiveGuard(String);
impl Drop for LiveGuard {
    fn drop(&mut self) {
        live_runs().lock().remove(&self.0);
    }
}

/// Abort `id` (or the newest in-progress run). A run executing in this process
/// is cancelled (the current command is killed); a run in another process
/// stops before its next phase; a stale record is just marked aborted.
pub fn abort(s: &ProjectStore, actor: &Actor, id: Option<&Id>) -> Result<ShipRun> {
    let target = match id {
        Some(id) => runs_get(s, id)?,
        None => runs_list(s)?
            .items
            .into_iter()
            .find(|r| r.status == ShipRunStatus::InProgress)
            .ok_or_else(|| CoreError::not_found("no in-progress ship run"))?,
    };
    if target.status != ShipRunStatus::InProgress {
        return Err(CoreError::conflict(format!("ship run {} is not in progress ({:?})", target.id, target.status)));
    }
    if let Some((_, cancel)) = live_runs().lock().get(target.id.as_str()) {
        cancel.cancel();
    }
    s.write(actor, |tx| {
        let mut run: ShipRun = tx.get(&target.id)?;
        if run.status == ShipRunStatus::InProgress {
            run.status = ShipRunStatus::Aborted;
            run.completed_at = Some(now_ms());
            tx.put(&run)?;
        }
        Ok(run)
    })
}

/// Persist the record unless another process aborted it; returns `true` if aborted.
fn persist(s: &ProjectStore, actor: &Actor, run: &ShipRun) -> Result<bool> {
    s.write(actor, |tx| {
        if let Ok(on_disk) = tx.get::<ShipRun>(&run.id) {
            if on_disk.status == ShipRunStatus::Aborted && run.status == ShipRunStatus::InProgress {
                return Ok(true);
            }
        }
        tx.put(run)?;
        Ok(false)
    })
}

/// Resolve `(previous, new)` versions for a run.
fn resolve_versions(dir: &Path, cfg: &ShipConfig, mode: ShipRunMode) -> Result<(Option<String>, String)> {
    match versions::canonical_version(dir, cfg)? {
        Some(cur) => match mode.bump() {
            Some(b) => Ok((Some(cur.clone()), versions::bump_version(&cur, b)?)),
            None => Ok((Some(cur.clone()), cur)),
        },
        None => {
            if mode.bump().is_some() {
                return Err(CoreError::invalid_input("the ship config has no versionFiles to bump; run with mode `deploy`"));
            }
            let sha = sys::git_short_sha(dir).map_err(|e| {
                CoreError::invalid_input(format!("no versionFiles and no git commit to version the run by: {}", e.message))
            })?;
            Ok((None, sha))
        }
    }
}

/// Execute the pipeline. Returns the final record whatever the outcome —
/// check `status` (`completed` / `failed` / `aborted` / `dry_run`). Errors are
/// returned only when the run cannot start (no config, invalid config,
/// unreadable versions, another live run). Dry runs are not persisted.
pub fn run(s: &ProjectStore, actor: &Actor, opts: ShipRunOptions, sink: &dyn ShipSink) -> Result<ShipRun> {
    run_with_config(s, actor, config_require(s)?, opts, sink)
}

/// Read a ship config from any file (e.g. one tracked in the repo instead of
/// `.quadflow/ship/config.json`). Unparseable → `invalid_input`.
pub fn config_from_file(path: &Path) -> Result<ShipConfig> {
    let bytes = std::fs::read(path).map_err(|e| CoreError::io(path, e))?;
    let cfg: ShipConfig = serde_json::from_slice(&bytes)
        .map_err(|e| CoreError::invalid_input(format!("{}: not a ship config: {e}", path.display())))?;
    check_format(&cfg)?;
    Ok(cfg)
}

/// [`run`] with an explicit config instead of the project's stored one. Run
/// records still go to the project's `local/ship/runs/`.
pub fn run_with_config(s: &ProjectStore, actor: &Actor, cfg: ShipConfig, opts: ShipRunOptions, sink: &dyn ShipSink) -> Result<ShipRun> {
    let dir = s.root().path.clone();
    let v = validate_config(&cfg, &dir);
    if !v.valid {
        return Err(CoreError::invalid_input(format!("ship config is invalid: {}", v.errors.join("; ")))
            .with_details(serde_json::json!({ "errors": v.errors })));
    }
    let (previous, version) = resolve_versions(&dir, &cfg, opts.mode)?;

    let root_key = s.root().key.clone();
    let cancel = ShipCancel::new();
    let id = new_id();
    {
        let mut live = live_runs().lock();
        if !opts.dry_run {
            if let Some((other, _)) = live.iter().find(|(_, (k, _))| *k == root_key) {
                return Err(CoreError::conflict(format!("ship run {other} is already running in this project")));
            }
        }
        live.insert(id.to_string(), (if opts.dry_run { String::new() } else { root_key }, cancel.clone()));
    }
    let _guard = LiveGuard(id.to_string());
    // After the live-run check: never restore a conf another run in this process patched.
    if !opts.dry_run {
        let restored = restore_backups(s);
        if !restored.is_empty() {
            sink.restored_backups(&restored);
        }
    }

    let mut record = ShipRun {
        id: id.clone(),
        version: version.clone(),
        previous_version: previous.clone(),
        mode: opts.mode,
        status: if opts.dry_run { ShipRunStatus::DryRun } else { ShipRunStatus::InProgress },
        dry_run: opts.dry_run,
        started_at: now_ms(),
        completed_at: None,
        started_by: actor.clone(),
        phases: cfg.phases.iter().map(ShipPhaseResult::pending).collect(),
        artifacts: Vec::new(),
        release_url: None,
        changelog: match cfg.changelog.source {
            ShipChangelogSource::GitLog => sys::changelog_from_git(&dir, &cfg.changelog.since).ok().filter(|c| !c.is_empty()),
            ShipChangelogSource::Manual => None,
        },
    };
    let save = |r: &ShipRun| -> Result<bool> { if opts.dry_run { Ok(false) } else { persist(s, actor, r) } };
    save(&record)?;

    let mut ctx = ShipContext::new(dir.clone(), id.clone(), cfg.product_name.clone(), version, previous);
    let exec = Exec { config: &cfg, opts: &opts, sink, cancel: &cancel };
    let total = cfg.phases.len() as u32;
    let mut failed = false;
    for (i, phase) in cfg.phases.iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        record.phases[i].status = ShipPhaseStatus::Running;
        record.phases[i].started_at = Some(now_ms());
        if save(&record)? {
            cancel.cancel();
            break;
        }
        sink.phase(ShipPhaseEvent { run_id: id.clone(), index: i as u32, total, phase: record.phases[i].clone() });

        let result = exec.execute(phase, &mut ctx);
        if let Some(u) = &result.url {
            record.release_url = Some(u.clone());
        }
        for a in &result.artifacts {
            if !record.artifacts.contains(a) {
                record.artifacts.push(a.clone());
            }
        }
        failed = result.status == ShipPhaseStatus::Failed;
        record.phases[i] = result;
        sink.phase(ShipPhaseEvent { run_id: id.clone(), index: i as u32, total, phase: record.phases[i].clone() });
        if save(&record)? {
            cancel.cancel();
        }
        if failed {
            break;
        }
    }
    // Every tauri.conf snapshot still outstanding goes back, success or not.
    exec::restore_backups(&ctx.backups);

    record.completed_at = Some(now_ms());
    record.status = if opts.dry_run {
        ShipRunStatus::DryRun
    } else if cancel.is_cancelled() {
        ShipRunStatus::Aborted
    } else if failed {
        ShipRunStatus::Failed
    } else {
        ShipRunStatus::Completed
    };
    if record.status == ShipRunStatus::Aborted {
        for p in record.phases.iter_mut().filter(|p| matches!(p.status, ShipPhaseStatus::Pending | ShipPhaseStatus::Running)) {
            p.status = ShipPhaseStatus::Skipped;
            p.detail.get_or_insert_with(|| "run aborted".into());
        }
        if !opts.dry_run {
            s.write(actor, |tx| tx.put(&record))?;
        }
    } else {
        save(&record)?;
    }
    Ok(record)
}

/// The error a CLI reports for a run that did not complete.
pub fn run_outcome_error(run: &ShipRun) -> Option<CoreError> {
    let msg = match run.status {
        ShipRunStatus::Completed | ShipRunStatus::DryRun => return None,
        ShipRunStatus::Aborted => format!("ship run {} (v{}) was aborted", run.id, run.version),
        ShipRunStatus::InProgress => format!("ship run {} (v{}) did not finish", run.id, run.version),
        ShipRunStatus::Failed => match run.failed_phase() {
            Some(p) => format!("ship run {} (v{}) failed at phase `{}`: {}", run.id, run.version, p.name, p.error.as_deref().unwrap_or("failed")),
            None => format!("ship run {} (v{}) failed", run.id, run.version),
        },
    };
    Some(CoreError::external(msg).with_details(serde_json::json!({ "run": run })))
}
