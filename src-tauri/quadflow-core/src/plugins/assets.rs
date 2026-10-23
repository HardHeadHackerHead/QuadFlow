//! Path resolution for the `qfplugin://` asset protocol (plugin-system.md §8.2).
//!
//! The Tauri handler (`src-tauri/src/plugin_protocol.rs`) is a thin wrapper:
//! everything security-relevant — which plugins are served, logical-path
//! parsing, percent-decoding, traversal and symlink checks, MIME types — lives
//! here so it is unit-tested with core.
//!
//! Logical paths:
//! - `/<pluginId>/<relPath>` → a file under that plugin's root;
//! - `/_runtime/<file>` → the sandbox runtime (`<resource_dir>/plugin-runtime/`, §8.4);
//! - `/_frame/<pluginId>` → the generated frame document of a sandboxed plugin
//!   ([`FrameDoc`], §8.4), only for `Active` plugins with a `ui.entry`.
//!
//! Every failure is reported as "not found" (404) so the protocol leaks nothing
//! about the filesystem.

use super::registry::{LoadedPlugin, PluginOrigin, PluginRegistry, PluginStatus};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// A plugin directory the protocol may serve from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetRoot {
    pub root: PathBuf,
    pub origin: PluginOrigin,
    /// UI module of an `Active` plugin: `/_frame/<id>` is served only when set.
    pub frame: Option<FrameSource>,
}

/// What a frame document loads (manifest `ui`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameSource {
    pub entry: String,
    pub style: Option<String>,
}

/// A resolved file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub plugin_id: String,
    /// Canonical path, inside the plugin root.
    pub file: PathBuf,
    pub mime: &'static str,
    pub origin: PluginOrigin,
}

/// Why a request is not served (all map to 404).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AssetError {
    /// Malformed or escaping path (`..`, backslash, absolute, bad escape, …).
    BadPath(String),
    /// Unknown or disabled plugin, reserved route, or missing file.
    NotFound(String),
}

impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AssetError::BadPath(m) => write!(f, "bad path: {m}"),
            AssetError::NotFound(m) => write!(f, "not found: {m}"),
        }
    }
}

/// Reserved first segments (PL-6).
pub const RUNTIME_PREFIX: &str = "_runtime";
pub const FRAME_PREFIX: &str = "_frame";

/// Plugins whose files may be served: enabled, with a readable manifest, built
/// for this OS. (Not only `Active`: Settings shows icons of plugins that need
/// consent or are incompatible. Code is only *executed* for active plugins —
/// the shell's loader decides that.)
pub fn is_servable(p: &LoadedPlugin) -> bool {
    p.enabled
        && p.manifest.is_some()
        && !matches!(p.status, PluginStatus::Disabled | PluginStatus::UnsupportedPlatform)
}

/// Snapshot of servable plugin roots, rebuilt whenever the registry changes.
#[derive(Clone, Debug, Default)]
pub struct AssetIndex {
    roots: BTreeMap<String, AssetRoot>,
    /// `<resource_dir>/plugin-runtime` (served at `/_runtime/`).
    runtime: Option<PathBuf>,
}

/// A request the protocol answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Served {
    File(Asset),
    Frame(FrameDoc),
}

impl AssetIndex {
    pub fn from_registry(reg: &PluginRegistry) -> Self {
        let roots = reg
            .all()
            .filter(|p| is_servable(p))
            .map(|p| {
                let frame = match (&p.status, p.manifest.as_ref().and_then(|m| m.ui.as_ref())) {
                    (PluginStatus::Active, Some(ui)) => Some(FrameSource { entry: ui.entry.clone(), style: ui.style.clone() }),
                    _ => None,
                };
                (p.id.clone(), AssetRoot { root: p.root.clone(), origin: p.origin, frame })
            })
            .collect();
        Self { roots, runtime: None }
    }

    pub fn from_roots(roots: impl IntoIterator<Item = (String, AssetRoot)>) -> Self {
        Self { roots: roots.into_iter().collect(), runtime: None }
    }

    /// Serve `/_runtime/*` from `dir` (`<resource_dir>/plugin-runtime`).
    pub fn with_runtime(mut self, dir: Option<PathBuf>) -> Self {
        self.runtime = dir;
        self
    }

    pub fn contains(&self, id: &str) -> bool {
        self.roots.contains_key(id)
    }

