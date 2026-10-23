//! Built-in templates and project detection. Templates take every path and
//! name from detection or from params — nothing refers to a particular product.

use super::model::*;
use super::sys::{self, tool_available};
use super::versions;
use crate::error::{CoreError, Result};
use std::collections::BTreeMap;
use std::path::Path;

// ------------------------------------------------------------------ detection

/// The project's shape. Unrecognized is `unsupported` (pick a template or
/// write the config by hand) — never a placeholder build command.
pub fn detect_project_kind(project_dir: &Path) -> Result<ShipProjectKind> {
    if project_dir.join("src-tauri/tauri.conf.json").is_file() {
        Ok(ShipProjectKind::Tauri)
    } else if project_dir.join("Cargo.toml").is_file() {
        Ok(ShipProjectKind::Cargo)
    } else if project_dir.join("package.json").is_file() {
        Ok(ShipProjectKind::Npm)
    } else if project_dir.join("pyproject.toml").is_file() {
        Ok(ShipProjectKind::Python)
    } else {
        Err(CoreError::unsupported(format!(
            "could not detect the project kind of {} (no src-tauri/tauri.conf.json, Cargo.toml, package.json or pyproject.toml)",
            project_dir.display()
        ))
        .with_details(serde_json::json!({
            "hint": "pick a template (`quadflow ship templates`) or write .quadflow/ship/config.json by hand"
        })))
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Every file that carries a readable version: package.json, tauri.conf.json,
/// Cargo.toml (`[package]` or `[workspace.package]`) at the root, under
/// `src-tauri/` and one level of crate folders, pyproject.toml.
pub fn detect_version_files(project_dir: &Path) -> Vec<ShipVersionFile> {
    let mut candidates: Vec<ShipVersionFile> = Vec::new();
    let json = |path: &str| ShipVersionFile { path: path.into(), kind: ShipVersionFileKind::Json, key: "version".into() };
    let toml = |path: String, key: &str| ShipVersionFile { path, kind: ShipVersionFileKind::Toml, key: key.into() };
    candidates.push(json("package.json"));
    candidates.push(json("src-tauri/tauri.conf.json"));
    let mut cargo_dirs = vec![String::new(), "src-tauri/".to_string()];
    for base in ["", "src-tauri/", "crates/"] {
        if let Ok(rd) = std::fs::read_dir(project_dir.join(base)) {
            let mut subs: Vec<String> = rd
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| !n.starts_with('.') && !matches!(n.as_str(), "target" | "node_modules" | "src" | "dist"))
                .filter(|n| project_dir.join(base).join(n).join("Cargo.toml").is_file())
                .map(|n| format!("{base}{n}/"))
                .collect();
            subs.sort();
            cargo_dirs.extend(subs);
        }
    }
    cargo_dirs.dedup();
    for d in cargo_dirs {
        candidates.push(toml(format!("{d}Cargo.toml"), "package.version"));
        candidates.push(toml(format!("{d}Cargo.toml"), "workspace.package.version"));
    }
    candidates.push(toml("pyproject.toml".into(), "project.version"));
    candidates.push(toml("pyproject.toml".into(), "tool.poetry.version"));
    let mut out: Vec<ShipVersionFile> = Vec::new();
    for c in candidates {
        if out.iter().any(|o| o.path == c.path && o.key == c.key) {
            continue;
        }
        if project_dir.join(&c.path).is_file() && versions::read_version(project_dir, &c).is_ok() {
            out.push(c);
        }
    }
    out
}

/// `productName` default: tauri.conf `productName` → package.json `name` →
/// Cargo `package.name` → pyproject `project.name` → folder name.
pub fn detect_product_name(project_dir: &Path) -> String {
    let from_json = |p: &str, k: &str| read_json(&project_dir.join(p)).and_then(|v| v.get(k).and_then(|x| x.as_str()).map(str::to_string));
    let from_toml = |p: &str, k: &str| std::fs::read_to_string(project_dir.join(p)).ok().and_then(|s| versions::read_toml_key(&s, k));
    from_json("src-tauri/tauri.conf.json", "productName")
        .or_else(|| from_json("package.json", "name"))
        .or_else(|| from_toml("Cargo.toml", "package.name"))
        .or_else(|| from_toml("pyproject.toml", "project.name"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| project_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "app".into()))
}

pub fn host_os() -> ShipTemplateOs {
    if cfg!(target_os = "windows") {
        ShipTemplateOs::Windows
    } else if cfg!(target_os = "macos") {
        ShipTemplateOs::Macos
    } else {
        ShipTemplateOs::Linux
    }
}

/// Tools `ship detect` reports.
pub const DETECTED_TOOLS: &[&str] = &[
    "git", "npm", "node", "cargo", "go", "python", "uv", "pip", "gh", // build + GitHub
    "signtool", "osslsigncode", "jsign", "minisign", "gpg", // signing
    "xcrun", "codesign", "security", "create-dmg", "hdiutil", // macOS
    "vercel", "wrangler", "netlify", "railway", "flyctl", "supabase", "heroku", // hosting
    "aws", "gcloud", "az", "doctl", // cloud
    "docker", "podman", "kubectl", "helm", // containers
];

pub fn detect_environment(project_dir: &Path) -> ShipEnvDetection {
    let tools: BTreeMap<String, bool> = std::thread::scope(|s| {
        let hs: Vec<_> = DETECTED_TOOLS.iter().map(|t| (t, s.spawn(move || tool_available(t)))).collect();
        hs.into_iter().map(|(t, h)| (t.to_string(), h.join().unwrap_or(false))).collect()
    });
    let tauri = read_json(&project_dir.join("src-tauri/tauri.conf.json"));
    let tauri_str = |k: &str| tauri.as_ref().and_then(|v| v.get(k)).and_then(|x| x.as_str()).map(str::to_string);
    let tauri_bundle_targets = tauri.as_ref().and_then(|v| v.get("bundle")).and_then(|b| b.get("targets")).and_then(|t| {
        if let Some(arr) = t.as_array() {
            Some(arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>())
        } else {
            t.as_str().map(|s| vec![s.to_string()])
        }
    });
    let existing_signing_keys = ["keys/tauri-signing-key", "keys/tauri.key", ".tauri/signing.key"]
        .iter()
        .filter(|c| project_dir.join(c).is_file())
        .map(|c| c.to_string())
        .collect();
    let mut gh_user = None;
    let mut gh_release_repos = Vec::new();
    if tools.get("gh").copied().unwrap_or(false) {
        if let Ok(o) = sys::run_line(project_dir, "gh api user --jq .login") {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if o.status.success() && !s.is_empty() {
                gh_user = Some(s);
            }
        }
        if let Ok(o) = sys::run_line(project_dir, "gh repo list --limit 200 --json nameWithOwner --jq .[].nameWithOwner") {
            if o.status.success() {
                gh_release_repos = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .filter(|l| {
                        let l = l.to_lowercase();
                        l.contains("release") || l.contains("update")
                    })
                    .map(str::to_string)
                    .collect();
            }
        }
    }
    let mut macos_codesign_identities = Vec::new();
    if cfg!(target_os = "macos") && tools.get("security").copied().unwrap_or(false) {
        if let Ok(o) = sys::command("security").args(["find-identity", "-v", "-p", "codesigning"]).output() {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut parts = line.splitn(3, '"');
                if let (Some(_), Some(name)) = (parts.next(), parts.next()) {
                    macos_codesign_identities.push(name.to_string());
                }
            }
        }
    }
    ShipEnvDetection {
        project_dir: project_dir.display().to_string(),
        project_kind: detect_project_kind(project_dir).ok(),
        product_name: detect_product_name(project_dir),
        host_os: host_os(),
        tools,
        version_files: detect_version_files(project_dir),
        tauri_bundle_targets,
        tauri_product_name: tauri_str("productName"),
        tauri_main_binary_name: tauri_str("mainBinaryName"),
        existing_signing_keys,
        gh_user,
        gh_release_repos,
        macos_codesign_identities,
    }
}

