// Drag preview store for managing drag state and preview layouts
import { create } from 'zustand'
import { MosaicNode, MosaicBranch } from 'react-mosaic-component'

// Drop positions relative to a tile
export type DropPosition = 'left' | 'right' | 'top' | 'bottom'

// Hovered drop zone info
export interface HoveredDropZone {
  path: MosaicBranch[]
  position: DropPosition
  targetTileId: string
}

interface DragPreviewState {
  // Current drag state
  isDragging: boolean
  draggedTileId: string | null

  // Trees
  originalTree: MosaicNode<string> | null
  previewTree: MosaicNode<string> | null

  // Hovered drop zone
  hoveredDropZone: HoveredDropZone | null

  // Source of drag (from layout or from minimized bar)
  dragSource: 'layout' | 'minimized' | null

  // Actions
  startDrag: (tileId: string, tree: MosaicNode<string> | null, source: 'layout' | 'minimized') => void
  setHoveredDropZone: (zone: HoveredDropZone | null) => void
  setPreviewTree: (tree: MosaicNode<string> | null) => void
  commitDrop: () => { tree: MosaicNode<string> | null; tileId: string | null }
  cancelDrag: () => void
  reset: () => void
}

const initialState = {
  isDragging: false,
  draggedTileId: null,
  originalTree: null,
  previewTree: null,
  hoveredDropZone: null,
  dragSource: null,
}

export const useDragPreviewStore = create<DragPreviewState>((set, get) => ({
  ...initialState,

  startDrag: (tileId: string, tree: MosaicNode<string> | null, source: 'layout' | 'minimized') => {
    set({
      isDragging: true,
      draggedTileId: tileId,
      originalTree: tree,
      previewTree: null,
      hoveredDropZone: null,
      dragSource: source,
    })
  },

  setHoveredDropZone: (zone: HoveredDropZone | null) => {
    set({ hoveredDropZone: zone })
  },

  setPreviewTree: (tree: MosaicNode<string> | null) => {
    set({ previewTree: tree })
  },

  commitDrop: () => {
    const state = get()
    const result = {
      tree: state.previewTree || state.originalTree,
      tileId: state.draggedTileId,
    }

    // Reset state after commit
    set(initialState)

    return result
  },

  cancelDrag: () => {
    set(initialState)
  },

  reset: () => {
    set(initialState)
  },
}))
