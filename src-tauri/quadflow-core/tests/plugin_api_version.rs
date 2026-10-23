//! `PLUGIN_API_VERSION` (core) == `packages/plugin-api/src/version.ts` ==
//! the `@quadflow/plugin-api` package version (plugin-system.md §4.2, §6.8).

use quadflow_core::plugins::PLUGIN_API_VERSION;
use std::path::Path;

fn repo_file(rel: &str) -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

#[test]
fn plugin_api_version_matches_ts_package() {
    let ts = repo_file("packages/plugin-api/src/version.ts");
    let re = regex::Regex::new(r#"export const PLUGIN_API_VERSION\s*=\s*['"]([^'"]+)['"]"#).unwrap();
    let ts_version = re.captures(&ts).expect("version.ts exports PLUGIN_API_VERSION")[1].to_string();
    assert_eq!(ts_version, PLUGIN_API_VERSION, "packages/plugin-api/src/version.ts drifted from core");

    let pkg: serde_json::Value = serde_json::from_str(&repo_file("packages/plugin-api/package.json")).unwrap();
    assert_eq!(pkg["version"].as_str(), Some(PLUGIN_API_VERSION), "@quadflow/plugin-api package version drifted");
}
