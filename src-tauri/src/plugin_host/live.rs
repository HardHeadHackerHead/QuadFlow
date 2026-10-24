//! Live plugin changes in the app (plugin-system.md §12.4): sidecars follow the registry.
//!
//! The shell reloads a plugin's UI module whenever its version, root or status changes (its
//! registry diff over `plugins_list`). This is the sidecar half: [`sync`] runs on every
//! `plugins_list` (which the shell calls on each `DataChanged { domain: "plugins" }`, so also
//! after `quadflow plugins update|install|uninstall|enable|disable|rollback` from the CLI in
//! another process), diffs the registry against the last snapshot it saw and
//! - stops the sidecar of a plugin that was removed or is no longer active,
//! - restarts a running (or failed) sidecar whose plugin now runs different code,
//! - starts the `onStartup` sidecars of plugins that became active.
//!
//! Commands that already stopped/started a sidecar themselves (install, update, rollback,
//! enable, disable, uninstall, grant from the GUI) call [`record`], so the next `sync` does not
//! restart the fresh process a second time. Dev rebuilds are the dev watcher's (`dev.rs`).

use super::sidecars;
use parking_lot::Mutex;
use quadflow_core::plugins::live::{self, PluginFingerprint};
use quadflow_core::plugins::sidecar::PluginSidecarState;
use quadflow_core::plugins::PluginRegistry;
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, Wry};

static LAST: Mutex<Option<BTreeMap<String, PluginFingerprint>>> = Mutex::new(None);

/// Remember `reg` as the state the app's sidecars already match.
pub fn record(reg: &PluginRegistry) {
    *LAST.lock() = Some(reg.fingerprints());
}

/// Bring running sidecars in line with `reg` (see the module docs). Never blocks on a process.
pub fn sync(app: &AppHandle<Wry>, reg: &PluginRegistry) {
    let next = reg.fingerprints();
    let Some(prev) = LAST.lock().replace(next.clone()) else {
        return; // first snapshot of this run: nothing ran yet
    };
    let changes: Vec<_> = live::diff(&prev, &next).into_iter().filter(|c| !c.dev_only()).collect();
    if changes.is_empty() {
        return;
    }
    let Some(sup) = app.try_state::<super::PluginHostState>().and_then(|s| s.sidecars.get().cloned()) else {
        // No sidecar ran yet: only `onStartup` ones of newly active plugins.
        sidecars::start_startup_sidecars(app);
        return;
    };
    let app = app.clone();
    // Off the command thread: stopping waits for the old process.
    std::thread::spawn(move || {
        for c in &changes {
            if c.stopped() {
                log::info!("[plugins] {} is no longer active: stopping its sidecar", c.id);
                sup.stop(&c.id);
            } else if c.code_changed() {
                let state = sup.status(&c.id).state;
                if matches!(
                    state,
                    PluginSidecarState::Running | PluginSidecarState::Starting | PluginSidecarState::Restarting | PluginSidecarState::Failed
                ) {
                    let version = |f: &Option<PluginFingerprint>| f.as_ref().and_then(|f| f.version.clone());
                    log::info!(
                        "[plugins] {} changed ({:?} → {:?}): restarting its sidecar",
                        c.id,
                        version(&c.before),
                        version(&c.after)
                    );
                    sup.restart(&c.id);
                }
            }
        }
        sidecars::start_startup_sidecars(&app);
    });
}
