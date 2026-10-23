import { useState } from 'react'
import { ToolInstance, ToolConfig } from '../../types'
import { useToolStore } from '../../stores/toolStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useFloatingWindowStore } from '../../stores/floatingWindowStore'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { removeTerminalPreservingLocked } from '../../lib/layoutUtils'
import { ToolIcon, contributionLabel } from '../../plugins/tools'

interface ToolTileToolbarProps {
  instance: ToolInstance
  config: ToolConfig | undefined
  onPaneDragStart?: (tileId: string, e: React.MouseEvent) => void
}

export default function ToolTileToolbar({ instance, config, onPaneDragStart }: ToolTileToolbarProps) {
  const { closeTool, minimizeTool, toggleToolLock, toolInstances, minimizedTools, restoreTool } = useToolStore()
  const { terminals, layoutTree, setLayoutTree, setActiveTerminal, minimizedTerminals } = useTerminalStore()
  const { popOutPanel, isFloating } = useFloatingWindowStore()
  const isPoppedOut = isFloating(instance.id)

  const handleFocus = () => {
    setActiveTerminal(instance.id)
  }

  // Compute locked IDs and minimized lists for lock-aware removal
  const getLockedAndMinimized = () => {
    const lockedIds = new Set<string>()
    terminals.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
    toolInstances.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
    const allMinimized = [...minimizedTerminals, ...minimizedTools]
    return { lockedIds, allMinimized }
  }

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Global tools live in globalWorkspaceStore — closeTool/removeTerminalPreservingLocked
    // would be no-ops, leaving a dangling leaf in the workspace's sub-tree.
    if (instance.scope === 'global') {
      void useGlobalWorkspaceStore.getState().closeWorkspaceInstance(instance.id)
      return
    }
    const { lockedIds, allMinimized } = getLockedAndMinimized()
    // Lock-aware removal from layout tree
    const { tree: newTree, restoredId } = removeTerminalPreservingLocked(
      layoutTree, instance.id, lockedIds, allMinimized
    )
    setLayoutTree(newTree)
    // If a minimized pane was auto-restored, remove it from its minimized list
    if (restoredId) {
      if (minimizedTerminals.includes(restoredId)) {
        useTerminalStore.getState().removeFromMinimizedList(restoredId)
      } else if (minimizedTools.includes(restoredId)) {
        restoreTool(restoredId)
      }
    }
    // Close the tool instance
    closeTool(instance.id)
  }

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation()
    const { lockedIds, allMinimized } = getLockedAndMinimized()
    // Lock-aware removal from layout tree
    const { tree: newTree, restoredId } = removeTerminalPreservingLocked(
      layoutTree, instance.id, lockedIds, allMinimized
    )
    setLayoutTree(newTree)
    // If a minimized pane was auto-restored, remove it from its minimized list
    if (restoredId) {
      if (minimizedTerminals.includes(restoredId)) {
        useTerminalStore.getState().removeFromMinimizedList(restoredId)
      } else if (minimizedTools.includes(restoredId)) {
        restoreTool(restoredId)
      }
    }
    // Mark as minimized
    minimizeTool(instance.id)
  }

  const handleToggleLock = (e: React.MouseEvent) => {
    e.stopPropagation()
    const wasLocked = instance.isLocked
    toggleToolLock(instance.id)
    // If unlocking, remove empty space from the layout
    if (wasLocked) {
      useTerminalStore.getState().removeAllEmptySpace()
    }
  }

  const handlePopOut = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const title = instance.title || config?.name || 'Tool'
    await popOutPanel(instance.id, 'tool', title)
  }

  const isGlobal = instance.scope === 'global'
  const [showPinMenu, setShowPinMenu] = useState(false)
  const workspacesList = useGlobalWorkspaceStore(s => s.workspaces)

  // Strip from project tree, then pin into the chosen workspace.
  const pinIntoWorkspace = async (workspaceId: string) => {
    const { lockedIds, allMinimized } = getLockedAndMinimized()
    const { tree: newTree, restoredId } = removeTerminalPreservingLocked(
      layoutTree, instance.id, lockedIds, allMinimized
    )
    setLayoutTree(newTree)
    if (restoredId) {
      if (minimizedTerminals.includes(restoredId)) {
        useTerminalStore.getState().removeFromMinimizedList(restoredId)
      } else if (minimizedTools.includes(restoredId)) {
        restoreTool(restoredId)
      }
    }
    await useGlobalWorkspaceStore.getState().pinInstanceToWorkspace(instance.id, workspaceId)
  }

  const handleClickPin = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const gs = useGlobalWorkspaceStore.getState()
    if (isGlobal) {
      await gs.unpinInstance(instance.id)
      return
    }
    const enabled = Array.from(workspacesList.values()).filter(w => w.enabled)
    if (enabled.length === 1) {
      await pinIntoWorkspace(enabled[0].id)
      return
    }
    setShowPinMenu(true)
  }

  const handlePickWorkspace = async (workspaceId: string) => {
    setShowPinMenu(false)
    await pinIntoWorkspace(workspaceId)
  }

  const handleCreateAndPin = async () => {
    const name = prompt('New workspace name:', `Workspace ${workspacesList.size + 1}`)?.trim()
    if (!name) { setShowPinMenu(false); return }
    const newId = await useGlobalWorkspaceStore.getState().createWorkspace(name)
    setShowPinMenu(false)
    await pinIntoWorkspace(newId)
  }

  // Return a native element - react-mosaic will wrap with connectDragSource
  return (
    <div
      className={`flex items-center justify-between gap-2 px-2 py-1.5 bg-vibe-surface border-b select-none ${
        instance.isLocked ? 'cursor-not-allowed border-amber-500/50' : 'cursor-grab active:cursor-grabbing border-vibe-border'
      }`}
      onClick={handleFocus}
      onMouseDown={(e) => {
        if (instance.isLocked) return
        if ((e.target as HTMLElement).closest('button')) return
        onPaneDragStart?.(instance.id, e)
      }}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Drag handle indicator */}
        <div className="flex flex-col gap-0.5 opacity-40 hover:opacity-70 transition-opacity">
          <div className="flex gap-0.5">
            <div className="w-1 h-1 rounded-full bg-vibe-muted" />
            <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          </div>
          <div className="flex gap-0.5">
            <div className="w-1 h-1 rounded-full bg-vibe-muted" />
            <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          </div>
        </div>

        {/* Status indicator */}
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            instance.status === 'active'
              ? 'bg-teal-500'
              : instance.status === 'error'
              ? 'bg-red-500'
              : 'bg-gray-500'
          }`}
        />

        {/* Tool icon and type badge */}
        {config && (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-white flex items-center gap-1 flex-shrink-0">
            <ToolIcon config={config} className="w-3.5 h-3.5" />
            {contributionLabel(config).toUpperCase()}
          </span>
        )}

        {/* Title (truncated) */}
        <span
          className="text-xs text-vibe-muted truncate flex-1"
          title={instance.title}
        >
          {instance.title}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Pop out button */}
        <button
          onClick={handlePopOut}
          disabled={isPoppedOut}
          className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title={isPoppedOut ? 'Already in floating window' : 'Pop out to floating window'}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>

        {/* Pin to / unpin from a global workspace */}
        <div className="relative">
          <button
            onClick={handleClickPin}
            className={`p-1 rounded transition-colors ${
              isGlobal
                ? 'text-cyan-300 bg-cyan-500/25 hover:bg-cyan-500/40 ring-1 ring-cyan-400/50'
                : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
            }`}
            title={isGlobal
              ? 'Move to project workspace (unpin from global)'
              : 'Pin to a global workspace (persist across project switches)'}
          >
            {isGlobal ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            )}
          </button>
          {showPinMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowPinMenu(false)} />
              <div
                className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-vibe-surface border border-vibe-border rounded shadow-lg py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-3 py-1 text-xs text-vibe-muted uppercase tracking-wide">
                  Pin to workspace
                </div>
                {Array.from(workspacesList.values()).filter(w => w.enabled).map(ws => (
                  <button
                    key={ws.id}
                    onClick={() => handlePickWorkspace(ws.id)}
                    className="w-full text-left px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/50"
                  >
                    {ws.name}
                  </button>
                ))}
                <div className="border-t border-vibe-border my-1" />
                <button
                  onClick={handleCreateAndPin}
                  className="w-full text-left px-3 py-1.5 text-sm text-teal-400 hover:bg-vibe-border/50"
                >
                  + New workspace…
                </button>
              </div>
            </>
          )}
        </div>

        {/* Lock button */}
        <button
          onClick={handleToggleLock}
          className={`p-1 rounded transition-colors ${
            instance.isLocked
              ? 'text-amber-400 bg-amber-400/20 hover:bg-amber-400/30'
              : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
          }`}
          title={instance.isLocked ? 'Unlock pane (allow moving/resizing)' : 'Lock pane (prevent moving/resizing)'}
        >
          {instance.isLocked ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          )}
        </button>

        {/* Minimize button — hidden for global panes. The minimized strip is
            session-scoped (per project), so a global tool there would make no
            sense; the workspace itself has its own minimize button. */}
        {!isGlobal && (
          <button
            onClick={handleMinimize}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="Minimize tool"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
        )}

        {/* Close button */}
        <button
          onClick={handleClose}
          className="p-1 text-vibe-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
          title="Close tool"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
