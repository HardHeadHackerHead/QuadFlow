import { useEffect, useRef, useState, useCallback } from 'react'
import type { TileProps } from '@quadflow/plugin-api'
import { useObsTrackerStore, DEFAULT_TRACKER_TIMER_STATE } from './store'
import { loadTrackerSettings, saveTrackerSettings, OBS_TRACKER_INSTANCE_DEFAULTS, type ObsTrackerInstanceSettings } from './api'

/** Size of the monitor the window is on, in physical pixels (the OBS canvas maps onto it). */
function monitorSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1
  return { width: Math.round(window.screen.width * dpr), height: Math.round(window.screen.height * dpr) }
}

export default function ObsTrackerTile({ ctx, config, instance }: TileProps) {
  const configId = config.id
  const {
    connectionSettings, status, videoDevices, scenes, error,
    isConnecting, isLoadingDevices, isLoadingSettings, isLoadingScenes,
    init, connect, disconnect, updateConnectionSettings, loadVideoDevices, loadScenes,
    toggleDevice, setActiveDevice, loadTrackerDevices,
    updatePosition, cleanupTracker, clearError,
    startRotationTimer, stopRotationTimer, toggleRotationPause, nextDevice, prevDevice,
  } = useObsTrackerStore()

  // Get enabled devices for this tracker
  const trackerDevices = useObsTrackerStore(s => s.trackerDevices.get(configId)) ?? []

  // Per-tracker settings (plugin storage, keyed by tool config id)
  const [trackerSettings, setTrackerSettings] = useState<ObsTrackerInstanceSettings>(OBS_TRACKER_INSTANCE_DEFAULTS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    loadTrackerSettings(configId).then((s) => {
      if (!alive) return
      setTrackerSettings(s)
      setSettingsLoaded(true)
    })
    return () => { alive = false }
  }, [configId])

  // Per-tracker timer state
  const trackerTimerState = useObsTrackerStore(s => s.trackerTimerStates.get(configId)) ?? DEFAULT_TRACKER_TIMER_STATE

  const containerRef = useRef<HTMLDivElement>(null)
  const [showConnectionSettings, setShowConnectionSettings] = useState(true)
  const [localHost, setLocalHost] = useState('127.0.0.1')
  const [localPort, setLocalPort] = useState('4455')
  const [localPassword, setLocalPassword] = useState('')
  const [livePosition, setLivePosition] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const lastPositionKey = useRef('')
  const [localInterval, setLocalInterval] = useState('10')
  const [isToggling, setIsToggling] = useState<string | null>(null)

  // Initialize store on mount
  useEffect(() => {
    init()
  }, [init])

  // Track if we've synced for this connection
  const hasSyncedRef = useRef(false)

  // Load tracker devices when connected
  useEffect(() => {
    if (status.connected) {
      loadTrackerDevices(configId)
      hasSyncedRef.current = false // Reset sync flag on new connection
    }
  }, [status.connected, configId, loadTrackerDevices])

  // Sync local form fields from connection settings
  useEffect(() => {
    if (connectionSettings) {
      setLocalHost(connectionSettings.host)
      setLocalPort(String(connectionSettings.port))
    }
  }, [connectionSettings])

  // Sync interval from tracker settings
  useEffect(() => {
    setLocalInterval(String(trackerSettings.rotate_interval_secs))
  }, [trackerSettings.rotate_interval_secs])

  // Collapse connection settings when connected
  useEffect(() => {
    if (status.connected) {
      setShowConnectionSettings(false)
    }
  }, [status.connected])

  // Cleanup on unmount (don't delete sources by default)
  useEffect(() => {
    return () => {
      cleanupTracker(configId, false)
    }
  }, [configId, cleanupTracker])

  // Update per-tracker settings (state + plugin storage)
  const updateTrackerSettings = useCallback((updates: Partial<ObsTrackerInstanceSettings>) => {
    setTrackerSettings((prev) => {
      const next = { ...prev, ...updates }
      saveTrackerSettings(configId, next).catch((e) => ctx.log.warn('saving tracker settings failed', e))
      return next
    })
  }, [configId, ctx])

  // Position tracking
  const activeDevice = trackerSettings.active_device
  const selectedScene = trackerSettings.selected_scene
  const isTracking = status.connected && activeDevice && selectedScene && trackerSettings.enabled

  // Auto-sync: re-enable devices that are in settings but missing from backend
  // This happens when app restarts (backend state is lost but frontend settings persist)
  useEffect(() => {
    if (!settingsLoaded || !status.connected || !selectedScene || videoDevices.length === 0 || hasSyncedRef.current) {
      return
    }

    const backendDeviceIds = new Set(trackerDevices.map(d => d.device_id))
    const missingDevices = trackerSettings.enabled_devices.filter(id => !backendDeviceIds.has(id))

    if (missingDevices.length > 0) {
      hasSyncedRef.current = true // Prevent re-running
      console.log('[OBS] Auto-syncing missing devices:', missingDevices)

      // Re-enable devices sequentially
      const syncDevices = async () => {
        for (const deviceId of missingDevices) {
          const device = videoDevices.find(d => d.id === deviceId)
          if (device) {
            await toggleDevice(configId, selectedScene, deviceId, device.name, true)
          }
        }
        // After syncing, if there's an active device in settings, set it
        if (trackerSettings.active_device) {
          await setActiveDevice(configId, trackerSettings.active_device)
        }
      }
      syncDevices()
    } else if (trackerDevices.length > 0) {
      // All devices are synced, mark as done
      hasSyncedRef.current = true
    }
  }, [settingsLoaded, status.connected, selectedScene, videoDevices, trackerDevices, trackerSettings.enabled_devices, trackerSettings.active_device, configId, toggleDevice, setActiveDevice])

  // Tile geometry from the host (absolute physical pixels; follows moves, resizes and
  // window moves). Debounced like the old ResizeObserver path; a 2 s refresh catches the rest.
  const sendPosition = useCallback(() => {
    if (!isTracking) return
    const g = ctx.native.tileGeometry(instance.id)
    const { x, y, width, height } = g.physical
    if (width <= 0 || height <= 0) return
    const key = `${x},${y},${width},${height}`
    if (key === lastPositionKey.current) return
    lastPositionKey.current = key
    const m = monitorSize()
    setLivePosition({ x, y, w: width, h: height })
    updatePosition(configId, x, y, width, height, m.width, m.height)
  }, [isTracking, ctx, instance.id, updatePosition, configId])

  useEffect(() => {
    if (!isTracking) return
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(sendPosition, 150)
    }
    const off = ctx.native.onTileGeometry(instance.id, debounced)
    const intervalId = setInterval(sendPosition, 2000)
    sendPosition()
    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      off()
      clearInterval(intervalId)
    }
  }, [isTracking, sendPosition, ctx, instance.id])

  // Enabled devices for rotation
  const enabledDevices = trackerDevices
  const hasMultipleDevices = enabledDevices.length >= 2
  const currentDeviceIndex = activeDevice
    ? enabledDevices.findIndex(d => d.device_id === activeDevice)
    : -1

  const handleConnect = async () => {
    await updateConnectionSettings({
      host: localHost,
      port: parseInt(localPort) || 4455,
      ...(localPassword ? { password: localPassword } : {}),
    })
    await connect()
  }

  const handleSceneSelect = (sceneName: string) => {
    updateTrackerSettings({ selected_scene: sceneName })
  }

  const handleToggleDevice = async (deviceId: string, deviceName: string) => {
    if (!selectedScene) return

    const isEnabled = trackerSettings.enabled_devices.includes(deviceId)
    setIsToggling(deviceId)

    try {
      const result = await toggleDevice(configId, selectedScene, deviceId, deviceName, !isEnabled)

      // Update local settings
      if (!isEnabled && result) {
        const newEnabledDevices = [...trackerSettings.enabled_devices, deviceId]
        const shouldSetActive = !trackerSettings.active_device
        updateTrackerSettings({
          enabled_devices: newEnabledDevices,
          // Auto-set as active if first device
          active_device: trackerSettings.active_device ?? deviceId,
        })
        // Tell backend about the active device
        if (shouldSetActive) {
          await setActiveDevice(configId, deviceId)
        }
      } else if (isEnabled) {
        const newEnabledDevices = trackerSettings.enabled_devices.filter(id => id !== deviceId)
        const newActiveDevice = trackerSettings.active_device === deviceId
          ? (newEnabledDevices[0] ?? null)
          : trackerSettings.active_device
        updateTrackerSettings({
          enabled_devices: newEnabledDevices,
          active_device: newActiveDevice,
        })
        // Tell backend about the new active device
        if (trackerSettings.active_device === deviceId) {
          await setActiveDevice(configId, newActiveDevice)
        }
      }
    } finally {
      setIsToggling(null)
    }
  }

  const handleSetActiveDevice = async (deviceId: string) => {
    console.log('[OBS] handleSetActiveDevice:', deviceId)
    updateTrackerSettings({ active_device: deviceId })
    try {
      await setActiveDevice(configId, deviceId)
    } catch (err) {
      console.error('[OBS] setActiveDevice failed:', err)
      // Backend might not have this device - this can happen after reconnect
      // The user needs to re-enable the device
    }
  }

  const handleToggleEnabled = () => {
    updateTrackerSettings({ enabled: !trackerSettings.enabled })
  }

  const handleToggleAutoRotate = () => {
    const newAutoRotate = !trackerSettings.auto_rotate
    updateTrackerSettings({ auto_rotate: newAutoRotate })

    if (newAutoRotate && enabledDevices.length >= 2) {
      startRotationTimer(configId, enabledDevices, trackerSettings.rotate_interval_secs)
    } else {
      stopRotationTimer(configId)
    }
  }

  const handleIntervalChange = (val: string) => {
    setLocalInterval(val)
    const num = parseInt(val)
    if (num >= 3 && num <= 300) {
      updateTrackerSettings({ rotate_interval_secs: num })

      if (trackerSettings.auto_rotate && enabledDevices.length >= 2) {
        startRotationTimer(configId, enabledDevices, num)
      }
    }
  }

  const handleNextDevice = () => nextDevice(configId, enabledDevices, activeDevice)
  const handlePrevDevice = () => prevDevice(configId, enabledDevices, activeDevice)
  const handleTogglePause = () => toggleRotationPause(configId, enabledDevices, trackerSettings.rotate_interval_secs)

  // Get device name for active device
  const activeDeviceInfo = enabledDevices.find(d => d.device_id === activeDevice)

  return (
    <div ref={containerRef} data-tracker-id={configId} className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-auto">
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vibe-border bg-vibe-surface/50">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            status.connected ? 'bg-green-500' : 'bg-red-500'
          }`}
        />
        <span className="text-sm truncate">
          {status.connected
            ? `Connected to OBS${status.obs_version ? ` v${status.obs_version}` : ''}`
            : 'Disconnected'}
        </span>
        {status.connected && status.canvas_width > 0 && (
          <span className="text-xs text-vibe-muted ml-auto flex-shrink-0">
            {status.canvas_width}x{status.canvas_height}
          </span>
        )}
      </div>

      {/* Connection settings */}
      <div className="border-b border-vibe-border">
        <button
          onClick={() => setShowConnectionSettings(!showConnectionSettings)}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text transition-colors"
        >
          <svg
            className={`w-3 h-3 transition-transform ${showConnectionSettings ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          Connection Settings
        </button>

        {showConnectionSettings && (
          <div className="px-3 pb-3 space-y-2">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-vibe-muted mb-1">Host</label>
                <input
                  type="text"
                  value={localHost}
                  onChange={(e) => setLocalHost(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-vibe-primary"
                  placeholder="127.0.0.1"
                  disabled={status.connected}
                />
              </div>
              <div className="w-20">
                <label className="block text-xs text-vibe-muted mb-1">Port</label>
                <input
                  type="text"
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-vibe-primary"
                  placeholder="4455"
                  disabled={status.connected}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-vibe-muted mb-1">Password</label>
              <input
                type="password"
                value={localPassword}
                onChange={(e) => setLocalPassword(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-vibe-primary"
                placeholder="Leave empty if no password"
                disabled={status.connected}
              />
            </div>
            <button
              onClick={status.connected ? disconnect : handleConnect}
              disabled={isConnecting || isLoadingSettings}
              className={`w-full px-3 py-1.5 text-sm rounded transition-colors ${
                status.connected
                  ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/30'
                  : 'bg-vibe-primary/20 text-vibe-primary hover:bg-vibe-primary/30 border border-vibe-primary/30'
              } disabled:opacity-50`}
            >
              {isConnecting ? 'Connecting...' : status.connected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        )}
      </div>

      {/* Scene selector */}
      {status.connected && (
        <div className="px-3 py-3 border-b border-vibe-border space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm text-vibe-muted">Scene</label>
            <button
              onClick={loadScenes}
              disabled={isLoadingScenes}
              className="ml-auto p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Refresh scenes"
            >
              <svg
                className={`w-3.5 h-3.5 ${isLoadingScenes ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
          <select
            value={selectedScene ?? ''}
            onChange={(e) => handleSceneSelect(e.target.value)}
            className="w-full px-2 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-vibe-primary"
          >
            <option value="">Select a scene...</option>
            {scenes.map((scene) => (
              <option key={scene.name} value={scene.name}>
                {scene.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Devices list */}
      {status.connected && selectedScene && (
        <div className="px-3 py-3 border-b border-vibe-border space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm text-vibe-muted">Devices</label>
            <button
              onClick={loadVideoDevices}
              disabled={isLoadingDevices}
              className="ml-auto p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Refresh devices"
            >
              <svg
                className={`w-3.5 h-3.5 ${isLoadingDevices ? 'animate-spin' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          <div className="space-y-1 max-h-40 overflow-y-auto">
            {videoDevices.length === 0 ? (
              <p className="text-xs text-vibe-muted/60 italic">No video devices found</p>
            ) : (
              videoDevices.map((device) => {
                // Check against BACKEND state for actual enabled status
                const backendDevice = trackerDevices.find(d => d.device_id === device.id)
                const isEnabledInBackend = !!backendDevice
                // Also check frontend settings for checkbox display (they sync on toggle)
                const isEnabledInSettings = trackerSettings.enabled_devices.includes(device.id)
                const isActive = activeDevice === device.id
                const isLoading = isToggling === device.id

                return (
                  <div
                    key={device.id}
                    className={`flex items-center gap-2 text-sm px-2 py-1.5 rounded transition-colors ${
                      isEnabledInBackend ? 'bg-vibe-surface/50' : 'hover:bg-vibe-surface/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isEnabledInSettings}
                      onChange={() => handleToggleDevice(device.id, device.name)}
                      disabled={isLoading}
                      className="rounded border-vibe-border"
                    />
                    <span
                      className={`truncate flex-1 cursor-pointer ${
                        isActive ? 'text-vibe-primary font-medium' : isEnabledInBackend ? 'text-vibe-text' : 'text-vibe-muted'
                      }`}
                      onClick={() => {
                        console.log('[OBS] Click on device:', device.name, 'isEnabledInBackend:', isEnabledInBackend, 'isActive:', isActive, 'backendDevice:', backendDevice)
                        if (isEnabledInBackend && !isActive) {
                          handleSetActiveDevice(device.id)
                        }
                      }}
                    >
                      {device.name}
                    </span>
                    {isLoading && (
                      <svg className="w-3.5 h-3.5 animate-spin text-vibe-muted" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                      </svg>
                    )}
                    {!isLoading && isActive && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium">
                        ACTIVE
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </div>

          {/* Tracking toggle */}
          {enabledDevices.length > 0 && (
            <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={trackerSettings.enabled}
                onChange={handleToggleEnabled}
                className="rounded border-vibe-border"
              />
              <span className="text-vibe-muted">Enable position tracking</span>
            </label>
          )}
        </div>
      )}

      {/* Rotation Controls */}
      {status.connected && selectedScene && hasMultipleDevices && (
        <div className="px-3 py-3 border-b border-vibe-border space-y-2">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer flex-1">
              <input
                type="checkbox"
                checked={trackerSettings.auto_rotate}
                onChange={handleToggleAutoRotate}
                className="rounded border-vibe-border"
              />
              <span className="text-vibe-muted">Auto-rotate</span>
            </label>
            {trackerSettings.auto_rotate && (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={3}
                  max={300}
                  value={localInterval}
                  onChange={(e) => handleIntervalChange(e.target.value)}
                  className="w-14 px-1.5 py-0.5 text-xs bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-vibe-primary text-center"
                />
                <span className="text-xs text-vibe-muted">sec</span>
              </div>
            )}
          </div>

          {trackerSettings.auto_rotate && (
            <div className="w-full h-1 bg-vibe-border/50 rounded-full overflow-hidden">
              <div
                className="h-full bg-vibe-primary/70 transition-[width] duration-100 ease-linear"
                style={{ width: `${trackerTimerState.rotationProgress}%` }}
              />
            </div>
          )}

          <div className="flex items-center justify-center gap-2">
            <button
              onClick={handlePrevDevice}
              className="p-1.5 rounded hover:bg-vibe-surface transition-colors text-vibe-muted hover:text-vibe-text"
              title="Previous device"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {trackerSettings.auto_rotate && (
              <button
                onClick={handleTogglePause}
                className={`p-1.5 rounded transition-colors ${
                  trackerTimerState.rotationPaused
                    ? 'bg-vibe-primary/20 text-vibe-primary hover:bg-vibe-primary/30'
                    : 'hover:bg-vibe-surface text-vibe-muted hover:text-vibe-text'
                }`}
                title={trackerTimerState.rotationPaused ? 'Resume' : 'Pause'}
              >
                {trackerTimerState.rotationPaused ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                )}
              </button>
            )}

            <button
              onClick={handleNextDevice}
              className="p-1.5 rounded hover:bg-vibe-surface transition-colors text-vibe-muted hover:text-vibe-text"
              title="Next device"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {activeDeviceInfo && currentDeviceIndex >= 0 && (
            <p className="text-center text-xs text-vibe-muted">
              Active: <span className="text-vibe-text font-medium">
                {activeDeviceInfo.device_name}
              </span>
              {' '}
              <span className="text-vibe-muted/60">
                ({currentDeviceIndex + 1}/{enabledDevices.length})
              </span>
            </p>
          )}
        </div>
      )}

      {/* Tracking area */}
      <div className="flex-1 flex items-center justify-center p-4">
        {isTracking ? (
          <div className="text-center space-y-3">
            <svg className="w-16 h-16 mx-auto text-vibe-primary/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-vibe-muted">Tracking this pane</p>
            {activeDeviceInfo && (
              <p className="text-xs font-mono text-vibe-muted/70">
                {activeDeviceInfo.device_name}
                {hasMultipleDevices && (
                  <span className="text-vibe-muted/50">
                    {' '}({currentDeviceIndex + 1}/{enabledDevices.length})
                  </span>
                )}
              </p>
            )}
            {livePosition && (
              <p className="text-xs font-mono text-vibe-muted/50">
                {livePosition.x}, {livePosition.y} &mdash; {livePosition.w}x{livePosition.h}
              </p>
            )}
          </div>
        ) : status.connected && selectedScene && enabledDevices.length > 0 ? (
          <div className="text-center space-y-2">
            <svg className="w-12 h-12 mx-auto text-vibe-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-vibe-muted">Tracking paused</p>
            <p className="text-xs text-vibe-muted/70">Enable tracking above to start</p>
          </div>
        ) : status.connected && selectedScene ? (
          <div className="text-center space-y-2">
            <svg className="w-12 h-12 mx-auto text-vibe-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-vibe-muted">Enable devices above</p>
          </div>
        ) : status.connected ? (
          <div className="text-center space-y-2">
            <svg className="w-12 h-12 mx-auto text-vibe-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-vibe-muted">Select a scene above</p>
          </div>
        ) : (
          <div className="text-center space-y-2">
            <svg className="w-12 h-12 mx-auto text-vibe-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <p className="text-sm text-vibe-muted">Connect to OBS to begin</p>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 bg-red-900/30 border-t border-red-600/30 flex items-center gap-2">
          <span className="text-xs text-red-400 flex-1 truncate">{error}</span>
          <button
            onClick={clearError}
            className="text-red-400 hover:text-red-300 flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
