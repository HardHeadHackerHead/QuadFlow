//! Embedded JSON Schemas and their compiled validators (plugin-system.md §3.2,
//! §12.2). The single sources are `packages/plugin-api/schema/*.schema.json`.

use jsonschema::{Resource, Validator};
use super::manifest::ManifestIssue;
use serde_json::Value;
use std::sync::OnceLock;

pub const MANIFEST_SCHEMA: &str = include_str!("../../../../packages/plugin-api/schema/quadflow-plugin.schema.json");
pub const INDEX_SCHEMA: &str = include_str!("../../../../packages/plugin-api/schema/plugin-index.schema.json");

/// `$id` of the agent-provider schema referenced by `contributes.agentProvider`.
pub const AGENT_PROVIDER_SCHEMA_ID: &str = "https://quadflow.dev/schema/agent-provider.schema.json";

/// `contributes.agentProvider` schema (agent-providers.md §3).
pub const AGENT_PROVIDER_SCHEMA: &str = include_str!("../../../../packages/plugin-api/schema/agent-provider.schema.json");

fn agent_resource() -> Resource {
    let agent: Value = serde_json::from_str(AGENT_PROVIDER_SCHEMA).expect("agent-provider schema is valid JSON");
    Resource::from_contents(agent).expect("agent-provider schema is a resource")
}

fn compile(schema_src: &str) -> Validator {
    let schema: Value = serde_json::from_str(schema_src).expect("embedded schema is valid JSON");
    jsonschema::draft202012::options()
        .should_validate_formats(true)
        .with_resource(AGENT_PROVIDER_SCHEMA_ID, agent_resource())
        .build(&schema)
        .expect("embedded schema compiles")
}

fn agent_provider_validator() -> &'static Validator {
    static V: OnceLock<Validator> = OnceLock::new();
    V.get_or_init(|| compile(AGENT_PROVIDER_SCHEMA))
}

/// Validate a `contributes.agentProvider` block on its own (paths relative to the block).
pub fn validate_agent_provider_json(instance: &Value) -> Vec<ManifestIssue> {
    collect(agent_provider_validator(), instance)
}

fn manifest_validator() -> &'static Validator {
    static V: OnceLock<Validator> = OnceLock::new();
    V.get_or_init(|| compile(MANIFEST_SCHEMA))
}

fn index_validator() -> &'static Validator {
    static V: OnceLock<Validator> = OnceLock::new();
    V.get_or_init(|| compile(INDEX_SCHEMA))
}

fn collect(v: &Validator, instance: &Value) -> Vec<ManifestIssue> {
    let mut out: Vec<ManifestIssue> = v
        .iter_errors(instance)
        .map(|e| ManifestIssue { path: e.instance_path.to_string(), message: e.to_string() })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.message.cmp(&b.message)));
    out.dedup();
    out
}

/// Validate a manifest document against `quadflow-plugin.schema.json`.
pub fn validate_manifest_json(instance: &Value) -> Vec<ManifestIssue> {
    collect(manifest_validator(), instance)
}

/// Validate a source index against `plugin-index.schema.json`.
pub fn validate_index_json(instance: &Value) -> Vec<ManifestIssue> {
    collect(index_validator(), instance)
}

/// Check that `schema` (a `contributes.settings` / `tile.configSchema` value) is a
/// compilable draft 2020-12 schema with `"type": "object"`.
pub fn check_object_schema(schema: &Value) -> Result<(), String> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err("must be a JSON Schema with \"type\": \"object\"".into());
    }
    jsonschema::draft202012::new(schema).map(|_| ()).map_err(|e| format!("is not a valid JSON Schema: {e}"))
}

/// The manifest's `id` pattern (shared with the registry's id checks).
pub fn manifest_id_pattern() -> &'static regex::Regex {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| {
        let schema: Value = serde_json::from_str(MANIFEST_SCHEMA).unwrap();
        let p = schema["properties"]["id"]["pattern"].as_str().unwrap();
        regex::Regex::new(p).unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schemas_compile() {
        let _ = manifest_validator();
        let _ = index_validator();
        let _ = agent_provider_validator();
    }

    #[test]
    fn permission_pattern_agrees_with_parser() {
        use crate::plugins::permissions::Permission;
        let schema: Value = serde_json::from_str(MANIFEST_SCHEMA).unwrap();
        let pat = schema["$defs"]["permission"]["pattern"].as_str().unwrap();
        let re = regex::Regex::new(pat).unwrap();
        for s in crate::plugins::permissions::tests_corpus::VALID {
            assert!(re.is_match(s), "schema rejects valid {s}");
            assert!(Permission::parse(s).is_ok());
        }
        // The parser is at least as strict as the schema (it also range-checks ports).
        for s in crate::plugins::permissions::tests_corpus::INVALID {
            assert!(Permission::parse(s).is_err(), "parser accepts {s:?}");
        }
    }

    #[test]
    fn index_schema_accepts_minimal_and_rejects_bad() {
        let ok = json!({
            "formatVersion": 1, "name": "Official",
            "plugins": [{ "id": "issues", "name": "Issues", "description": "d", "versions": [{
                "version": "1.0.0", "apiVersion": "^1.0.0", "platforms": ["windows"],
                "url": "https://example.com/issues-1.0.0.zip", "sha256": "0".repeat(64), "size": 10, "permissions": []
            }]}]
        });
        assert!(validate_index_json(&ok).is_empty(), "{:?}", validate_index_json(&ok));
        let mut bad = ok.clone();
        bad["formatVersion"] = json!(2);
        bad["plugins"][0]["versions"][0]["sha256"] = json!("xyz");
        let errs = validate_index_json(&bad);
        assert!(errs.iter().any(|e| e.path == "/formatVersion"), "{errs:?}");
        assert!(errs.iter().any(|e| e.path.ends_with("/sha256")), "{errs:?}");
    }

    #[test]
    fn object_schema_check() {
        assert!(check_object_schema(&json!({"type":"object","properties":{"a":{"type":"string"}}})).is_ok());
        assert!(check_object_schema(&json!({"type":"string"})).is_err());
        assert!(check_object_schema(&json!({"type":"object","properties":{"a":{"type":"strnig"}}})).is_err());
    }
}