// ------------------------------------------------------------------ catalog

fn p(key: &str, label: &str, placeholder: &str, required: bool) -> ShipTemplateParam {
    ShipTemplateParam { key: key.into(), label: label.into(), placeholder: placeholder.into(), required, kind: ShipTemplateParamKind::Text, default: None }
}
fn p_default(key: &str, label: &str, default: &str) -> ShipTemplateParam {
    ShipTemplateParam { default: Some(default.into()), ..p(key, label, default, false) }
}
fn p_bool(key: &str, label: &str, default: bool) -> ShipTemplateParam {
    ShipTemplateParam { kind: ShipTemplateParamKind::Bool, ..p_default(key, label, if default { "true" } else { "false" }) }
}
fn p_list(key: &str, label: &str, placeholder: &str) -> ShipTemplateParam {
    ShipTemplateParam { kind: ShipTemplateParamKind::List, ..p(key, label, placeholder, true) }
}

fn web_params(mut v: Vec<ShipTemplateParam>) -> Vec<ShipTemplateParam> {
    v.push(p_bool("bump", "Bump version files and commit before deploying", true));
    v.push(p_bool("audit_tag", "Tag each deploy as deploy-{version}", true));
    v.push(p_bool("push_tag", "Push the audit tag to the remote", true));
    v
}

fn product_param() -> ShipTemplateParam {
    p("product_name", "Product name (default: detected)", "MyApp", false)
}

