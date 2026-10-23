//! `native.*` (plugin-system.md §6.7): main window handle (`native:windows`),
//! child webviews in tiles (`native:webview`) and screen capture
//! (`native:screen-capture`). Tile geometry and the overlay/z-order contract
//! live in the shell (JS); the shell positions a plugin's child webview with
//! `native.webviewSetBounds` and hides it whenever the tile is not visible.

use super::AppExtension;
use parking_lot::Mutex;
use quadflow_core::plugins::host::{HostCall, HostEnv, MethodSpec, PermReq};
use quadflow_core::CoreError;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Wry};

/// Child webviews created by plugins: label → owning plugin id.
#[derive(Default)]
pub struct PluginWebviews(Mutex<HashMap<String, String>>);

fn webview_of(app: &AppHandle<Wry>, owned: &PluginWebviews, c: &HostCall) -> Result<tauri::Webview<Wry>, CoreError> {
    let id: String = c.arg("id")?;
    if owned.0.lock().get(&id).map(String::as_str) != Some(c.plugin.id.as_str()) {
        return Err(CoreError::not_found(format!("webview {id:?} does not belong to plugin {:?}", c.plugin.id)));
    }
    app.get_webview(&id).ok_or_else(|| CoreError::not_found(format!("webview {id:?} is gone")))
}

