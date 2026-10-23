//! Readiness checks: the ids a `checks` phase may list, their evaluators, and
//! the readiness report (config checks + checks implied by other phases).

use super::model::{ShipBumpType, ShipCheckLevel, ShipConfig, ShipPhase, ShipReadinessCheck};
use super::sys::{self, tool_available};
use super::{exec, versions};
use std::collections::BTreeSet;
use std::path::Path;

/// Exact check ids.
pub const CHECKS: &[&str] = &[
    "git_clean",
    "version_files_in_sync",
    "gh_authenticated",
    "xcrun_available",
    "gpg_available",
    "vercel_authenticated",
    "docker_logged_in",
    "npm_token_valid",
    "railway_authenticated",
    "fly_authenticated",
    "netlify_authenticated",
    "supabase_authenticated",
    "gcloud_authenticated",
    "az_authenticated",
    "doctl_authenticated",
    "wrangler_authenticated",
    "heroku_authenticated",
    "cargo_logged_in",
];

/// Check ids of the form `<prefix><argument>`.
pub const CHECK_PREFIXES: &[&str] = &[
    "git_branch:",
    "tool_available:",
    "file_exists:",
    "gh_repo_reachable:",
    "tag_not_exists:",
    "disk_space:",
    "minisign_key_valid:",
    "no_holding_processes:",
    "dev_server_not_running:",
    "codesign_identity:",
    "notarytool_profile:",
    "command_succeeds:",
    "no_stale_bundle:",
];

pub fn is_known_check(id: &str) -> bool {
    CHECKS.contains(&id) || CHECK_PREFIXES.iter().any(|p| id.strip_prefix(p).is_some_and(|rest| !rest.is_empty()))
}

fn check(id: &str, label: impl Into<String>, level: ShipCheckLevel, hint: Option<String>, fix: Option<String>, from_config: bool) -> ShipReadinessCheck {
    ShipReadinessCheck { id: id.into(), label: label.into(), level, hint, fix_command: fix, from_config }
}
fn pass(id: &str, label: impl Into<String>, from_config: bool) -> ShipReadinessCheck {
    check(id, label, ShipCheckLevel::Pass, None, None, from_config)
}
fn fail(id: &str, label: impl Into<String>, hint: impl Into<String>, fix: Option<String>, from_config: bool) -> ShipReadinessCheck {
    check(id, label, ShipCheckLevel::Fail, Some(hint.into()), fix, from_config)
}
fn warn(id: &str, label: impl Into<String>, hint: impl Into<String>, fix: Option<String>, from_config: bool) -> ShipReadinessCheck {
    check(id, label, ShipCheckLevel::Warn, Some(hint.into()), fix, from_config)
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).lines().next().unwrap_or("(no output)").trim().to_string()
}