/// `quadflow ship templates`.
pub fn available_templates() -> Vec<ShipTemplateInfo> {
    let t = |id: &str, label: &str, description: &str, params: Vec<ShipTemplateParam>, os: ShipTemplateOs| ShipTemplateInfo {
        id: id.into(),
        label: label.into(),
        description: description.into(),
        params,
        os,
    };
    vec![
        t(
            "minimal",
            "Minimal",
            "Preflight + version bump + staging dir + the detected build command (npm / cargo / python -m build). Errors when the project kind cannot be detected.",
            vec![product_param()],
            ShipTemplateOs::Any,
        ),
        t(
            "library-publish",
            "Library publish (npm / cargo / PyPI / …)",
            "Bump version files, commit, tag v{version}, push. Registry-side CI publishes from the tag.",
            vec![p_default("remote", "Git remote", "origin"), p_default("branch", "Required branch", "main"), product_param()],
            ShipTemplateOs::Any,
        ),
        t(
            "gh-release-binaries",
            "GitHub Release: cross-platform binaries (Cargo)",
            "Build one binary per target in parallel, stage them, tag, push and upload them to a GitHub release.",
            vec![
                p("repo", "GitHub repo", "OWNER/REPO", true),
                p("bin_name", "Binary name", "myapp", true),
                p_list("targets", "Targets (comma-separated)", "x86_64-pc-windows-msvc,x86_64-unknown-linux-gnu,aarch64-apple-darwin"),
                product_param(),
            ],
            ShipTemplateOs::Any,
        ),
        t(
            "vercel",
            "Vercel deploy",
            "Optional bump + commit, `vercel deploy --prod`, optional deploy-{version} audit tag.",
            web_params(vec![p("project_name", "Vercel project name (optional)", "my-app", false), product_param()]),
            ShipTemplateOs::Any,
        ),
        t(
            "railway",
            "Railway deploy",
            "Optional bump + commit, optional environment/service selection, `railway up --detach`, optional audit tag.",
            web_params(vec![
                p("service", "Service name (optional)", "web", false),
                p("environment", "Environment name (optional)", "production", false),
                product_param(),
            ]),
            ShipTemplateOs::Any,
        ),
        t(
            "fly",
            "Fly.io deploy",
            "Optional bump + commit, `flyctl deploy --remote-only` (app and region from fly.toml), optional audit tag.",
            web_params(vec![product_param()]),
            ShipTemplateOs::Any,
        ),
        t(
            "netlify",
            "Netlify deploy",
            "Optional bump + commit, `npm run build`, `netlify deploy --prod --dir=<dist>`, optional audit tag.",
            web_params(vec![p_default("dist_dir", "Build output directory", "dist"), product_param()]),
            ShipTemplateOs::Any,
        ),
        t(
            "cloudflare-pages",
            "Cloudflare Pages deploy",
            "Optional bump + commit, `npm run build`, `wrangler pages deploy`, optional audit tag.",
            web_params(vec![
                p("project", "Pages project name", "my-site", true),
                p_default("dist_dir", "Build output directory", "dist"),
                product_param(),
            ]),
            ShipTemplateOs::Any,
        ),
        t(
            "docker",
            "Docker image build + push",
            "Bump, build the image with :{version} and :latest, push both, tag v{version}, push the tag.",
            vec![p("image", "Image (registry/name)", "ghcr.io/owner/app", true), product_param()],
            ShipTemplateOs::Any,
        ),
        t(
            "s3-static-site",
            "S3 static site (+ CloudFront)",
            "Optional bump + commit, `npm run build`, `aws s3 sync --delete`, optional CloudFront invalidation and audit tag.",
            web_params(vec![
                p("bucket", "S3 bucket", "my-site-bucket", true),
                p_default("dist_dir", "Build output directory", "dist"),
                p("cloudfront_dist_id", "CloudFront distribution id (optional)", "E1A2B3C4D5", false),
                product_param(),
            ]),
            ShipTemplateOs::Any,
        ),
        t(
            "tauri-windows",
            "Tauri / Windows",
            "Preflight → bump → staging → build the NSIS installer → stage it → GitHub release. Optional: Authenticode signing through Tauri's signCommand (`sign_command`, any tool, e.g. signtool), and the Tauri updater (`signing_key` → updater bundle, signature, latest.json).",
            vec![
                p("repo", "GitHub releases repo", "OWNER/REPO", true),
                p("bundle_basename", "Asset base name (default: <productName>-Windows)", "MyApp-Windows", false),
                p("signing_key", "Tauri updater private key file (optional; enables updater artifacts)", "keys/tauri-signing-key", false),
                p("sign_command", "Authenticode sign command, {file} = file to sign (optional)", "signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}", false),
                product_param(),
            ],
            ShipTemplateOs::Windows,
        ),
        t(
            "tauri-macos",
            "Tauri / macOS",
            "Preflight (xcrun, codesign identity, notarytool profile) → bump → build → codesign → DMG → notarize → staple → GitHub release. Optional Tauri updater artifacts with `signing_key`.",
            vec![
                p("repo", "GitHub releases repo", "OWNER/REPO", true),
                p("codesign_identity", "Codesign identity", "Developer ID Application: Name (TEAMID)", true),
                p("notarytool_profile", "notarytool keychain profile", "NOTARY_PROFILE", true),
                p("app_name", "App bundle name without .app (default: productName)", "MyApp", false),
                p("bundle_basename", "Asset base name (default: <productName>-macOS)", "MyApp-macOS", false),
                p("signing_key", "Tauri updater private key file (optional)", "keys/tauri-signing-key", false),
                p_default("updater_platform", "Updater platform key", "darwin-aarch64"),
                product_param(),
            ],
            ShipTemplateOs::Macos,
        ),
    ]
}

