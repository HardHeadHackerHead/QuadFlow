import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import {
  MosaicWithoutDragDropContext,
  MosaicWindow,
  MosaicNode,
  MosaicBranch,
} from 'react-mosaic-component'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { useDragPreviewStore } from '../../stores/dragPreviewStore'
import { dedupeTreeLeaves } from '../../lib/layoutUtils'
import {
  PROJECT_MOSAIC_LEAF,
  isGlobalWsTile,
  isProjectMosaicLeaf,
  isTileTool,
  parseGlobalWsTileId,
} from '../../types'
import FlexibleTerminalLayout from '../layout/FlexibleTerminalLayout'
import GlobalWorkspaceTile from './GlobalWorkspaceTile'

/**
 * The outer mosaic that contains the project mosaic (rendered into a special
 * __project__ leaf) plus zero or more global workspace tiles. Same layout
 * across every project — workspaces stay in the same place when the user
 * switches projects.
 *
 * If the global workspace feature is disabled, falls through to render only
 * the project mosaic with no outer mosaic at all.
 */
export default function FrameMosaic() {
  const workspaces = useGlobalWorkspaceStore(s => s.workspaces)
  const frameTree = useGlobalWorkspaceStore(s => s.frameTree)
  const globallyEnabled = useGlobalWorkspaceStore(s => s.globallyEnabled)
  const setFrameTree = useGlobalWorkspaceStore(s => s.setFrameTree)

  // react-dnd needs its provider mounted with a real DOM element to scope to —
  // this matches the pattern used in FlexibleTerminalLayout.
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dndReady, setDndReady] = useState(false)
  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    setDndReady(!!node)
  }, [])

  const isDragging = useDragPreviewStore(s => s.isDragging)
  const dragSource = useDragPreviewStore(s => s.dragSource)

  // When a pane is dragged FROM a global workspace and released over the
  // project area, unpin it so it returns to the project mosaic.
  useEffect(() => {
    if (!isDragging || dragSource !== 'layout') return

    const onUpCapture = (e: MouseEvent) => {
      const draggedId = useDragPreviewStore.getState().draggedTileId
      if (!draggedId) return

      // Determine if the drag source is inside a global workspace by checking
      // store state — pinned terminals have scope='global', global tools live
      // in globalToolInstances.
      const gs = useGlobalWorkspaceStore.getState()
      const isFromGlobal =
        gs.globalToolInstances.has(draggedId) || gs.globalTerminalIds.has(draggedId)
      if (!isFromGlobal) return

      // Did the drop land on the project's mosaic-layout area?
      const projectEl = document.querySelector('.mosaic-layout') as HTMLElement | null
      if (!projectEl) return
      const rect = projectEl.getBoundingClientRect()
      const overProject =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom
      if (!overProject) return

      e.stopPropagation()

      if (isTileTool(draggedId)) {
        gs.unpinInstance(draggedId)
          .catch(err => console.error('[FrameMosaic] unpinInstance:', err))
      } else {
        gs.unpinTerminal(draggedId)
          .catch(err => console.error('[FrameMosaic] unpinTerminal:', err))
      }
      useDragPreviewStore.getState().cancelDrag()
    }
    window.addEventListener('mouseup', onUpCapture, true)
    return () => window.removeEventListener('mouseup', onUpCapture, true)
  }, [isDragging, dragSource])


  // Build the effective frame tree (strips disabled / minimized workspaces).
  // Memoized off the inputs for stable referential identity per render.
  const effectiveTree: MosaicNode<string> | null = useMemo(() => {
    if (!globallyEnabled) return PROJECT_MOSAIC_LEAF
    return useGlobalWorkspaceStore.getState().getEffectiveFrameTree()
    // Re-derive whenever any of these change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globallyEnabled, frameTree, workspaces])

  const handleChange = useCallback(
    (next: MosaicNode<string> | null) => {
      // Persist user-initiated frame edits. The store's setFrameTree
      // re-injects __project__ if the user accidentally deletes it.
      setFrameTree(next)
    },
    [setFrameTree],
  )

  const renderTile = useCallback(
    (id: string, path: MosaicBranch[]) => {
      if (isProjectMosaicLeaf(id)) {
        // The project mosaic is fixed in place and has no header. We still
        // wrap it in a MosaicWindow so that drag/drop targets (used when
        // global workspaces are dragged) work, but its toolbar is hidden via
        // the `[&>.mosaic-window-toolbar]:hidden` Tailwind arbitrary variant
        // and the tile is non-draggable.
        return (
          <MosaicWindow<string>
            path={path}
            title=""
            draggable={false}
            renderToolbar={() => <span />}
            className="frame-project-window [&>.mosaic-window-toolbar]:hidden"
          >
            <div className="h-full w-full">
              <FlexibleTerminalLayout />
            </div>
          </MosaicWindow>
        )
      }
      if (isGlobalWsTile(id)) {
        const wsId = parseGlobalWsTileId(id)
        if (!wsId) return <div className="h-full w-full bg-vibe-bg" />
        return <GlobalWorkspaceTile workspaceId={wsId} path={path} />
      }
      return <div className="h-full w-full bg-vibe-bg" />
    },
    [],
  )

  // Fast path: feature disabled OR no global workspaces visible — render only
  // the project layout, no outer mosaic at all.
  if (!globallyEnabled || effectiveTree === PROJECT_MOSAIC_LEAF) {
    return <FlexibleTerminalLayout />
  }

  return (
    <div ref={containerCallbackRef} className="h-full w-full">
      {dndReady && containerRef.current && (
        <DndProvider backend={HTML5Backend} options={{ rootElement: containerRef.current }}>
          <MosaicWithoutDragDropContext<string>
            renderTile={renderTile}
            value={dedupeTreeLeaves(effectiveTree)}
            onChange={handleChange}
            className="mosaic-theme-dark frame-mosaic"
            blueprintNamespace="bp5"
          />
        </DndProvider>
      )}
    </div>
  )
}