/// Evaluate one check id against the project.
pub fn evaluate(project_dir: &Path, id: &str, config: &ShipConfig, from_config: bool) -> ShipReadinessCheck {
    let fc = from_config;
    match id {
        "git_clean" => {
            let label = "Working tree is clean";
            return match sys::git_clean(project_dir) {
                Ok(true) => pass(id, label, fc),
                Ok(false) => fail(id, label, "Uncommitted changes would end up in the release.", Some("git status".into()), fc),
                Err(e) => fail(id, label, e.message, None, fc),
            };
        }
        "version_files_in_sync" => {
            return match versions::canonical_version(project_dir, config) {
                Ok(Some(v)) => pass(id, format!("Version files in sync ({v})"), fc),
                Ok(None) => pass(id, "No version files configured", fc),
                Err(e) => fail(id, "Version files in sync", e.message, None, fc),
            };
        }
        "gh_authenticated" => {
            let label = "GitHub CLI authenticated";
            if !tool_available("gh") {
                return fail(id, label, "`gh` is not on PATH.", None, fc);
            }
            return match sys::run_line(project_dir, "gh auth status --hostname github.com") {
                Ok(o) if o.status.success() => pass(id, label, fc),
                _ => fail(id, label, "Not logged in to github.com.", Some("gh auth login".into()), fc),
            };
        }
        "xcrun_available" => {
            if !cfg!(target_os = "macos") {
                return pass(id, "xcrun (skipped: not macOS)", fc);
            }
            return if tool_available("xcrun") {
                pass(id, "xcrun is on PATH", fc)
            } else {
                fail(id, "xcrun is on PATH", "Xcode Command Line Tools are not installed.", Some("xcode-select --install".into()), fc)
            };
        }
        "gpg_available" => {
            return if tool_available("gpg") {
                pass(id, "`gpg` is on PATH", fc)
            } else {
                fail(id, "`gpg` is on PATH", "Install GnuPG.", None, fc)
            };
        }
        "cargo_logged_in" => {
            let ok = dirs::home_dir().map(|h| h.join(".cargo/credentials.toml").exists()).unwrap_or(false);
            return if ok {
                pass(id, "cargo registry credentials exist", fc)
            } else {
                fail(id, "cargo registry credentials exist", "Run `cargo login <token>`.", None, fc)
            };
        }
        _ => {}
    }
    let alias = match id {
        "vercel_authenticated" => Some("vercel whoami"),
        "docker_logged_in" => Some("docker info"),
        "npm_token_valid" => Some("npm whoami"),
        "railway_authenticated" => Some("railway whoami"),
        "fly_authenticated" => Some("flyctl auth whoami"),
        "netlify_authenticated" => Some("netlify status"),
        "supabase_authenticated" => Some("supabase projects list"),
        "gcloud_authenticated" => Some("gcloud auth list"),
        "az_authenticated" => Some("az account show"),
        "doctl_authenticated" => Some("doctl account get"),
        "wrangler_authenticated" => Some("wrangler whoami"),
        "heroku_authenticated" => Some("heroku auth:whoami"),
        _ => None,
    };
    if let Some(cmd) = alias {
        let mut r = command_succeeds(project_dir, id, cmd, fc);
        // Auth checks are fixed interactively by the user, never by `run_fix`.
        r.fix_command = None;
        return r;
    }

    if let Some(branch) = id.strip_prefix("git_branch:") {
        let label = format!("On branch '{branch}'");
        return match sys::git_branch(project_dir) {
            Ok(cur) if cur == branch => pass(id, label, fc),
            Ok(cur) => fail(id, label, format!("Currently on '{cur}'."), Some(format!("git checkout {branch}")), fc),
            Err(e) => fail(id, label, e.message, None, fc),
        };
    }
    if let Some(tool) = id.strip_prefix("tool_available:") {
        let label = format!("`{tool}` is on PATH");
        return if tool_available(tool) { pass(id, label, fc) } else { fail(id, label, format!("`{tool}` was not found on PATH."), None, fc) };
    }
    if let Some(file) = id.strip_prefix("file_exists:") {
        let label = format!("`{file}` exists");
        return if project_dir.join(file).exists() { pass(id, label, fc) } else { fail(id, label, format!("Missing: {file}"), None, fc) };
    }
    if let Some(repo) = id.strip_prefix("gh_repo_reachable:") {
        let label = format!("Can reach `{repo}`");
        if !tool_available("gh") {
            return fail(id, label, "`gh` is not on PATH.", None, fc);
        }
        return match sys::run_line(project_dir, &format!("gh repo view {repo} --json name")) {
            Ok(o) if o.status.success() => pass(id, label, fc),
            Ok(o) => fail(id, label, format!("`gh repo view {repo}` failed: {}", first_line(&o.stderr)), None, fc),
            Err(e) => fail(id, label, e.to_string(), None, fc),
        };
    }
    if let Some(repo) = id.strip_prefix("tag_not_exists:") {
        if !tool_available("gh") {
            return fail(id, format!("Next tag not on `{repo}`"), "`gh` is not on PATH.", None, fc);
        }
        let next = match versions::canonical_version(project_dir, config)
            .and_then(|v| v.map(|v| versions::bump_version(&v, ShipBumpType::Patch)).transpose())
        {
            Ok(Some(v)) => v,
            _ => return warn(id, format!("Next tag not on `{repo}`"), "Could not compute the next version.", None, fc),
        };
        let tag = format!("v{next}");
        let label = format!("Tag {tag} not yet on `{repo}`");
        return match sys::run_line(project_dir, &format!("gh release view {tag} --repo {repo}")) {
            Ok(o) if o.status.success() => fail(
                id,
                label,
                format!("A release for {tag} already exists on {repo} (an orphan draft from an earlier run?)."),
                Some(format!("gh release delete {tag} --repo {repo} --yes")),
                fc,
            ),
            Ok(_) => pass(id, label, fc),
            Err(e) => fail(id, label, e.to_string(), None, fc),
        };
    }
    if let Some(gb) = id.strip_prefix("disk_space:") {
        let Ok(need) = gb.trim().parse::<u64>() else {
            return fail(id, "Disk space", format!("`{gb}` is not a number of GB."), None, fc);
        };
        return match sys::free_bytes_on_volume(project_dir) {
            None => warn(id, format!("Disk space ≥ {need} GB"), "Could not read free disk space.", None, fc),
            Some(b) if b / (1 << 30) >= need => pass(id, format!("Disk space: {} GB free (≥ {need} GB)", b / (1 << 30)), fc),
            Some(b) => fail(id, format!("Disk space ≥ {need} GB"), format!("Only {} GB free.", b / (1 << 30)), None, fc),
        };
    }
    if let Some(path) = id.strip_prefix("minisign_key_valid:") {
        let label = format!("`{path}` is a minisign key");
        let gen = Some(format!("npx tauri signer generate -w {path}"));
        let contents = match std::fs::read_to_string(project_dir.join(path)) {
            Ok(s) => s,
            Err(_) => return fail(id, label, format!("Missing or unreadable: {path}"), gen, fc),
        };
        let t = contents.trim();
        let plain = t.starts_with("untrusted comment:") || t.starts_with("RWR") || t.starts_with("RWQ");
        return if plain || is_base64_minisign(t) {
            pass(id, label, fc)
        } else {
            fail(id, label, "Expected a Tauri minisign key (plain, or base64 of `untrusted comment: …`).", gen, fc)
        };
    }
    if let Some(csv) = id.strip_prefix("no_holding_processes:") {
        if !cfg!(windows) {
            return pass(id, "No holding processes (skipped: not Windows)", fc);
        }
        let wanted: Vec<&str> = csv.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        let found: Vec<&str> = wanted
            .iter()
            .copied()
            .filter(|exe| {
                sys::command("tasklist")
                    .args(["/FI", &format!("IMAGENAME eq {exe}"), "/NH", "/FO", "CSV"])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).contains(exe))
                    .unwrap_or(false)
            })
            .collect();
        return if found.is_empty() {
            pass(id, format!("No holding processes ({})", wanted.join(", ")), fc)
        } else {
            warn(id, "No holding processes", format!("Running: {} (may hold file locks).", found.join(", ")), None, fc)
        };
    }
    if let Some(csv) = id.strip_prefix("dev_server_not_running:") {
        let ports: Vec<u16> = csv.split(',').filter_map(|s| s.trim().parse().ok()).collect();
        if ports.is_empty() {
            return warn(id, "Dev server not running", "No ports given (e.g. dev_server_not_running:5173).", None, fc);
        }
        let bound: Vec<String> = ports
            .iter()
            .filter(|p| std::net::TcpListener::bind(("127.0.0.1", **p)).is_err())
            .map(|p| p.to_string())
            .collect();
        return if bound.is_empty() {
            pass(id, format!("No dev server on {csv}"), fc)
        } else {
            warn(
                id,
                "Dev server not running",
                format!("Port(s) {} are in use — a dev server may restart when the version files change.", bound.join(", ")),
                None,
                fc,
            )
        };
    }
    if let Some(ident) = id.strip_prefix("codesign_identity:") {
        if !cfg!(target_os = "macos") {
            return pass(id, format!("codesign identity `{ident}` (skipped: not macOS)"), fc);
        }
        let label = format!("codesign identity `{ident}` available");
        return match sys::command("security").args(["find-identity", "-v", "-p", "codesigning"]).output() {
            Ok(o) if o.status.success() && String::from_utf8_lossy(&o.stdout).contains(ident) => pass(id, label, fc),
            Ok(o) if o.status.success() => fail(id, label, "Identity not found in the keychain.", None, fc),
            _ => fail(id, label, "`security find-identity` failed.", None, fc),
        };
    }
    if let Some(profile) = id.strip_prefix("notarytool_profile:") {
        if !cfg!(target_os = "macos") {
            return pass(id, format!("notarytool profile `{profile}` (skipped: not macOS)"), fc);
        }
        let label = format!("notarytool profile `{profile}` works");
        return match sys::command("xcrun").args(["notarytool", "history", "--keychain-profile", profile]).output() {
            Ok(o) if o.status.success() => pass(id, label, fc),
            _ => fail(
                id,
                label,
                format!("Profile not found or invalid. Create it with `xcrun notarytool store-credentials {profile} …`."),
                None,
                fc,
            ),
        };
    }
    if let Some(cmd) = id.strip_prefix("command_succeeds:") {
        return command_succeeds(project_dir, id, cmd, fc);
    }
    if let Some(pattern) = id.strip_prefix("no_stale_bundle:") {
        let resolved = match versions::canonical_version(project_dir, config) {
            Ok(Some(v)) => pattern.replace("{version}", &v),
            _ => pattern.to_string(),
        };
        let n = exec::glob(project_dir, &resolved).len();
        return if n == 0 {
            pass(id, "No stale bundles in the build dir", fc)
        } else {
            warn(id, "No stale bundles in the build dir", format!("{n} artifact(s) match `{resolved}` from an earlier build."), None, fc)
        };
    }
    fail(id, id, format!("unknown check `{id}`"), None, fc)
}

