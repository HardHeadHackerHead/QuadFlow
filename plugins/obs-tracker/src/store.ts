import { create } from 'zustand'
import {
  obsTrackerApi,
  type ObsConnectionSettings,
  type ObsConnectionStatus,
  type VideoDevice,
  type OBSScene,
  type TrackerDeviceInfo,
  type UnlistenFn,
} from './api'

// Per-tracker timer state (keyed by configId)
interface TrackerTimerState {
  rotationProgress: number
  rotationPaused: boolean
  _rotationTimer: ReturnType<typeof setInterval> | null
  _rotationProgressTimer: ReturnType<typeof setInterval> | null
  _rotationStartTime: number
}

// Stable default for selectors (never mutated)
export const DEFAULT_TRACKER_TIMER_STATE: TrackerTimerState = Object.freeze({
  rotationProgress: 0,
  rotationPaused: false,
  _rotationTimer: null,
  _rotationProgressTimer: null,
  _rotationStartTime: 0,
})

function createTrackerTimerState(): TrackerTimerState {
  return {
    rotationProgress: 0,
    rotationPaused: false,
    _rotationTimer: null,
    _rotationProgressTimer: null,
    _rotationStartTime: 0,
  }
}

interface ObsTrackerStore {
  // Global state
  connectionSettings: ObsConnectionSettings | null
  status: ObsConnectionStatus
  videoDevices: VideoDevice[]
  scenes: OBSScene[]
  error: string | null

  // Per-tracker enabled devices (keyed by configId)
  trackerDevices: Map<string, TrackerDeviceInfo[]>

  // Per-tracker timer states
  trackerTimerStates: Map<string, TrackerTimerState>

  // Loading states
  isLoadingSettings: boolean
  isConnecting: boolean
  isLoadingDevices: boolean
  isLoadingScenes: boolean

  // Event listener cleanup
  _unlistenFns: UnlistenFn[]
  _initialized: boolean

  // Global actions
  init: () => Promise<void>
  cleanup: () => void
  loadConnectionSettings: () => Promise<void>
  updateConnectionSettings: (request: Parameters<typeof obsTrackerApi.updateConnectionSettings>[0]) => Promise<void>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refreshStatus: () => Promise<void>
  loadVideoDevices: () => Promise<void>
  loadScenes: () => Promise<void>
  clearError: () => void

  // Per-tracker actions
  toggleDevice: (configId: string, sceneName: string, deviceId: string, deviceName: string, enabled: boolean) => Promise<TrackerDeviceInfo | null>
  setActiveDevice: (configId: string, deviceId: string | null) => Promise<void>
  loadTrackerDevices: (configId: string) => Promise<void>
  updatePosition: (configId: string, x: number, y: number, w: number, h: number, monitorW: number, monitorH: number) => void
  cleanupTracker: (configId: string, deleteSources: boolean) => Promise<void>

  // Rotation timer actions
  startRotationTimer: (configId: string, devices: TrackerDeviceInfo[], intervalSecs: number) => void
  stopRotationTimer: (configId: string) => void
  toggleRotationPause: (configId: string, devices: TrackerDeviceInfo[], intervalSecs: number) => void
  nextDevice: (configId: string, devices: TrackerDeviceInfo[], activeDevice: string | null) => void
  prevDevice: (configId: string, devices: TrackerDeviceInfo[], activeDevice: string | null) => void
}