fn web_url(raw: &str) -> Result<tauri::Url, CoreError> {
    let url = tauri::Url::parse(raw).map_err(|e| CoreError::invalid_input(format!("invalid url {raw:?}: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreError::invalid_input(format!("child webviews only load http(s) URLs, got {raw:?}")));
    }
    Ok(url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Region {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Optional `userAgent` param (API 1.4): one line, at most 512 characters.
fn user_agent(c: &HostCall) -> Result<Option<String>, CoreError> {
    match c.opt::<String>("userAgent")?.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(ua) if ua.len() > 512 || ua.chars().any(char::is_control) => {
            Err(CoreError::invalid_input("userAgent must be one line of at most 512 characters"))
        }
        other => Ok(other),
    }
}

fn err(e: impl std::fmt::Display) -> CoreError {
    CoreError::external(e.to_string())
}

pub(super) fn methods(ext: &AppExtension) -> Vec<MethodSpec> {
    let mut v = Vec::new();

    let app = ext.app.clone();
    v.push(MethodSpec::new("native.mainWindowHandle", PermReq::One("native:windows"), move |_e: &HostEnv, _c: &HostCall| {
        let w = app.get_webview_window("main").ok_or_else(|| CoreError::not_found("main window"))?;
        #[cfg(windows)]
        {
            // Plugins ask for the handle to embed / position native windows next to the webview.
            ensure_webview_clip_siblings(&app);
            let h = w.hwnd().map_err(err)?;
            Ok(Value::String((h.0 as isize).to_string()))
        }
        #[cfg(target_os = "macos")]
        {
            let h = w.ns_window().map_err(err)?;
            Ok(Value::String((h as usize).to_string()))
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = w;
            Err(CoreError::unsupported("native.mainWindowHandle is not available on this platform yet"))
        }
    }));

    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.createChildWebview", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let url = web_url(&c.arg::<String>("url")?)?;
        let instance: String = c.arg("instanceId")?;
        let window = app.get_window("main").ok_or_else(|| CoreError::not_found("main window"))?;
        let label = format!("plugin-wv-{}", uuid::Uuid::new_v4().simple());
        let mut builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url));
        if let Some(ua) = user_agent(c)? {
            builder = builder.user_agent(&ua);
        }
        // Created off-screen at zero size; the shell positions it from the
        // tile geometry (and keeps it hidden while overlays cover the tile).
        let wv = window
            .add_child(builder, LogicalPosition::new(-10_000.0, -10_000.0), LogicalSize::new(1.0, 1.0))
            .map_err(err)?;
        let _ = wv.hide();
        ensure_webview_clip_siblings(&app);
        owned.0.lock().insert(label.clone(), c.plugin.id.clone());
        log::debug!("[plugin-host] {} child webview {label} for tile {instance}", c.plugin.id);
        Ok(json!({ "id": label }))
    }));

    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.webviewSetBounds", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let wv = webview_of(&app, &owned, c)?;
        let b: Bounds = c.arg("bounds")?;
        if b.visible && b.width >= 1.0 && b.height >= 1.0 {
            wv.set_position(LogicalPosition::new(b.x, b.y)).map_err(err)?;
            wv.set_size(LogicalSize::new(b.width, b.height)).map_err(err)?;
            wv.show().map_err(err)?;
        } else {
            wv.hide().map_err(err)?;
        }
        Ok(Value::Null)
    }));

    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.webviewNavigate", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let wv = webview_of(&app, &owned, c)?;
        wv.navigate(web_url(&c.arg::<String>("url")?)?).map_err(err)?;
        Ok(Value::Null)
    }));

    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.webviewEval", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let wv = webview_of(&app, &owned, c)?;
        wv.eval(c.arg::<String>("js")?).map_err(err)?;
        Ok(Value::Null)
    }));

    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.webviewClose", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let wv = webview_of(&app, &owned, c)?;
        owned.0.lock().remove(wv.label());
        // `native.openWindow` windows close as a whole; child webviews on their own.
        match app.get_webview_window(wv.label()) {
            Some(w) => w.close().map_err(err)?,
            None => wv.close().map_err(err)?,
        }
        Ok(Value::Null)
    }));

    // API 1.4: a top-level window for an http(s) page (pop-out players). Owned like a child
    // webview, so `native.webview*` (navigate / eval / close) work on it.
    let (app, owned) = (ext.app.clone(), Arc::clone(&ext.webviews));
    v.push(MethodSpec::new("native.openWindow", PermReq::One("native:webview"), move |_e: &HostEnv, c: &HostCall| {
        let url = web_url(&c.arg::<String>("url")?)?;
        let label = format!("plugin-win-{}", uuid::Uuid::new_v4().simple());
        let title = c.opt::<String>("title")?.map(|t| t.chars().take(200).collect::<String>()).unwrap_or_else(|| "QuadFlow".into());
        let width = c.opt::<f64>("width")?.unwrap_or(480.0).clamp(200.0, 4000.0);
        let height = c.opt::<f64>("height")?.unwrap_or(800.0).clamp(200.0, 4000.0);
        let mut b = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
            .title(&title)
            .inner_size(width, height)
            .resizable(true);
        if let Some(ua) = user_agent(c)? {
            b = b.user_agent(&ua);
        }
        b.build().map_err(err)?;
        owned.0.lock().insert(label.clone(), c.plugin.id.clone());
        log::debug!("[plugin-host] {} window {label}", c.plugin.id);
        Ok(json!({ "id": label }))
    }));

    // API 1.4: the monitor at an absolute physical point (the shell passes the tile's center).
    let app = ext.app.clone();
    v.push(MethodSpec::new("native.monitorOf", PermReq::One("native:windows"), move |_e: &HostEnv, c: &HostCall| {
        let (x, y): (f64, f64) = (c.arg("x")?, c.arg("y")?);
        let w = app.get_webview_window("main").ok_or_else(|| CoreError::not_found("main window"))?;
        let m = w.monitor_from_point(x, y).map_err(err)?.or(w.current_monitor().map_err(err)?);
        Ok(match m {
            Some(m) => json!({
                "name": m.name(),
                "x": m.position().x,
                "y": m.position().y,
                "width": m.size().width,
                "height": m.size().height,
                "scaleFactor": m.scale_factor(),
            }),
            None => Value::Null,
        })
    }));

    // API 1.4: hand the foreground right to a process the plugin started or focuses
    // for the user (Windows refuses SetForegroundWindow from a background sidecar).
    v.push(MethodSpec::new("native.allowSetForeground", PermReq::One("native:windows"), |_e: &HostEnv, c: &HostCall| {
        let pid: u32 = c.arg("pid")?;
        if pid == 0 {
            return Err(CoreError::invalid_input("native.allowSetForeground: pid must not be 0"));
        }
        allow_set_foreground(pid)?;
        Ok(Value::Null)
    }));

    v.push(MethodSpec::new("native.captureRegion", PermReq::One("native:screen-capture"), |_e: &HostEnv, c: &HostCall| {
        use base64::Engine;
        let r: Region = c.arg("rect")?;
        let png = capture_png(r)?;
        Ok(Value::String(base64::engine::general_purpose::STANDARD.encode(png)))
    }));

    v
}