fn command_succeeds(project_dir: &Path, id: &str, cmd: &str, fc: bool) -> ShipReadinessCheck {
    let label = format!("`{cmd}` succeeds");
    match sys::run_line(project_dir, cmd) {
        Ok(o) if o.status.success() => pass(id, label, fc),
        Ok(o) => fail(
            id,
            label,
            format!("exit {}: {}", o.status.code().unwrap_or(-1), first_line(if o.stderr.is_empty() { &o.stdout } else { &o.stderr })),
            Some(cmd.to_string()),
            fc,
        ),
        Err(e) => fail(id, label, e.to_string(), Some(cmd.to_string()), fc),
    }
}

/// A base64 wrapper around `untrusted comment: …` (what `tauri signer generate` writes).
fn is_base64_minisign(s: &str) -> bool {
    let one: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    one.len() >= 24 && one.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6")
}

/// The ids to evaluate for a config: `version_files_in_sync`, the first
/// `checks` phase's ids, plus checks implied by other phases.
pub fn readiness_ids(config: &ShipConfig) -> Vec<(String, bool)> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut push = |id: String, fc: bool| {
        if seen.insert(id.clone()) {
            out.push((id, fc));
        }
    };
    if let Some(ShipPhase::Checks { checks, .. }) = config.phases.iter().find(|p| matches!(p, ShipPhase::Checks { .. })) {
        for c in checks {
            push(c.clone(), true);
        }
    }
    push("version_files_in_sync".into(), false);
    fn walk(phases: &[ShipPhase], push: &mut dyn FnMut(String, bool)) {
        for p in phases {
            match p {
                ShipPhase::LoadEnvFromFile { file, required: true, .. } => push(format!("file_exists:{file}"), false),
                ShipPhase::SignAuthenticode { tool: Some(tool), .. } => {
                    if let Some(exe) = tool.split_whitespace().next() {
                        push(format!("tool_available:{exe}"), false);
                    }
                }
                ShipPhase::GhRelease { repo, .. } | ShipPhase::BuildLatestJson { repo, .. } => {
                    push("tool_available:gh".into(), false);
                    push("gh_authenticated".into(), false);
                    push(format!("gh_repo_reachable:{repo}"), false);
                }
                ShipPhase::Parallel { children, .. } | ShipPhase::Sequence { children, .. } => walk(children, push),
                _ => {}
            }
        }
    }
    walk(&config.phases, &mut push);
    out
}

/// The readiness report. Checks run in parallel (most are subprocesses).
pub fn evaluate_readiness(project_dir: &Path, config: &ShipConfig) -> Vec<ShipReadinessCheck> {
    let ids = readiness_ids(config);
    std::thread::scope(|scope| {
        let handles: Vec<_> = ids
            .iter()
            .map(|(id, fc)| scope.spawn(move || evaluate(project_dir, id, config, *fc)))
            .collect();
        handles
            .into_iter()
            .zip(ids.iter())
            .map(|(h, (id, fc))| h.join().unwrap_or_else(|_| fail(id, id.as_str(), "check panicked", None, *fc)))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_checks() {
        assert!(is_known_check("git_clean"));
        assert!(is_known_check("git_branch:main"));
        assert!(!is_known_check("git_branch:"));
        assert!(!is_known_check("qwick_authenticated"));
        assert!(!is_known_check("nope"));
    }

    #[test]
    fn minisign_base64() {
        assert!(is_base64_minisign("dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5"));
        assert!(!is_base64_minisign("hello world"));
    }
}
