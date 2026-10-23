//! OBS WebSocket control (obws). One connection per sidecar; each tracker
//! (= one OBS Tracker tool config) manages its own scene and the webcam
//! sources it enabled there, and moves the active one to follow its tile.

use crate::devices::{self, VideoDevice};
use crate::settings::{self, ObsConnectionSettings, SettingsStore, UpdateObsConnectionSettingsRequest};
use quadflow_sidecar::{json, Host, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// OBS scene
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OBSScene {
    pub name: String,
}

/// Tracker's source info (device enabled in a scene)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackerDeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub source_name: String,
    pub scene_item_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ObsConnectionStatus {
    pub connected: bool,
    pub obs_version: Option<String>,
    pub canvas_width: u32,
    pub canvas_height: u32,
}

/// Tile rectangle in absolute physical screen pixels, plus the monitor size the
/// OBS canvas maps to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PositionUpdate {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub monitor_width: f64,
    pub monitor_height: f64,
}

#[derive(Default)]
struct PerTrackerState {
    scene_name: Option<String>,
    devices: HashMap<String, TrackerDeviceInfo>,
    active_device: Option<String>,
    last_position: Option<PositionUpdate>,
}

pub struct Obs {
    host: Option<Host>,
    settings: SettingsStore,
    client: tokio::sync::Mutex<Option<obws::Client>>,
    status: Mutex<ObsConnectionStatus>,
    trackers: Mutex<HashMap<String, PerTrackerState>>,
}

type R<T> = Result<T, String>;

/// Scale a tile rectangle (screen px) to OBS canvas coordinates.
pub fn to_canvas(u: &PositionUpdate, canvas_w: u32, canvas_h: u32) -> Option<(f64, f64, f64, f64)> {
    if canvas_w == 0 || canvas_h == 0 || u.monitor_width <= 0.0 || u.monitor_height <= 0.0 {
        return None;
    }
    let sx = canvas_w as f64 / u.monitor_width;
    let sy = canvas_h as f64 / u.monitor_height;
    Some((u.x * sx, u.y * sy, u.width * sx, u.height * sy))
}

/// The OBS input name for a tracker + device pair.
pub fn source_name(tracker_id: &str, device_name: &str) -> String {
    format!(
        "QuadFlow_{}_{}",
        tracker_id.chars().take(8).collect::<String>(),
        device_name.replace(' ', "_").chars().take(20).collect::<String>()
    )
}

