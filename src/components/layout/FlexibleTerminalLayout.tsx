import { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import {
  MosaicWithoutDragDropContext,
  MosaicWindow,
  MosaicNode,
  MosaicBranch,
} from 'react-mosaic-component'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore, countPaneTools } from '../../stores/toolStore'
import { useDragPreviewStore } from '../../stores/dragPreviewStore'
import { useFloatingWindowStore } from '../../stores/floatingWindowStore'
import { isTileTool } from '../../types'
import ProviderBadge from '../../agents/ProviderBadge'
import { contributionLabel } from '../../plugins/tools'
import { preserveLockedSplitPercentages, removeTerminalPreservingLocked, cloneTree, isEmptyTile, createEmptyTileId, containsLockedPane, dedupeTreeLeaves } from '../../lib/layoutUtils'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import type { MosaicDirection } from 'react-mosaic-component'
import TerminalTileContent from './TerminalTileContent'
import TerminalTileToolbar from './TerminalTileToolbar'
import ToolTileContent from '../tools/ToolTileContent'
import ToolTileToolbar from '../tools/ToolTileToolbar'
import DropZoneDetector from './DropZoneDetector'
import FloatingPlaceholder from './FloatingPlaceholder'
import EmptyTileBubbleMenu from './EmptyTileBubbleMenu'
import WorkspaceEmptyState from './WorkspaceEmptyState'
import 'react-mosaic-component/react-mosaic-component.css'

// Drag threshold in pixels before actual drag starts
const DRAG_THRESHOLD = 5

