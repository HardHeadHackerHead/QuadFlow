import { useEffect, useMemo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTerminalStore } from './stores/terminalStore'
import { useSessionStore } from './stores/sessionStore'
import { useProjectStore } from './stores/projectStore'
import { initIssueTerminalAutoClose } from './lib/issueTerminals'
import { useToolStore } from './stores/toolStore'
import { useFloatingWindowStore } from './stores/floatingWindowStore'
import { getTerminalBuffer } from './lib/terminalRegistry'
import { terminalApi } from './lib/tauri-api'
import { removeTerminalFromTree } from './lib/layoutUtils'
import { confirmTerminalClose } from './lib/terminalUtils'
import { initMainWindowSync } from './lib/windowSync'
import { scheduleSave, cancelPendingSave, flushSave, initializeWorkspaces } from './lib/workspaceSave'
import { initAgentSessionListener, reconcileAgentSessionsOnRestore } from './lib/agentSessions'
import { initAgentModelListeners } from './lib/core/agents'
import { ensureProviders } from './agents/providers'
import Toolbar from './components/layout/Toolbar'
import FrameMosaic from './components/global-workspace/FrameMosaic'
import MinimizedBar from './components/layout/MinimizedBar'
import { useGlobalWorkspaceStore } from './stores/globalWorkspaceStore'
import FileBrowserSidebar from './components/layout/FileBrowserSidebar'
import ProjectSidebar from './components/layout/ProjectSidebar'
import CommandPalette from './components/commandPalette/CommandPalette'
import ConfirmModal from './components/common/ConfirmModal'
import { useSidebarStore } from './stores/sidebarStore'
import { useProjectSidebarStore } from './stores/projectSidebarStore'
import { useCommandPaletteStore } from './stores/commandPaletteStore'
import { useSessionSummaryPoller } from './hooks/useSessionSummaryPoller'
import { useUpdateStore } from './stores/updateStore'
import { isModKey } from './lib/platformKeys'
import './index.css'
import { isToolLeaf } from './lib/layoutIds'
import { installToolConfigSync } from './plugins/tools'
import { installDevReload } from './plugins/devReload'
import { installLiveReload } from './plugins/liveReload'
import { deactivateAllPlugins } from './plugins/loader'
import OnboardingWizard from './onboarding/OnboardingWizard'
import { maybeShowOnboarding } from './onboarding/onboardingStore'
import ImportV1Dialog from './onboarding/ImportV1Dialog'
import { maybeShowImportV1 } from './onboarding/importV1Store'
import { commands } from './generated/bindings'

