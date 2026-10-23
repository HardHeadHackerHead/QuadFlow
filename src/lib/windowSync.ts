/**
 * Cross-window state synchronization using Tauri events
 *
 * Event types:
 * - window-sync:state-update - Main window broadcasts state changes
 * - window-sync:pop-in-request - Floating window requests to pop back in
 * - window-sync:state-request - Floating window requests initial state
 * - window-sync:state-response - Main window responds with current state
 * - window-sync:panel-popped-out - Notification that a panel was popped out
 * - window-sync:panel-popped-in - Notification that a panel was popped in
 */

import { emit, listen, UnlistenFn } from '@tauri-apps/api/event'
import { TerminalState } from '../types'

// Types for sync events
export interface SyncStateUpdate {
  type: 'terminal' | 'tool'
  panelId: string
  state: Partial<TerminalState> | unknown
}

export interface PopInRequest {
  panelId: string
  panelType: 'terminal' | 'tool'
}

export interface StateRequest {
  panelId: string
  panelType: 'terminal' | 'tool'
  requestId: string
}

export interface StateResponse {
  requestId: string
  panelId: string
  panelType: 'terminal' | 'tool'
  state: unknown
  config?: unknown // For tools, include the config
  projectContext?: { // Active project for filtering data
    id: string
    workingDirectory: string
  }
}

export interface PanelPoppedEvent {
  panelId: string
  panelType: 'terminal' | 'tool'
  windowLabel?: string
}