    /// Resolve a file path of a protocol URL (`/hello/dist/index.js`,
    /// `/_runtime/react.js`). Frame documents come from [`AssetIndex::serve`].
    pub fn resolve(&self, url_path: &str) -> Result<Asset, AssetError> {
        let (id, segments) = parse_logical_path(url_path)?;
        if id == FRAME_PREFIX {
            return Err(AssetError::NotFound("frame documents are generated (AssetIndex::serve)".into()));
        }
        if id == RUNTIME_PREFIX {
            let dir = self.runtime.as_ref().ok_or_else(|| AssetError::NotFound("no sandbox runtime".into()))?;
            let file = resolve_in_root(dir, &segments)?;
            return Ok(Asset { plugin_id: id, mime: mime_for(&file), file, origin: PluginOrigin::Bundled });
        }
        let root = self.roots.get(&id).ok_or_else(|| AssetError::NotFound(format!("plugin {id:?} is not served")))?;
        let file = resolve_in_root(&root.root, &segments)?;
        Ok(Asset { plugin_id: id, mime: mime_for(&file), file, origin: root.origin })
    }

    /// Resolve any protocol path: plugin files, the runtime, and
    /// `/_frame/<pluginId>`. `query` is the URL query (without `?`); only
    /// `theme=dark|light` is read here (the initial `data-theme`, so the frame
    /// does not flash) — the bootstrap reads the rest from its own location.
    pub fn serve(&self, url_path: &str, query: Option<&str>) -> Result<Served, AssetError> {
        let (id, segments) = parse_logical_path(url_path)?;
        if id != FRAME_PREFIX {
            return self.resolve(url_path).map(Served::File);
        }
        let [plugin_id] = segments.as_slice() else {
            return Err(AssetError::BadPath(format!("{url_path:?}: expected /_frame/<pluginId>")));
        };
        if !valid_plugin_id(plugin_id) {
            return Err(AssetError::BadPath(format!("{url_path:?}: invalid plugin id")));
        }
        let root =
            self.roots.get(plugin_id).ok_or_else(|| AssetError::NotFound(format!("plugin {plugin_id:?} is not served")))?;
        let src = root.frame.as_ref().ok_or_else(|| AssetError::NotFound(format!("plugin {plugin_id:?} has no active UI")))?;
        if self.runtime.as_ref().is_none_or(|d| !d.join("frame.js").is_file()) {
            return Err(AssetError::NotFound("the sandbox runtime is not installed".into()));
        }
        // The entry must be a real file of the plugin (same checks as any asset).
        let rel = |p: &str| p.split('/').filter(|s| !s.is_empty()).map(str::to_string).collect::<Vec<_>>();
        resolve_in_root(&root.root, &rel(&src.entry))?;
        let style = src.style.as_deref().filter(|s| resolve_in_root(&root.root, &rel(s)).is_ok());
        let theme = query
            .into_iter()
            .flat_map(|q| q.split('&'))
            .find_map(|kv| kv.strip_prefix("theme="))
            .filter(|t| matches!(*t, "dark" | "light"))
            .unwrap_or("dark");
        Ok(Served::Frame(frame_doc(plugin_id, &src.entry, style, theme, root.origin, &new_nonce())))
    }
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'))
}

// ---------------------------------------------------------------------------
// Sandbox frame document (plugin-system.md §8.4)
// ---------------------------------------------------------------------------

/// The shared specifiers (§8.3) and their files in the runtime — the same
/// file names as `public/qf-shared/` (`scripts/gen-shared-shims.mjs` SHARED).
pub const RUNTIME_MODULES: &[(&str, &str)] = &[
    ("react", "react.js"),
    ("react/jsx-runtime", "react-jsx-runtime.js"),
    ("react-dom", "react-dom.js"),
    ("react-dom/client", "react-dom-client.js"),
    ("zustand", "zustand.js"),
    ("@quadflow/plugin-api", "plugin-api.js"),
    ("@quadflow/ui", "ui.js"),
];

/// Origin of protocol URLs on this platform (what `convertFileSrc(…, 'qfplugin')` yields).
pub fn protocol_origin() -> &'static str {
    if cfg!(windows) {
        "http://qfplugin.localhost"
    } else {
        "qfplugin://localhost"
    }
}

/// A generated frame document and its `Content-Security-Policy` header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameDoc {
    pub plugin_id: String,
    pub html: String,
    pub csp: String,
    pub origin: PluginOrigin,
}

fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Percent-encode a manifest-relative path per segment (like `src/plugins/urls.ts`).
fn encode_path(rel: &str) -> String {
    rel.split('/')
        .filter(|s| !s.is_empty())
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// JSON for an inline `<script>`: `<`, `>`, `&`, U+2028/U+2029 escaped so the
/// text can never close the element.
fn inline_json(v: &serde_json::Value) -> String {
    serde_json::to_string(v)
        .expect("json")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// The frame HTML: an import map pointing the shared specifiers at
/// `/_runtime/*`, the runtime + plugin styles, the plugin's entry (as JSON data)
/// and the bootstrap module `/_runtime/frame.js`. The CSP allows scripts only
/// from `/_runtime/` and the plugin's own directory (plus the nonce'd import
/// map), no network (`connect-src 'none'`), no nested frames, no remote images.
pub fn frame_doc(plugin_id: &str, entry: &str, style: Option<&str>, theme: &str, origin: PluginOrigin, nonce: &str) -> FrameDoc {
    let base = protocol_origin();
    let imports: serde_json::Map<String, serde_json::Value> =
        RUNTIME_MODULES.iter().map(|(spec, file)| ((*spec).to_string(), format!("/_runtime/{file}").into())).collect();
    let import_map = inline_json(&serde_json::json!({ "imports": imports }));
    let boot = inline_json(&serde_json::json!({
        "pluginId": plugin_id,
        "entry": format!("/{plugin_id}/{}", encode_path(entry)),
        "dev": origin == PluginOrigin::Dev,
    }));
    let style_link = style
        .map(|s| format!("<link rel=\"stylesheet\" href=\"/{plugin_id}/{}\">\n", encode_path(s)))
        .unwrap_or_default();
    let html = format!(
        "<!doctype html>\n<html data-theme=\"{theme}\" data-qf-frame=\"{plugin_id}\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"color-scheme\" content=\"dark light\">\n\
         <script type=\"importmap\" nonce=\"{nonce}\">{import_map}</script>\n\
         <script type=\"application/json\" id=\"qf-frame\">{boot}</script>\n\
         <link rel=\"stylesheet\" href=\"/_runtime/runtime.css\">\n{style_link}\
         <script type=\"module\" src=\"/_runtime/frame.js\"></script>\n</head>\n<body><div id=\"root\"></div></body>\n</html>\n"
    );
    let own = format!("{base}/{plugin_id}/");
    let rt = format!("{base}/_runtime/");
    let csp = [
        "default-src 'none'".to_string(),
        format!("script-src 'nonce-{nonce}' {rt} {own}"),
        format!("style-src 'unsafe-inline' {rt} {own}"),
        format!("img-src data: blob: {rt} {own}"),
        format!("font-src data: {rt} {own}"),
        format!("media-src data: blob: {own}"),
        "connect-src 'none'".into(),
        "frame-src 'none'".into(),
        "worker-src 'none'".into(),
        "object-src 'none'".into(),
        "base-uri 'none'".into(),
        "form-action 'none'".into(),
    ]
    .join("; ");
    FrameDoc { plugin_id: plugin_id.to_string(), html, csp, origin }
}

/// Split `/<id>/<seg>/<seg>…` into the plugin id and decoded relative segments.
pub fn parse_logical_path(url_path: &str) -> Result<(String, Vec<String>), AssetError> {
    let bad = |m: &str| AssetError::BadPath(format!("{url_path:?}: {m}"));
    let rest = url_path.strip_prefix('/').ok_or_else(|| bad("must start with /"))?;
    if rest.contains('\\') {
        return Err(bad("backslash"));
    }
    let mut parts = rest.split('/');
    let id = decode_segment(parts.next().unwrap_or_default()).map_err(|m| bad(&m))?;
    let id_ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_'));
    if !id_ok {
        return Err(bad("invalid plugin id"));
    }
    let segments = parts.map(decode_segment).collect::<Result<Vec<_>, _>>().map_err(|m| bad(&m))?;
    if segments.is_empty() {
        return Err(bad("no file path"));
    }
    Ok((id, segments))
}

/// Percent-decode one path segment and reject anything that is not a plain
/// file/dir name: empty, `.`, `..`, separators, drive/stream colons, NUL and
/// other control characters.
fn decode_segment(raw: &str) -> Result<String, String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3).ok_or("truncated percent escape")?;
            let b = u8::from_str_radix(hex, 16).map_err(|_| "invalid percent escape")?;
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out).map_err(|_| "segment is not UTF-8")?;
    if s.is_empty() {
        return Err("empty path segment".into());
    }
    if s == "." || s == ".." {
        return Err("dot segment".into());
    }
    if s.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control()) {
        return Err(format!("forbidden character in segment {s:?}"));
    }
    Ok(s)
}

