//! Writes `src/generated/bindings.ts` (data-layer.md §9). CI runs this and then
//! `git diff --exit-code src/generated` to catch drift.

use quadflow_tauri_lib::bindings::{bindings_path, builder, command_names, export, BINDINGS_HEADER};

#[test]
fn export_bindings() {
    let b = builder();
    export(&b).unwrap();
    let ts = std::fs::read_to_string(bindings_path()).unwrap();
    assert!(ts.starts_with(BINDINGS_HEADER));
    assert!(ts.contains("projectInit"));
    assert!(ts.contains("dataChanged"));
    // Plugin-author copy: domain types only, no Tauri runtime.
    let types = std::fs::read_to_string(quadflow_tauri_lib::bindings::plugin_api_types_path()).unwrap();
    assert!(types.starts_with(BINDINGS_HEADER));
    assert!(types.contains("export type ProjectConfig"));
    assert!(!types.contains("@tauri-apps/api"), "plugin-api types must not import Tauri");
    let names = command_names(&b);
    assert!(names.contains("project_init"), "{names:?}");
}