/// Give every webview host window (`WRY_WEBVIEW`) directly under the main window
/// `WS_CLIPSIBLINGS`. Wry creates it without, so it paints over sibling windows a
/// plugin embeds next to it (they get input but stay invisible). Called at startup
/// and after each child webview is created; idempotent. No-op off Windows.
pub fn ensure_webview_clip_siblings<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetWindow, GetWindowLongPtrW, SetWindowLongPtrW, GWL_STYLE, GW_CHILD, GW_HWNDNEXT, WS_CLIPSIBLINGS,
        };
        let Some(w) = app.get_webview_window("main") else { return };
        let Ok(main) = w.hwnd() else { return };
        let main = HWND(main.0 as _);
        unsafe {
            let mut c = GetWindow(main, GW_CHILD).ok();
            while let Some(h) = c {
                let mut buf = [0u16; 64];
                let n = GetClassNameW(h, &mut buf).max(0) as usize;
                if String::from_utf16_lossy(&buf[..n]) == "WRY_WEBVIEW" {
                    let st = GetWindowLongPtrW(h, GWL_STYLE);
                    if st & WS_CLIPSIBLINGS.0 as isize == 0 {
                        SetWindowLongPtrW(h, GWL_STYLE, st | WS_CLIPSIBLINGS.0 as isize);
                    }
                }
                c = GetWindow(h, GW_HWNDNEXT).ok();
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// `native.allowSetForeground(pid)` (API 1.4): let that process take the foreground
/// (Windows `AllowSetForegroundWindow`; the caller acts on a user click, which gives
/// QuadFlow the right to pass it on). No-op elsewhere.
fn allow_set_foreground(pid: u32) -> Result<(), CoreError> {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid).map_err(err)?;
    }
    #[cfg(not(windows))]
    let _ = pid;
    Ok(())
}

/// Capture `r` (absolute physical pixels) as PNG.
fn capture_png(r: Region) -> Result<Vec<u8>, CoreError> {
    use xcap::image::{ImageFormat, RgbaImage};
    if r.width == 0 || r.height == 0 {
        return Err(CoreError::invalid_input("capture region has zero size"));
    }
    let monitor = xcap::Monitor::from_point(r.x + (r.width as i32) / 2, r.y + (r.height as i32) / 2).map_err(err)?;
    let (mx, my) = (monitor.x().map_err(err)?, monitor.y().map_err(err)?);
    let full = monitor.capture_image().map_err(err)?;
    let (fw, fh) = (full.width() as i32, full.height() as i32);
    let (lx, ly) = ((r.x - mx).max(0), (r.y - my).max(0));
    let (right, bottom) = (((r.x - mx) + r.width as i32).min(fw), ((r.y - my) + r.height as i32).min(fh));
    let (cw, ch) = ((right - lx).max(0) as u32, (bottom - ly).max(0) as u32);
    if cw == 0 || ch == 0 {
        return Err(CoreError::invalid_input("capture region is off-screen"));
    }
    let raw = full.into_raw();
    let stride = fw as usize * 4;
    let mut out = Vec::with_capacity(cw as usize * ch as usize * 4);
    for row in 0..ch as usize {
        let start = (ly as usize + row) * stride + lx as usize * 4;
        out.extend_from_slice(&raw[start..start + cw as usize * 4]);
    }
    let img = RgbaImage::from_raw(cw, ch, out).ok_or_else(|| CoreError::internal("capture buffer size mismatch"))?;
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, ImageFormat::Png).map_err(err)?;
    Ok(png.into_inner())
}
