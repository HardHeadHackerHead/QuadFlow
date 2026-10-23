//! Context-module registry (plugin-system.md §9.3): the always-enabled base
//! module `quadflow`, the reference docs bundled with core, and every active
//! plugin's `agentContextDocs` ([`ContextRegistry::with_plugins`], PL-8).

use crate::error::CoreError;
use crate::paths::AppPaths;
use crate::plugins::manifest::check_file_in_root;
use crate::plugins::{LoadOptions, PluginRegistry};
use crate::store::AppDb;
use serde::{Deserialize, Serialize};

/// Id of the implicit base module (always first, cannot be disabled).
pub const BASE_MODULE: &str = "quadflow";

/// Context-module id of a plugin doc (§9.3).
pub fn plugin_module_id(plugin_id: &str, doc_id: &str) -> String {
    if doc_id == plugin_id {
        plugin_id.to_string()
    } else {
        format!("{plugin_id}.{doc_id}")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextModuleInfo {
    pub id: String,
    pub title: String,
    /// `"core"` or the contributing plugin id.
    pub source: String,
    /// The base module: always included.
    pub implicit: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextModule {
    pub info: ContextModuleInfo,
    pub markdown: String,
}

#[derive(Clone, Debug, Default)]
pub struct ContextRegistry {
    modules: Vec<ContextModule>,
}

/// Docs bundled with core until each domain's plugin contributes its own
/// (`ideas`, `discovery`, `plans`, `issues`, `ship`, `chat`, `missions` and `scripts` moved to
/// `plugins/<id>/docs/agent.md`, MIG-*).
const BUNDLED: &[(&str, &str, &str)] = &[
];

const BASE_DOC: &str = include_str!("../../../resources/agent-context/quadflow.md");

impl ContextRegistry {
    /// Base module + core-bundled docs.
    pub fn builtin() -> Self {
        let mut r = ContextRegistry::default();
        r.add(BASE_MODULE, "QuadFlow", "core", true, BASE_DOC);
        for (id, title, md) in BUNDLED {
            r.add(id, title, "core", false, md);
        }
        r
    }

    /// Base module + core docs + every active plugin's `agentContextDocs` (§9.3).
    pub fn with_plugins(plugins: &PluginRegistry) -> Self {
        let mut r = Self::builtin();
        r.add_plugin_docs(plugins);
        r
    }

    /// Load the plugin registry for `paths` and build [`Self::with_plugins`].
    /// Falls back to [`Self::builtin`] (with the reason) when the registry
    /// cannot be loaded, so docs stay available with a broken plugin setup.
    pub fn load(paths: &AppPaths, db: &AppDb, opts: &LoadOptions) -> (Self, Option<CoreError>) {
        match PluginRegistry::load_with(paths, db, opts) {
            Ok(reg) => (Self::with_plugins(&reg), None),
            Err(e) => (Self::builtin(), Some(e)),
        }
    }

    /// Add the docs of active plugins. Module id = `<pluginId>` when the doc id
    /// equals the plugin id, else `<pluginId>.<docId>`. A plugin doc replaces a
    /// core-bundled doc of the same id (the domain moved into a plugin); the
    /// base module cannot be replaced. Unreadable files are skipped (logged).
    pub fn add_plugin_docs(&mut self, plugins: &PluginRegistry) {
        for p in plugins.active() {
            let Some(m) = &p.manifest else { continue };
            for d in &m.contributes.agent_context_docs {
                let id = plugin_module_id(&p.id, &d.id);
                if id == BASE_MODULE {
                    continue;
                }
                let md = match check_file_in_root(&p.root, &d.file)
                    .and_then(|()| std::fs::read_to_string(p.root.join(&d.file)).map_err(|e| e.to_string()))
                {
                    Ok(md) => md,
                    Err(e) => {
                        log::warn!("[context] plugin {:?} doc {:?}: {e}", p.id, d.id);
                        continue;
                    }
                };
                let module = ContextModule {
                    info: ContextModuleInfo { id: id.clone(), title: d.title.clone(), source: p.id.clone(), implicit: false },
                    markdown: md,
                };
                match self.modules.iter_mut().find(|x| x.info.id == id) {
                    Some(existing) if existing.info.source == "core" => *existing = module,
                    Some(_) => {}
                    None => self.modules.push(module),
                }
            }
        }
    }

    /// Register a module (first registration of an id wins).
    pub fn add(&mut self, id: &str, title: &str, source: &str, implicit: bool, markdown: &str) {
        if self.get(id).is_some() {
            return;
        }
        self.modules.push(ContextModule {
            info: ContextModuleInfo { id: id.into(), title: title.into(), source: source.into(), implicit },
            markdown: markdown.to_string(),
        });
    }

    pub fn get(&self, id: &str) -> Option<&ContextModule> {
        self.modules.iter().find(|m| m.info.id == id)
    }

    pub fn list(&self) -> &[ContextModule] {
        &self.modules
    }

    /// Ids of the non-implicit modules.
    pub fn optional_ids(&self) -> Vec<&str> {
        self.modules.iter().filter(|m| !m.info.implicit).map(|m| m.info.id.as_str()).collect()
    }
}