export default function App() {
  const { terminals, layoutTree, minimizedTerminals } = useTerminalStore()
  const activeSessionId = useSessionStore((s) => s.activeSession?.id ?? null)
  const { toolInstances, minimizedTools } = useToolStore()
  const { initializeListeners: initFloatingListeners, cleanup: cleanupFloating } = useFloatingWindowStore()

  // Session titles from the providers' `sessionTitle` hooks update terminal titles
  useSessionSummaryPoller()

  // Background updater check on startup. Fires once a few seconds after
  // launch, and only actually hits GitHub if the last successful check is
  // more than 24h old (see updateStore.maybeAutoCheck). Errors are
  // swallowed silently — UI surfaces them only on explicit clicks.
  useEffect(() => {
    const t = window.setTimeout(() => {
      useUpdateStore.getState().loadVersion()
      useUpdateStore.getState().maybeAutoCheck()
    }, 5000)
    return () => window.clearTimeout(t)
  }, [])

  // Sync the native window title with the active project name.
  const activeProjectName = useProjectStore(s => s.activeProject?.name)
  const titleWorkingDir = useTerminalStore(s => s.globalWorkingDirectory)
  useEffect(() => {
    const projectName = activeProjectName || titleWorkingDir.split(/[/\\]/).pop()
    const title = projectName ? `QuadFlow - ${projectName}` : 'QuadFlow'
    getCurrentWindow().setTitle(title).catch(() => {})
  }, [activeProjectName, titleWorkingDir])

  // Initialize floating window listeners and state sync
  useEffect(() => {
    let unlisteners: (() => void)[] = []

    const initWindowSync = async () => {
      // Initialize floating window event listeners
      await initFloatingListeners()

      // Set up main window sync to respond to state requests from floating windows
      // IMPORTANT: Call getState() inside the callbacks to get current state,
      // not stale state captured at initialization time
      unlisteners = await initMainWindowSync(
        // Get terminal state - must call getState() each time to get current state
        // Also include the terminal buffer content so the floating window can restore it
        (id) => {
          const state = useTerminalStore.getState().terminals.get(id)
          if (state) {
            // Use the saved buffer content if available (captured when marked as floating),
            // otherwise try to get fresh buffer content
            const bufferContent = state.pendingBufferContent || getTerminalBuffer(id)
            return { ...state, pendingBufferContent: bufferContent }
          }
          return undefined
        },
        // Get tool state - must call getState() each time to get current state
        (id) => {
          const toolStore = useToolStore.getState()
          const instance = toolStore.toolInstances.get(id)
          const config = instance ? toolStore.toolConfigs.get(instance.configId) : undefined
          return instance && config ? { instance, config } : undefined
        },
        // Get project context - for filtering data in floating windows
        () => {
          const project = useProjectStore.getState().activeProject
          return project ? { id: project.id, workingDirectory: project.workingDirectory } : undefined
        }
      )
    }

    initWindowSync()

    return () => {
      unlisteners.forEach((fn) => fn())
      cleanupFloating()
    }
  }, [initFloatingListeners, cleanupFloating])

  // App start: tool configs → global dock → active project → its active
  // workspace, as one exclusive transition (lib/workspaceSave.ts).
  useEffect(() => {
    // Agent framework (core): provider specs, model lists, session discovery
    // events. The model catalog refreshes itself in the core at startup.
    ensureProviders().catch((err) => console.error('[App] agent providers failed to load:', err))
    initAgentModelListeners()
    initAgentSessionListener()
    const toolStore = useToolStore.getState()
    installToolConfigSync()
    installDevReload()
    installLiveReload()
    initializeWorkspaces({
      loadToolConfigs: () => toolStore.loadToolConfigs(),
      loadGlobalWorkspace: () => useGlobalWorkspaceStore.getState().loadFromDb(),
      // Seed the core's session claims; resume discovery for restored agent
      // terminals that came back without a session id.
      onRestored: (workingDir) => reconcileAgentSessionsOnRestore(workingDir),
    })
      .catch((err) => console.error('[App] workspace initialization failed:', err))
      // First run: the welcome flow opens over the restored (default) workspace.
      // A 1.x installation: offer to bring its projects over (after the welcome flow).
      .finally(() => void maybeShowOnboarding().finally(() => void maybeShowImportV1()))
    const unlistenProjects = useProjectStore.getState().initChangeListener()
    const unlistenIssueTerminals = initIssueTerminalAutoClose()
    return () => {
      unlistenProjects()
      unlistenIssueTerminals()
    }
  }, [])

  // Compute a stable signature of only the fields that get persisted in
  // saveWorkspaceState. This intentionally EXCLUDES transient state that
  // changes constantly but isn't saved (lastActivityAt, isIdle, needsAttention,
  // pendingBufferContent, etc.) so we don't auto-save on every PTY tick or
  // idle-checker pulse. Buffer content is captured at save time, not here.
  const saveSignature = useMemo(() => {
    const termSig = Array.from(terminals.values())
      .map(t =>
        [
          t.id,
          t.title ?? '',
          t.titleSource ?? '',
          t.originalPrompt ?? '',
          t.workingDirectory ?? '',
          t.gridPosition,
          t.status ?? '',
          t.agent ? JSON.stringify(t.agent) : '',
          t.role ?? '',
          t.customRoleLabel ?? '',
          t.isLocked ? 1 : 0,
        ].join('|')
      )
      .join(';')
    const toolSig = Array.from(toolInstances.values())
      .map(t =>
        [
          t.id,
          t.configId,
          t.title ?? '',
          t.status ?? '',
          t.terminalId ?? '',
          t.isLocked ? 1 : 0,
          t.isFlyoutInstance ? 1 : 0,
          t.metadata ? JSON.stringify(t.metadata) : '',
        ].join('|')
      )
      .join(';')
    const minTerms = [...minimizedTerminals].sort().join(',')
    const minTools = [...minimizedTools].sort().join(',')
    return `${termSig}::${toolSig}::${layoutTree ?? ''}::${minTerms}::${minTools}`
  }, [terminals, toolInstances, minimizedTerminals, minimizedTools, layoutTree])

  // Trigger auto-save only when a persisted field actually changes. The
  // controller ignores changes made while a switch/restore is running and
  // only saves a workspace whose state is fully loaded.
  useEffect(() => {
    if (activeSessionId) scheduleSave()
  }, [saveSignature, activeSessionId])

  // Save on window close — awaited before the window is destroyed (bounded so
  // a stuck save can never keep the app open).
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    getCurrentWindow()
      .onCloseRequested(async () => {
        await Promise.race([
          Promise.all([
            flushSave().catch((e) => console.error('[App] save on exit failed:', e)),
            // Plugins release native resources (e.g. embedded windows) while the
            // main window still exists; then their sidecars stop (before the window and
            // its children are destroyed — RunEvent::Exit is too late for that).
            deactivateAllPlugins().then(() => commands.pluginSidecarsStopAll()),
          ]),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ])
      })
      .then((fn) => { if (disposed) fn(); else unlisten = fn })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
      cancelPendingSave()
    }
  }, [])

  // Keyboard shortcuts (Ctrl+K command palette, Ctrl+W close pane)
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Ctrl+K - Toggle command palette
      if (isModKey(e) && e.key === 'k') {
        e.preventDefault()
        useCommandPaletteStore.getState().toggle()
        return
      }

      // Ctrl+Shift+P - Open command palette (VS Code style)
      if (isModKey(e) && e.shiftKey && e.key === 'P') {
        e.preventDefault()
        useCommandPaletteStore.getState().open('>')
        return
      }

      // Ctrl+Shift+B - Toggle project sidebar
      if (isModKey(e) && e.shiftKey && e.key === 'B') {
        e.preventDefault()
        useProjectSidebarStore.getState().toggle()
        return
      }

      // Ctrl+B - Toggle file browser sidebar
      if (isModKey(e) && e.key === 'b') {
        e.preventDefault()
        useSidebarStore.getState().toggle()
        return
      }

      // Skip other shortcuts when command palette is open
      if (useCommandPaletteStore.getState().isOpen) return

      // Ctrl+W - Close active terminal or tool (unless locked)
      if (isModKey(e) && e.key === 'w') {
        e.preventDefault() // Prevent browser from closing tab

        const terminalStore = useTerminalStore.getState()
        const toolStore = useToolStore.getState()
        const activeTerminalId = terminalStore.activeTerminalId

        if (activeTerminalId) {
          // Check if it's a tool
          if (isToolLeaf(activeTerminalId)) {
            // Don't close locked tools
            if (toolStore.isToolLocked(activeTerminalId)) return
            // Close the tool
            const newTree = removeTerminalFromTree(terminalStore.layoutTree, activeTerminalId)
            terminalStore.setLayoutTree(newTree)
            toolStore.closeTool(activeTerminalId)
          } else {
            // Don't close locked terminals
            if (terminalStore.isTerminalLocked(activeTerminalId)) return
            // Close the terminal
            const terminal = terminalStore.terminals.get(activeTerminalId)
            if (terminal && !await confirmTerminalClose(terminal)) return
            try {
              await terminalApi.kill(activeTerminalId)
            } catch {
              // Ignore errors killing terminal
            }
            terminalStore.removeTerminal(activeTerminalId)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const sidebarSide = useSidebarStore(s => s.side)

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <div className="flex-1 min-h-0 w-full flex flex-col bg-vibe-bg">
        <Toolbar />
        <main className="flex-1 min-h-0 overflow-hidden flex">
          {sidebarSide === 'left' ? <FileBrowserSidebar /> : <ProjectSidebar />}
          <div className="flex-1 min-h-0 overflow-hidden min-w-[200px] flex flex-col">
            {/* The mosaic gets the inner padding so it doesn't touch the
                sidebars. The bottom bar lives outside the padded region so it
                runs edge-to-edge. */}
            <div className="flex-1 min-h-0 p-2 pb-0">
              <FrameMosaic />
            </div>
            <MinimizedBar />
          </div>
          {sidebarSide === 'right' ? <FileBrowserSidebar /> : <ProjectSidebar />}
        </main>
        <CommandPalette />
        <ConfirmModal />
        <OnboardingWizard />
        <ImportV1Dialog />
      </div>
    </div>
  )
}
