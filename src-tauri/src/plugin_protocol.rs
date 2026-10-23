//! `qfplugin://` asset protocol (plugin-system.md §8.2, §8.4).
//!
//! URLs: `http://qfplugin.localhost/<pluginId>/<relPath>` on Windows,
//! `qfplugin://localhost/<pluginId>/<relPath>` on macOS/Linux, plus the sandbox
//! routes `/_runtime/<file>` (the in-frame runtime from
//! `<resource_dir>/plugin-runtime/`) and `/_frame/<pluginId>` (the generated
//! frame document of a sandboxed plugin, with its own CSP header). Path
//! parsing, traversal/symlink checks, the set of served plugins, frame HTML
//! and MIME types live in `quadflow_core::plugins::assets` (unit-tested
//! there); this module only adapts them to HTTP responses.
//!
//! Every response carries `Access-Control-Allow-Origin: *` (module scripts are
//! fetched in CORS mode — from the host document, and from opaque-origin
//! sandbox frames, whose `Origin` is `null`) and `X-Content-Type-Options:
//! nosniff`. Dev plugins, the runtime and frame documents get
//! `Cache-Control: no-cache`. Unknown/disabled plugins and bad paths → 404.

use crate::core_state::CoreState;
use parking_lot::RwLock;
use quadflow_core::plugins::assets::{AssetError, AssetIndex, Served, RUNTIME_PREFIX};
use quadflow_core::plugins::{resource_dir, PluginOrigin, PluginRegistry, ENV_RESOURCE_DIR};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

pub const SCHEME: &str = "qfplugin";

/// Cached [`AssetIndex`]; rebuilt lazily after [`PluginAssetState::invalidate`].
#[derive(Default)]
pub struct PluginAssetState {
    index: RwLock<Option<Arc<AssetIndex>>>,
}

/// `<resource_dir>/plugin-runtime` (built by `packages/plugin-runtime`, staged by bundle-plugins).
fn runtime_dir() -> Option<PathBuf> {
    resource_dir(std::env::var(ENV_RESOURCE_DIR).ok().as_deref()).map(|d| d.join("plugin-runtime"))
}

impl PluginAssetState {
    pub fn invalidate(&self) {
        *self.index.write() = None;
    }

    pub fn update_from(&self, reg: &PluginRegistry) {
        *self.index.write() = Some(Arc::new(AssetIndex::from_registry(reg).with_runtime(runtime_dir())));
    }

    fn get_or_load(&self, core: &quadflow_core::Core) -> Option<Arc<AssetIndex>> {
        if let Some(ix) = self.index.read().clone() {
            return Some(ix);
        }
        let db = core.app_db().map_err(|e| log::warn!("[qfplugin] app db: {e}")).ok()?;
        let reg = PluginRegistry::load(&core.paths, &db).map_err(|e| log::warn!("[qfplugin] registry: {e}")).ok()?;
        let ix = Arc::new(AssetIndex::from_registry(&reg).with_runtime(runtime_dir()));
        *self.index.write() = Some(ix.clone());
        Some(ix)
    }
}

/// Refresh the cached index from a freshly loaded registry (if the state is managed).
pub fn refresh<R: Runtime>(app: &AppHandle<R>, reg: &PluginRegistry) {
    if let Some(s) = app.try_state::<PluginAssetState>() {
        s.update_from(reg);
    }
}

/// Drop the cached index (after enable/disable/grant/install).
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(s) = app.try_state::<PluginAssetState>() {
        s.invalidate();
    }
}

/// Manage the state and register the scheme on the builder.
pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.manage(PluginAssetState::default()).register_asynchronous_uri_scheme_protocol(
        SCHEME,
        |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(handle(&app, &request)));
        },
    )
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("X-Content-Type-Options", "nosniff")
}

fn text(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    base(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.as_bytes().to_vec())
        .expect("static response")
}

fn handle<R: Runtime>(app: &AppHandle<R>, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method();
    if method == Method::OPTIONS {
        return base(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
            .body(Vec::new())
            .expect("static response");
    }
    if method != Method::GET && method != Method::HEAD {
        return text(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
    }
    let (Some(core), Some(state)) = (app.try_state::<CoreState>(), app.try_state::<PluginAssetState>()) else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
    };
    let Some(index) = state.get_or_load(&core.core) else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Service Unavailable");
    };
    let path = request.uri().path();
    let served = match index.serve(path, request.uri().query()) {
        Ok(s) => s,
        Err(e) => {
            match &e {
                AssetError::BadPath(_) => log::warn!("[qfplugin] rejected {path:?}: {e}"),
                AssetError::NotFound(_) => log::debug!("[qfplugin] {path:?}: {e}"),
            }
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
    };
    let asset = match served {
        Served::File(a) => a,
        Served::Frame(doc) => {
            let bytes = doc.html.into_bytes();
            let len = bytes.len();
            let body = if method == Method::HEAD { Vec::new() } else { bytes };
            return base(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_LENGTH, len)
                .header(header::CACHE_CONTROL, "no-cache")
                .header("Content-Security-Policy", doc.csp)
                .header("Referrer-Policy", "no-referrer")
                .body(body)
                .unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"));
        }
    };
    let bytes = match std::fs::read(&asset.file) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[qfplugin] read {}: {e}", asset.file.display());
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
    };
    let mut res = base(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime)
        .header(header::CONTENT_LENGTH, bytes.len());
    if asset.origin == PluginOrigin::Dev || asset.plugin_id == RUNTIME_PREFIX {
        res = res.header(header::CACHE_CONTROL, "no-cache");
    }
    let body = if method == Method::HEAD { Vec::new() } else { bytes };
    res.body(body).unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error"))
}