// Emit helpers
export const windowSync = {
  /**
   * Broadcast a state update to all windows
   */
  broadcastStateUpdate: async (update: SyncStateUpdate) => {
    await emit('window-sync:state-update', update)
  },

  /**
   * Request to pop a panel back into the main window
   */
  requestPopIn: async (panelId: string, panelType: 'terminal' | 'tool') => {
    await emit('window-sync:pop-in-request', { panelId, panelType })
  },

  /**
   * Request the current state of a panel from the main window
   */
  requestState: async (panelId: string, panelType: 'terminal' | 'tool'): Promise<StateResponse> => {
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(7)}`
    console.log('[WindowSync] requestState called - panelId:', panelId, 'panelType:', panelType, 'requestId:', requestId)

    return new Promise((resolve, reject) => {
      let unlisten: UnlistenFn | null = null
      const timeout = setTimeout(() => {
        console.error('[WindowSync] State request TIMED OUT after 5 seconds!')
        if (unlisten) unlisten()
        reject(new Error('State request timed out'))
      }, 5000)

      listen<StateResponse>('window-sync:state-response', (event) => {
        console.log('[WindowSync] Received state-response event:', event.payload)
        if (event.payload.requestId === requestId) {
          console.log('[WindowSync] Response matches our requestId, resolving...')
          clearTimeout(timeout)
          if (unlisten) unlisten()
          resolve(event.payload)
        } else {
          console.log('[WindowSync] Response requestId mismatch - expected:', requestId, 'got:', event.payload.requestId)
        }
      }).then((fn) => {
        unlisten = fn
        console.log('[WindowSync] Listener set up, emitting state-request...')
        // Send the request after listener is set up
        emit('window-sync:state-request', { panelId, panelType, requestId })
        console.log('[WindowSync] state-request emitted')
      })
    })
  },

  /**
   * Respond to a state request (called by main window)
   */
  respondToStateRequest: async (response: StateResponse) => {
    await emit('window-sync:state-response', response)
  },

  /**
   * Notify that a panel was popped out
   */
  notifyPanelPoppedOut: async (event: PanelPoppedEvent) => {
    await emit('window-sync:panel-popped-out', event)
  },

  /**
   * Notify that a panel was popped back in
   */
  notifyPanelPoppedIn: async (event: PanelPoppedEvent) => {
    await emit('window-sync:panel-popped-in', event)
  },
}

// Listener helpers
export const windowSyncListeners = {
  /**
   * Listen for state updates
   */
  onStateUpdate: (callback: (update: SyncStateUpdate) => void): Promise<UnlistenFn> => {
    return listen<SyncStateUpdate>('window-sync:state-update', (event) => {
      callback(event.payload)
    })
  },

  /**
   * Listen for pop-in requests
   */
  onPopInRequest: (callback: (request: PopInRequest) => void): Promise<UnlistenFn> => {
    return listen<PopInRequest>('window-sync:pop-in-request', (event) => {
      callback(event.payload)
    })
  },

  /**
   * Listen for state requests (main window should handle this)
   */
  onStateRequest: (callback: (request: StateRequest) => void): Promise<UnlistenFn> => {
    return listen<StateRequest>('window-sync:state-request', (event) => {
      callback(event.payload)
    })
  },

  /**
   * Listen for panel popped out events
   */
  onPanelPoppedOut: (callback: (event: PanelPoppedEvent) => void): Promise<UnlistenFn> => {
    return listen<PanelPoppedEvent>('window-sync:panel-popped-out', (event) => {
      callback(event.payload)
    })
  },

  /**
   * Listen for panel popped in events
   */
  onPanelPoppedIn: (callback: (event: PanelPoppedEvent) => void): Promise<UnlistenFn> => {
    return listen<PanelPoppedEvent>('window-sync:panel-popped-in', (event) => {
      callback(event.payload)
    })
  },
}

/**
 * Initialize window sync listeners for the main window
 * This should be called once when the main app mounts
 */
export async function initMainWindowSync(
  getTerminalState: (id: string) => TerminalState | undefined,
  getToolState: (id: string) => { instance: unknown; config: unknown } | undefined,
  getProjectContext?: () => { id: string; workingDirectory: string } | undefined
): Promise<UnlistenFn[]> {
  console.log('[WindowSync] initMainWindowSync called - setting up listeners')
  const unlisteners: UnlistenFn[] = []

  // Handle state requests from floating windows
  const unlistenStateRequest = await windowSyncListeners.onStateRequest(async (request) => {
    console.log('[WindowSync] MAIN WINDOW received state request:', request)

    if (request.panelType === 'terminal') {
      const state = getTerminalState(request.panelId)
      console.log('[WindowSync] Got terminal state:', state)
      console.log('[WindowSync] Sending terminal state response...')
      await windowSync.respondToStateRequest({
        requestId: request.requestId,
        panelId: request.panelId,
        panelType: 'terminal',
        state: state || null,
      })
      console.log('[WindowSync] Terminal state response sent')
    } else {
      console.log('[WindowSync] Getting tool state for:', request.panelId)
      const toolData = getToolState(request.panelId)
      const projectContext = getProjectContext?.()
      console.log('[WindowSync] Got tool data:', toolData)
      console.log('[WindowSync] Got project context:', projectContext)
      console.log('[WindowSync] Sending tool state response...')
      await windowSync.respondToStateRequest({
        requestId: request.requestId,
        panelId: request.panelId,
        panelType: 'tool',
        state: toolData?.instance || null,
        config: toolData?.config || null,
        projectContext: projectContext,
      })
      console.log('[WindowSync] Tool state response sent')
    }
  })
  unlisteners.push(unlistenStateRequest)

  console.log('[WindowSync] initMainWindowSync complete - listeners set up')
  return unlisteners
}

/**
 * Helper to determine if current window is a floating window
 */
export function isFloatingWindow(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.get('floating') === 'true'
}

/**
 * Get floating window params from URL
 */
export function getFloatingWindowParams(): { panelId: string; panelType: 'terminal' | 'tool' } | null {
  const params = new URLSearchParams(window.location.search)
  const isFloating = params.get('floating') === 'true'
  const panelId = params.get('panelId')
  const panelType = params.get('panelType') as 'terminal' | 'tool' | null

  if (!isFloating || !panelId || !panelType) {
    return null
  }

  return { panelId, panelType }
}
