//! Manifest → [`SidecarConfig`] (plugin-system.md §10.2 "Resolution", "Spawn"; §10.3 `initialize`).

use super::{SidecarConfig, SidecarLaunch, PROTOCOL_VERSION};
use crate::domains::environments::{self, SystemProbe, TargetPlatform};
use crate::error::{CoreError, Result};
use crate::paths::AppPaths;
use crate::plugins::manifest::{check_file_in_root, SidecarRuntime};
use crate::plugins::{current_target, LoadedPlugin, Permission, PluginOrigin, PluginStatus, PLUGIN_API_VERSION};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Host-side facts sent to the sidecar.
pub struct ResolveContext<'a> {
    pub paths: &'a AppPaths,
    /// QuadFlow version.
    pub host_version: &'a str,
    /// `gui` or `cli` (`QUADFLOW_SIDECAR_MODE`, `initialize.host.mode`).
    pub mode: &'a str,
    /// `(root, rootKey)` of the active project.
    pub project: Option<(String, String)>,
    /// The plugin's resolved settings (`settings.getAll`).
    pub settings: Value,
    pub locale: String,
}

/// Does the plugin declare a sidecar?
pub fn has_sidecar(plugin: &LoadedPlugin) -> bool {
    plugin.manifest.as_ref().is_some_and(|m| m.sidecar.is_some())
}

pub fn resolve(plugin: &LoadedPlugin, ctx: &ResolveContext) -> Result<SidecarConfig> {
    let manifest = plugin
        .manifest
        .as_ref()
        .ok_or_else(|| CoreError::unsupported(format!("plugin {:?} has no valid manifest", plugin.id)))?;
    let sc = manifest
        .sidecar
        .as_ref()
        .ok_or_else(|| CoreError::unsupported(format!("plugin {:?} has no sidecar", plugin.id)))?;
    if plugin.status != PluginStatus::Active {
        return Err(CoreError::permission_denied(format!("plugin {:?} is not active ({})", plugin.id, plugin.status.label())));
    }

    let (program, mut args) = if sc.runtime == Some(SidecarRuntime::Node) {
        let need = Permission::parse("sidecar:runtime:node").expect("valid permission");
        if !plugin.granted.iter().any(|g| g.satisfies(&need)) {
            return Err(CoreError::permission_denied(format!(
                "plugin {:?} needs permission `sidecar:runtime:node` to run its sidecar",
                plugin.id
            )));
        }
        let entry = sc.entry.as_deref().ok_or_else(|| CoreError::invalid_input("sidecar runtime node needs an entry"))?;
        check_file_in_root(&plugin.root, entry).map_err(|e| CoreError::not_found(format!("sidecar entry: {e}")))?;
        let node = environments::which(&SystemProbe, TargetPlatform::current(), "node").ok_or_else(|| {
            CoreError::not_found("Node.js was not found on PATH; install Node.js (https://nodejs.org) to use this plugin")
        })?;
        (node, vec![plugin.root.join(entry).display().to_string()])
    } else {
        let target = current_target().ok_or_else(|| CoreError::unsupported("no sidecar for this platform"))?;
        let rel = sc
            .binaries
            .as_ref()
            .and_then(|b| b.get(&target))
            .ok_or_else(|| CoreError::unsupported(format!("no sidecar for this platform ({target})")))?;
        check_file_in_root(&plugin.root, rel).map_err(|e| CoreError::not_found(format!("sidecar binary: {e}")))?;
        let mut path = plugin.root.join(rel);
        if plugin.origin == PluginOrigin::Dev {
            // Dev mode (§15.3): run a copy, so the plugin's own build can overwrite the binary
            // while it runs (Windows locks running executables); a rebuild restarts the sidecar.
            path = crate::plugins::dev::shadow_copy(&ctx.paths.cache_dir, &plugin.id, &path)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&path) {
                let mut perm = meta.permissions();
                if perm.mode() & 0o111 == 0 {
                    perm.set_mode(perm.mode() | 0o755);
                    let _ = std::fs::set_permissions(&path, perm);
                }
            }
        }
        (path, Vec::new())
    };
    args.extend(sc.args.iter().cloned());

    let data_dir: PathBuf = ctx.paths.plugin_data_dir.join(&plugin.id);
    std::fs::create_dir_all(&data_dir).map_err(|e| CoreError::io(&data_dir, e))?;

    let mut env = sc.env.clone();
    env.insert("QUADFLOW_PLUGIN_ID".into(), plugin.id.clone());
    env.insert("QUADFLOW_PLUGIN_DIR".into(), plugin.root.display().to_string());
    env.insert("QUADFLOW_PLUGIN_DATA".into(), data_dir.display().to_string());
    env.insert("QUADFLOW_SIDECAR_MODE".into(), ctx.mode.to_string());

    let initialize = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "host": {
            "version": ctx.host_version,
            "apiVersion": PLUGIN_API_VERSION,
            "platform": crate::plugins::Platform::current().map(|p| p.as_str()).unwrap_or("unknown"),
            "arch": std::env::consts::ARCH,
            "mode": ctx.mode,
        },
        "plugin": {
            "id": plugin.id,
            "version": manifest.version,
            "dir": plugin.root.display().to_string(),
            "dataDir": data_dir.display().to_string(),
        },
        "project": ctx.project.as_ref().map(|(root, key)| json!({ "root": root, "rootKey": key })),
        "settings": ctx.settings,
        "locale": ctx.locale,
    });

    Ok(SidecarConfig {
        launch: SidecarLaunch { program, args, cwd: data_dir, env },
        restart: sc.restart,
        initialize,
    })
}