// ------------------------------------------------------------------ params

struct Params<'a> {
    values: &'a BTreeMap<String, String>,
}

impl Params<'_> {
    fn opt(&self, k: &str) -> Option<String> {
        self.values.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }
    fn req(&self, k: &str) -> Result<String> {
        self.opt(k).ok_or_else(|| CoreError::invalid_input(format!("template param `{k}` is required")))
    }
    fn or(&self, k: &str, default: &str) -> String {
        self.opt(k).unwrap_or_else(|| default.to_string())
    }
    fn flag(&self, k: &str, default: bool) -> Result<bool> {
        match self.opt(k) {
            None => Ok(default),
            Some(v) => parse_bool(&v).ok_or_else(|| CoreError::invalid_input(format!("template param `{k}`: expected true/false, got {v:?}"))),
        }
    }
}

pub fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" | "on" => Some(true),
        "false" | "no" | "0" | "off" => Some(false),
        _ => None,
    }
}

/// Parse `key=value` strings (CLI `--param`).
pub fn parse_params<I: IntoIterator<Item = S>, S: AsRef<str>>(raw: I) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for r in raw {
        let s = r.as_ref();
        let (k, v) = s
            .split_once('=')
            .filter(|(k, _)| !k.trim().is_empty())
            .ok_or_else(|| CoreError::invalid_input(format!("--param {s:?}: expected key=value")))?;
        out.insert(k.trim().to_string(), v.trim().to_string());
    }
    Ok(out)
}

// ------------------------------------------------------------------ builders

fn checks(name: &str, ids: Vec<String>) -> ShipPhase {
    ShipPhase::Checks { name: name.into(), checks: ids }
}
fn bump() -> ShipPhase {
    ShipPhase::VersionBump { name: "bump".into() }
}
fn staging() -> ShipPhase {
    ShipPhase::EnsureStagingDir { name: "staging".into(), path: "release/v{version}".into(), clean: true }
}
fn shell(name: &str, command: String, skip_build: bool, external: bool) -> ShipPhase {
    ShipPhase::Shell {
        name: name.into(),
        command,
        skippable: skip_build,
        skip_flag: skip_build.then(|| "skip-build".to_string()),
        working_directory: None,
        env: BTreeMap::new(),
        external_terminal: external,
    }
}
fn build(command: &str) -> ShipPhase {
    ShipPhase::Build { name: "build".into(), command: command.into(), working_directory: None, external_terminal: true }
}
fn commit(message: &str) -> ShipPhase {
    ShipPhase::GitCommit { name: "commit".into(), message: message.into(), paths: Vec::new(), sign: false }
}
fn tag(name: &str, tag: &str, if_exists: ShipTagConflict) -> ShipPhase {
    ShipPhase::GitTag { name: name.into(), tag: tag.into(), message: None, sign: false, if_exists }
}
fn push(name: &str) -> ShipPhase {
    ShipPhase::GitPush { name: name.into(), remote: "origin".into(), tag_strategy: ShipTagPush::Follow }
}
fn release(repo: &str, notes: String, files: Vec<String>) -> ShipPhase {
    ShipPhase::GhRelease {
        name: "publish".into(),
        repo: repo.into(),
        tag: "v{version}".into(),
        title: "{productName} v{version}".into(),
        notes,
        notes_file: None,
        draft: true,
        files,
    }
}

fn config(product_name: String, version_files: Vec<ShipVersionFile>, phases: Vec<ShipPhase>) -> ShipConfig {
    ShipConfig { format_version: SHIP_FORMAT_VERSION, product_name, version_files, phases, changelog: ShipChangelogConfig::default() }
}

/// Web-deploy wrapper: `[bump, commit] + deploy phases + [audit tag, push]`.
fn web(product: String, dir: &Path, params: &Params, preflight: Vec<String>, deploy: Vec<ShipPhase>) -> Result<ShipConfig> {
    let bump_on = params.flag("bump", true)?;
    let audit = params.flag("audit_tag", true)?;
    let push_tag = params.flag("push_tag", true)?;
    let mut pre = preflight;
    let mut files = Vec::new();
    if bump_on {
        files = detect_version_files(dir);
        if files.is_empty() {
            return Err(CoreError::invalid_input("bump=true but no version file was detected; pass --param bump=false"));
        }
        pre.push("git_clean".into());
        pre.push("version_files_in_sync".into());
    }
    let mut phases = vec![checks("preflight", pre)];
    if bump_on {
        phases.push(bump());
        phases.push(commit("chore: deploy v{version}"));
    }
    phases.extend(deploy);
    if audit {
        phases.push(tag("audit-tag", "deploy-{version}", ShipTagConflict::Skip));
        if push_tag {
            phases.push(push("publish-audit-tag"));
        }
    }
    Ok(config(product, files, phases))
}

