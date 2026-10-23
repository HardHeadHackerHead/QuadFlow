/**
 * Client of the obs-tracker sidecar (one method per former `obs_*` command; events are
 * its `ui/*` notifications) and the per-tracker settings, which live in this plugin's
 * storage keyed by tool config id (they used to be the tool config's `settings`).
 */
import type { JsonValue, PluginContext } from '@quadflow/plugin-api'

// ---- wire types (snake_case, as the Rust structs serialize) ----

export interface ObsConnectionSettings {
  host: string
  port: number
  /** Masked. */
  password: string | null
}

export interface UpdateObsConnectionSettingsRequest {
  host?: string
  port?: number
  password?: string
  clear_password?: boolean
}

export interface ObsConnectionStatus {
  connected: boolean
  obs_version: string | null
  canvas_width: number
  canvas_height: number
}

/** Video capture device (webcam) */
export interface VideoDevice {
  id: string
  name: string
}

/** A device enabled in a tracker's scene */
export interface TrackerDeviceInfo {
  device_id: string
  device_name: string
  source_name: string
  scene_item_id: number
}

export interface OBSScene {
  name: string
}

export interface ObsPositionUpdate {
  x: number
  y: number
  width: number
  height: number
  monitor_width: number
  monitor_height: number
}

/** Per-tracker settings (plugin storage `tracker/<configId>`). */
export interface ObsTrackerInstanceSettings {
  selected_scene: string | null
  enabled_devices: string[]
  active_device: string | null
  enabled: boolean
  auto_rotate: boolean
  rotate_interval_secs: number
}

export const OBS_TRACKER_INSTANCE_DEFAULTS: ObsTrackerInstanceSettings = {
  selected_scene: null,
  enabled_devices: [],
  active_device: null,
  enabled: false,
  auto_rotate: false,
  rotate_interval_secs: 10,
}

export type UnlistenFn = () => void

let current: PluginContext | null = null

export function bindContext(ctx: PluginContext) {
  current = ctx
}

function ctx(): PluginContext {
  if (!current) throw new Error('obs-tracker: plugin context not bound yet')
  return current
}

async function call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  try {
    return await ctx().sidecar.request<T>(method, params as JsonValue, { timeoutMs })
  } catch (e) {
    // The views show `${error}`: surface the sidecar's message.
    throw e instanceof Error ? e.message : e
  }
}

function on<T>(event: string, cb: (p: T) => void): Promise<UnlistenFn> {
  const off = ctx().sidecar.onNotification(event, (p) => cb(p as T))
  return Promise.resolve(() => off())
}

export const obsTrackerApi = {
  getConnectionSettings: () => call<ObsConnectionSettings>('get_connection_settings'),
  updateConnectionSettings: (request: UpdateObsConnectionSettingsRequest) =>
    call<ObsConnectionSettings>('update_connection_settings', { request }),
  connect: () => call<ObsConnectionStatus>('connect', {}, 20_000),
  disconnect: () => call<void>('disconnect'),
  getStatus: () => call<ObsConnectionStatus>('get_status'),
  listVideoDevices: () => call<VideoDevice[]>('list_video_devices'),
  listScenes: () => call<OBSScene[]>('list_scenes'),
  toggleDevice: (trackerId: string, sceneName: string, deviceId: string, deviceName: string, enabled: boolean) =>
    call<TrackerDeviceInfo | null>('toggle_device', { trackerId, sceneName, deviceId, deviceName, enabled }),
  setActiveDevice: (trackerId: string, deviceId: string | null) => call<void>('set_active_device', { trackerId, deviceId }),
  getTrackerDevices: (trackerId: string) => call<TrackerDeviceInfo[]>('get_tracker_devices', { trackerId }),
  /** Hot path: a notification (no response, no timeout). */
  updatePosition: async (trackerId: string, update: ObsPositionUpdate): Promise<void> => {
    ctx().sidecar.notify('update_position', { trackerId, update } as unknown as JsonValue)
  },
  cleanupTracker: (trackerId: string, deleteSources: boolean) => call<void>('cleanup_tracker', { trackerId, deleteSources }),

  onStatus: (cb: (s: ObsConnectionStatus) => void) => on('status', cb),
  onConnectionSettingsChanged: (cb: (s: ObsConnectionSettings) => void) => on('connection-settings-changed', cb),
  onError: (cb: (e: { message: string }) => void) => on('error', cb),
}

// ---- per-tracker settings ----

const key = (configId: string) => `tracker/${configId}`

export async function loadTrackerSettings(configId: string): Promise<ObsTrackerInstanceSettings> {
  const v = (await ctx().storage.get(key(configId)).catch(() => null)) as Partial<ObsTrackerInstanceSettings> | null
  return { ...OBS_TRACKER_INSTANCE_DEFAULTS, ...(v ?? {}) }
}

export async function saveTrackerSettings(configId: string, s: ObsTrackerInstanceSettings): Promise<void> {
  await ctx().storage.set(key(configId), s as unknown as JsonValue)
}
