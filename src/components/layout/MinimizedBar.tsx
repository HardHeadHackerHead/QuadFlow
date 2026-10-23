import { useMemo, useState, useEffect, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore } from '../../stores/toolStore'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { useDragPreviewStore } from '../../stores/dragPreviewStore'
import { terminalApi } from '../../lib/tauri-api'
import { insertTerminalFillEmpty } from '../../lib/layoutUtils'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { confirmTerminalClose } from '../../lib/terminalUtils'
import { ToolIcon, contributionLabel } from '../../plugins/tools'
import { TerminalState, ToolInstance, ToolConfig } from '../../types'
import MinimizedBarFlyout from './MinimizedBarFlyout'

// Union type for dragged items
type DraggedItem =
  | { type: 'terminal'; data: TerminalState }
  | { type: 'tool'; data: ToolInstance; config: ToolConfig | undefined }

export default function MinimizedBar() {
  const { getMinimizedTerminals, restoreTerminal, removeTerminal, removeFromMinimizedList, layoutTree, setLayoutTree, activeTerminalId, setTerminalAttention, minimizedTerminals: minimizedTerminalIds } = useTerminalStore()
  const { getMinimizedToolInstances, restoreTool, closeTool, toolConfigs, setToolAttention, minimizedTools: minimizedToolIds, activeFlyout: toolbarFlyout, closeFlyout: closeToolbarFlyout } = useToolStore()
  const minimizedTerminals = getMinimizedTerminals()
  const minimizedTools = getMinimizedToolInstances()
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null)
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 })
  const [isLocalDragging, setIsLocalDragging] = useState(false)

  // Flyout state: which minimized item is currently peeking
  const [flyoutState, setFlyoutState] = useState<{
    type: 'terminal' | 'tool'
    id: string
    anchorRect: DOMRect
  } | null>(null)

  // Mutual exclusion: close our flyout when toolbar flyout opens
  useEffect(() => {
    if (toolbarFlyout) setFlyoutState(null)
  }, [toolbarFlyout])

  // Close flyout if the item is no longer minimized (restored/closed elsewhere)
  useEffect(() => {
    if (!flyoutState) return
    if (flyoutState.type === 'terminal' && !minimizedTerminalIds.includes(flyoutState.id)) {
      setFlyoutState(null)
    } else if (flyoutState.type === 'tool' && !minimizedToolIds.includes(flyoutState.id)) {
      setFlyoutState(null)
    }
  }, [flyoutState, minimizedTerminalIds, minimizedToolIds])

  // Open flyout for a minimized item (toggle behavior)
  const handleFlyout = useCallback((type: 'terminal' | 'tool', id: string, anchorRect: DOMRect) => {
    // Close toolbar flyout if open
    if (toolbarFlyout) closeToolbarFlyout()
    // Toggle: if same item is already flying out, close it
    if (flyoutState?.id === id) {
      setFlyoutState(null)
    } else {
      setFlyoutState({ type, id, anchorRect })
    }
  }, [flyoutState, toolbarFlyout, closeToolbarFlyout])

  const {
    isDragging: isPreviewDragging,
    previewTree,
    hoveredDropZone,
    startDrag,
    commitDrop,
    cancelDrag,
  } = useDragPreviewStore()

  // Combined drag state (local UI + preview system)
  const isDragging = isLocalDragging || isPreviewDragging

  useEffect(() => {
    if (!isLocalDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      setDragPosition({ x: e.clientX, y: e.clientY })
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (draggedItem) {
        const itemId = draggedItem.data.id

        // Check if we have a preview tree with a valid drop zone
        if (isPreviewDragging && previewTree && hoveredDropZone) {
          // Use the preview system's commit
          const result = commitDrop()
          if (result.tree) {
            // Set the new layout tree (already has item inserted)
            setLayoutTree(result.tree)
            // Remove from minimized list and clear attention based on type
            if (draggedItem.type === 'terminal') {
              setTerminalAttention(itemId, false)
              removeFromMinimizedList(itemId)
            } else {
              setToolAttention(itemId, false)
              restoreTool(itemId)
            }
          }
        } else {
          // Fallback: Check if dropped over the mosaic area (simple restore)
          const mosaicElement = document.querySelector('.mosaic-layout')
          if (mosaicElement) {
            const rect = mosaicElement.getBoundingClientRect()
            if (
              e.clientX >= rect.left &&
              e.clientX <= rect.right &&
              e.clientY >= rect.top &&
              e.clientY <= rect.bottom
            ) {
              // Restore to the layout based on type (also clear attention)
              if (draggedItem.type === 'terminal') {
                setTerminalAttention(itemId, false)
                restoreTerminal(itemId)
              } else {
                // Inline tool restore to avoid stale closure
                setToolAttention(itemId, false)
                const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
                const newTree = insertTerminalFillEmpty(layoutTree, itemId, activeTerminalId, splitDir)
                setLayoutTree(newTree)
                restoreTool(itemId)
              }
            }
          }
          // Cancel preview if no drop zone
          cancelDrag()
        }
      }
      setIsLocalDragging(false)
      setDraggedItem(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isLocalDragging, draggedItem, restoreTerminal, restoreTool, removeFromMinimizedList, isPreviewDragging, previewTree, hoveredDropZone, commitDrop, cancelDrag, setLayoutTree, layoutTree, activeTerminalId, setTerminalAttention, setToolAttention])

  const handleDragStart = useCallback((e: React.MouseEvent, terminal: TerminalState) => {
    e.preventDefault()
    setDraggedItem({ type: 'terminal', data: terminal })
    setDragPosition({ x: e.clientX, y: e.clientY })
    setIsLocalDragging(true)

    // Start the preview system for this minimized terminal
    startDrag(terminal.id, layoutTree, 'minimized')
  }, [startDrag, layoutTree])

  const handleToolDragStart = useCallback((e: React.MouseEvent, tool: ToolInstance, config: ToolConfig | undefined) => {
    e.preventDefault()
    setDraggedItem({ type: 'tool', data: tool, config })
    setDragPosition({ x: e.clientX, y: e.clientY })
    setIsLocalDragging(true)

    // Start the preview system for this minimized tool
    startDrag(tool.id, layoutTree, 'minimized')
  }, [startDrag, layoutTree])

  // Handler to restore a tool back to the layout
  // Reads latest state from store to support being called in a loop (e.g., Restore All)
  const handleRestoreTool = useCallback((instanceId: string) => {
    const currentTree = useTerminalStore.getState().layoutTree
    const currentActive = useTerminalStore.getState().activeTerminalId
    const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
    const newTree = insertTerminalFillEmpty(currentTree, instanceId, currentActive, splitDir)
    setLayoutTree(newTree)
    // Remove from minimized list
    restoreTool(instanceId)
  }, [setLayoutTree, restoreTool])

  // Minimized global workspaces — pulled in here so the bottom bar is one
  // unified row instead of two stacked strips.
  const workspaces = useGlobalWorkspaceStore(s => s.workspaces)
  const setWorkspaceMinimized = useGlobalWorkspaceStore(s => s.setWorkspaceMinimized)
  const minimizedWorkspaces = useMemo(
    () => Array.from(workspaces.values())
      .filter(w => w.enabled && w.minimized)
      .sort((a, b) => a.displayOrder - b.displayOrder),
    [workspaces],
  )

  if (
    minimizedTerminals.length === 0 &&
    minimizedTools.length === 0 &&
    minimizedWorkspaces.length === 0
  ) return null

  const totalMinimized = minimizedTerminals.length + minimizedTools.length

  return (
    <>
      {/* Minimized bar — single unified row at the very bottom edge. */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-vibe-surface border-t border-vibe-border">
        <div className="flex items-center gap-1.5 overflow-x-auto flex-1">
          {/* Global workspace chips first — distinct green-tinted globe pill. */}
          {minimizedWorkspaces.map(ws => (
            <button
              key={ws.id}
              onClick={() => setWorkspaceMinimized(ws.id, false)}
              className="flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 border border-emerald-500/40 rounded-md text-xs text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-400 transition-all flex-shrink-0"
              title={`Restore global workspace "${ws.name}"`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                <circle cx="12" cy="12" r="10" />
                <path d="M2 12h20" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span className="truncate max-w-[140px]">{ws.name}</span>
            </button>
          ))}

          {minimizedWorkspaces.length > 0 && (minimizedTerminals.length > 0 || minimizedTools.length > 0) && (
            <span className="w-px h-5 bg-vibe-border flex-shrink-0 mx-0.5" />
          )}

          {minimizedTerminals.map((terminal) => (
            <MinimizedTab
              key={terminal.id}
              terminal={terminal}
              onDragStart={handleDragStart}
              onFlyout={(anchorRect) => handleFlyout('terminal', terminal.id, anchorRect)}
              onRestore={() => {
                setFlyoutState(null)
                setTerminalAttention(terminal.id, false)
                restoreTerminal(terminal.id)
              }}
              onClose={async () => {
                if (!await confirmTerminalClose(terminal)) return
                setFlyoutState(null)
                await terminalApi.kill(terminal.id)
                removeTerminal(terminal.id)
              }}
              isDragging={isDragging && draggedItem?.type === 'terminal' && draggedItem.data.id === terminal.id}
              isActive={flyoutState?.id === terminal.id}
            />
          ))}
          {minimizedTools.map((tool) => {
            const config = toolConfigs.get(tool.configId)
            return (
              <MinimizedToolTab
                key={tool.id}
                tool={tool}
                config={config}
                onDragStart={(e) => handleToolDragStart(e, tool, config)}
                onFlyout={(anchorRect) => handleFlyout('tool', tool.id, anchorRect)}
                onRestore={() => {
                  setFlyoutState(null)
                  setToolAttention(tool.id, false)
                  handleRestoreTool(tool.id)
                }}
                onClose={() => {
                  setFlyoutState(null)
                  closeTool(tool.id)
                }}
                isDragging={isDragging && draggedItem?.type === 'tool' && draggedItem.data.id === tool.id}
                isActive={flyoutState?.id === tool.id}
              />
            )
          })}
        </div>
        {totalMinimized > 1 && (
          <button
            onClick={() => {
              setFlyoutState(null)
              minimizedTerminals.forEach((t) => {
                setTerminalAttention(t.id, false)
                restoreTerminal(t.id)
              })
              minimizedTools.forEach((t) => {
                setToolAttention(t.id, false)
                handleRestoreTool(t.id)
              })
            }}
            className="text-[11px] text-vibe-muted hover:text-vibe-text px-1.5 py-0.5 rounded hover:bg-vibe-border/50 transition-colors flex-shrink-0"
          >
            Restore All
          </button>
        )}
      </div>

      {/* Flyout panel for peeking at minimized items */}
      {flyoutState && (
        <MinimizedBarFlyout
          flyoutState={flyoutState}
          onClose={() => setFlyoutState(null)}
          onRestore={() => {
            if (flyoutState.type === 'terminal') {
              setTerminalAttention(flyoutState.id, false)
              restoreTerminal(flyoutState.id)
            } else {
              setToolAttention(flyoutState.id, false)
              handleRestoreTool(flyoutState.id)
            }
            setFlyoutState(null)
          }}
        />
      )}

      {/* Drag preview overlay */}
      {isDragging && draggedItem?.type === 'terminal' && (
        <DragPreview terminal={draggedItem.data} position={dragPosition} />
      )}
      {isDragging && draggedItem?.type === 'tool' && (
        <ToolDragPreview tool={draggedItem.data} config={draggedItem.config} position={dragPosition} />
      )}

      {/* Drop zone indicator when dragging */}
      {isDragging && <DropZoneOverlay />}
    </>
  )
}

interface MinimizedTabProps {
  terminal: TerminalState
  onDragStart: (e: React.MouseEvent, terminal: TerminalState) => void
  onFlyout: (anchorRect: DOMRect) => void
  onRestore: () => void
  onClose: () => void
  isDragging: boolean
  isActive: boolean
}

function MinimizedTab({ terminal, onDragStart, onFlyout, onRestore, onClose, isDragging, isActive }: MinimizedTabProps) {
  const needsAttention = terminal.needsAttention
  const isIdle = terminal.isIdle

  // Build class list for the tab - active flyout > attention > idle styling priority
  const tabClasses = [
    'flex items-center gap-1.5 px-2 py-1 bg-vibe-bg border border-vibe-border rounded-md transition-all group cursor-grab active:cursor-grabbing flex-shrink-0',
    isDragging ? 'opacity-50' : 'hover:border-vibe-primary/50 hover:bg-vibe-border/30',
    isActive ? 'border-vibe-primary bg-vibe-primary/10' : '',
    needsAttention ? 'minimized-tab-attention' : (isIdle ? 'minimized-tab-idle' : ''),
  ].filter(Boolean).join(' ')

  return (
    <div
      data-minimized-tab
      className={tabClasses}
      onMouseDown={(e) => {
        // Only start drag if not clicking a button
        if (!(e.target as HTMLElement).closest('button')) {
          onDragStart(e, terminal)
        }
      }}
    >
      {/* Drag handle indicator */}
      <div className="flex flex-col gap-0.5 opacity-40 group-hover:opacity-60">
        <div className="flex gap-0.5">
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
        </div>
        <div className="flex gap-0.5">
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
        </div>
      </div>

      {/* Status dot - dynamic color for attention/idle */}
      <div
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          needsAttention
            ? ''
            : isIdle
            ? ''
            : terminal.status === 'active'
            ? 'bg-green-500'
            : terminal.status === 'error'
            ? 'bg-red-500'
            : 'bg-gray-500'
        }`}
        style={
          needsAttention
            ? { backgroundColor: 'var(--attention-glow-color)' }
            : isIdle
            ? { backgroundColor: 'var(--idle-glow-color)' }
            : undefined
        }
      />

      {/* Title (clickable to open flyout preview) */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          const tab = (e.target as HTMLElement).closest('[data-minimized-tab]')
          if (tab) onFlyout(tab.getBoundingClientRect())
        }}
        className="text-xs text-vibe-text truncate max-w-[150px] hover:text-vibe-primary transition-colors"
        title={`Click to preview: ${terminal.title}${terminal.originalPrompt ? ` - ${terminal.originalPrompt}` : ''}`}
      >
        {(() => {
          const maxLen = useAppSettingsStore.getState().toolbar.tabTitleMaxLength
          return terminal.title.length > maxLen ? terminal.title.substring(0, maxLen) + '...' : terminal.title
        })()}
      </button>

      {/* Restore to layout button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRestore()
        }}
        className="p-0.5 text-vibe-muted hover:text-vibe-primary opacity-0 group-hover:opacity-100 transition-all"
        title="Restore to layout"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </button>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="p-0.5 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
        title="Close terminal"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

interface MinimizedToolTabProps {
  tool: ToolInstance
  config: ToolConfig | undefined
  onDragStart: (e: React.MouseEvent) => void
  onFlyout: (anchorRect: DOMRect) => void
  onRestore: () => void
  onClose: () => void
  isDragging: boolean
  isActive: boolean
}

function MinimizedToolTab({ tool, config, onDragStart, onFlyout, onRestore, onClose, isDragging, isActive }: MinimizedToolTabProps) {
  const needsAttention = tool.needsAttention

  // Build class list for the tab - active flyout > attention styling
  const tabClasses = [
    'flex items-center gap-1.5 px-2 py-1 bg-vibe-bg border border-vibe-border rounded-md transition-all group cursor-grab active:cursor-grabbing flex-shrink-0',
    isDragging ? 'opacity-50' : 'hover:border-vibe-primary/50 hover:bg-vibe-border/30',
    isActive ? 'border-teal-500 bg-teal-500/10' : '',
    needsAttention ? 'minimized-tab-attention' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      data-minimized-tab
      className={tabClasses}
      onMouseDown={(e) => {
        // Only start drag if not clicking a button
        if (!(e.target as HTMLElement).closest('button')) {
          onDragStart(e)
        }
      }}
    >
      {/* Drag handle indicator */}
      <div className="flex flex-col gap-0.5 opacity-40 group-hover:opacity-60">
        <div className="flex gap-0.5">
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
        </div>
        <div className="flex gap-0.5">
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
          <div className="w-1 h-1 rounded-full bg-vibe-muted" />
        </div>
      </div>

      {/* Status dot - orange when needs attention */}
      <div
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          needsAttention
            ? 'bg-orange-500'
            : tool.status === 'active'
            ? 'bg-teal-500'
            : tool.status === 'error'
            ? 'bg-red-500'
            : 'bg-gray-500'
        }`}
      />

      {/* Tool type badge */}
      {config && (
        <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-white flex items-center gap-1 flex-shrink-0">
          <ToolIcon config={config} className="w-3 h-3" />
        </span>
      )}

      {/* Title (clickable to open flyout preview) */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          const tab = (e.target as HTMLElement).closest('[data-minimized-tab]')
          if (tab) onFlyout(tab.getBoundingClientRect())
        }}
        className="text-xs text-vibe-text truncate max-w-[150px] hover:text-vibe-primary transition-colors"
        title={`Click to preview: ${tool.title}`}
      >
        {(() => {
          const maxLen = useAppSettingsStore.getState().toolbar.tabTitleMaxLength
          return tool.title.length > maxLen ? tool.title.substring(0, maxLen) + '...' : tool.title
        })()}
      </button>

      {/* Restore to layout button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRestore()
        }}
        className="p-0.5 text-vibe-muted hover:text-teal-400 opacity-0 group-hover:opacity-100 transition-all"
        title="Restore to layout"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      </button>

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="p-0.5 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
        title="Close tool"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

interface DragPreviewProps {
  terminal: TerminalState
  position: { x: number; y: number }
}

function DragPreview({ terminal, position }: DragPreviewProps) {
  const { hoveredDropZone } = useDragPreviewStore()

  // Show different hint based on hover state
  const dropHint = hoveredDropZone
    ? `Insert ${hoveredDropZone.position === 'left' ? 'left of' : hoveredDropZone.position === 'right' ? 'right of' : hoveredDropZone.position === 'top' ? 'above' : 'below'} tile`
    : 'Drag to a drop zone'

  return (
    <div
      className="fixed pointer-events-none z-[9999]"
      style={{
        left: position.x - 100,
        top: position.y - 40,
      }}
    >
      {/* Preview window */}
      <div className={`w-[200px] h-[120px] bg-vibe-surface border-2 rounded-lg shadow-2xl overflow-hidden transition-all ${
        hoveredDropZone ? 'border-green-500 shadow-green-500/30' : 'border-vibe-primary shadow-vibe-primary/30'
      }`}>
        {/* Preview header */}
        <div className="flex items-center gap-2 px-2 py-1.5 bg-vibe-bg border-b border-vibe-border">
          <div
            className={`w-2 h-2 rounded-full ${
              terminal.status === 'active' ? 'bg-green-500' : 'bg-gray-500'
            }`}
          />
          <span className="text-xs text-vibe-muted truncate flex-1">
            {terminal.title}
          </span>
        </div>
        {/* Preview content */}
        <div className="flex-1 bg-[rgb(var(--qf-term-bg))] p-2">
          <div className="text-xs text-vibe-muted font-mono opacity-50">
            Terminal content...
          </div>
        </div>
      </div>
      {/* Drop hint */}
      <div className={`text-center mt-2 text-xs font-medium transition-colors ${
        hoveredDropZone ? 'text-green-500' : 'text-vibe-primary'
      }`}>
        {dropHint}
      </div>
    </div>
  )
}