fn build_transform(x: f64, y: f64, w: f64, h: f64) -> obws::requests::scene_items::SceneItemTransform {
    use obws::common::BoundsType;
    use obws::requests::scene_items::{Bounds, Position, SceneItemTransform};
    SceneItemTransform {
        position: Some(Position { x: Some(x as f32), y: Some(y as f32) }),
        rotation: None,
        scale: None,
        alignment: None,
        bounds: Some(Bounds { r#type: Some(BoundsType::Stretch), alignment: None, width: Some(w as f32), height: Some(h as f32) }),
        crop: None,
    }
}

/// In Studio Mode, cut to the scene so a change goes live at once.
async fn cut_if_studio_mode(client: &obws::Client, scene_name: &str) {
    if client.ui().studio_mode_enabled().await.unwrap_or(false) {
        let saved = client.transitions().current().await.ok();
        let _ = client.transitions().set_current("Cut").await;
        let _ = client.scenes().set_current_program_scene(scene_name).await;
        if let Some(saved) = saved {
            let _ = client.transitions().set_current(saved.id.name.as_str()).await;
        }
    }
}

impl Obs {
    pub fn new(data_dir: &std::path::Path, host: Option<Host>) -> Self {
        Self {
            settings: SettingsStore::new(data_dir, host.clone()),
            host,
            client: tokio::sync::Mutex::new(None),
            status: Mutex::new(ObsConnectionStatus::default()),
            trackers: Mutex::new(HashMap::new()),
        }
    }

    fn emit<T: Serialize>(&self, name: &str, payload: &T) {
        if let Some(h) = &self.host {
            h.ui(name, serde_json::to_value(payload).unwrap_or(Value::Null));
        }
    }

    fn log(&self, msg: String) {
        match &self.host {
            Some(h) => h.log("debug", msg),
            None => eprintln!("{msg}"),
        }
    }

    fn status_snapshot(&self) -> ObsConnectionStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn get_connection_settings(&self) -> ObsConnectionSettings {
        settings::masked(self.settings.get())
    }

    pub fn update_connection_settings(&self, r: &UpdateObsConnectionSettingsRequest) -> R<ObsConnectionSettings> {
        let s = settings::masked(self.settings.update(r)?);
        self.emit("connection-settings-changed", &s);
        Ok(s)
    }

    pub async fn connect(&self) -> R<ObsConnectionStatus> {
        let s = self.settings.get();
        let client = obws::Client::connect(&s.host, s.port, s.password.as_deref())
            .await
            .map_err(|e| format!("Failed to connect to OBS: {}", e))?;
        let version = client.general().version().await.map_err(|e| format!("Failed to get OBS version: {}", e))?;
        let video = client.config().video_settings().await.map_err(|e| format!("Failed to get video settings: {}", e))?;
        let status = ObsConnectionStatus {
            connected: true,
            obs_version: Some(version.obs_version.to_string()),
            canvas_width: video.base_width,
            canvas_height: video.base_height,
        };
        *self.client.lock().await = Some(client);
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        self.emit("status", &status);
        Ok(status)
    }

    pub async fn disconnect(&self) {
        self.client.lock().await.take();
        let status = ObsConnectionStatus::default();
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        self.trackers.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.emit("status", &status);
    }

    pub fn get_status(&self) -> ObsConnectionStatus {
        self.status_snapshot()
    }

    pub fn list_video_devices(&self) -> Vec<VideoDevice> {
        devices::enumerate_video_devices()
    }

    pub async fn list_scenes(&self) -> R<Vec<OBSScene>> {
        let lock = self.client.lock().await;
        let client = lock.as_ref().ok_or("Not connected to OBS")?;
        let scenes = client.scenes().list().await.map_err(|e| format!("Failed to list scenes: {}", e))?;
        Ok(scenes.scenes.iter().map(|s| OBSScene { name: s.id.name.clone() }).collect())
    }

    /// Enable (create/show + size) or disable (hide) a webcam source in the tracker's scene.
    pub async fn toggle_device(
        &self,
        tracker_id: &str,
        scene_name: &str,
        device_id: &str,
        device_name: &str,
        enabled: bool,
    ) -> R<Option<TrackerDeviceInfo>> {
        use obws::requests::inputs::{Create, SetSettings};
        use obws::requests::scene_items::{CreateSceneItem, SetEnabled, SetTransform};

        let lock = self.client.lock().await;
        let client = lock.as_ref().ok_or("Not connected to OBS")?;
        let source = source_name(tracker_id, device_name);

        if !enabled {
            let items = client.scene_items().list(scene_name.into()).await.map_err(|e| format!("Failed to list scene items: {}", e))?;
            if let Some(item) = items.iter().find(|i| i.source_name == source) {
                client
                    .scene_items()
                    .set_enabled(SetEnabled { scene: scene_name.into(), item_id: item.id, enabled: false })
                    .await
                    .map_err(|e| format!("Failed to disable source: {}", e))?;
            }
            if let Some(t) = self.trackers.lock().unwrap_or_else(|e| e.into_inner()).get_mut(tracker_id) {
                t.devices.remove(device_id);
                if t.active_device.as_deref() == Some(device_id) {
                    t.active_device = None;
                }
            }
            self.emit("device-disabled", &json!({ "tracker_id": tracker_id, "device_id": device_id }));
            return Ok(None);
        }

        // DirectShow input (the plugin is Windows-only).
        let input_kind = "dshow_input";
        let exists = client
            .inputs()
            .list(None)
            .await
            .map_err(|e| format!("Failed to list inputs: {}", e))?
            .iter()
            .any(|i| i.id.name == source);
        if !exists {
            self.log(format!("[OBS] Creating source '{source}' for device '{device_name}'"));
            client
                .inputs()
                .create(Create { scene: scene_name.into(), input: &source, kind: input_kind, settings: None::<Value>, enabled: Some(true) })
                .await
                .map_err(|e| format!("Failed to create input '{}': {}", source, e))?;
        }

        // OBS's own device list gives the exact id it expects for this camera.
        let available = client
            .inputs()
            .properties_list_property_items(source.as_str().into(), "video_device_id")
            .await
            .map_err(|e| format!("Failed to get video device list: {}", e))?;
        let obs_device = available.iter().find(|d| d.name == device_name).ok_or_else(|| {
            format!("Device '{}' not found in OBS. Available: {:?}", device_name, available.iter().map(|d| &d.name).collect::<Vec<_>>())
        })?;
        let obs_device_id = match &obs_device.value {
            Value::String(s) => s.clone(),
            other => other.to_string().trim_matches('"').to_string(),
        };
        let input_settings = json!({ "video_device_id": obs_device_id, "res_type": 0, "audio_output_mode": 0 });
        client
            .inputs()
            .set_settings(SetSettings { input: source.as_str().into(), settings: &input_settings, overlay: Some(true) })
            .await
            .map_err(|e| format!("Failed to set device: {}", e))?;

        let items = client.scene_items().list(scene_name.into()).await.map_err(|e| format!("Failed to list scene items: {}", e))?;
        let scene_item_id = match items.iter().find(|i| i.source_name == source) {
            Some(item) => {
                client
                    .scene_items()
                    .set_enabled(SetEnabled { scene: scene_name.into(), item_id: item.id, enabled: true })
                    .await
                    .map_err(|e| format!("Failed to enable source: {}", e))?;
                item.id
            }
            None => client
                .scene_items()
                .create(CreateSceneItem { scene: scene_name.into(), source: source.as_str().into(), enabled: Some(true) })
                .await
                .map_err(|e| format!("Failed to add source to scene: {}", e))?,
        };

        // Visible initial size: 640x480, centered.
        let st = self.status_snapshot();
        let (w, h) = (640.0, 480.0);
        let _ = client
            .scene_items()
            .set_transform(SetTransform {
                scene: scene_name.into(),
                item_id: scene_item_id,
                transform: build_transform((st.canvas_width as f64 - w) / 2.0, (st.canvas_height as f64 - h) / 2.0, w, h),
            })
            .await;

        let info = TrackerDeviceInfo {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
            source_name: source,
            scene_item_id,
        };
        {
            let mut trackers = self.trackers.lock().unwrap_or_else(|e| e.into_inner());
            let t = trackers.entry(tracker_id.to_string()).or_default();
            t.scene_name = Some(scene_name.to_string());
            t.devices.insert(device_id.to_string(), info.clone());
        }
        self.emit("device-enabled", &json!({ "tracker_id": tracker_id, "device": info }));
        Ok(Some(info))
    }

    /// Show only `device_id` in the tracker's scene and move it to the last known tile position.
    pub async fn set_active_device(&self, tracker_id: &str, device_id: Option<String>) -> R<()> {
        use obws::requests::scene_items::{SetEnabled, SetTransform};
        let lock = self.client.lock().await;
        let client = lock.as_ref().ok_or("Not connected to OBS")?;
        let (scene_name, devices, last_pos) = {
            let mut trackers = self.trackers.lock().unwrap_or_else(|e| e.into_inner());
            let t = trackers.entry(tracker_id.to_string()).or_default();
            t.active_device = device_id.clone();
            (t.scene_name.clone(), t.devices.clone(), t.last_position)
        };
        let scene_name = scene_name.ok_or_else(|| "No scene selected for this tracker".to_string())?;
        for (id, info) in &devices {
            let _ = client
                .scene_items()
                .set_enabled(SetEnabled { scene: scene_name.as_str().into(), item_id: info.scene_item_id, enabled: device_id.as_ref() == Some(id) })
                .await;
        }
        if let (Some(active), Some(u)) = (&device_id, last_pos) {
            if let (Some(info), Some((x, y, w, h))) = (devices.get(active), to_canvas(&u, self.status_snapshot().canvas_width, self.status_snapshot().canvas_height)) {
                let _ = client
                    .scene_items()
                    .set_transform(SetTransform { scene: scene_name.as_str().into(), item_id: info.scene_item_id, transform: build_transform(x, y, w, h) })
                    .await;
            }
        }
        cut_if_studio_mode(client, &scene_name).await;
        self.emit("active-device-changed", &json!({ "tracker_id": tracker_id, "device_id": device_id }));
        Ok(())
    }

    pub fn get_tracker_devices(&self, tracker_id: &str) -> Vec<TrackerDeviceInfo> {
        self.trackers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(tracker_id)
            .map(|t| t.devices.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Hot path: move the tracker's active source to the tile's position.
    pub async fn update_position(&self, tracker_id: &str, u: PositionUpdate) {
        use obws::requests::scene_items::SetTransform;
        let st = self.status_snapshot();
        if !st.connected {
            return;
        }
        let Some((x, y, w, h)) = to_canvas(&u, st.canvas_width, st.canvas_height) else { return };
        let target = {
            let mut trackers = self.trackers.lock().unwrap_or_else(|e| e.into_inner());
            let Some(t) = trackers.get_mut(tracker_id) else { return };
            t.last_position = Some(u);
            match (&t.active_device, &t.scene_name) {
                (Some(active), Some(scene)) => t.devices.get(active).map(|i| (scene.clone(), i.scene_item_id)),
                _ => None,
            }
        };
        let Some((scene_name, item_id)) = target else { return };
        let lock = self.client.lock().await;
        let Some(client) = lock.as_ref() else { return };
        let _ = client
            .scene_items()
            .set_transform(SetTransform { scene: scene_name.as_str().into(), item_id, transform: build_transform(x, y, w, h) })
            .await;
        cut_if_studio_mode(client, &scene_name).await;
    }

    /// Forget a tracker (tile closed); optionally remove its sources from OBS.
    pub async fn cleanup_tracker(&self, tracker_id: &str, delete_sources: bool) {
        let sources: Vec<String> = if delete_sources {
            self.trackers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(tracker_id)
                .map(|t| t.devices.values().map(|d| d.source_name.clone()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if !sources.is_empty() {
            if let Some(client) = self.client.lock().await.as_ref() {
                for s in &sources {
                    let _ = client.inputs().remove(s.as_str().into()).await;
                }
            }
        }
        self.trackers.lock().unwrap_or_else(|e| e.into_inner()).remove(tracker_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_mapping() {
        let u = PositionUpdate { x: 960.0, y: 540.0, width: 480.0, height: 270.0, monitor_width: 1920.0, monitor_height: 1080.0 };
        assert_eq!(to_canvas(&u, 3840, 2160), Some((1920.0, 1080.0, 960.0, 540.0)));
        assert_eq!(to_canvas(&u, 0, 0), None);
        let bad = PositionUpdate { monitor_width: 0.0, ..u };
        assert_eq!(to_canvas(&bad, 1920, 1080), None);
    }

    #[test]
    fn source_names_are_bounded() {
        assert_eq!(source_name("0123456789abcdef", "HD Pro Webcam C920"), "QuadFlow_01234567_HD_Pro_Webcam_C920");
        assert_eq!(source_name("t", "A very long camera name indeed"), "QuadFlow_t_A_very_long_camera_n");
        // Multi-byte names are cut on characters.
        assert_eq!(source_name("é", "Камера ноутбука встроенная"), "QuadFlow_é_Камера_ноутбука_встр");
    }

    #[tokio::test]
    async fn commands_without_obs_fail_cleanly() {
        let obs = Obs::new(&std::env::temp_dir().join("obs-tracker-test-noobs"), None);
        assert_eq!(obs.list_scenes().await.unwrap_err(), "Not connected to OBS");
        assert!(obs.toggle_device("t", "Scene", "d", "Cam", true).await.is_err());
        assert!(obs.set_active_device("t", None).await.is_err());
        // Hot path and cleanup are no-ops while disconnected.
        obs.update_position("t", PositionUpdate { x: 0.0, y: 0.0, width: 1.0, height: 1.0, monitor_width: 1.0, monitor_height: 1.0 }).await;
        obs.cleanup_tracker("t", true).await;
        assert!(obs.get_tracker_devices("t").is_empty());
        assert!(!obs.get_status().connected);
    }
}