/// `root/segments…` must be an existing regular file whose canonical path is
/// inside the canonical root (symlinks resolved and re-checked).
pub fn resolve_in_root(root: &Path, segments: &[String]) -> Result<PathBuf, AssetError> {
    let not_found = |m: String| AssetError::NotFound(m);
    let canon_root = dunce::canonicalize(root).map_err(|e| not_found(format!("plugin root: {e}")))?;
    let mut p = canon_root.clone();
    for s in segments {
        p.push(s);
    }
    let canon = dunce::canonicalize(&p).map_err(|_| not_found(format!("{} does not exist", segments.join("/"))))?;
    if !canon.starts_with(&canon_root) {
        return Err(AssetError::BadPath(format!("{} resolves outside the plugin directory", segments.join("/"))));
    }
    if !canon.is_file() {
        return Err(not_found(format!("{} is not a file", segments.join("/"))));
    }
    Ok(canon)
}

/// `Content-Type` by extension.
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(dir: &Path) -> AssetIndex {
        AssetIndex::from_roots([(
            "hello".to_string(),
            AssetRoot { root: dir.join("hello"), origin: PluginOrigin::Bundled, frame: None },
        )])
    }

    /// `hello` (active UI) + `nope` (no UI) and a runtime dir with frame.js.
    fn frame_index(dir: &Path, origin: PluginOrigin) -> AssetIndex {
        let rt = dir.join("plugin-runtime");
        std::fs::create_dir_all(&rt).unwrap();
        std::fs::write(rt.join("frame.js"), "// boot").unwrap();
        std::fs::write(rt.join("react.js"), "export default {}").unwrap();
        AssetIndex::from_roots([
            (
                "hello".to_string(),
                AssetRoot {
                    root: dir.join("hello"),
                    origin,
                    frame: Some(FrameSource { entry: "dist/index.js".into(), style: Some("dist/missing.css".into()) }),
                },
            ),
            ("nope".to_string(), AssetRoot { root: dir.join("hello"), origin, frame: None }),
        ])
        .with_runtime(Some(rt))
    }

    #[test]
    fn runtime_files_are_served_from_the_runtime_dir() {
        let t = fixture();
        let ix = frame_index(t.path(), PluginOrigin::Bundled);
        let a = ix.resolve("/_runtime/react.js").unwrap();
        assert_eq!(a.mime, "text/javascript; charset=utf-8");
        assert!(a.file.ends_with("react.js"));
        assert!(ix.resolve("/_runtime/../secret.txt").is_err());
        assert!(ix.resolve("/_runtime/%2e%2e/secret.txt").is_err());
        assert!(matches!(ix.resolve("/_runtime/missing.js"), Err(AssetError::NotFound(_))));
        // Without a runtime dir nothing under /_runtime is served.
        assert!(matches!(index(t.path()).resolve("/_runtime/react.js"), Err(AssetError::NotFound(_))));
    }

    #[test]
    fn frame_documents() {
        let t = fixture();
        let ix = frame_index(t.path(), PluginOrigin::Dev);
        let Served::Frame(doc) = ix.serve("/_frame/hello", Some("role=tile&theme=light&tile=hello")).unwrap() else {
            panic!("expected a frame")
        };
        assert_eq!(doc.plugin_id, "hello");
        assert_eq!(doc.origin, PluginOrigin::Dev);
        assert!(doc.html.contains(r#"<html data-theme="light""#));
        assert!(doc.html.contains(r#""react":"/_runtime/react.js""#), "{}", doc.html);
        assert!(doc.html.contains(r#""@quadflow/ui":"/_runtime/ui.js""#));
        assert!(doc.html.contains(r#""entry":"/hello/dist/index.js""#));
        assert!(doc.html.contains(r#""dev":true"#));
        assert!(doc.html.contains(r#"<script type="module" src="/_runtime/frame.js">"#));
        // A missing style is left out rather than 404ing the frame.
        assert!(!doc.html.contains("missing.css"));
        // CSP: nonce'd import map, scripts only from the runtime and the plugin itself, no network.
        let nonce = doc.html.split("nonce=\"").nth(1).unwrap().split('"').next().unwrap();
        assert_eq!(nonce.len(), 32);
        let origin = protocol_origin();
        assert!(doc.csp.contains(&format!("script-src 'nonce-{nonce}' {origin}/_runtime/ {origin}/hello/;")), "{}", doc.csp);
        assert!(doc.csp.contains("connect-src 'none'"));
        assert!(doc.csp.contains("default-src 'none'"));
        assert!(doc.csp.contains("frame-src 'none'"));
        assert!(!doc.csp.contains("https:"));
        // Each document gets a fresh nonce.
        let Served::Frame(again) = ix.serve("/_frame/hello", None).unwrap() else { panic!() };
        assert_ne!(again.csp, doc.csp);
        assert!(again.html.contains(r#"data-theme="dark""#), "default theme");
        // Bad theme values fall back to dark (no injection into the attribute).
        let Served::Frame(bad) = ix.serve("/_frame/hello", Some("theme=%22%3E%3Cscript%3E")).unwrap() else { panic!() };
        assert!(bad.html.contains(r#"data-theme="dark""#));
        // Files still resolve through serve().
        assert!(matches!(ix.serve("/hello/dist/index.js", None), Ok(Served::File(_))));
    }

    #[test]
    fn frames_need_an_active_ui_and_the_runtime() {
        let t = fixture();
        let ix = frame_index(t.path(), PluginOrigin::Installed);
        assert!(matches!(ix.serve("/_frame/nope", None), Err(AssetError::NotFound(_))));
        assert!(matches!(ix.serve("/_frame/other", None), Err(AssetError::NotFound(_))));
        assert!(ix.serve("/_frame/hello/extra", None).is_err());
        assert!(ix.serve("/_frame/HELLO", None).is_err());
        assert!(ix.serve("/_frame/..", None).is_err());
        // frame.js missing → no frames.
        std::fs::remove_file(t.path().join("plugin-runtime/frame.js")).unwrap();
        assert!(matches!(ix.serve("/_frame/hello", None), Err(AssetError::NotFound(_))));
        // The entry must exist inside the plugin.
        let ix2 = AssetIndex::from_roots([(
            "hello".to_string(),
            AssetRoot {
                root: t.path().join("hello"),
                origin: PluginOrigin::Installed,
                frame: Some(FrameSource { entry: "../secret.txt".into(), style: None }),
            },
        )])
        .with_runtime(Some(t.path().join("plugin-runtime")));
        std::fs::write(t.path().join("plugin-runtime/frame.js"), "").unwrap();
        assert!(ix2.serve("/_frame/hello", None).is_err());
    }

    #[test]
    fn inline_json_cannot_close_the_script() {
        let s = inline_json(&serde_json::json!({ "x": "</script><script>alert(1)</script>&\u{2028}" }));
        assert!(!s.contains('<') && !s.contains('>') && !s.contains('&') && !s.contains('\u{2028}'));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&s).unwrap()["x"], "</script><script>alert(1)</script>&\u{2028}");
        assert_eq!(encode_path("dist/my file.js"), "dist/my%20file.js");
    }

    fn fixture() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("hello");
        std::fs::create_dir_all(root.join("dist/assets")).unwrap();
        std::fs::write(root.join("dist/index.js"), "export default {}").unwrap();
        std::fs::write(root.join("dist/assets/my icon.svg"), "<svg/>").unwrap();
        std::fs::write(root.join("quadflow-plugin.json"), "{}").unwrap();
        // A secret next to the plugin root.
        std::fs::write(t.path().join("secret.txt"), "nope").unwrap();
        t
    }

    #[test]
    fn serves_files_with_mime() {
        let t = fixture();
        let ix = index(t.path());
        let a = ix.resolve("/hello/dist/index.js").unwrap();
        assert_eq!(a.mime, "text/javascript; charset=utf-8");
        assert_eq!(a.plugin_id, "hello");
        assert!(a.file.ends_with("index.js"));
        let svg = ix.resolve("/hello/dist/assets/my%20icon.svg").unwrap();
        assert_eq!(svg.mime, "image/svg+xml");
        assert_eq!(ix.resolve("/hello/quadflow-plugin.json").unwrap().mime, "application/json; charset=utf-8");
    }

    #[test]
    fn traversal_and_malformed_paths_are_rejected() {
        let t = fixture();
        let ix = index(t.path());
        for p in [
            "/hello/../secret.txt",
            "/hello/dist/../../secret.txt",
            "/hello/%2e%2e/secret.txt",
            "/hello/%2E%2E/secret.txt",
            "/hello/dist/%2e%2e%2f%2e%2e%2fsecret.txt",
            "/hello/..%2fsecret.txt",
            "/hello/..%5csecret.txt",
            "/hello/dist\\..\\..\\secret.txt",
            "/hello/./dist/index.js",
            "/hello//dist/index.js",
            "/hello/C:%5cWindows%5cwin.ini",
            "/hello/dist/index.js%00.png",
            "/hello/dist/index.js:stream",
            "/hello/%zz",
            "/hello/%2",
            "/hello",
            "/hello/",
            "hello/dist/index.js",
            "/../hello/dist/index.js",
            "/HELLO/dist/index.js",
        ] {
            assert!(ix.resolve(p).is_err(), "{p} must be rejected");
        }
    }

    #[test]
    fn unknown_plugins_reserved_routes_and_missing_files_404() {
        let t = fixture();
        let ix = index(t.path());
        assert!(matches!(ix.resolve("/other/dist/index.js"), Err(AssetError::NotFound(_))));
        assert!(matches!(ix.resolve("/_runtime/react.js"), Err(AssetError::NotFound(_))));
        assert!(matches!(ix.resolve("/_frame/hello"), Err(AssetError::NotFound(_))));
        assert!(matches!(ix.resolve("/hello/dist/missing.js"), Err(AssetError::NotFound(_))));
        // A directory is not a file.
        assert!(matches!(ix.resolve("/hello/dist"), Err(AssetError::NotFound(_))));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let t = fixture();
        std::os::unix::fs::symlink(t.path().join("secret.txt"), t.path().join("hello/dist/link.txt")).unwrap();
        let ix = index(t.path());
        assert!(matches!(ix.resolve("/hello/dist/link.txt"), Err(AssetError::BadPath(_))));
    }

    #[cfg(windows)]
    #[test]
    fn symlink_escape_is_rejected() {
        let t = fixture();
        // Symlink creation needs Developer Mode / admin on Windows; skip if refused.
        if std::os::windows::fs::symlink_file(t.path().join("secret.txt"), t.path().join("hello/dist/link.txt")).is_err() {
            return;
        }
        let ix = index(t.path());
        assert!(matches!(ix.resolve("/hello/dist/link.txt"), Err(AssetError::BadPath(_))));
    }

    #[test]
    fn only_enabled_plugins_with_a_manifest_are_servable() {
        let manifest: super::super::Manifest = serde_json::from_value(serde_json::json!({
            "id": "hello", "name": "Hello", "version": "1.0.0", "apiVersion": "^1.0.0",
            "platforms": ["windows", "macos", "linux"]
        }))
        .unwrap();
        let base = LoadedPlugin {
            id: "hello".into(),
            manifest: Some(manifest),
            root: PathBuf::from("/x"),
            origin: PluginOrigin::Bundled,
            isolation: super::super::Isolation::Trusted,
            status: PluginStatus::Active,
            enabled: true,
            granted: Default::default(),
            errors: vec![],
            warnings: vec![],
            shadowed: vec![],
        };
        assert!(is_servable(&base));
        assert!(is_servable(&LoadedPlugin { status: PluginStatus::NeedsConsent, ..base.clone() }));
        assert!(!is_servable(&LoadedPlugin { status: PluginStatus::Disabled, enabled: false, ..base.clone() }));
        assert!(!is_servable(&LoadedPlugin { enabled: false, ..base.clone() }));
        assert!(!is_servable(&LoadedPlugin { status: PluginStatus::UnsupportedPlatform, ..base.clone() }));
        assert!(!is_servable(&LoadedPlugin { manifest: None, ..base }));
    }

    #[test]
    fn mime_table() {
        assert_eq!(mime_for(Path::new("a/b.CSS")), "text/css; charset=utf-8");
        assert_eq!(mime_for(Path::new("x.woff2")), "font/woff2");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }
}