export default function FlexibleTerminalLayout() {
  const {
    terminals,
    layoutTree,
    setLayoutTree,
    activeTerminalId,
  } = useTerminalStore()

  const { toolInstances, toolConfigs } = useToolStore()

  const { isFloating } = useFloatingWindowStore()

  const {
    isDragging: isPreviewDragging,
    dragSource,
    previewTree,
  } = useDragPreviewStore()

  // Ref for the mosaic container — used to scope react-dnd's event listeners
  // so they don't intercept native drag events from the sidebar file tree.
  // Uses a callback ref so dndReady is set as soon as the DOM node appears,
  // even if the component initially renders the empty state path.
  const mosaicContainerRef = useRef<HTMLDivElement | null>(null)
  const [dndReady, setDndReady] = useState(false)
  const mosaicContainerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    mosaicContainerRef.current = node
    setDndReady(!!node)
  }, [])

  // Layout pane drag state
  const [layoutDragTileId, setLayoutDragTileId] = useState<string | null>(null)
  const [layoutDragPosition, setLayoutDragPosition] = useState({ x: 0, y: 0 })
  const [isLayoutDragActive, setIsLayoutDragActive] = useState(false)
  const layoutDragStartRef = useRef({ x: 0, y: 0 })
  const isLayoutDragActiveRef = useRef(false)

  // Custom drag active from either source (minimized bar OR layout pane)
  const isCustomDrag = isPreviewDragging && (dragSource === 'minimized' || dragSource === 'layout')
  const isLayoutDrag = isLayoutDragActive && isPreviewDragging && dragSource === 'layout'
  const rawDisplayTree = isCustomDrag && previewTree ? previewTree : layoutTree

  // Defensive dedupe — strip any duplicate ids and any ids that belong to a
  // global workspace (those should never appear in the project tree). This
  // protects against persisted/corrupted state crashing react-mosaic with
  // "Duplicate IDs detected".
  const globalWorkspaces = useGlobalWorkspaceStore(s => s.workspaces)
  const globalTerminalIds = useGlobalWorkspaceStore(s => s.globalTerminalIds)
  const globalToolInstances = useGlobalWorkspaceStore(s => s.globalToolInstances)
  const displayTree = useMemo(() => {
    const exclude = new Set<string>(globalTerminalIds)
    globalToolInstances.forEach((_, id) => exclude.add(id))
    // Also exclude ids currently sitting in any global workspace's sub-tree.
    globalWorkspaces.forEach((ws) => {
      if (!ws.layoutTree) return
      const ids: string[] = []
      const walk = (n: import('react-mosaic-component').MosaicNode<string> | null): void => {
        if (n === null) return
        if (typeof n === 'string') { ids.push(n); return }
        walk(n.first); walk(n.second)
      }
      walk(ws.layoutTree)
      ids.forEach(id => exclude.add(id))
    })
    return dedupeTreeLeaves(rawDisplayTree, exclude)
  }, [rawDisplayTree, globalTerminalIds, globalToolInstances, globalWorkspaces])

  // Compute set of all locked pane IDs (terminals + tools)
  const lockedIds = useMemo(() => {
    const ids = new Set<string>()
    terminals.forEach((t) => { if (t.isLocked) ids.add(t.id) })
    toolInstances.forEach((t) => { if (t.isLocked) ids.add(t.id) })
    return ids
  }, [terminals, toolInstances])

  const handleChange = useCallback(
    (newTree: MosaicNode<string> | null) => {
      // Don't update layout during any custom drag preview
      if (isCustomDrag) return
      // Prevent split-percentage changes adjacent to locked panes
      const protectedTree = preserveLockedSplitPercentages(layoutTree, newTree, lockedIds)
      setLayoutTree(protectedTree)
    },
    [setLayoutTree, isCustomDrag, layoutTree, lockedIds]
  )

  // Handle pane drag start from toolbar mousedown
  const handlePaneDragStart = useCallback((tileId: string, e: React.MouseEvent) => {
    e.preventDefault()
    setLayoutDragTileId(tileId)
    layoutDragStartRef.current = { x: e.clientX, y: e.clientY }
    setLayoutDragPosition({ x: e.clientX, y: e.clientY })
    // Don't activate drag yet - wait for mouse to move past threshold
  }, [])

  // Layout drag mouse tracking
  useEffect(() => {
    if (!layoutDragTileId) return

    const handleMouseMove = (e: MouseEvent) => {
      setLayoutDragPosition({ x: e.clientX, y: e.clientY })

      if (!isLayoutDragActiveRef.current) {
        const dx = e.clientX - layoutDragStartRef.current.x
        const dy = e.clientY - layoutDragStartRef.current.y
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          // Threshold exceeded - start actual drag
          isLayoutDragActiveRef.current = true
          setIsLayoutDragActive(true)

          const store = useDragPreviewStore.getState()
          store.startDrag(layoutDragTileId, layoutTree, 'layout')
          // Set preview to tree with dragged tile removed (lock-aware: shows empty space)
          const { tree: removedTree } = removeTerminalPreservingLocked(
            cloneTree(layoutTree), layoutDragTileId, lockedIds, []
          )
          store.setPreviewTree(removedTree)
        }
      }
    }

    const handleMouseUp = () => {
      if (isLayoutDragActiveRef.current) {
        const store = useDragPreviewStore.getState()
        if (store.previewTree && store.hoveredDropZone) {
          // Valid drop zone - commit the layout change
          const result = store.commitDrop()
          if (result.tree) {
            setLayoutTree(result.tree)
          }
        } else {
          // No valid drop zone - snap back to original position
          store.cancelDrag()
        }
      }
      isLayoutDragActiveRef.current = false
      setIsLayoutDragActive(false)
      setLayoutDragTileId(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [layoutDragTileId, layoutTree, setLayoutTree])

  // Custom renderer for each mosaic tile
  // Native mosaic drag is disabled - we use our custom preview system for all drags
  const renderTile = useCallback(
    (id: string, path: MosaicBranch[]) => {
      // Check if this is an empty placeholder tile - render without MosaicWindow
      // to avoid all the internal structure (toolbar, drop targets, overlays)
      if (isEmptyTile(id)) {
        return <EmptyTileBubbleMenu tileId={id} />
      }

      // Check if this panel is floating - show placeholder instead of actual content
      const panelIsFloating = isFloating(id)

      // Check if this is a tool tile
      if (isTileTool(id)) {
        const toolInstance = toolInstances.get(id)
        const toolConfig = toolInstance ? toolConfigs.get(toolInstance.configId) : undefined

        if (!toolInstance) {
          return <div className="h-full w-full bg-vibe-bg" />
        }

        const isToolActive = activeTerminalId === id
        const needsAttention = toolInstance.needsAttention
        const isLocked = toolInstance.isLocked

        // Build class list: needs-attention takes priority over active-window
        const toolWindowClasses = [
          'tool-mosaic-window',
          panelIsFloating ? 'floating-panel' : '',
          needsAttention ? 'needs-attention' : (isToolActive ? 'active-window' : ''),
          isLocked ? 'locked-pane' : '',
        ].filter(Boolean).join(' ')

        return (
          <MosaicWindow<string>
            path={path}
            title={toolInstance.title}
            renderToolbar={() => (
              <div className="mosaic-window-toolbar-draggable">
                <ToolTileToolbar instance={toolInstance} config={toolConfig} onPaneDragStart={handlePaneDragStart} />
              </div>
            )}
            draggable={false}
            className={toolWindowClasses}
          >
            <div data-tool-id={id} className="h-full w-full">
              {panelIsFloating ? (
                <FloatingPlaceholder
                  panelId={id}
                  panelType="tool"
                  title={toolInstance.title}
                />
              ) : (
                <ToolTileContent instance={toolInstance} config={toolConfig} />
              )}
            </div>
          </MosaicWindow>
        )
      }

      // Otherwise render as terminal
      const terminal = terminals.get(id)
      if (!terminal) {
        return <div className="h-full w-full bg-vibe-bg" />
      }

      const isActive = activeTerminalId === id
      const needsAttention = terminal.needsAttention
      const isLocked = terminal.isLocked

      // Build class list: needs-attention > is-idle > active-window
      const glowClass = needsAttention
        ? 'needs-attention'
        : terminal.isIdle
        ? 'is-idle'
        : isActive
        ? 'active-window'
        : ''
      const terminalWindowClasses = [
        'terminal-mosaic-window',
        panelIsFloating ? 'floating-panel' : '',
        glowClass,
        isLocked ? 'locked-pane' : '',
      ].filter(Boolean).join(' ')

      return (
        <MosaicWindow<string>
          path={path}
          title={terminal.originalPrompt || terminal.title}
          renderToolbar={() => (
            <div className="mosaic-window-toolbar-draggable">
              <TerminalTileToolbar terminal={terminal} onPaneDragStart={handlePaneDragStart} />
            </div>
          )}
          draggable={false}
          className={terminalWindowClasses}
        >
          <div data-terminal-id={id} className="h-full w-full">
            {panelIsFloating ? (
              <FloatingPlaceholder
                panelId={id}
                panelType="terminal"
                title={terminal.originalPrompt || terminal.title}
              />
            ) : (
              <TerminalTileContent terminal={terminal} />
            )}
          </div>
        </MosaicWindow>
      )
    },
    [terminals, toolInstances, toolConfigs, activeTerminalId, isFloating, handlePaneDragStart]
  )

  // If no terminals or tools exist (empty tiles don't count), show empty state
  if ((terminals.size === 0 && countPaneTools(toolInstances) === 0) || layoutTree === null) {
    return <WorkspaceEmptyState />
  }

  return (
    <div className="h-full w-full flex flex-col">
      {/* Main mosaic layout — DnD scoped to this container so sidebar native drag works */}
      <div ref={mosaicContainerCallbackRef} className={`flex-1 min-h-0 mosaic-layout relative ${isCustomDrag ? 'preview-mode' : ''}`}>
        {dndReady && mosaicContainerRef.current && (
          <DndProvider backend={HTML5Backend} options={{ rootElement: mosaicContainerRef.current }}>
            <MosaicWithoutDragDropContext<string>
              renderTile={renderTile}
              value={displayTree}
              onChange={handleChange}
              className="mosaic-theme-dark"
              blueprintNamespace="bp5"
              zeroStateView={
                <div className="text-vibe-muted text-center p-8">
                  No terminals visible. Restore minimized terminals below.
                </div>
              }
            />
          </DndProvider>
        )}
        {/* Edge resize handles for creating empty space from window edges */}
        {!isCustomDrag && <EdgeResizeHandles lockedIds={lockedIds} />}
      </div>

      {/* Drop zone detector overlay - active during any custom drag */}
      {isCustomDrag && <DropZoneDetector layoutTree={layoutTree} />}

      {/* Layout pane drag preview */}
      {isLayoutDrag && layoutDragTileId && (
        <LayoutPaneDragPreview
          tileId={layoutDragTileId}
          position={layoutDragPosition}
        />
      )}

      {/* Minimized bar is rendered globally in App.tsx so it spans the full
          width across the project tile and any sibling global workspaces. */}
    </div>
  )
}

// Find all real (non-empty) leaf pane IDs that sit on a given edge of the mosaic tree.
// Empty tiles are transparent — if an empty tile sits on the edge, we look through it
// to find real panes that would be on the edge if the empty tile weren't there.
function getPanesOnEdge(tree: MosaicNode<string> | null, edge: 'top' | 'bottom' | 'left' | 'right'): string[] {
  if (tree === null) return []
  if (typeof tree === 'string') {
    // Skip empty tiles — they don't count as real panes on the edge
    if (isEmptyTile(tree)) return []
    return [tree]
  }
  if (tree.direction === 'row') {
    if (edge === 'left') {
      const firstPanes = getPanesOnEdge(tree.first, edge)
      // If the first branch is entirely empty tiles, look through to the second branch
      if (firstPanes.length === 0) return getPanesOnEdge(tree.second, edge)
      return firstPanes
    }
    if (edge === 'right') {
      const secondPanes = getPanesOnEdge(tree.second, edge)
      if (secondPanes.length === 0) return getPanesOnEdge(tree.first, edge)
      return secondPanes
    }
    return [...getPanesOnEdge(tree.first, edge), ...getPanesOnEdge(tree.second, edge)]
  } else {
    if (edge === 'top') {
      const firstPanes = getPanesOnEdge(tree.first, edge)
      if (firstPanes.length === 0) return getPanesOnEdge(tree.second, edge)
      return firstPanes
    }
    if (edge === 'bottom') {
      const secondPanes = getPanesOnEdge(tree.second, edge)
      if (secondPanes.length === 0) return getPanesOnEdge(tree.first, edge)
      return secondPanes
    }
    return [...getPanesOnEdge(tree.first, edge), ...getPanesOnEdge(tree.second, edge)]
  }
}

// Edge resize handles for creating empty space by dragging from window edges
function EdgeResizeHandles({ lockedIds }: { lockedIds: Set<string> }) {
  const layoutTree = useTerminalStore((s) => s.layoutTree)
  const setLayoutTree = useTerminalStore((s) => s.setLayoutTree)

  // Determine which edges have a locked pane and should be disabled
  const disabledEdges = useMemo(() => {
    const disabled = { top: false, bottom: false, left: false, right: false }
    if (!layoutTree || lockedIds.size === 0) return disabled
    for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
      const panesOnEdge = getPanesOnEdge(layoutTree, edge)
      if (panesOnEdge.some(id => lockedIds.has(id))) {
        disabled[edge] = true
      }
    }
    return disabled
  }, [layoutTree, lockedIds])

  const handleMouseDown = useCallback((edge: 'top' | 'bottom' | 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault()
    if (!layoutTree) return

    // Strip existing empty-tile wrapping on this edge to get the base tree
    let baseTree: MosaicNode<string> = layoutTree
    if (typeof layoutTree !== 'string') {
      const dir: MosaicDirection = (edge === 'left' || edge === 'right') ? 'row' : 'column'
      if (layoutTree.direction === dir) {
        if ((edge === 'right' || edge === 'bottom') && typeof layoutTree.second === 'string' && isEmptyTile(layoutTree.second)) {
          baseTree = layoutTree.first
        } else if ((edge === 'left' || edge === 'top') && typeof layoutTree.first === 'string' && isEmptyTile(layoutTree.first)) {
          baseTree = layoutTree.second
        }
      }
    }

    const emptyId = createEmptyTileId()
    const direction: MosaicDirection = (edge === 'left' || edge === 'right') ? 'row' : 'column'
    let created = false

    // Check if there are locked panes — if so, we need to insert the empty tile
    // into an unlocked subtree rather than wrapping the entire root.
    const hasLocked = lockedIds.size > 0 && containsLockedPane(baseTree, lockedIds)

    // Insert empty tile into the tree, targeting only unlocked subtrees when locked panes exist.
    // `wrapSide` is 'first' to put empty before content, 'second' to put empty after.
    function insertEmptyIntoTree(
      tree: MosaicNode<string>,
      wrapSide: 'first' | 'second',
      pct: number,
    ): MosaicNode<string> {
      if (!hasLocked) {
        // No locked panes — simple root-level wrap
        return wrapSide === 'second'
          ? { direction, first: tree, second: emptyId, splitPercentage: pct }
          : { direction, first: emptyId, second: tree, splitPercentage: pct }
      }

      // If the tree is a single leaf, wrap it (it must be unlocked since the edge isn't disabled)
      if (typeof tree === 'string') {
        return wrapSide === 'second'
          ? { direction, first: tree, second: emptyId, splitPercentage: pct }
          : { direction, first: emptyId, second: tree, splitPercentage: pct }
      }

      // If this entire subtree has no locked panes, wrap it directly
      if (!containsLockedPane(tree, lockedIds)) {
        return wrapSide === 'second'
          ? { direction, first: tree, second: emptyId, splitPercentage: pct }
          : { direction, first: emptyId, second: tree, splitPercentage: pct }
      }

      // This subtree has locked panes — recurse into the unlocked branch.
      // For edge drags, the "opposite side" branch is the one farthest from the edge.
      // right edge → we want to insert into the rightmost unlocked branch (second for row)
      // left edge → leftmost unlocked branch (first for row)
      const firstLocked = containsLockedPane(tree.first, lockedIds)
      const secondLocked = containsLockedPane(tree.second, lockedIds)

      if (tree.direction === direction) {
        // Same axis as the edge drag
        if (wrapSide === 'second') {
          // Inserting on the second side (right/bottom edge)
          if (!secondLocked) {
            return { ...tree, second: insertEmptyIntoTree(tree.second, wrapSide, pct) }
          }
          if (!firstLocked) {
            return { ...tree, first: insertEmptyIntoTree(tree.first, wrapSide, pct) }
          }
        } else {
          // Inserting on the first side (left/top edge)
          if (!firstLocked) {
            return { ...tree, first: insertEmptyIntoTree(tree.first, wrapSide, pct) }
          }
          if (!secondLocked) {
            return { ...tree, second: insertEmptyIntoTree(tree.second, wrapSide, pct) }
          }
        }
      }

      // Cross-axis split or both branches have locked panes — try to find any unlocked branch
      if (!firstLocked) {
        return { ...tree, first: insertEmptyIntoTree(tree.first, wrapSide, pct) }
      }
      if (!secondLocked) {
        return { ...tree, second: insertEmptyIntoTree(tree.second, wrapSide, pct) }
      }

      // Both branches locked — shouldn't happen since edge would be disabled, but fallback
      return wrapSide === 'second'
        ? { direction, first: tree, second: emptyId, splitPercentage: pct }
        : { direction, first: emptyId, second: tree, splitPercentage: pct }
    }

    // Store the original base tree for snap-back
    const originalBase = baseTree
    // Capture baseTree in a const for the closure
    const capturedBase = baseTree

    const handleMouseMove = (ev: MouseEvent) => {
      const container = document.querySelector('.mosaic-layout') as HTMLElement
      if (!container) return
      const rect = container.getBoundingClientRect()

      if (edge === 'right') {
        let pct = ((ev.clientX - rect.left) / rect.width) * 100
        pct = Math.max(15, Math.min(95, pct))
        if (pct > 93) { if (created) { setLayoutTree(originalBase); created = false }; return }
        created = true
        setLayoutTree(insertEmptyIntoTree(capturedBase, 'second', pct))
      } else if (edge === 'left') {
        let pct = ((ev.clientX - rect.left) / rect.width) * 100
        pct = Math.max(5, Math.min(85, pct))
        if (pct < 7) { if (created) { setLayoutTree(originalBase); created = false }; return }
        created = true
        setLayoutTree(insertEmptyIntoTree(capturedBase, 'first', pct))
      } else if (edge === 'bottom') {
        let pct = ((ev.clientY - rect.top) / rect.height) * 100
        pct = Math.max(15, Math.min(95, pct))
        if (pct > 93) { if (created) { setLayoutTree(originalBase); created = false }; return }
        created = true
        setLayoutTree(insertEmptyIntoTree(capturedBase, 'second', pct))
      } else { // top
        let pct = ((ev.clientY - rect.top) / rect.height) * 100
        pct = Math.max(5, Math.min(85, pct))
        if (pct < 7) { if (created) { setLayoutTree(originalBase); created = false }; return }
        created = true
        setLayoutTree(insertEmptyIntoTree(capturedBase, 'first', pct))
      }
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [layoutTree, setLayoutTree, lockedIds])

  return (
    <>
      {!disabledEdges.right && <div
        className="absolute top-0 right-0 w-[5px] h-full cursor-col-resize z-10 opacity-0 hover:opacity-100 hover:bg-vibe-muted/10 transition-opacity"
        onMouseDown={(e) => handleMouseDown('right', e)}
      />}
      {!disabledEdges.bottom && <div
        className="absolute bottom-0 left-0 h-[5px] w-full cursor-row-resize z-10 opacity-0 hover:opacity-100 hover:bg-vibe-muted/10 transition-opacity"
        onMouseDown={(e) => handleMouseDown('bottom', e)}
      />}
      {!disabledEdges.left && <div
        className="absolute top-0 left-0 w-[5px] h-full cursor-col-resize z-10 opacity-0 hover:opacity-100 hover:bg-vibe-muted/10 transition-opacity"
        onMouseDown={(e) => handleMouseDown('left', e)}
      />}
      {!disabledEdges.top && <div
        className="absolute top-0 left-0 h-[5px] w-full cursor-row-resize z-10 opacity-0 hover:opacity-100 hover:bg-vibe-muted/10 transition-opacity"
        onMouseDown={(e) => handleMouseDown('top', e)}
      />}
    </>
  )
}

// Drag preview for layout pane drags
function LayoutPaneDragPreview({ tileId, position }: { tileId: string; position: { x: number; y: number } }) {
  const { hoveredDropZone } = useDragPreviewStore()
  const terminals = useTerminalStore((s) => s.terminals)
  const toolInstances = useToolStore((s) => s.toolInstances)
  const toolConfigs = useToolStore((s) => s.toolConfigs)

  const dropHint = hoveredDropZone
    ? `Insert ${hoveredDropZone.position === 'left' ? 'left of' : hoveredDropZone.position === 'right' ? 'right of' : hoveredDropZone.position === 'top' ? 'above' : 'below'} tile`
    : 'Drag to a drop zone'

  const isTool = isTileTool(tileId)

  if (isTool) {
    const toolInstance = toolInstances.get(tileId)
    const toolConfig = toolConfigs.get(toolInstance?.configId ?? '')
    if (!toolInstance) return null

    return (
      <div
        className="fixed pointer-events-none z-[9999]"
        style={{ left: position.x - 100, top: position.y - 40 }}
      >
        <div className={`w-[200px] h-[120px] bg-vibe-surface border-2 rounded-lg shadow-2xl overflow-hidden transition-all ${
          hoveredDropZone ? 'border-green-500 shadow-green-500/30' : 'border-teal-500 shadow-teal-500/30'
        }`}>
          <div className="flex items-center gap-2 px-2 py-1.5 bg-vibe-bg border-b border-vibe-border">
            <div className={`w-2 h-2 rounded-full ${toolInstance.status === 'active' ? 'bg-teal-500' : 'bg-gray-500'}`} />
            {toolConfig && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-white flex-shrink-0">
                {contributionLabel(toolConfig).toUpperCase()}
              </span>
            )}
            <span className="text-xs text-vibe-muted truncate flex-1">{toolInstance.title}</span>
          </div>
          <div className="flex-1 bg-vibe-bg p-2">
            <div className="text-xs text-vibe-muted opacity-50">Tool content...</div>
          </div>
        </div>
        <div className={`text-center mt-2 text-xs font-medium transition-colors ${
          hoveredDropZone ? 'text-green-500' : 'text-teal-500'
        }`}>
          {dropHint}
        </div>
      </div>
    )
  }

  // Terminal preview
  const terminal = terminals.get(tileId)
  if (!terminal) return null

  return (
    <div
      className="fixed pointer-events-none z-[9999]"
      style={{ left: position.x - 100, top: position.y - 40 }}
    >
      <div className={`w-[200px] h-[120px] bg-vibe-surface border-2 rounded-lg shadow-2xl overflow-hidden transition-all ${
        hoveredDropZone ? 'border-green-500 shadow-green-500/30' : 'border-vibe-primary shadow-vibe-primary/30'
      }`}>
        <div className="flex items-center gap-2 px-2 py-1.5 bg-vibe-bg border-b border-vibe-border">
          <div className={`w-2 h-2 rounded-full ${terminal.status === 'active' ? 'bg-green-500' : 'bg-gray-500'}`} />
          <ProviderBadge providerId={terminal.agent?.providerId} />
          <span className="text-xs text-vibe-muted truncate flex-1">{terminal.title}</span>
        </div>
        <div className="flex-1 bg-[rgb(var(--qf-term-bg))] p-2">
          <div className="text-xs text-vibe-muted font-mono opacity-50">Terminal content...</div>
        </div>
      </div>
      <div className={`text-center mt-2 text-xs font-medium transition-colors ${
        hoveredDropZone ? 'text-green-500' : 'text-vibe-primary'
      }`}>
        {dropHint}
      </div>
    </div>
  )
}
