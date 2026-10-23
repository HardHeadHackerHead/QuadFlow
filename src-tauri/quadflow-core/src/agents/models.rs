//! Model list of a provider (agent-providers.md §6.4): `system-default` ++
//! catalog models (non-deprecated first) ++ custom models from settings.

use super::catalog::{Catalog, CatalogModelKind};
use crate::domains::app::settings;
use crate::error::{CoreError, Result};
use crate::store::AppDb;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

/// Sentinel: launch without model args (the CLI's own default).
pub const SYSTEM_DEFAULT_MODEL: &str = "system-default";
/// Settings namespace for agent settings.
pub const SETTINGS_NS: &str = "agents";

pub fn custom_models_key(provider_id: &str) -> String {
    format!("customModels.{provider_id}")
}
pub fn default_model_key(provider_id: &str) -> String {
    format!("defaultModel.{provider_id}")
}

fn model_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._:\[\]-]+$").unwrap())
}

/// §0 rule 4: `^[A-Za-z0-9._:\[\]-]+$`, ≤ 128 chars.
pub fn validate_model_id(id: &str) -> Result<()> {
    if id.len() <= 128 && model_re().is_match(id) {
        Ok(())
    } else {
        Err(CoreError::invalid_input(format!("invalid model id {id:?}: expected [A-Za-z0-9._:[]-]{{1,128}}")))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentModelKind {
    Alias,
    Model,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentModelSource {
    Catalog,
    Custom,
    System,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelInfo {
    pub id: String,
    pub label: String,
    pub short_label: Option<String>,
    pub context_window: Option<u64>,
    pub kind: AgentModelKind,
    pub is_default: bool,
    pub deprecated: bool,
    pub source: AgentModelSource,
}

/// One entry of setting `agents.customModels.<providerId>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCustomModel {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub short_label: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
}

/// Validate a value for `agents.customModels.<pid>` (used by `settings::set`).
pub fn validate_custom_models(v: &Value) -> Result<Vec<AgentCustomModel>> {
    if v.is_null() {
        return Ok(Vec::new());
    }
    let list: Vec<AgentCustomModel> = serde_json::from_value(v.clone())
        .map_err(|e| CoreError::invalid_input(format!("custom models must be [{{id, label}}]: {e}")))?;
    for m in &list {
        validate_model_id(&m.id)?;
        if m.id == SYSTEM_DEFAULT_MODEL {
            return Err(CoreError::invalid_input("\"system-default\" is reserved"));
        }
        if m.label.trim().is_empty() || m.label.len() > 100 || m.label.chars().any(char::is_control) {
            return Err(CoreError::invalid_input(format!("custom model {:?}: label must be 1-100 printable chars", m.id)));
        }
        if m.short_label.as_ref().is_some_and(|s| s.chars().count() > 12 || s.chars().any(char::is_control)) {
            return Err(CoreError::invalid_input(format!("custom model {:?}: shortLabel must be ≤ 12 chars", m.id)));
        }
    }
    Ok(list)
}

/// The per-provider model settings.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ModelSettings {
    pub custom: Vec<AgentCustomModel>,
    pub default_model: Option<String>,
}

impl ModelSettings {
    /// Read `agents.customModels.<pid>` / `agents.defaultModel.<pid>`; invalid
    /// stored values are ignored (logged).
    pub fn load(db: &AppDb, provider_id: &str) -> Result<Self> {
        let all = settings::get(db, SETTINGS_NS)?;
        let custom = match all.get(&custom_models_key(provider_id)) {
            Some(v) => validate_custom_models(v).unwrap_or_else(|e| {
                tracing::warn!("ignoring invalid {}: {}", custom_models_key(provider_id), e.message);
                Vec::new()
            }),
            None => Vec::new(),
        };
        let default_model = all.get(&default_model_key(provider_id)).and_then(Value::as_str).map(str::to_string);
        Ok(Self { custom, default_model })
    }
}

/// `models(p, catalog, settings)` of §6.4.
pub fn models(catalog_key: &str, allow_custom: bool, catalog: &Catalog, s: &ModelSettings) -> Vec<AgentModelInfo> {
    let mut out = vec![AgentModelInfo {
        id: SYSTEM_DEFAULT_MODEL.into(),
        label: "Default".into(),
        short_label: Some("Def".into()),
        context_window: None,
        kind: AgentModelKind::Alias,
        is_default: false,
        deprecated: false,
        source: AgentModelSource::System,
    }];
    let mut seen: HashSet<String> = HashSet::from([SYSTEM_DEFAULT_MODEL.to_string()]);
    let cat = catalog.models_for(catalog_key);
    let (live, old): (Vec<_>, Vec<_>) = cat.iter().partition(|m| !m.deprecated);
    for m in live.into_iter().chain(old) {
        if !seen.insert(m.id.clone()) {
            continue;
        }
        // Custom entries with a catalog id can refine shortLabel/contextWindow (labels: catalog wins).
        let over = s.custom.iter().find(|c| c.id == m.id);
        out.push(AgentModelInfo {
            id: m.id.clone(),
            label: m.label.clone(),
            short_label: over.and_then(|c| c.short_label.clone()).or_else(|| m.short_label.clone()),
            context_window: over.and_then(|c| c.context_window).or(m.context_window),
            kind: match m.kind {
                CatalogModelKind::Alias => AgentModelKind::Alias,
                CatalogModelKind::Model => AgentModelKind::Model,
            },
            is_default: false,
            deprecated: m.deprecated,
            source: AgentModelSource::Catalog,
        });
    }
    if allow_custom {
        for c in &s.custom {
            if validate_model_id(&c.id).is_err() || !seen.insert(c.id.clone()) {
                continue;
            }
            out.push(AgentModelInfo {
                id: c.id.clone(),
                label: c.label.clone(),
                short_label: c.short_label.clone(),
                context_window: c.context_window,
                kind: AgentModelKind::Model,
                is_default: false,
                deprecated: false,
                source: AgentModelSource::Custom,
            });
        }
    }
    let default_id = s
        .default_model
        .as_deref()
        .filter(|d| out.iter().any(|m| m.id == *d))
        .map(str::to_string)
        .or_else(|| cat.iter().find(|m| m.default && !m.deprecated).map(|m| m.id.clone()))
        .unwrap_or_else(|| SYSTEM_DEFAULT_MODEL.to_string());
    for m in &mut out {
        m.is_default = m.id == default_id;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::catalog::parse;
    use serde_json::json;

    fn cat() -> Catalog {
        parse(
            json!({"schemaVersion":1,"updatedAt":"x","providers":{"alpha":{"models":[
                {"id":"old","label":"Old","deprecated":true},
                {"id":"opus[1m]","label":"Opus 1M","shortLabel":"O1M"},
                {"id":"m2","label":"M2","default":true}
            ]}}})
            .to_string()
            .as_bytes(),
        )
        .unwrap()
        .0
    }

    #[test]
    fn merge_order_dedupe_and_default() {
        let s = ModelSettings {
            custom: vec![
                AgentCustomModel { id: "opus[1m]".into(), label: "Mine".into(), short_label: Some("X".into()), context_window: Some(1_000_000) },
                AgentCustomModel { id: "custom-1".into(), label: "Custom".into(), short_label: None, context_window: None },
            ],
            default_model: None,
        };
        let m = models("alpha", true, &cat(), &s);
        let ids: Vec<_> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["system-default", "opus[1m]", "m2", "old", "custom-1"]);
        assert_eq!(m[1].label, "Opus 1M", "catalog wins for labels");
        assert_eq!(m[1].short_label.as_deref(), Some("X"));
        assert_eq!(m[1].context_window, Some(1_000_000));
        assert!(m.iter().find(|x| x.id == "m2").unwrap().is_default, "catalog default");
        assert_eq!(m.iter().filter(|x| x.is_default).count(), 1);

        // Setting default wins when present (also for catalog models).
        let s2 = ModelSettings { default_model: Some("old".into()), ..s.clone() };
        assert!(models("alpha", true, &cat(), &s2).iter().find(|x| x.id == "old").unwrap().is_default);
        // Unknown default → catalog default; no catalog default → system-default.
        let s3 = ModelSettings { default_model: Some("gone".into()), ..s.clone() };
        assert!(models("alpha", true, &cat(), &s3).iter().find(|x| x.id == "m2").unwrap().is_default);
        assert!(models("nope", true, &cat(), &ModelSettings::default())[0].is_default);
        // allowCustom = false hides custom models.
        assert!(!models("alpha", false, &cat(), &s).iter().any(|x| x.id == "custom-1"));
    }

    #[test]
    fn model_id_rules() {
        for ok in ["opus", "opus[1m]", "vendor-x-4-5-20251001", "gpt-5.3-mini", "a:b"] {
            assert!(validate_model_id(ok).is_ok(), "{ok}");
        }
        for bad in ["", "x; rm -rf ~", "$(id)", "a b", "a\nb", "it's", "\"q\"", &"a".repeat(129)] {
            assert!(validate_model_id(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn custom_model_validation() {
        assert!(validate_custom_models(&json!([{ "id": "ok", "label": "OK" }])).is_ok());
        assert!(validate_custom_models(&json!(null)).unwrap().is_empty());
        assert!(validate_custom_models(&json!([{ "id": "x; rm -rf ~", "label": "bad" }])).is_err());
        assert!(validate_custom_models(&json!([{ "id": "ok", "label": "" }])).is_err());
        assert!(validate_custom_models(&json!([{ "id": "system-default", "label": "x" }])).is_err());
        assert!(validate_custom_models(&json!({ "id": "ok" })).is_err());
    }

    #[test]
    fn settings_roundtrip() {
        let app = crate::testing::TempApp::new();
        settings::set_many(&app.db, SETTINGS_NS, [(custom_models_key("alpha"), json!([{ "id": "c1", "label": "C1" }])), (default_model_key("alpha"), json!("c1"))].into_iter().collect()).unwrap();
        let s = ModelSettings::load(&app.db, "alpha").unwrap();
        assert_eq!(s.custom.len(), 1);
        assert_eq!(s.default_model.as_deref(), Some("c1"));
        // Invalid custom models are rejected at save.
        assert!(settings::set(&app.db, SETTINGS_NS, &custom_models_key("alpha"), json!([{ "id": "$(id)", "label": "x" }])).is_err());
        assert!(settings::set(&app.db, SETTINGS_NS, &default_model_key("alpha"), json!("x; rm -rf ~")).is_err());
        assert!(settings::set(&app.db, SETTINGS_NS, "catalogUrl", json!("http://evil")).is_err());
    }
}
