//! Ship — a typed, generic release pipeline (data-layer.md §6.7).
//!
//! The project opts in with `.quadflow/ship/config.json` ([`ShipConfig`]): version
//! files plus an ordered list of typed [`ShipPhase`]s (checks, bump, build,
//! sign, stage, publish, git, deploy commands…). Every execution is a
//! [`ShipRun`] with a fresh id under `.quadflow/local/ship/runs/` — runs never
//! overwrite each other. Output streams through a [`ShipSink`] (the GUI uses a
//! Tauri channel, the CLI prints); runs are abortable.
//!
//! Nothing here is specific to one product: templates take names and paths
//! from detection or params, signing tools are always user-supplied, and an
//! unrecognized project is `unsupported` rather than a placeholder command.

mod checks;
mod exec;
mod model;
mod service;
mod sys;
mod templates;
mod versions;

pub use checks::{evaluate as evaluate_check, evaluate_readiness, is_known_check, CHECKS, CHECK_PREFIXES};
pub use exec::{external_complete, external_roundtrip, glob, restore_orphan_backups, substitute, NullSink, ShipContext, ShipSink};
pub use model::*;
pub use service::*;
pub use sys::{changelog_from_git, git_branch, git_clean, tool_available, ShipCancel};
pub use templates::{
    available_templates, build_from_template, detect_environment, detect_product_name, detect_project_kind,
    detect_version_files, parse_bool, parse_params, DETECTED_TOOLS,
};
pub use versions::{bump_all, bump_version, canonical_version, read_version, write_version};

#[cfg(test)]
mod tests;