export const useObsTrackerStore = create<ObsTrackerStore>((set, get) => ({
  // Initial state
  connectionSettings: null,
  status: {
    connected: false,
    obs_version: null,
    canvas_width: 0,
    canvas_height: 0,
  },
  videoDevices: [],
  scenes: [],
  error: null,
  trackerDevices: new Map(),
  trackerTimerStates: new Map(),
  isLoadingSettings: false,
  isConnecting: false,
  isLoadingDevices: false,
  isLoadingScenes: false,
  _unlistenFns: [],
  _initialized: false,

  init: async () => {
    if (get()._initialized) return

    const unlistens: UnlistenFn[] = []

    try {
      // Listen for status changes
      const unlistenStatus = await obsTrackerApi.onStatus((statusEvent) => {
        set({ status: statusEvent })
      })
      unlistens.push(unlistenStatus)

      // Listen for errors
      const unlistenError = await obsTrackerApi.onError((event) => {
        set({ error: event.message })
      })
      unlistens.push(unlistenError)

      // Listen for connection settings changes
      const unlistenSettings = await obsTrackerApi.onConnectionSettingsChanged((newSettings) => {
        set({ connectionSettings: newSettings })
      })
      unlistens.push(unlistenSettings)

      set({ _unlistenFns: unlistens, _initialized: true })

      // Load initial data
      await get().loadConnectionSettings()
      await get().refreshStatus()
      // The sidecar outlives the window (e.g. a reload): pick up an existing connection.
      if (get().status.connected) {
        await get().loadVideoDevices()
        await get().loadScenes()
      }
    } catch (error) {
      console.error('Failed to initialize OBS Tracker store:', error)
    }
  },

  cleanup: () => {
    const { _unlistenFns, trackerTimerStates } = get()
    _unlistenFns.forEach((fn) => fn())
    // Clear all tracker timers
    trackerTimerStates.forEach((ts) => {
      if (ts._rotationTimer) clearInterval(ts._rotationTimer)
      if (ts._rotationProgressTimer) clearInterval(ts._rotationProgressTimer)
    })
    set({
      _unlistenFns: [],
      _initialized: false,
      trackerTimerStates: new Map(),
      trackerDevices: new Map(),
    })
  },

  loadConnectionSettings: async () => {
    set({ isLoadingSettings: true, error: null })
    try {
      const connectionSettings = await obsTrackerApi.getConnectionSettings()
      set({ connectionSettings, isLoadingSettings: false })
    } catch (error) {
      set({ isLoadingSettings: false, error: `Failed to load settings: ${error}` })
    }
  },

  updateConnectionSettings: async (request) => {
    set({ isLoadingSettings: true, error: null })
    try {
      const connectionSettings = await obsTrackerApi.updateConnectionSettings(request)
      set({ connectionSettings, isLoadingSettings: false })
    } catch (error) {
      set({ isLoadingSettings: false, error: `Failed to update settings: ${error}` })
    }
  },

  connect: async () => {
    set({ isConnecting: true, error: null })
    try {
      const status = await obsTrackerApi.connect()
      set({ status, isConnecting: false })
      // Load video devices and scenes on successful connect
      await get().loadVideoDevices()
      await get().loadScenes()
    } catch (error) {
      set({ isConnecting: false, error: `Failed to connect: ${error}` })
    }
  },

  disconnect: async () => {
    set({ error: null })
    try {
      // Stop all tracker timers
      const { trackerTimerStates } = get()
      trackerTimerStates.forEach((ts) => {
        if (ts._rotationTimer) clearInterval(ts._rotationTimer)
        if (ts._rotationProgressTimer) clearInterval(ts._rotationProgressTimer)
      })
      await obsTrackerApi.disconnect()
      set({
        videoDevices: [],
        scenes: [],
        trackerDevices: new Map(),
        trackerTimerStates: new Map(),
        status: {
          connected: false,
          obs_version: null,
          canvas_width: 0,
          canvas_height: 0,
        },
      })
    } catch (error) {
      set({ error: `Failed to disconnect: ${error}` })
    }
  },

  refreshStatus: async () => {
    try {
      const status = await obsTrackerApi.getStatus()
      set({ status })
    } catch (error) {
      console.error('Failed to refresh OBS status:', error)
    }
  },

  loadVideoDevices: async () => {
    set({ isLoadingDevices: true, error: null })
    try {
      const videoDevices = await obsTrackerApi.listVideoDevices()
      set({ videoDevices, isLoadingDevices: false })
    } catch (error) {
      set({ isLoadingDevices: false, error: `Failed to load devices: ${error}` })
    }
  },

  loadScenes: async () => {
    set({ isLoadingScenes: true, error: null })
    try {
      const scenes = await obsTrackerApi.listScenes()
      set({ scenes, isLoadingScenes: false })
    } catch (error) {
      set({ isLoadingScenes: false, error: `Failed to load scenes: ${error}` })
    }
  },

  clearError: () => set({ error: null }),

  // ==================== Per-Tracker Actions ====================

  toggleDevice: async (configId, sceneName, deviceId, deviceName, enabled) => {
    try {
      const result = await obsTrackerApi.toggleDevice(configId, sceneName, deviceId, deviceName, enabled)

      // Update local state
      const { trackerDevices } = get()
      const newDevices = new Map(trackerDevices)
      const existing = newDevices.get(configId) ?? []

      if (enabled && result) {
        // Add or update device
        const filtered = existing.filter(d => d.device_id !== deviceId)
        newDevices.set(configId, [...filtered, result])
      } else {
        // Remove device
        newDevices.set(configId, existing.filter(d => d.device_id !== deviceId))
      }

      set({ trackerDevices: newDevices })
      return result
    } catch (error) {
      set({ error: `Failed to toggle device: ${error}` })
      return null
    }
  },

  setActiveDevice: async (configId, deviceId) => {
    try {
      await obsTrackerApi.setActiveDevice(configId, deviceId)
    } catch (error) {
      set({ error: `Failed to set active device: ${error}` })
    }
  },

  loadTrackerDevices: async (configId) => {
    try {
      const devices = await obsTrackerApi.getTrackerDevices(configId)
      const newDevices = new Map(get().trackerDevices)
      newDevices.set(configId, devices)
      set({ trackerDevices: newDevices })
    } catch (error) {
      console.error('Failed to load tracker devices:', error)
    }
  },

  updatePosition: (configId, x, y, w, h, monitorW, monitorH) => {
    obsTrackerApi.updatePosition(configId, {
      x, y, width: w, height: h,
      monitor_width: monitorW, monitor_height: monitorH,
    }).catch(() => {
      // Silently ignore position update errors
    })
  },

  cleanupTracker: async (configId, deleteSources) => {
    // Stop timers
    const { trackerTimerStates } = get()
    const ts = trackerTimerStates.get(configId)
    if (ts) {
      if (ts._rotationTimer) clearInterval(ts._rotationTimer)
      if (ts._rotationProgressTimer) clearInterval(ts._rotationProgressTimer)
    }

    try {
      await obsTrackerApi.cleanupTracker(configId, deleteSources)
    } catch (error) {
      console.error('Failed to cleanup tracker:', error)
    }

    // Remove local state
    const newTimers = new Map(trackerTimerStates)
    newTimers.delete(configId)
    const newDevices = new Map(get().trackerDevices)
    newDevices.delete(configId)
    set({ trackerTimerStates: newTimers, trackerDevices: newDevices })
  },

  // ==================== Rotation Timer Actions ====================

  startRotationTimer: (configId, devices, intervalSecs) => {
    const { trackerTimerStates } = get()
    const existing = trackerTimerStates.get(configId)
    if (existing?._rotationTimer) clearInterval(existing._rotationTimer)
    if (existing?._rotationProgressTimer) clearInterval(existing._rotationProgressTimer)

    if (devices.length < 2) return

    const ts = existing ?? createTrackerTimerState()
    if (ts.rotationPaused) return

    const intervalMs = (intervalSecs || 10) * 1000
    const startTime = Date.now()

    let currentIndex = 0

    // Main rotation timer
    const timer = setInterval(() => {
      const curDevices = get().trackerDevices.get(configId) ?? []
      if (curDevices.length < 2) return

      currentIndex = (currentIndex + 1) % curDevices.length
      get().setActiveDevice(configId, curDevices[currentIndex].device_id)

      // Reset progress
      const newStates = new Map(get().trackerTimerStates)
      const curTs = newStates.get(configId)
      if (curTs) {
        newStates.set(configId, { ...curTs, _rotationStartTime: Date.now(), rotationProgress: 0 })
        set({ trackerTimerStates: newStates })
      }
    }, intervalMs)

    // Progress timer
    const progressTimer = setInterval(() => {
      const curTs = get().trackerTimerStates.get(configId)
      if (!curTs) return
      const elapsed = Date.now() - curTs._rotationStartTime
      const total = intervalSecs * 1000
      const progress = Math.min(100, (elapsed / total) * 100)

      const newStates = new Map(get().trackerTimerStates)
      newStates.set(configId, { ...curTs, rotationProgress: progress })
      set({ trackerTimerStates: newStates })
    }, 100)

    const newStates = new Map(trackerTimerStates)
    newStates.set(configId, {
      ...ts,
      _rotationTimer: timer,
      _rotationProgressTimer: progressTimer,
      _rotationStartTime: startTime,
      rotationProgress: 0,
      rotationPaused: false,
    })
    set({ trackerTimerStates: newStates })
  },

  stopRotationTimer: (configId) => {
    const { trackerTimerStates } = get()
    const ts = trackerTimerStates.get(configId)
    if (!ts) return
    if (ts._rotationTimer) clearInterval(ts._rotationTimer)
    if (ts._rotationProgressTimer) clearInterval(ts._rotationProgressTimer)

    const newStates = new Map(trackerTimerStates)
    newStates.set(configId, {
      ...ts,
      _rotationTimer: null,
      _rotationProgressTimer: null,
      rotationProgress: 0,
    })
    set({ trackerTimerStates: newStates })
  },

  toggleRotationPause: (configId, devices, intervalSecs) => {
    const { trackerTimerStates } = get()
    const ts = trackerTimerStates.get(configId) ?? createTrackerTimerState()

    if (ts.rotationPaused) {
      // Resume
      const newStates = new Map(trackerTimerStates)
      newStates.set(configId, { ...ts, rotationPaused: false })
      set({ trackerTimerStates: newStates })
      get().startRotationTimer(configId, devices, intervalSecs)
    } else {
      // Pause
      if (ts._rotationTimer) clearInterval(ts._rotationTimer)
      if (ts._rotationProgressTimer) clearInterval(ts._rotationProgressTimer)

      const newStates = new Map(trackerTimerStates)
      newStates.set(configId, {
        ...ts,
        rotationPaused: true,
        _rotationTimer: null,
        _rotationProgressTimer: null,
      })
      set({ trackerTimerStates: newStates })
    }
  },

  nextDevice: (configId, devices, activeDevice) => {
    if (devices.length < 2) return

    const currentIndex = activeDevice
      ? devices.findIndex(d => d.device_id === activeDevice)
      : -1
    const nextIndex = (currentIndex + 1) % devices.length
    get().setActiveDevice(configId, devices[nextIndex].device_id)
  },

  prevDevice: (configId, devices, activeDevice) => {
    if (devices.length < 2) return

    const currentIndex = activeDevice
      ? devices.findIndex(d => d.device_id === activeDevice)
      : 0
    const prevIndex = (currentIndex - 1 + devices.length) % devices.length
    get().setActiveDevice(configId, devices[prevIndex].device_id)
  },
}))