/// The template id → config dispatcher used by `ship init` (CLI and GUI) and
/// `ship templates --id` previews. Unknown ids and unknown/missing params are
/// `invalid_input`.
pub fn build_from_template(project_dir: &Path, template: Option<&str>, values: &BTreeMap<String, String>) -> Result<ShipConfig> {
    let id = template.unwrap_or("minimal");
    let info = available_templates()
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| CoreError::invalid_input(format!("unknown template `{id}` (see `quadflow ship templates`)")))?;
    for k in values.keys() {
        if !info.params.iter().any(|p| &p.key == k) {
            let known: Vec<&str> = info.params.iter().map(|p| p.key.as_str()).collect();
            return Err(CoreError::invalid_input(format!(
                "template `{id}` has no param `{k}` (known: {})",
                if known.is_empty() { "none".to_string() } else { known.join(", ") }
            )));
        }
    }
    let params = Params { values };
    for p in info.params.iter().filter(|p| p.required) {
        params.req(&p.key)?;
    }
    let product = params.opt("product_name").unwrap_or_else(|| detect_product_name(project_dir));
    let dir = project_dir;
    match id {
        "minimal" => {
            let kind = detect_project_kind(dir)?;
            let cmd = match kind {
                ShipProjectKind::Tauri | ShipProjectKind::Npm => "npm run build",
                ShipProjectKind::Cargo => "cargo build --release",
                ShipProjectKind::Python => "python -m build",
            };
            let files = detect_version_files(dir);
            let mut phases = vec![checks("preflight", vec!["version_files_in_sync".into()])];
            if !files.is_empty() {
                phases.push(bump());
            }
            phases.push(staging());
            phases.push(build(cmd));
            Ok(config(product, files, phases))
        }
        "library-publish" => {
            let files = detect_version_files(dir);
            if files.is_empty() {
                return Err(CoreError::invalid_input("library-publish needs a version file (package.json, Cargo.toml, pyproject.toml)"));
            }
            let remote = params.or("remote", "origin");
            let phases = vec![
                checks("preflight", vec!["git_clean".into(), format!("git_branch:{}", params.or("branch", "main")), "version_files_in_sync".into()]),
                bump(),
                commit("chore: release v{version}"),
                ShipPhase::GitTag { name: "tag".into(), tag: "v{version}".into(), message: Some("v{version}".into()), sign: false, if_exists: ShipTagConflict::Fail },
                ShipPhase::GitPush { name: "push".into(), remote, tag_strategy: ShipTagPush::Follow },
            ];
            Ok(config(product, files, phases))
        }
        "gh-release-binaries" => {
            let repo = params.req("repo")?;
            let bin = params.req("bin_name")?;
            let targets: Vec<String> = params.req("targets")?.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            if targets.is_empty() {
                return Err(CoreError::invalid_input("template param `targets` is empty"));
            }
            let mut builds = Vec::new();
            let mut stages = Vec::new();
            for target in &targets {
                let exe = if target.contains("windows") { ".exe" } else { "" };
                builds.push(shell(&format!("build-{target}"), format!("cargo build --release --target {target}"), true, false));
                stages.push(ShipPhase::StageArtifact {
                    name: format!("stage-{target}"),
                    source_glob: format!("target/{target}/release/{bin}{exe}"),
                    dest_name: format!("{bin}-{{version}}-{target}{exe}"),
                });
            }
            let phases = vec![
                checks(
                    "preflight",
                    vec!["version_files_in_sync".into(), "tool_available:cargo".into(), "gh_authenticated".into(), format!("gh_repo_reachable:{repo}")],
                ),
                bump(),
                staging(),
                ShipPhase::Parallel { name: "build-all".into(), children: builds },
                ShipPhase::Sequence { name: "stage-all".into(), children: stages },
                commit("chore: release v{version}"),
                tag("tag", "v{version}", ShipTagConflict::Fail),
                push("push"),
                release(&repo, "{productName} v{version}".into(), vec!["{staging_dir}/*".into()]),
            ];
            Ok(config(product, detect_version_files(dir), phases))
        }
        "vercel" => {
            let name = params.opt("project_name").map(|p| format!(" --name {p}")).unwrap_or_default();
            web(product, dir, &params, vec!["tool_available:vercel".into(), "vercel_authenticated".into()], vec![shell("deploy", format!("vercel deploy --prod{name}"), false, false)])
        }
        "railway" => {
            let mut deploy = Vec::new();
            if let Some(env) = params.opt("environment") {
                deploy.push(shell("select-environment", format!("railway environment {env}"), false, false));
            }
            if let Some(svc) = params.opt("service") {
                deploy.push(shell("select-service", format!("railway service {svc}"), false, false));
            }
            deploy.push(shell("deploy", "railway up --detach".into(), false, false));
            web(product, dir, &params, vec!["tool_available:railway".into(), "railway_authenticated".into()], deploy)
        }
        "fly" => web(
            product,
            dir,
            &params,
            vec!["tool_available:flyctl".into(), "fly_authenticated".into(), "file_exists:fly.toml".into()],
            vec![shell("deploy", "flyctl deploy --remote-only".into(), false, false)],
        ),
        "netlify" => {
            let dist = params.or("dist_dir", "dist");
            web(
                product,
                dir,
                &params,
                vec!["tool_available:netlify".into(), "netlify_authenticated".into()],
                vec![shell("build", "npm run build".into(), true, true), shell("deploy", format!("netlify deploy --prod --dir={dist}"), false, false)],
            )
        }
        "cloudflare-pages" => {
            let project = params.req("project")?;
            let dist = params.or("dist_dir", "dist");
            web(
                product,
                dir,
                &params,
                vec!["tool_available:wrangler".into(), "wrangler_authenticated".into()],
                vec![
                    shell("build", "npm run build".into(), true, true),
                    shell("deploy", format!("wrangler pages deploy {dist} --project-name={project}"), false, false),
                ],
            )
        }
        "s3-static-site" => {
            let bucket = params.req("bucket")?;
            let dist = params.or("dist_dir", "dist");
            let mut deploy = vec![shell("build", "npm run build".into(), true, true), shell("sync", format!("aws s3 sync {dist} s3://{bucket} --delete"), false, false)];
            if let Some(id) = params.opt("cloudfront_dist_id") {
                deploy.push(shell("invalidate", format!("aws cloudfront create-invalidation --distribution-id {id} --paths \"/*\""), false, false));
            }
            web(product, dir, &params, vec!["tool_available:aws".into(), "command_succeeds:aws sts get-caller-identity".into()], deploy)
        }
        "docker" => {
            let image = params.req("image")?;
            let files = detect_version_files(dir);
            if files.is_empty() {
                return Err(CoreError::invalid_input("docker needs a version file to tag the image with"));
            }
            let phases = vec![
                checks("preflight", vec!["tool_available:docker".into(), "docker_logged_in".into(), "git_clean".into(), "version_files_in_sync".into()]),
                bump(),
                commit("chore: release v{version}"),
                shell("build", format!("docker build -t {image}:{{version}} -t {image}:latest ."), true, true),
                shell("push-versioned", format!("docker push {image}:{{version}}"), false, false),
                shell("push-latest", format!("docker push {image}:latest"), false, false),
                tag("tag", "v{version}", ShipTagConflict::Fail),
                push("push"),
            ];
            Ok(config(product, files, phases))
        }
        "tauri-windows" => tauri_windows(dir, product, &params),
        "tauri-macos" => tauri_macos(dir, product, &params),
        other => Err(CoreError::internal(format!("template `{other}` is listed but has no builder"))),
    }
}

