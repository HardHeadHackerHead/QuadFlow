//! `log.*` and `project.list` (plugin-system.md §6.2, §7.1).

use super::{json, HostCall, HostEnv, MethodSpec, PermReq};
use crate::domains::app::projects;
use crate::domains::project_config;
use crate::error::Result;
use serde::Serialize;
use serde_json::Value;

/// `ProjectInfo` (§6.2) as returned by `project.list`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfoOut {
    id: String,
    name: String,
    root: String,
    root_key: String,
    /// `null` when the project's `.quadflow/config.json` is missing or unreadable.
    config: Option<project_config::ProjectConfig>,
}

fn message(c: &HostCall) -> Result<String> {
    // `args` is the JS logger's argument list; strings verbatim, the rest as JSON.
    let args: Vec<Value> = c.arg_or_default("args")?;
    let mut out = String::new();
    for (i, a) in args.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        match a {
            Value::String(s) => out.push_str(s),
            other => out.push_str(&other.to_string()),
        }
    }
    const MAX: usize = 8 * 1024;
    if out.len() > MAX {
        let mut cut = MAX;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    Ok(out)
}

macro_rules! log_method {
    ($v:ident, $name:literal, $level:expr) => {
        $v.push(MethodSpec::new($name, PermReq::None, |_env: &HostEnv, c: &HostCall| {
            log::log!(target: "plugin", $level, "[plugin:{}] {}", c.plugin.id, message(c)?);
            Ok(Value::Null)
        }));
    };
}

pub(super) fn methods() -> Vec<MethodSpec> {
    let mut v = Vec::new();
    log_method!(v, "log.debug", log::Level::Debug);
    log_method!(v, "log.info", log::Level::Info);
    log_method!(v, "log.warn", log::Level::Warn);
    log_method!(v, "log.error", log::Level::Error);

    v.push(MethodSpec::new("project.list", PermReq::None, |env: &HostEnv, _c: &HostCall| {
        let db = env.core.app_db()?;
        let list: Vec<ProjectInfoOut> = projects::list(&db)?
            .into_iter()
            .map(|p| {
                let config = env.core.project(std::path::Path::new(&p.root)).ok().and_then(|s| project_config::read(&s).ok());
                ProjectInfoOut { id: p.id.to_string(), name: p.name, root: p.root, root_key: p.root_key, config }
            })
            .collect();
        json(list)
    }));

    v.push(MethodSpec::new("host.methods", PermReq::None, |env: &HostEnv, _c: &HostCall| json(env.available())));
    v
}
