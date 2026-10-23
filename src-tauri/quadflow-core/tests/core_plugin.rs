//! The bundled `core` plugin (plugins/core) carries the shell's own
//! contributions — the Terminal / AI Agent toolbar items, their commands and
//! the session History flyout. Its manifest must stay valid or the shell loses
//! them.

use quadflow_core::plugins::registry::validate_plugin_dir;
use quadflow_core::plugins::{LoadOptions, PluginOrigin};
use std::path::PathBuf;

#[test]
fn core_plugin_manifest_is_valid() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins/core");
    let opts = LoadOptions::from_env(|_| None);
    let report = validate_plugin_dir(&dir, PluginOrigin::Bundled, true, &opts);
    assert!(report.is_valid(), "core: {:?}", report.errors);
    let m = report.manifest.expect("manifest");
    assert_eq!(m.id, "core");
    let c = &m.contributes;
    let tiles: Vec<&str> = c.tiles.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(tiles, ["chat-history"]);
    for t in &c.tiles {
        assert!(t.icon.is_some(), "core/{}: every tile has an icon", t.id);
    }
    let items: Vec<(&str, &str)> = c.toolbar_items.iter().map(|t| (t.id.as_str(), t.command.as_str())).collect();
    assert_eq!(items, [("terminal", "new-terminal"), ("ai-agent", "launch-agent")]);
    let commands: Vec<&str> = c.commands.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(commands, ["new-terminal", "launch-agent"]);
}