fn require_tauri(dir: &Path) -> Result<()> {
    if dir.join("src-tauri/tauri.conf.json").is_file() {
        Ok(())
    } else {
        Err(CoreError::invalid_input("this template needs src-tauri/tauri.conf.json"))
    }
}

fn tauri_windows(dir: &Path, product: String, params: &Params) -> Result<ShipConfig> {
    require_tauri(dir)?;
    let repo = params.req("repo")?;
    let base = params.opt("bundle_basename").unwrap_or_else(|| format!("{}-Windows", asset_safe(&product)));
    let key = params.opt("signing_key");
    let sign = params.opt("sign_command");
    let nsis = "**target/release/bundle/nsis";
    let mut pre = vec![
        "version_files_in_sync".to_string(),
        "gh_authenticated".into(),
        format!("gh_repo_reachable:{repo}"),
        format!("tag_not_exists:{repo}"),
        format!("no_stale_bundle:{nsis}/*{{version}}*.exe"),
        "no_holding_processes:cargo.exe,rustc.exe".into(),
    ];
    if let Some(k) = &key {
        pre.push(format!("minisign_key_valid:{k}"));
    }
    if let Some(exe) = sign.as_deref().and_then(|s| s.split_whitespace().next()) {
        pre.push(format!("tool_available:{exe}"));
    }
    let mut phases = vec![checks("preflight", pre), bump(), staging()];
    if let Some(k) = &key {
        phases.push(ShipPhase::LoadEnvFromFile { name: "load-updater-key".into(), var: "TAURI_SIGNING_PRIVATE_KEY".into(), file: k.clone(), required: true });
    }
    if let Some(s) = &sign {
        phases.push(ShipPhase::PatchTauriConf {
            name: "patch-conf".into(),
            path: Some("src-tauri/tauri.conf.json".into()),
            before_bundle_command: None,
            windows_sign_command: Some(s.clone()),
            webview_install_mode: None,
        });
    }
    phases.push(build("npm run tauri build"));
    if sign.is_some() {
        phases.push(ShipPhase::RestoreTauriConf { name: "restore-conf".into(), path: Some("src-tauri/tauri.conf.json".into()) });
        phases.push(ShipPhase::VerifyAuthenticode { name: "verify-installer".into(), file: format!("{nsis}/*{{version}}*.exe") });
    }
    phases.push(ShipPhase::StageArtifact {
        name: "stage-installer".into(),
        source_glob: format!("{nsis}/*{{version}}*.exe"),
        dest_name: format!("{base}-{{version}}-setup.exe"),
    });
    let mut files = vec![format!("{{staging_dir}}/{base}-{{version}}-setup.exe")];
    if key.is_some() {
        // Tauri v2 updater artifacts: the installer itself + its .sig.
        phases.push(ShipPhase::ReadUpdaterSig { name: "read-updater-sig".into(), source_glob: format!("{nsis}/*{{version}}*.exe.sig"), store_as: "signature".into() });
        phases.push(ShipPhase::BuildLatestJson {
            name: "build-latest-json".into(),
            repo: repo.clone(),
            platform: "windows-x86_64".into(),
            bundle_name: format!("{base}-{{version}}-setup.exe"),
            tag: "v{version}".into(),
            sig_var: "signature".into(),
            dest: "{staging_dir}/latest.json".into(),
            notes: "{productName} v{version}".into(),
        });
        files.push("{staging_dir}/latest.json".into());
    }
    phases.push(release(&repo, "{productName} v{version} for Windows".into(), files));
    Ok(config(product, detect_version_files(dir), phases))
}

