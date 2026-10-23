//! Sidecar of the `obs-tracker` plugin (plugin-system.md §10).
//!
//! Requests (former `obs_*` Tauri commands without the prefix):
//! `get_connection_settings`, `update_connection_settings {request}`, `connect`,
//! `disconnect`, `get_status`, `list_video_devices`, `list_scenes`,
//! `toggle_device {trackerId, sceneName, deviceId, deviceName, enabled}`,
//! `set_active_device {trackerId, deviceId}`, `get_tracker_devices {trackerId}`,
//! `update_position {trackerId, update}` (also accepted as a notification — the
//! hot path), `cleanup_tracker {trackerId, deleteSources}`.
//! UI events (`ui/<name>`): `status`, `connection-settings-changed`, `error`,
//! `device-enabled`, `device-disabled`, `active-device-changed`.
//!
//! The OBS WebSocket connection is made by this process directly (obws); the
//! password is a host secret.

mod devices;
mod obs;
mod settings;

use obs::{Obs, PositionUpdate};
use quadflow_sidecar::{json, Host, RpcError, Server, Value};
use serde::de::DeserializeOwned;
use std::path::PathBuf;
use std::sync::OnceLock;

static OBS: OnceLock<Obs> = OnceLock::new();
static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime"))
}

fn obs(host: &Host) -> &'static Obs {
    OBS.get_or_init(|| {
        let dir = host
            .init()
            .and_then(|i| i.pointer("/plugin/dataDir"))
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("QUADFLOW_PLUGIN_DATA").map(PathBuf::from))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        Obs::new(&dir, Some(host.clone()))
    })
}

fn arg<T: DeserializeOwned>(p: &Value, keys: &[&str]) -> Result<T, RpcError> {
    let v = keys.iter().find_map(|k| p.get(*k)).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| RpcError::invalid_params(format!("`{}`: {e}", keys[0])))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| RpcError::new(e.to_string()))
}

fn err(host: &Host, message: String) -> RpcError {
    host.ui("error", json!({ "message": message }));
    RpcError::new(message)
}

fn update_position(host: &Host, p: &Value) -> Result<(), RpcError> {
    let tracker_id: String = arg(p, &["trackerId", "tracker_id"])?;
    let update: PositionUpdate = arg(p, &["update"])?;
    rt().block_on(obs(host).update_position(&tracker_id, update));
    Ok(())
}

fn main() -> std::io::Result<()> {
    Server::new()
        .on_request("get_connection_settings", |h, _| to_value(obs(h).get_connection_settings()))
        .on_request("update_connection_settings", |h, p| {
            let r: settings::UpdateObsConnectionSettingsRequest = arg(&p, &["request"])?;
            obs(h).update_connection_settings(&r).map_err(|e| err(h, e)).and_then(to_value)
        })
        .on_request("connect", |h, _| rt().block_on(obs(h).connect()).map_err(RpcError::new).and_then(to_value))
        .on_request("disconnect", |h, _| {
            rt().block_on(obs(h).disconnect());
            Ok(Value::Null)
        })
        .on_request("get_status", |h, _| to_value(obs(h).get_status()))
        .on_request("list_video_devices", |h, _| to_value(obs(h).list_video_devices()))
        .on_request("list_scenes", |h, _| rt().block_on(obs(h).list_scenes()).map_err(RpcError::new).and_then(to_value))
        .on_request("toggle_device", |h, p| {
            let tracker_id: String = arg(&p, &["trackerId", "tracker_id"])?;
            let scene_name: String = arg(&p, &["sceneName", "scene_name"])?;
            let device_id: String = arg(&p, &["deviceId", "device_id"])?;
            let device_name: String = arg(&p, &["deviceName", "device_name"])?;
            let enabled: bool = arg(&p, &["enabled"])?;
            rt().block_on(obs(h).toggle_device(&tracker_id, &scene_name, &device_id, &device_name, enabled))
                .map_err(RpcError::new)
                .and_then(to_value)
        })
        .on_request("set_active_device", |h, p| {
            let tracker_id: String = arg(&p, &["trackerId", "tracker_id"])?;
            let device_id: Option<String> = arg(&p, &["deviceId", "device_id"])?;
            rt().block_on(obs(h).set_active_device(&tracker_id, device_id)).map_err(RpcError::new)?;
            Ok(Value::Null)
        })
        .on_request("get_tracker_devices", |h, p| {
            let tracker_id: String = arg(&p, &["trackerId", "tracker_id"])?;
            to_value(obs(h).get_tracker_devices(&tracker_id))
        })
        .on_request("update_position", |h, p| update_position(h, &p).map(|_| Value::Null))
        .on_notification("update_position", |h, p| {
            if let Err(e) = update_position(h, &p) {
                h.log("debug", format!("update_position: {e}"));
            }
        })
        .on_request("cleanup_tracker", |h, p| {
            let tracker_id: String = arg(&p, &["trackerId", "tracker_id"])?;
            let delete: bool = arg::<Option<bool>>(&p, &["deleteSources", "delete_sources"])?.unwrap_or(false);
            rt().block_on(obs(h).cleanup_tracker(&tracker_id, delete));
            Ok(Value::Null)
        })
        .run()
}
