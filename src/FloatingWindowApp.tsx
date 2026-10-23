/**
 * FloatingWindowApp - Root component for floating windows
 *
 * This component is rendered in pop-out windows when URL has
 * ?floating=true&panelId=X&panelType=Y
 *
 * It renders a single terminal or tool with minimal chrome
 * and a toolbar with a "Pop In" button to return to main window.
 */

import { useEffect, useState, useCallback } from 'react'
import { getFloatingWindowParams, windowSync, windowSyncListeners } from './lib/windowSync'
import { TerminalState, ToolInstance, ToolConfig } from './types'
import TerminalView from './components/terminal/TerminalView'
import ToolTileContent from './components/tools/ToolTileContent'
import FloatingWindowToolbar from './components/layout/FloatingWindowToolbar'

// Minimal store providers for floating window
import { useTerminalStore } from './stores/terminalStore'
import { useProjectStore } from './stores/projectStore'

// Import CSS for floating window - required for styling
import './index.css'

interface FloatingWindowState {
  loading: boolean
  error: string | null
  panelId: string
  panelType: 'terminal' | 'tool'
  terminalState: TerminalState | null
  toolInstance: ToolInstance | null
  toolConfig: ToolConfig | null
}

export default function FloatingWindowApp() {
  console.log('[FloatingWindowApp] Component rendering')

  const [state, setState] = useState<FloatingWindowState>({
    loading: true,
    error: null,
    panelId: '',
    panelType: 'terminal',
    terminalState: null,
    toolInstance: null,
    toolConfig: null,
  })

  console.log('[FloatingWindowApp] Current state:', {
    loading: state.loading,
    error: state.error,
    panelId: state.panelId,
    panelType: state.panelType,
    hasTerminalState: !!state.terminalState,
    hasToolInstance: !!state.toolInstance,
    hasToolConfig: !!state.toolConfig,
  })

  // Initialize terminal store actions
  const { updateTerminal, addTerminal } = useTerminalStore()

  const handlePopIn = useCallback(async () => {
    try {
      await windowSync.requestPopIn(state.panelId, state.panelType)
      // Window will be closed by main app
    } catch (error) {
      console.error('[FloatingWindow] Failed to pop in:', error)
    }
  }, [state.panelId, state.panelType])

  // Initialize on mount
  useEffect(() => {
    console.log('[FloatingWindowApp] useEffect running - initializing')
    console.log('[FloatingWindowApp] URL:', window.location.href)
    console.log('[FloatingWindowApp] Search params:', window.location.search)

    const params = getFloatingWindowParams()
    console.log('[FloatingWindowApp] Parsed params:', params)

    if (!params) {
      console.error('[FloatingWindowApp] Invalid URL parameters!')
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Invalid floating window URL parameters',
      }))
      return
    }

    const { panelId, panelType } = params
    console.log('[FloatingWindowApp] Panel ID:', panelId, 'Type:', panelType)

    setState((s) => ({
      ...s,
      panelId,
      panelType,
    }))

    // Request initial state from main window
    const fetchInitialState = async () => {
      console.log('[FloatingWindowApp] fetchInitialState starting...')
      try {
        // Small delay to ensure main window has finished processing the pop-out
        // This helps avoid race conditions where we request state before
        // the main window has updated its stores
        console.log('[FloatingWindowApp] Waiting 100ms for main window to settle...')
        await new Promise(resolve => setTimeout(resolve, 100))

        console.log('[FloatingWindowApp] Requesting state for:', panelId, panelType)
        const response = await windowSync.requestState(panelId, panelType)
        console.log('[FloatingWindowApp] Received state response:', response)
        console.log('[FloatingWindowApp] response.state:', response.state)
        console.log('[FloatingWindowApp] response.config:', response.config)

        if (panelType === 'terminal' && response.state) {
          const terminalState = response.state as TerminalState
          // Add to local terminal store so TerminalView can find it
          addTerminal({
            id: terminalState.id,
            cwd: terminalState.workingDirectory,
            pid: terminalState.pid,
          })
          // Update with full state
          updateTerminal(terminalState.id, terminalState)

          setState((s) => ({
            ...s,
            loading: false,
            terminalState,
          }))
        } else if (panelType === 'tool' && response.state) {
          console.log('[FloatingWindowApp] Setting tool state')
          console.log('[FloatingWindowApp] Tool instance:', response.state)
          console.log('[FloatingWindowApp] Tool config:', response.config)
          console.log('[FloatingWindowApp] Project context:', response.projectContext)

          // Set project context in the store so tools can filter by project
          if (response.projectContext) {
            useProjectStore.setState({
              activeProject: {
                id: response.projectContext.id,
                name: '', // Not needed for filtering
                workingDirectory: response.projectContext.workingDirectory,
                isActive: true,
                createdAt: 0,
                updatedAt: 0,
              }
            })
          }

          setState((s) => ({
            ...s,
            loading: false,
            toolInstance: response.state as ToolInstance,
            toolConfig: response.config as ToolConfig,
          }))
        } else {
          console.error('[FloatingWindowApp] Panel state not found!')
          console.error('[FloatingWindowApp] panelType:', panelType)
          console.error('[FloatingWindowApp] response.state:', response.state)
          setState((s) => ({
            ...s,
            loading: false,
            error: 'Panel state not found',
          }))
        }
      } catch (error) {
        console.error('[FloatingWindow] Failed to get initial state:', error)
        setState((s) => ({
          ...s,
          loading: false,
          error: `Failed to load panel state: ${error}`,
        }))
      }
    }

    fetchInitialState()

    // Listen for state updates from main window
    let unlistenStateUpdate: (() => void) | null = null
    windowSyncListeners.onStateUpdate((update) => {
      if (update.panelId === panelId) {
        if (update.type === 'terminal') {
          setState((s) => ({
            ...s,
            terminalState: {
              ...s.terminalState,
              ...(update.state as Partial<TerminalState>),
            } as TerminalState,
          }))
          // Update local store too
          updateTerminal(panelId, update.state as Partial<TerminalState>)
        } else {
          setState((s) => ({
            ...s,
            toolInstance: {
              ...s.toolInstance,
              ...(update.state as Partial<ToolInstance>),
            } as ToolInstance,
          }))
        }
      }
    }).then((unlisten) => {
      unlistenStateUpdate = unlisten
    })

    // Listen for panel popped in event (window should close)
    let unlistenPoppedIn: (() => void) | null = null
    windowSyncListeners.onPanelPoppedIn((event) => {
      if (event.panelId === panelId) {
        // Close this window - main app handled the pop-in
        window.close()
      }
    }).then((unlisten) => {
      unlistenPoppedIn = unlisten
    })

    // Handle window close via OS controls
    const handleBeforeUnload = () => {
      // Request pop-in when window is closed
      windowSync.requestPopIn(panelId, panelType)
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      if (unlistenStateUpdate) unlistenStateUpdate()
      if (unlistenPoppedIn) unlistenPoppedIn()
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [addTerminal, updateTerminal])

  // Loading state
  if (state.loading) {
    console.log('[FloatingWindowApp] RENDER: Loading state')
    return (
      <div className="h-screen w-screen bg-vibe-bg flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-vibe-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-vibe-muted">Loading panel...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (state.error) {
    console.log('[FloatingWindowApp] RENDER: Error state -', state.error)
    return (
      <div className="h-screen w-screen bg-vibe-bg flex items-center justify-center">
        <div className="text-center max-w-md p-4">
          <svg
            className="w-12 h-12 mx-auto mb-4 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-red-400 mb-4">{state.error}</p>
          <button
            onClick={handlePopIn}
            className="px-4 py-2 bg-vibe-primary text-white rounded hover:bg-vibe-primary/80 transition-colors"
          >
            Return to Main Window
          </button>
        </div>
      </div>
    )
  }

  // Render terminal
  if (state.panelType === 'terminal' && state.terminalState) {
    console.log('[FloatingWindowApp] RENDER: Terminal -', state.terminalState.id)
    return (
      <div className="h-screen w-screen bg-vibe-bg flex flex-col overflow-hidden">
        <FloatingWindowToolbar
          title={state.terminalState.title || 'Terminal'}
          panelType="terminal"
          onPopIn={handlePopIn}
        />
        <div className="flex-1 min-h-0 bg-[rgb(var(--qf-term-bg))]">
          <TerminalView terminalId={state.terminalState.id} />
        </div>
      </div>
    )
  }

  // Render tool
  if (state.panelType === 'tool' && state.toolInstance && state.toolConfig) {
    console.log('[FloatingWindowApp] RENDER: Tool -', state.toolInstance.id, 'config:', state.toolConfig.name)
    return (
      <div className="h-screen w-screen bg-vibe-bg flex flex-col overflow-hidden">
        <FloatingWindowToolbar
          title={state.toolInstance.title || state.toolConfig.name}
          panelType="tool"
          onPopIn={handlePopIn}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          <ToolTileContent instance={state.toolInstance} config={state.toolConfig} />
        </div>
      </div>
    )
  }

  // Fallback
  console.log('[FloatingWindowApp] RENDER: Fallback - no matching conditions')
  console.log('[FloatingWindowApp] panelType:', state.panelType)
  console.log('[FloatingWindowApp] hasTerminalState:', !!state.terminalState)
  console.log('[FloatingWindowApp] hasToolInstance:', !!state.toolInstance)
  console.log('[FloatingWindowApp] hasToolConfig:', !!state.toolConfig)
  return (
    <div className="h-screen w-screen bg-vibe-bg flex items-center justify-center">
      <div className="text-center">
        <p className="text-vibe-muted">No panel to display</p>
        <button
          onClick={handlePopIn}
          className="mt-4 px-4 py-2 bg-vibe-primary text-white rounded hover:bg-vibe-primary/80 transition-colors"
        >
          Return to Main Window
        </button>
      </div>
    </div>
  )
}