fn tauri_macos(dir: &Path, product: String, params: &Params) -> Result<ShipConfig> {
    require_tauri(dir)?;
    let repo = params.req("repo")?;
    let identity = params.req("codesign_identity")?;
    let profile = params.req("notarytool_profile")?;
    let app = params.opt("app_name").unwrap_or_else(|| product.clone());
    let base = params.opt("bundle_basename").unwrap_or_else(|| format!("{}-macOS", asset_safe(&product)));
    let key = params.opt("signing_key");
    let bundle_dir = "**target/release/bundle/macos";
    let dmg = format!("{{staging_dir}}/{base}-{{version}}.dmg");
    let mut pre = vec![
        "version_files_in_sync".to_string(),
        "gh_authenticated".into(),
        format!("gh_repo_reachable:{repo}"),
        format!("tag_not_exists:{repo}"),
        "xcrun_available".into(),
        format!("codesign_identity:{identity}"),
        format!("notarytool_profile:{profile}"),
    ];
    if let Some(k) = &key {
        pre.push(format!("minisign_key_valid:{k}"));
    }
    let mut phases = vec![checks("preflight", pre), bump(), staging()];
    if let Some(k) = &key {
        phases.push(ShipPhase::LoadEnvFromFile { name: "load-updater-key".into(), var: "TAURI_SIGNING_PRIVATE_KEY".into(), file: k.clone(), required: true });
    }
    phases.push(build("npm run tauri build"));
    phases.push(ShipPhase::CodesignMacos { name: "codesign-app".into(), app_bundle: format!("{bundle_dir}/{app}.app"), identity, entitlements: None });
    phases.push(ShipPhase::CreateDmg { name: "create-dmg".into(), app_bundle: format!("{bundle_dir}/{app}.app"), dest: dmg.clone(), volume_name: Some(app.clone()) });
    phases.push(ShipPhase::Notarize { name: "notarize-dmg".into(), artifact: dmg.clone(), keychain_profile: profile });
    phases.push(ShipPhase::StapleNotarization { name: "staple-dmg".into(), artifact: dmg.clone() });
    let mut files = vec![dmg];
    if key.is_some() {
        phases.push(ShipPhase::StageArtifact {
            name: "stage-updater-bundle".into(),
            source_glob: format!("{bundle_dir}/{app}.app.tar.gz"),
            dest_name: format!("{base}-{{version}}.app.tar.gz"),
        });
        phases.push(ShipPhase::ReadUpdaterSig { name: "read-updater-sig".into(), source_glob: format!("{bundle_dir}/{app}.app.tar.gz.sig"), store_as: "signature".into() });
        phases.push(ShipPhase::BuildLatestJson {
            name: "build-latest-json".into(),
            repo: repo.clone(),
            platform: params.or("updater_platform", "darwin-aarch64"),
            bundle_name: format!("{base}-{{version}}.app.tar.gz"),
            tag: "v{version}".into(),
            sig_var: "signature".into(),
            dest: "{staging_dir}/latest.json".into(),
            notes: "{productName} v{version}".into(),
        });
        files.push(format!("{{staging_dir}}/{base}-{{version}}.app.tar.gz"));
        files.push("{staging_dir}/latest.json".into());
    }
    phases.push(release(&repo, "{productName} v{version} for macOS".into(), files));
    Ok(config(product, detect_version_files(dir), phases))
}

