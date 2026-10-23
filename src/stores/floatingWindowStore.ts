import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen, emit, UnlistenFn } from '@tauri-apps/api/event'
import { useTerminalStore } from './terminalStore'
import { useToolStore } from './toolStore'
import { getTerminalBuffer } from '../lib/terminalRegistry'

export interface FloatingWindow {
  id: string           // Panel ID
  windowLabel: string  // Tauri window label
  panelType: 'terminal' | 'tool'
  title: string
  x: number
  y: number
  width: number
  height: number
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface FloatingWindowStore {
  floatingWindows: Map<string, FloatingWindow>
  unlistenFunctions: Map<string, UnlistenFn>

  // Actions
  popOutPanel: (panelId: string, panelType: 'terminal' | 'tool', title: string) => Promise<void>
  popInPanel: (panelId: string) => Promise<void>
  isFloating: (panelId: string) => boolean
  getFloatingWindow: (panelId: string) => FloatingWindow | undefined
  closeFloatingWindow: (panelId: string) => Promise<void>
  focusFloatingWindow: (panelId: string) => Promise<void>
  updateWindowBounds: (panelId: string, bounds: Partial<WindowBounds>) => void
  initializeListeners: () => Promise<void>
  cleanup: () => void
}

export const useFloatingWindowStore = create<FloatingWindowStore>((set, get) => ({
  floatingWindows: new Map(),
  unlistenFunctions: new Map(),

  popOutPanel: async (panelId: string, panelType: 'terminal' | 'tool', title: string) => {
    console.log('[FloatingWindowStore] popOutPanel called:', { panelId, panelType, title })

    // Check if already floating
    if (get().floatingWindows.has(panelId)) {
      console.log('[FloatingWindowStore] Panel already floating, focusing existing window')
      // Focus the existing window instead
      await get().focusFloatingWindow(panelId)
      return
    }

    try {
      console.log('[FloatingWindowStore] Creating floating window via Tauri...')
      // Create the floating window via Tauri
      const windowLabel = await invoke<string>('create_floating_window', {
        panelId,
        panelType,
        title,
        x: null,
        y: null,
        width: 800,
        height: 600,
      })
      console.log('[FloatingWindowStore] Floating window created, label:', windowLabel)

      // Mark panel as floating - keep it in the layout tree so we can show a placeholder
      // The actual content will be replaced with FloatingPlaceholder in the layout renderer
      console.log('[FloatingWindowStore] Marking panel as floating...')
      if (panelType === 'terminal') {
        const terminalStore = useTerminalStore.getState()
        // IMPORTANT: Capture the terminal buffer BEFORE marking as floating
        // When we mark as floating, TerminalView will unmount and clear the buffer
        // We need to save it in pendingBufferContent so the floating window can restore it
        const bufferContent = getTerminalBuffer(panelId)
        console.log('[FloatingWindowStore] Captured terminal buffer, length:', bufferContent?.length || 0)
        // Mark terminal as floating and save the buffer
        terminalStore.updateTerminal(panelId, {
          isFloating: true,
          pendingBufferContent: bufferContent,
        })
        console.log('[FloatingWindowStore] Terminal marked as floating')
      } else {
        const toolStore = useToolStore.getState()
        // Mark tool as floating (don't remove from layout tree)
        toolStore.updateTool(panelId, { isFloating: true })
        console.log('[FloatingWindowStore] Tool marked as floating')
      }

      // Store floating window info
      const floatingWindow: FloatingWindow = {
        id: panelId,
        windowLabel,
        panelType,
        title,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      }

      set((state) => {
        const floatingWindows = new Map(state.floatingWindows)
        floatingWindows.set(panelId, floatingWindow)
        return { floatingWindows }
      })

      // Emit event for cross-window sync
      await emit('window-sync:panel-popped-out', {
        panelId,
        panelType,
        windowLabel,
      })

      console.log(`[FloatingWindow] Popped out ${panelType}: ${panelId}`)
    } catch (error) {
      console.error('[FloatingWindow] Failed to pop out panel:', error)
      throw error
    }
  },

  popInPanel: async (panelId: string) => {
    const floatingWindow = get().floatingWindows.get(panelId)
    if (!floatingWindow) {
      console.warn(`[FloatingWindow] Panel not floating: ${panelId}`)
      return
    }

    try {
      // Close the floating window
      await invoke('close_floating_window', { windowLabel: floatingWindow.windowLabel })

      // Clear the floating flag - panel is still in layout tree, just show actual content again
      if (floatingWindow.panelType === 'terminal') {
        const terminalStore = useTerminalStore.getState()
        terminalStore.updateTerminal(panelId, { isFloating: false })
      } else {
        const toolStore = useToolStore.getState()
        toolStore.updateTool(panelId, { isFloating: false })
      }

      // Remove from floating windows map
      set((state) => {
        const floatingWindows = new Map(state.floatingWindows)
        floatingWindows.delete(panelId)
        return { floatingWindows }
      })

      // Emit event for cross-window sync
      await emit('window-sync:panel-popped-in', {
        panelId,
        panelType: floatingWindow.panelType,
      })

      console.log(`[FloatingWindow] Popped in ${floatingWindow.panelType}: ${panelId}`)
    } catch (error) {
      console.error('[FloatingWindow] Failed to pop in panel:', error)
      throw error
    }
  },

  isFloating: (panelId: string) => {
    return get().floatingWindows.has(panelId)
  },

  getFloatingWindow: (panelId: string) => {
    return get().floatingWindows.get(panelId)
  },

  closeFloatingWindow: async (panelId: string) => {
    // Same as popInPanel - close window and restore to main
    await get().popInPanel(panelId)
  },

  focusFloatingWindow: async (panelId: string) => {
    const floatingWindow = get().floatingWindows.get(panelId)
    if (floatingWindow) {
      await invoke('focus_floating_window', { windowLabel: floatingWindow.windowLabel })
    }
  },

  updateWindowBounds: (panelId: string, bounds: Partial<WindowBounds>) => {
    set((state) => {
      const floatingWindows = new Map(state.floatingWindows)
      const window = floatingWindows.get(panelId)
      if (window) {
        floatingWindows.set(panelId, {
          ...window,
          ...bounds,
        })
      }
      return { floatingWindows }
    })
  },

  initializeListeners: async () => {

    // Listen for pop-in requests from floating windows
    const unlistenPopIn = await listen<{ panelId: string }>('window-sync:pop-in-request', async (event) => {
      console.log('[FloatingWindow] Received pop-in request:', event.payload)
      await get().popInPanel(event.payload.panelId)
    })

    // Listen for window closed events (user closed via OS controls)
    const unlistenClosed = await listen<{ windowLabel: string }>('tauri://close-requested', async (event) => {
      // Find the panel by window label and pop it back in
      const floatingWindows = get().floatingWindows
      for (const [panelId, window] of floatingWindows) {
        if (window.windowLabel === event.payload?.windowLabel) {
          await get().popInPanel(panelId)
          break
        }
      }
    })

    set((s) => {
      const unlistenFunctions = new Map(s.unlistenFunctions)
      unlistenFunctions.set('pop-in', unlistenPopIn)
      unlistenFunctions.set('closed', unlistenClosed)
      return { unlistenFunctions }
    })
  },

  cleanup: () => {
    const { unlistenFunctions } = get()
    unlistenFunctions.forEach((unlisten) => unlisten())
    set({ unlistenFunctions: new Map() })
  },
}))