interface ToolDragPreviewProps {
  tool: ToolInstance
  config: ToolConfig | undefined
  position: { x: number; y: number }
}

function ToolDragPreview({ tool, config, position }: ToolDragPreviewProps) {
  const { hoveredDropZone } = useDragPreviewStore()

  // Show different hint based on hover state
  const dropHint = hoveredDropZone
    ? `Insert ${hoveredDropZone.position === 'left' ? 'left of' : hoveredDropZone.position === 'right' ? 'right of' : hoveredDropZone.position === 'top' ? 'above' : 'below'} tile`
    : 'Drag to a drop zone'

  return (
    <div
      className="fixed pointer-events-none z-[9999]"
      style={{
        left: position.x - 100,
        top: position.y - 40,
      }}
    >
      {/* Preview window */}
      <div className={`w-[200px] h-[120px] bg-vibe-surface border-2 rounded-lg shadow-2xl overflow-hidden transition-all ${
        hoveredDropZone ? 'border-green-500 shadow-green-500/30' : 'border-teal-500 shadow-teal-500/30'
      }`}>
        {/* Preview header */}
        <div className="flex items-center gap-2 px-2 py-1.5 bg-vibe-bg border-b border-vibe-border">
          <div
            className={`w-2 h-2 rounded-full ${
              tool.status === 'active' ? 'bg-teal-500' : 'bg-gray-500'
            }`}
          />
          {config && (
            <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-white flex items-center gap-1">
              <ToolIcon config={config} className="w-3 h-3" />
              {contributionLabel(config).toUpperCase()}
            </span>
          )}
          <span className="text-xs text-vibe-muted truncate flex-1">
            {tool.title}
          </span>
        </div>
        {/* Preview content */}
        <div className="flex-1 bg-vibe-bg p-2">
          <div className="text-xs text-vibe-muted opacity-50">
            Tool content...
          </div>
        </div>
      </div>
      {/* Drop hint */}
      <div className={`text-center mt-2 text-xs font-medium transition-colors ${
        hoveredDropZone ? 'text-green-500' : 'text-teal-500'
      }`}>
        {dropHint}
      </div>
    </div>
  )
}

function DropZoneOverlay() {
  const { hoveredDropZone } = useDragPreviewStore()

  // Get the mosaic layout element's position
  const mosaicElement = document.querySelector('.mosaic-layout')
  const rect = mosaicElement?.getBoundingClientRect()

  if (!rect) return null

  // Show different message based on whether we're hovering a drop zone
  const isHoveringZone = !!hoveredDropZone

  return (
    <div className="fixed inset-0 pointer-events-none z-[9995]">
      {/* Overlay on the mosaic area only - but more subtle now */}
      <div
        className={`absolute border-2 border-dashed rounded-lg flex items-center justify-center transition-all ${
          isHoveringZone
            ? 'border-green-500/60 bg-green-500/5'
            : 'border-vibe-primary/40 bg-vibe-primary/5'
        }`}
        style={{
          left: rect.left + 8,
          top: rect.top + 8,
          width: rect.width - 16,
          height: rect.height - 16,
        }}
      >
        {/* Only show message if not hovering a specific zone */}
        {!isHoveringZone && (
          <div className="text-vibe-primary text-sm font-medium bg-vibe-surface/95 px-6 py-3 rounded-lg shadow-lg border border-vibe-primary/30">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Drag to edge of a tile to insert
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