/// File-name-safe product name for asset names.
fn asset_safe(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        for (p, c) in files {
            let path = t.path().join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, c).unwrap();
        }
        t
    }

    fn json(cfg: &ShipConfig) -> String {
        serde_json::to_string(cfg).unwrap()
    }

    #[test]
    fn unknown_project_kind_is_unsupported() {
        let t = tempfile::tempdir().unwrap();
        let e = build_from_template(t.path(), None, &BTreeMap::new()).unwrap_err();
        assert_eq!(e.code, crate::ErrorCode::Unsupported);
    }

    #[test]
    fn minimal_uses_detected_build_and_version_files() {
        let t = dir_with(&[
            ("Cargo.toml", "[workspace]\nmembers = [\"crates/a\"]\n\n[workspace.package]\nversion = \"0.2.0\"\n"),
            ("crates/a/Cargo.toml", "[package]\nname = \"a\"\nversion = \"0.2.0\"\n"),
        ]);
        let cfg = build_from_template(t.path(), Some("minimal"), &BTreeMap::new()).unwrap();
        let paths: Vec<_> = cfg.version_files.iter().map(|v| format!("{}#{}", v.path, v.key)).collect();
        assert_eq!(paths, ["Cargo.toml#workspace.package.version", "crates/a/Cargo.toml#package.version"]);
        assert!(json(&cfg).contains("cargo build --release"));
        assert!(!json(&cfg).contains("TODO"));
    }

    #[test]
    fn no_template_bakes_in_product_or_signing_defaults() {
        let t = dir_with(&[
            ("package.json", "{\"name\":\"acme\",\"version\":\"1.0.0\"}"),
            ("src-tauri/tauri.conf.json", "{\"productName\":\"Acme\",\"version\":\"1.0.0\"}"),
            ("src-tauri/Cargo.toml", "[package]\nname = \"acme\"\nversion = \"1.0.0\"\n"),
        ]);
        let all: BTreeMap<&str, &str> = [
            ("repo", "o/r"), ("bin_name", "x"), ("targets", "x86_64-unknown-linux-gnu"), ("project", "p"), ("image", "i"),
            ("bucket", "b"), ("codesign_identity", "id"), ("notarytool_profile", "np"),
        ]
        .into_iter()
        .collect();
        for info in available_templates() {
            let params: BTreeMap<String, String> =
                info.params.iter().filter_map(|p| all.get(p.key.as_str()).map(|v| (p.key.clone(), v.to_string()))).collect();
            let cfg = build_from_template(t.path(), Some(&info.id), &params).unwrap_or_else(|e| panic!("{}: {}", info.id, e.message));
            let s = json(&cfg).to_lowercase();
            for banned in ["qwick", "quadflow", "sign-quadflow", "build-release", "generate-keys", "todo build", "owner/repo"] {
                assert!(!s.contains(banned), "{} contains {banned}: {s}", info.id);
            }
            assert_eq!(cfg.product_name, "Acme");
            let v = super::super::validate_config(&cfg, t.path());
            assert!(v.valid, "{}: {:?}", info.id, v.errors);
        }
    }

    #[test]
    fn unknown_param_and_missing_required_are_rejected() {
        let t = dir_with(&[("package.json", "{\"version\":\"1.0.0\"}")]);
        let mut p = BTreeMap::new();
        p.insert("nope".to_string(), "1".to_string());
        assert_eq!(build_from_template(t.path(), Some("vercel"), &p).unwrap_err().code, crate::ErrorCode::InvalidInput);
        assert_eq!(build_from_template(t.path(), Some("docker"), &BTreeMap::new()).unwrap_err().code, crate::ErrorCode::InvalidInput);
        assert_eq!(build_from_template(t.path(), Some("nope"), &BTreeMap::new()).unwrap_err().code, crate::ErrorCode::InvalidInput);
        let mut b = BTreeMap::new();
        b.insert("bump".to_string(), "maybe".to_string());
        assert_eq!(build_from_template(t.path(), Some("fly"), &b).unwrap_err().code, crate::ErrorCode::InvalidInput);
    }

    #[test]
    fn tauri_windows_signing_is_opt_in() {
        let t = dir_with(&[("src-tauri/tauri.conf.json", "{\"productName\":\"Acme App\",\"version\":\"1.0.0\"}")]);
        let mut p = BTreeMap::new();
        p.insert("repo".to_string(), "o/r".to_string());
        let plain = json(&build_from_template(t.path(), Some("tauri-windows"), &p).unwrap());
        assert!(!plain.contains("sign_authenticode") && !plain.contains("signCommand") && !plain.contains("latest.json"));
        assert!(plain.contains("Acme-App-Windows-{version}-setup.exe"));
        p.insert("sign_command".to_string(), "signtool sign /a {file}".to_string());
        p.insert("signing_key".to_string(), "keys/k".to_string());
        let signed = json(&build_from_template(t.path(), Some("tauri-windows"), &p).unwrap());
        assert!(signed.contains("\"windowsSignCommand\":\"signtool sign /a {file}\""));
        assert!(signed.contains("verify_authenticode") && signed.contains("latest.json"));
    }
}
