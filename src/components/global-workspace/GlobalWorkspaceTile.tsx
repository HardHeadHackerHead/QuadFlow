import { useCallback, useMemo, useEffect, useRef } from 'react'
import {
  MosaicWithoutDragDropContext,
  MosaicWindow,
  MosaicNode,
  MosaicBranch,
} from 'react-mosaic-component'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { useToolStore } from '../../stores/toolStore'
import { useDragPreviewStore } from '../../stores/dragPreviewStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { removeTerminalPreservingLocked, dedupeTreeLeaves } from '../../lib/layoutUtils'
import { isTileTool } from '../../types'
import ToolTileContent from '../tools/ToolTileContent'
import ToolTileToolbar from '../tools/ToolTileToolbar'
import TerminalTileContent from '../layout/TerminalTileContent'
import TerminalTileToolbar from '../layout/TerminalTileToolbar'

interface Props {
  workspaceId: string
  path: MosaicBranch[]
}

/**
 * Renders a single global workspace as a tile inside the frame mosaic. The
 * body is a nested MosaicWithoutDragDropContext driven by the workspace's
 * sub_layout_tree. Tool tiles inside use the same ToolTileContent /
 * ToolTileToolbar components as the project mosaic.
 */
export default function GlobalWorkspaceTile({ workspaceId, path }: Props) {
  const workspace = useGlobalWorkspaceStore(s => s.workspaces.get(workspaceId))
  // Subscribe to frameTree so the arrow-button enabled/disabled state updates
  // immediately after a reorder (canMoveWorkspaceInFrame reads frameTree).
  const frameTree = useGlobalWorkspaceStore(s => s.frameTree)
  const setWorkspaceLayoutTree = useGlobalWorkspaceStore(s => s.setWorkspaceLayoutTree)
  const setWorkspaceMinimized = useGlobalWorkspaceStore(s => s.setWorkspaceMinimized)
  const moveWorkspaceInFrame = useGlobalWorkspaceStore(s => s.moveWorkspaceInFrame)
  const canMoveWorkspaceInFrame = useGlobalWorkspaceStore(s => s.canMoveWorkspaceInFrame)
  const globalToolInstances = useGlobalWorkspaceStore(s => s.globalToolInstances)
  const toolConfigs = useToolStore(s => s.toolConfigs)
  // Subscribe to the terminals Map so the inner pane re-renders when a
  // terminal's scope flips between 'session' and 'global' — without this the
  // pin button wouldn't update its label/icon after a pin.
  const terminals = useTerminalStore(s => s.terminals)
  const isDragging = useDragPreviewStore(s => s.isDragging)
  const dragSource = useDragPreviewStore(s => s.dragSource)

  void frameTree // referenced just to subscribe for re-renders on tree changes
  const canLeft = canMoveWorkspaceInFrame(workspaceId, 'left')
  const canRight = canMoveWorkspaceInFrame(workspaceId, 'right')

  const containerRef = useRef<HTMLDivElement | null>(null)

  // Pane-drag start from inside the workspace. We piggyback on the existing
  // dragPreviewStore (`dragSource: 'layout'`) so the visual drag preview shows
  // as usual; on mouseup, our own handlers (this tile's handler if released
  // inside, or the global window listener below if released over the project
  // area) decide where the pane lands.
  const handleInnerPaneDragStart = useCallback((tileId: string, e: React.MouseEvent) => {
    e.preventDefault()
    const subTree = useGlobalWorkspaceStore.getState().workspaces.get(workspaceId)?.layoutTree ?? null
    useDragPreviewStore.getState().startDrag(tileId, subTree, 'layout')
  }, [workspaceId])

  const handleSubChange = useCallback(
    (next: MosaicNode<string> | null) => {
      setWorkspaceLayoutTree(workspaceId, next)
    },
    [workspaceId, setWorkspaceLayoutTree],
  )

  const renderSubTile = useCallback(
    (id: string, subPath: MosaicBranch[]) => {
      // Tool tile path
      if (isTileTool(id)) {
        const instance = globalToolInstances.get(id)
        const config = instance ? toolConfigs.get(instance.configId) : undefined

        if (!instance) return <div className="h-full w-full bg-vibe-bg" />

        const classes = [
          'tool-mosaic-window',
          'global-tool-mosaic-window',
          instance.needsAttention ? 'needs-attention' : '',
          instance.isLocked ? 'locked-pane' : '',
        ].filter(Boolean).join(' ')

        return (
          <MosaicWindow<string>
            path={subPath}
            title={instance.title}
            renderToolbar={() => (
              <div className="mosaic-window-toolbar-draggable cursor-move" title="Drag to rearrange / stack panels">
                <ToolTileToolbar instance={instance} config={config} onPaneDragStart={handleInnerPaneDragStart} />
              </div>
            )}
            draggable={true}
            className={classes}
          >
            <div data-tool-id={id} data-global="true" data-workspace-id={workspaceId} className="h-full w-full">
              <ToolTileContent instance={instance} config={config} />
            </div>
          </MosaicWindow>
        )
      }

      // Terminal tile path — terminals can also be pinned to a global workspace.
      // Look the terminal up in the reactive terminals Map (subscribed above)
      // so the button state updates when scope flips.
      const terminal = terminals.get(id)
      if (!terminal) return <div className="h-full w-full bg-vibe-bg" />

      const termClasses = [
        'terminal-mosaic-window',
        'global-tool-mosaic-window',
        terminal.needsAttention ? 'needs-attention' : '',
        terminal.isIdle ? 'is-idle' : '',
        terminal.isLocked ? 'locked-pane' : '',
      ].filter(Boolean).join(' ')

      return (
        <MosaicWindow<string>
          path={subPath}
          title={terminal.originalPrompt || terminal.title}
          renderToolbar={() => (
            <div className="mosaic-window-toolbar-draggable cursor-move" title="Drag to rearrange / stack panels">
              <TerminalTileToolbar terminal={terminal} onPaneDragStart={handleInnerPaneDragStart} />
            </div>
          )}
          draggable={true}
          className={termClasses}
        >
          <div data-terminal-id={id} data-global="true" data-workspace-id={workspaceId} className="h-full w-full">
            <TerminalTileContent terminal={terminal} />
          </div>
        </MosaicWindow>
      )
    },
    [globalToolInstances, toolConfigs, terminals, handleInnerPaneDragStart, workspaceId],
  )

  // Cross-region drop: project mosaic tile dragged onto this workspace. We
  // intercept window mouseup in capture phase so the project mosaic's own
  // mouseup handler doesn't cancel the drag first.
  useEffect(() => {
    if (!isDragging || dragSource !== 'layout') return

    const isOverTile = (clientX: number, clientY: number): boolean => {
      const el = containerRef.current
      if (!el) return false
      const rect = el.getBoundingClientRect()
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    }

    const onUpCapture = (e: MouseEvent) => {
      if (!isOverTile(e.clientX, e.clientY)) return
      const dragStore = useDragPreviewStore.getState()
      const draggedId = dragStore.draggedTileId
      if (!draggedId) return
      e.stopPropagation()

      // Strip the dragged pane from the project's layout tree.
      try {
        const termStore = useTerminalStore.getState()
        const toolStore = useToolStore.getState()
        const lockedIds = new Set<string>()
        termStore.terminals.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
        toolStore.toolInstances.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
        const { tree: newTree } = removeTerminalPreservingLocked(
          termStore.layoutTree, draggedId, lockedIds, []
        )
        termStore.setLayoutTree(newTree)
      } catch (err) {
        console.error('[globalWorkspace] drop strip failed:', err)
      }

      // Tool: route through the existing pinInstanceToWorkspace flow.
      // Terminal (or anything else): just attach the id to the workspace's
      // sub-layout tree and mark the terminal scope=global.
      const gs = useGlobalWorkspaceStore.getState()
      if (isTileTool(draggedId)) {
        gs.pinInstanceToWorkspace(draggedId, workspaceId)
          .catch(err => console.error('[globalWorkspace] pinInstanceToWorkspace:', err))
      } else {
        gs.pinTerminalToWorkspace(draggedId, workspaceId)
          .catch(err => console.error('[globalWorkspace] pinTerminalToWorkspace:', err))
      }
      dragStore.cancelDrag()
    }
    window.addEventListener('mouseup', onUpCapture, true)
    return () => window.removeEventListener('mouseup', onUpCapture, true)
  }, [isDragging, dragSource, workspaceId])

  const showDropOverlay = isDragging && dragSource === 'layout'
  const isEmpty = useMemo(() => !workspace?.layoutTree, [workspace?.layoutTree])

  if (!workspace) return <div className="h-full w-full bg-vibe-bg" />

  return (
    <MosaicWindow<string>
      path={path}
      title={workspace.name}
      draggable={true}
      renderToolbar={() => (
        <div
          className="w-full h-full flex items-center gap-2 px-2 py-1.5 bg-vibe-surface border-b border-cyan-500/30 select-none cursor-move"
          title="Drag to rearrange workspace"
        >
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-cyan-500 to-blue-500 text-white">
            GLOBAL
          </span>
          <span className="text-xs text-vibe-text truncate flex-1 font-medium" title={workspace.name}>
            {workspace.name}
          </span>

          {/* Reposition arrows — swap with adjacent leaf in the frame's
              left-to-right (rows) / top-to-bottom (columns) leaf order.
              onMouseDown stops the native mosaic drag from starting when
              clicking the button itself. */}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); moveWorkspaceInFrame(workspaceId, 'left') }}
            disabled={!canLeft}
            className="p-1 text-vibe-muted hover:text-cyan-300 hover:bg-vibe-border/50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-vibe-muted cursor-pointer"
            title={canLeft ? 'Move workspace toward start' : 'Already at start'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); moveWorkspaceInFrame(workspaceId, 'right') }}
            disabled={!canRight}
            className="p-1 text-vibe-muted hover:text-cyan-300 hover:bg-vibe-border/50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-vibe-muted cursor-pointer"
            title={canRight ? 'Move workspace toward end' : 'Already at end'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>

          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setWorkspaceMinimized(workspaceId, true) }}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors cursor-pointer"
            title="Minimize workspace"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
        </div>
      )}
      className="global-workspace-window"
    >
      <div ref={containerRef} className="h-full w-full relative bg-vibe-bg">
        {showDropOverlay && (
          <div className="absolute inset-0 z-10 pointer-events-none border-2 border-dashed border-cyan-400/60 bg-cyan-400/10 flex items-center justify-center">
            <div className="text-cyan-300 text-sm font-medium px-3 py-1.5 bg-vibe-bg/80 rounded">
              Drop to pin to "{workspace.name}"
            </div>
          </div>
        )}
        {isEmpty ? (
          <EmptyTilePrompt name={workspace.name} />
        ) : (
          <MosaicWithoutDragDropContext<string>
            renderTile={renderSubTile}
            value={dedupeTreeLeaves(workspace.layoutTree)}
            onChange={handleSubChange}
            className="mosaic-theme-dark"
            blueprintNamespace="bp5"
            zeroStateView={
              <div className="text-vibe-muted text-center p-4 text-sm">No tools.</div>
            }
          />
        )}
      </div>
    </MosaicWindow>
  )
}

function EmptyTilePrompt({ name }: { name: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center p-6 text-center">
      <div className="text-vibe-muted">
        <p className="text-sm font-medium mb-1">"{name}" is empty</p>
        <p className="text-xs opacity-70">
          Use the globe icon on any tool, or drag any pane (terminal, agent, or tool)
          into this panel to pin it here.
        </p>
      </div>
    </div>
  )
}
