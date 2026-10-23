// Layout tree manipulation utilities for react-mosaic

import { MosaicNode, MosaicDirection, MosaicBranch } from 'react-mosaic-component'
import { DropPosition, HoveredDropZone } from '../stores/dragPreviewStore'
import { EMPTY_PREFIX, isEmptyLeaf, newEmptyLeafId } from './layoutIds'

/**
 * Dedupe leaves in a mosaic tree so the same id never appears twice. Keeps
 * the FIRST occurrence (in-order walk) and removes subsequent ones, collapsing
 * empty parent splits. react-mosaic-component throws "Duplicate IDs" if this
 * invariant is violated, so render paths defensively pipe trees through this
 * helper before handing them to the mosaic.
 *
 * @param tree The tree to dedupe.
 * @param exclude Optional set of ids that should be REMOVED entirely (every
 *                occurrence). Useful for stripping ids that belong to a
 *                different mosaic instance from this one.
 */
export function dedupeTreeLeaves(
  tree: MosaicNode<string> | null,
  exclude?: Set<string>,
): MosaicNode<string> | null {
  if (tree === null) return null
  const seen = new Set<string>()
  const walk = (node: MosaicNode<string> | null): MosaicNode<string> | null => {
    if (node === null) return null
    if (typeof node === 'string') {
      if (exclude?.has(node)) return null
      if (seen.has(node)) return null
      seen.add(node)
      return node
    }
    const first = walk(node.first)
    const second = walk(node.second)
    if (first === null && second === null) return null
    if (first === null) return second
    if (second === null) return first
    return { ...node, first, second }
  }
  return walk(tree)
}

/** Collect every leaf id in a tree into a Set (used for cross-tree dedupe). */
export function collectAllLeafIds(tree: MosaicNode<string> | null, into?: Set<string>): Set<string> {
  const out = into ?? new Set<string>()
  const walk = (node: MosaicNode<string> | null) => {
    if (node === null) return
    if (typeof node === 'string') { out.add(node); return }
    walk(node.first)
    walk(node.second)
  }
  walk(tree)
  return out
}

// ── Empty Tile (placeholder) utilities ───────────────────────────────────

export const EMPTY_TILE_PREFIX = EMPTY_PREFIX

/** Check if a tile ID represents an empty placeholder (see lib/layoutIds.ts). */
export function isEmptyTile(id: string): boolean {
  return isEmptyLeaf(id)
}

/** Create a unique empty tile ID (`empty:<ulid>`). */
export function createEmptyTileId(): string {
  return newEmptyLeafId()
}

/** Find the first empty tile in a tree (prefers second/bottom-right branch) */
export function findEmptyTile(tree: MosaicNode<string> | null): string | null {
  if (tree === null) return null
  if (typeof tree === 'string') return isEmptyTile(tree) ? tree : null
  return findEmptyTile(tree.second) ?? findEmptyTile(tree.first)
}

/** Replace a specific empty tile with a new tile ID */
export function replaceEmptyTile(
  tree: MosaicNode<string> | null,
  emptyId: string,
  newId: string
): MosaicNode<string> | null {
  if (tree === null) return null
  if (typeof tree === 'string') return tree === emptyId ? newId : tree
  return {
    ...tree,
    first: replaceEmptyTile(tree.first, emptyId, newId)!,
    second: replaceEmptyTile(tree.second, emptyId, newId)!,
  }
}

/** Count empty tiles in a tree */
export function countEmptyTiles(tree: MosaicNode<string> | null): number {
  if (tree === null) return 0
  if (typeof tree === 'string') return isEmptyTile(tree) ? 1 : 0
  return countEmptyTiles(tree.first) + countEmptyTiles(tree.second)
}

/**
 * Collapse empty tiles that are not adjacent to (siblings of) locked panes.
 * Used when a pane is unlocked to let it expand into adjacent empty space.
 */
export function collapseUnneededEmptyTiles(
  tree: MosaicNode<string> | null,
  lockedIds: Set<string>
): MosaicNode<string> | null {
  if (tree === null) return null
  if (typeof tree === 'string') return tree

  const first = collapseUnneededEmptyTiles(tree.first, lockedIds)
  const second = collapseUnneededEmptyTiles(tree.second, lockedIds)

  if (first === null && second === null) return null
  if (first === null) return second
  if (second === null) return first

  // If first is an empty tile and second has no locked panes, collapse it
  if (typeof first === 'string' && isEmptyTile(first) && !containsLockedPane(second, lockedIds)) {
    return second
  }
  // If second is an empty tile and first has no locked panes, collapse it
  if (typeof second === 'string' && isEmptyTile(second) && !containsLockedPane(first, lockedIds)) {
    return first
  }

  return { ...tree, first, second }
}

/**
 * Layout preset types for cycling through different arrangements
 */
export type LayoutPresetType = 'grid' | 'columns' | 'rows' | 'mainSidebar' | 'mainBottom' | 'focus'

export interface GridConfig {
  rows: number
  cols: number
}

export interface LayoutPreset {
  type: LayoutPresetType
  name: string
  description: string
  icon: string // SVG path data
}

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    type: 'grid',
    name: 'Grid',
    description: 'Balanced grid layout',
    icon: 'M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z',
  },
  {
    type: 'columns',
    name: 'Columns',
    description: 'Side-by-side columns',
    icon: 'M4 4a1 1 0 011-1h3a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM10 4a1 1 0 011-1h3a1 1 0 011 1v16a1 1 0 01-1 1h-3a1 1 0 01-1-1V4zM16 4a1 1 0 011-1h3a1 1 0 011 1v16a1 1 0 01-1 1h-3a1 1 0 01-1-1V4z',
  },
  {
    type: 'rows',
    name: 'Rows',
    description: 'Stacked rows',
    icon: 'M4 4a1 1 0 011-1h14a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM4 10a1 1 0 011-1h14a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zM4 16a1 1 0 011-1h14a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3z',
  },
  {
    type: 'mainSidebar',
    name: 'Main + Sidebar',
    description: 'Large panel left, others stacked right',
    icon: 'M4 4a1 1 0 011-1h8a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM16 4a1 1 0 011-1h3a1 1 0 011 1v7a1 1 0 01-1 1h-3a1 1 0 01-1-1V4zM16 14a1 1 0 011-1h3a1 1 0 011 1v6a1 1 0 01-1 1h-3a1 1 0 01-1-1v-6z',
  },
  {
    type: 'mainBottom',
    name: 'Main + Bottom',
    description: 'Large panel top, others in row below',
    icon: 'M4 4a1 1 0 011-1h14a1 1 0 011 1v10a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM4 17a1 1 0 011-1h6a1 1 0 011 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-3zM14 17a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1v-3z',
  },
  {
    type: 'focus',
    name: 'Focus',
    description: 'One panel maximized, rest minimized',
    icon: 'M4 4a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V4zM7 20h2v1H7v-1zM11 20h2v1h-2v-1zM15 20h2v1h-2v-1z',
  },
]

/**
 * Get all terminal IDs from a mosaic tree
 */
export function getTerminalIdsFromTree(node: MosaicNode<string> | null): string[] {
  if (node === null) return []
  if (typeof node === 'string') return [node]

  return [
    ...getTerminalIdsFromTree(node.first),
    ...getTerminalIdsFromTree(node.second),
  ]
}

/**
 * Insert a new terminal into the tree by splitting the rightmost leaf
 */
export function insertTerminalIntoTree(
  tree: MosaicNode<string> | null,
  terminalId: string,
  direction: MosaicDirection = 'row'
): MosaicNode<string> {
  // If tree is empty, just return the terminal ID
  if (tree === null) {
    return terminalId
  }

  // If tree is a single terminal, split it
  if (typeof tree === 'string') {
    return {
      direction,
      first: tree,
      second: terminalId,
      splitPercentage: 50,
    }
  }

  // Otherwise, insert into the second (right/bottom) branch
  return {
    ...tree,
    second: insertTerminalIntoTree(tree.second, terminalId, direction === 'row' ? 'column' : 'row'),
  }
}

/**
 * Insert a new terminal by splitting a specific target terminal
 * If target is not found, falls back to inserting at rightmost leaf
 */
export function insertTerminalAtTarget(
  tree: MosaicNode<string> | null,
  terminalId: string,
  targetId: string | null,
  direction: MosaicDirection = 'row'
): MosaicNode<string> {
  // If tree is empty, just return the terminal ID
  if (tree === null) {
    return terminalId
  }

  // If no target specified, use default insertion
  if (targetId === null) {
    return insertTerminalIntoTree(tree, terminalId, direction)
  }

  // If tree is a single terminal
  if (typeof tree === 'string') {
    // If this is the target, split it
    if (tree === targetId) {
      return {
        direction,
        first: tree,
        second: terminalId,
        splitPercentage: 50,
      }
    }
    // Not the target, and no more tree to search - fall back to splitting this one
    return {
      direction,
      first: tree,
      second: terminalId,
      splitPercentage: 50,
    }
  }

  // Check if target is in first branch
  if (terminalExistsInTree(tree.first, targetId)) {
    return {
      ...tree,
      first: insertTerminalAtTarget(tree.first, terminalId, targetId, direction),
    }
  }

  // Check if target is in second branch
  if (terminalExistsInTree(tree.second, targetId)) {
    return {
      ...tree,
      second: insertTerminalAtTarget(tree.second, terminalId, targetId, direction),
    }
  }

  // Target not found in tree - fall back to default insertion
  return insertTerminalIntoTree(tree, terminalId, direction)
}

/**
 * Insert a terminal into the tree, preferring to fill an empty placeholder tile.
 * If an empty tile exists, replaces it with the new terminal.
 * If the target (active) pane is locked, finds an unlocked pane to split instead.
 * Otherwise, falls back to splitting the target.
 */
export function insertTerminalFillEmpty(
  tree: MosaicNode<string> | null,
  terminalId: string,
  targetId: string | null,
  direction: MosaicDirection = 'row',
  lockedIds?: Set<string>
): MosaicNode<string> {
  if (tree === null) return terminalId

  // 1. Try to fill an empty tile first
  const emptyTileId = findEmptyTile(tree)
  if (emptyTileId) {
    return replaceEmptyTile(tree, emptyTileId, terminalId)!
  }

  // 2. If target pane is locked, find an unlocked pane to split instead
  if (lockedIds && targetId && lockedIds.has(targetId)) {
    const allIds = getTerminalIdsFromTree(tree)
    const unlockedTarget = allIds.find(id => !lockedIds.has(id) && !isEmptyTile(id))
    if (unlockedTarget) {
      return insertTerminalAtTarget(tree, terminalId, unlockedTarget, direction)
    }
    // All panes are locked - split the active pane as last resort
  }

  // 3. Default: split the target
  return insertTerminalAtTarget(tree, terminalId, targetId, direction)
}

/**
 * Remove a terminal from the tree
 */
export function removeTerminalFromTree(
  tree: MosaicNode<string> | null,
  terminalId: string
): MosaicNode<string> | null {
  if (tree === null) return null

  // If this is the terminal to remove, return null
  if (typeof tree === 'string') {
    return tree === terminalId ? null : tree
  }

  // Check if the terminal is in either branch
  const firstResult = removeTerminalFromTree(tree.first, terminalId)
  const secondResult = removeTerminalFromTree(tree.second, terminalId)

  // If first branch was removed entirely, return second
  if (firstResult === null) return secondResult
  // If second branch was removed entirely, return first
  if (secondResult === null) return firstResult

  // Both branches still exist, return updated tree
  return {
    ...tree,
    first: firstResult,
    second: secondResult,
  }
}

/**
 * Check if a terminal exists in the tree
 */
export function terminalExistsInTree(
  tree: MosaicNode<string> | null,
  terminalId: string
): boolean {
  if (tree === null) return false
  if (typeof tree === 'string') return tree === terminalId

  return (
    terminalExistsInTree(tree.first, terminalId) ||
    terminalExistsInTree(tree.second, terminalId)
  )
}

/**
 * Count the number of terminals in the tree
 */
export function countTerminalsInTree(tree: MosaicNode<string> | null): number {
  if (tree === null) return 0
  if (typeof tree === 'string') return isEmptyTile(tree) ? 0 : 1

  return countTerminalsInTree(tree.first) + countTerminalsInTree(tree.second)
}

/**
 * Create a default layout tree from terminal IDs
 * This creates a balanced layout similar to the old grid system
 */
export function createDefaultLayoutTree(terminalIds: string[]): MosaicNode<string> | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return terminalIds[0]

  // For 2 terminals: side by side
  if (terminalIds.length === 2) {
    return {
      direction: 'row',
      first: terminalIds[0],
      second: terminalIds[1],
      splitPercentage: 50,
    }
  }

  // For 3 terminals: one tall on left, two stacked on right
  if (terminalIds.length === 3) {
    return {
      direction: 'row',
      first: terminalIds[0],
      second: {
        direction: 'column',
        first: terminalIds[1],
        second: terminalIds[2],
        splitPercentage: 50,
      },
      splitPercentage: 50,
    }
  }

  // For 4+ terminals: 2x2 grid pattern
  if (terminalIds.length === 4) {
    return {
      direction: 'row',
      first: {
        direction: 'column',
        first: terminalIds[0],
        second: terminalIds[2],
        splitPercentage: 50,
      },
      second: {
        direction: 'column',
        first: terminalIds[1],
        second: terminalIds[3],
        splitPercentage: 50,
      },
      splitPercentage: 50,
    }
  }

  // For 5+ terminals: create a recursive balanced layout
  const mid = Math.ceil(terminalIds.length / 2)
  const leftIds = terminalIds.slice(0, mid)
  const rightIds = terminalIds.slice(mid)

  return {
    direction: 'row',
    first: createDefaultLayoutTree(leftIds)!,
    second: createDefaultLayoutTree(rightIds)!,
    splitPercentage: 50,
  }
}

/**
 * Build a balanced binary tree from an array of items along one direction.
 * Used internally by createGridLayout to build rows/columns.
 */
function buildBalancedTree(
  items: MosaicNode<string>[],
  direction: MosaicDirection
): MosaicNode<string> | null {
  if (items.length === 0) return null
  if (items.length === 1) return items[0]
  if (items.length === 2) {
    return {
      direction,
      first: items[0],
      second: items[1],
      splitPercentage: 50,
    }
  }
  // Split in half for balanced tree
  const mid = Math.ceil(items.length / 2)
  const left = buildBalancedTree(items.slice(0, mid), direction)!
  const right = buildBalancedTree(items.slice(mid), direction)!
  return {
    direction,
    first: left,
    second: right,
    splitPercentage: (mid / items.length) * 100,
  }
}

/**
 * Auto-detect the best grid dimensions for a given number of panes.
 * Tries to pick the most square-like grid that fits all panes with minimal waste.
 *
 * Examples:
 *   1 → 1×1    2 → 1×2    3 → 1×3    4 → 2×2
 *   5 → 2×3    6 → 2×3    7 → 2×4    8 → 2×4
 *   9 → 3×3   10 → 3×4   12 → 3×4   16 → 4×4
 */
export function autoDetectGridDimensions(count: number): { rows: number; cols: number } {
  if (count <= 0) return { rows: 0, cols: 0 }
  if (count === 1) return { rows: 1, cols: 1 }
  if (count === 2) return { rows: 1, cols: 2 }
  if (count === 3) return { rows: 1, cols: 3 }

  // Find the smallest rows × cols where rows <= cols and rows * cols >= count
  const sqrt = Math.sqrt(count)
  const rows = Math.floor(sqrt)
  const cols = Math.ceil(count / rows)

  // If rows * cols still doesn't fit, bump rows
  if (rows * cols < count) {
    return { rows: rows + 1, cols }
  }

  return { rows, cols }
}

/**
 * Create a grid layout with a specific number of rows and columns.
 * Panes fill row by row. If there are fewer panes than cells, empty tiles fill the rest
 * (unless skipPadding is true, in which case the last row simply has fewer items).
 * If there are more panes than cells, excess panes are returned as minimized.
 */
export function createConfigurableGridLayout(
  terminalIds: string[],
  rows: number,
  cols: number,
  skipPadding?: boolean
): { layoutTree: MosaicNode<string> | null; minimizedIds: string[] } {
  if (terminalIds.length === 0) return { layoutTree: null, minimizedIds: [] }
  if (rows <= 0 || cols <= 0) return { layoutTree: null, minimizedIds: [] }

  const capacity = rows * cols
  const visibleIds = terminalIds.slice(0, capacity)
  const minimizedIds = terminalIds.slice(capacity)

  if (skipPadding) {
    // No empty tile padding — last row gets fewer items if needed
    // Special case: single row - just build columns
    if (rows === 1) {
      return { layoutTree: buildBalancedTree(visibleIds, 'row'), minimizedIds }
    }

    // Special case: single column - just build rows
    if (cols === 1) {
      return { layoutTree: buildBalancedTree(visibleIds, 'column'), minimizedIds }
    }

    // Build each row as a horizontal balanced tree, then stack rows vertically
    const rowNodes: MosaicNode<string>[] = []
    for (let r = 0; r < rows; r++) {
      const rowItems = visibleIds.slice(r * cols, (r + 1) * cols)
      if (rowItems.length === 0) break // no more items, skip empty rows
      const rowTree = buildBalancedTree(rowItems, 'row')
      if (rowTree) rowNodes.push(rowTree)
    }

    return { layoutTree: buildBalancedTree(rowNodes, 'column'), minimizedIds }
  }

  // Pad with empty tiles if we have fewer panes than cells
  const paddedIds: string[] = [...visibleIds]
  while (paddedIds.length < capacity) {
    paddedIds.push(createEmptyTileId())
  }

  // Special case: single row - just build columns
  if (rows === 1) {
    return { layoutTree: buildBalancedTree(paddedIds, 'row'), minimizedIds }
  }

  // Special case: single column - just build rows
  if (cols === 1) {
    return { layoutTree: buildBalancedTree(paddedIds, 'column'), minimizedIds }
  }

  // Build each row as a horizontal balanced tree, then stack rows vertically
  const rowNodes: MosaicNode<string>[] = []
  for (let r = 0; r < rows; r++) {
    const rowItems = paddedIds.slice(r * cols, (r + 1) * cols)
    const rowTree = buildBalancedTree(rowItems, 'row')
    if (rowTree) rowNodes.push(rowTree)
  }

  return { layoutTree: buildBalancedTree(rowNodes, 'column'), minimizedIds }
}

/**
 * Create a columns layout (all panels side-by-side horizontally)
 */
export function createColumnsLayout(terminalIds: string[]): MosaicNode<string> | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return terminalIds[0]
  if (terminalIds.length === 2) {
    return {
      direction: 'row',
      first: terminalIds[0],
      second: terminalIds[1],
      splitPercentage: 50,
    }
  }

  // Build a balanced horizontal tree
  const buildHorizontal = (ids: string[]): MosaicNode<string> => {
    if (ids.length === 1) return ids[0]
    if (ids.length === 2) {
      return {
        direction: 'row',
        first: ids[0],
        second: ids[1],
        splitPercentage: 50,
      }
    }
    const mid = Math.ceil(ids.length / 2)
    return {
      direction: 'row',
      first: buildHorizontal(ids.slice(0, mid)),
      second: buildHorizontal(ids.slice(mid)),
      splitPercentage: (mid / ids.length) * 100,
    }
  }
  return buildHorizontal(terminalIds)
}

/**
 * Create a rows layout (all panels stacked vertically)
 */
export function createRowsLayout(terminalIds: string[]): MosaicNode<string> | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return terminalIds[0]
  if (terminalIds.length === 2) {
    return {
      direction: 'column',
      first: terminalIds[0],
      second: terminalIds[1],
      splitPercentage: 50,
    }
  }

  // Build a balanced vertical tree
  const buildVertical = (ids: string[]): MosaicNode<string> => {
    if (ids.length === 1) return ids[0]
    if (ids.length === 2) {
      return {
        direction: 'column',
        first: ids[0],
        second: ids[1],
        splitPercentage: 50,
      }
    }
    const mid = Math.ceil(ids.length / 2)
    return {
      direction: 'column',
      first: buildVertical(ids.slice(0, mid)),
      second: buildVertical(ids.slice(mid)),
      splitPercentage: (mid / ids.length) * 100,
    }
  }
  return buildVertical(terminalIds)
}

/**
 * Create a main + sidebar layout (large panel left, others stacked right)
 * Uses activeId as the main panel if provided and present in the list
 */
export function createMainSidebarLayout(terminalIds: string[], activeId?: string | null): MosaicNode<string> | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return terminalIds[0]

  // Determine which terminal should be main (active one, or first)
  const mainId = activeId && terminalIds.includes(activeId) ? activeId : terminalIds[0]
  const sidebarIds = terminalIds.filter(id => id !== mainId)

  if (sidebarIds.length === 0) return mainId
  if (sidebarIds.length === 1) {
    return {
      direction: 'row',
      first: mainId,
      second: sidebarIds[0],
      splitPercentage: 70,
    }
  }

  // Main terminal on left, rest stacked in sidebar on right
  const sidebar = createRowsLayout(sidebarIds)!

  return {
    direction: 'row',
    first: mainId,
    second: sidebar,
    splitPercentage: 65,
  }
}

/**
 * Create a main + bottom layout (large panel top, others in row below)
 * Uses activeId as the main panel if provided and present in the list
 */
export function createMainBottomLayout(terminalIds: string[], activeId?: string | null): MosaicNode<string> | null {
  if (terminalIds.length === 0) return null
  if (terminalIds.length === 1) return terminalIds[0]

  // Determine which terminal should be main (active one, or first)
  const mainId = activeId && terminalIds.includes(activeId) ? activeId : terminalIds[0]
  const bottomIds = terminalIds.filter(id => id !== mainId)

  if (bottomIds.length === 0) return mainId
  if (bottomIds.length === 1) {
    return {
      direction: 'column',
      first: mainId,
      second: bottomIds[0],
      splitPercentage: 70,
    }
  }

  // Main terminal on top, rest in row at bottom
  const bottom = createColumnsLayout(bottomIds)!

  return {
    direction: 'column',
    first: mainId,
    second: bottom,
    splitPercentage: 65,
  }
}

/**
 * Swap a terminal with the main (first) pane in a main+bottom or main+sidebar layout.
 * The root node's `first` is the "main" pane. This finds `targetId` anywhere in the
 * tree and swaps it with whatever is currently in `first`.
 */
export function swapWithMain(tree: MosaicNode<string> | null, targetId: string): MosaicNode<string> | null {
  if (tree === null || typeof tree === 'string') return tree

  // Get the current main pane ID (the leaf at root.first)
  const mainId = getMainPaneId(tree.first)
  if (!mainId || mainId === targetId) return tree // already main or can't find it

  // Swap: replace targetId with mainId throughout the tree, then set first to targetId
  const swapped: MosaicNode<string> = {
    ...tree,
    first: replaceId(tree.first, targetId, mainId),
    second: replaceId(tree.second, targetId, mainId),
  }

  // Now set the root's first to targetId
  // If first was just the mainId string, replace it directly
  if (typeof swapped.first === 'string' && swapped.first === mainId) {
    return { ...swapped, first: targetId }
  }
  // If first is a branch (shouldn't happen for main+bottom/sidebar, but handle it)
  return { ...swapped, first: replaceId(swapped.first, mainId, targetId) }
}

/** Get the leftmost/topmost leaf ID from a tree node */
function getMainPaneId(node: MosaicNode<string>): string | null {
  if (typeof node === 'string') return node
  return getMainPaneId(node.first)
}

/** Replace all occurrences of oldId with newId in a tree */
function replaceId(node: MosaicNode<string>, oldId: string, newId: string): MosaicNode<string> {
  if (typeof node === 'string') return node === oldId ? newId : node
  return {
    ...node,
    first: replaceId(node.first, oldId, newId),
    second: replaceId(node.second, oldId, newId),
  }
}

/**
 * Create a focus layout result - returns the main terminal and list of terminals to minimize
 */
export interface FocusLayoutResult {
  layoutTree: MosaicNode<string> | null
  minimizedIds: string[]
}

export function createFocusLayout(terminalIds: string[], activeId?: string | null): FocusLayoutResult {
  if (terminalIds.length === 0) {
    return { layoutTree: null, minimizedIds: [] }
  }

  // Use active terminal as the focused one, or fall back to first
  const focusedId = activeId && terminalIds.includes(activeId) ? activeId : terminalIds[0]
  const minimizedIds = terminalIds.filter(id => id !== focusedId)

  return {
    layoutTree: focusedId,
    minimizedIds,
  }
}

/**
 * Create a layout tree based on the specified preset type
 */
export function createLayoutByPreset(
  presetType: LayoutPresetType,
  terminalIds: string[],
  activeId?: string | null,
  gridConfig?: GridConfig
): { layoutTree: MosaicNode<string> | null; minimizedIds: string[] } {
  switch (presetType) {
    case 'grid':
      if (gridConfig && (gridConfig.rows > 0 && gridConfig.cols > 0)) {
        return createConfigurableGridLayout(terminalIds, gridConfig.rows, gridConfig.cols)
      }
      // Auto mode: detect optimal grid dimensions based on pane count
      // Skip empty tile padding — just arrange the actual panes tightly
      {
        const auto = autoDetectGridDimensions(terminalIds.length)
        if (auto.rows > 0 && auto.cols > 0) {
          return createConfigurableGridLayout(terminalIds, auto.rows, auto.cols, true)
        }
      }
      return { layoutTree: createDefaultLayoutTree(terminalIds), minimizedIds: [] }
    case 'columns':
      return { layoutTree: createColumnsLayout(terminalIds), minimizedIds: [] }
    case 'rows':
      return { layoutTree: createRowsLayout(terminalIds), minimizedIds: [] }
    case 'mainSidebar':
      return { layoutTree: createMainSidebarLayout(terminalIds, activeId), minimizedIds: [] }
    case 'mainBottom':
      return { layoutTree: createMainBottomLayout(terminalIds, activeId), minimizedIds: [] }
    case 'focus':
      return createFocusLayout(terminalIds, activeId)
    default:
      return { layoutTree: createDefaultLayoutTree(terminalIds), minimizedIds: [] }
  }
}

/**
 * Serialize a layout tree to JSON string for persistence
 */
export function serializeLayoutTree(tree: MosaicNode<string> | null): string | null {
  if (tree === null) return null
  return JSON.stringify(tree)
}

/**
 * Deserialize a layout tree from JSON string
 */
export function deserializeLayoutTree(json: string | null): MosaicNode<string> | null {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    console.error('Failed to parse layout tree JSON')
    return null
  }
}

/**
 * Migrate from old gridPosition-based layout to mosaic tree
 * Takes terminal IDs sorted by gridPosition and creates a balanced tree
 */
export function migrateFromGridPositions(terminalIds: string[]): MosaicNode<string> | null {
  return createDefaultLayoutTree(terminalIds)
}

/**
 * Deep clone a mosaic tree
 */
export function cloneTree(node: MosaicNode<string> | null): MosaicNode<string> | null {
  if (node === null) return null
  if (typeof node === 'string') return node

  return {
    direction: node.direction,
    first: cloneTree(node.first)!,
    second: cloneTree(node.second)!,
    splitPercentage: node.splitPercentage,
  }
}

/**
 * Get a node at a specific path in the tree
 */
export function getNodeAtPath(
  tree: MosaicNode<string> | null,
  path: MosaicBranch[]
): MosaicNode<string> | null {
  if (tree === null || path.length === 0) return tree
  if (typeof tree === 'string') return null

  const [first, ...rest] = path
  const child = first === 'first' ? tree.first : tree.second
  return getNodeAtPath(child, rest)
}

/**
 * Get the tile ID at a specific path
 */
export function getTileIdAtPath(
  tree: MosaicNode<string> | null,
  path: MosaicBranch[]
): string | null {
  const node = getNodeAtPath(tree, path)
  if (typeof node === 'string') return node
  return null
}

/**
 * Find the path to a specific tile ID in the tree
 */
export function findPathToTile(
  tree: MosaicNode<string> | null,
  tileId: string,
  currentPath: MosaicBranch[] = []
): MosaicBranch[] | null {
  if (tree === null) return null
  if (typeof tree === 'string') {
    return tree === tileId ? currentPath : null
  }

  const firstPath = findPathToTile(tree.first, tileId, [...currentPath, 'first'])
  if (firstPath) return firstPath

  const secondPath = findPathToTile(tree.second, tileId, [...currentPath, 'second'])
  if (secondPath) return secondPath

  return null
}

/**
 * Insert a tile at a specific position relative to a target tile
 * @param tree - The original tree
 * @param tileId - The tile to insert
 * @param targetPath - Path to the target tile
 * @param position - Where to insert relative to target (left/right/top/bottom)
 * @returns New tree with tile inserted
 */
export function insertAtPosition(
  tree: MosaicNode<string> | null,
  tileId: string,
  targetPath: MosaicBranch[],
  position: DropPosition
): MosaicNode<string> | null {
  if (tree === null) return tileId

  // Get the direction based on position
  const direction: MosaicDirection = position === 'left' || position === 'right' ? 'row' : 'column'
  const isFirst = position === 'left' || position === 'top'

  // Helper to insert at a specific path
  function insertHelper(
    node: MosaicNode<string>,
    path: MosaicBranch[]
  ): MosaicNode<string> {
    // At the target path, create a new split
    if (path.length === 0) {
      return {
        direction,
        first: isFirst ? tileId : node,
        second: isFirst ? node : tileId,
        splitPercentage: 50,
      }
    }

    // Not at target yet, recurse
    if (typeof node === 'string') {
      // We should have reached the target, but path continues - this is an error
      return node
    }

    const [first, ...rest] = path
    if (first === 'first') {
      return {
        ...node,
        first: insertHelper(node.first, rest),
      }
    } else {
      return {
        ...node,
        second: insertHelper(node.second, rest),
      }
    }
  }

  return insertHelper(tree, targetPath)
}

/**
 * Compute a preview tree by moving a tile to a new position
 * @param originalTree - The original tree before any changes
 * @param draggedTileId - The tile being dragged
 * @param dropZone - Where to drop the tile
 * @param isFromMinimized - Whether the tile is coming from the minimized bar
 * @returns Preview tree showing the result of the drop
 */
export function computePreviewTree(
  originalTree: MosaicNode<string> | null,
  draggedTileId: string,
  dropZone: HoveredDropZone,
  isFromMinimized: boolean = false
): MosaicNode<string> | null {
  // If dropping on itself, return original
  if (dropZone.targetTileId === draggedTileId) {
    return originalTree
  }

  let workingTree = cloneTree(originalTree)

  // If dragging from layout (not minimized), remove tile from current position first
  if (!isFromMinimized && workingTree) {
    workingTree = removeTerminalFromTree(workingTree, draggedTileId)
  }

  // If tree is now null (removed the only tile), just return the dragged tile
  if (workingTree === null) {
    return draggedTileId
  }

  // If dropping onto an empty tile, replace it instead of splitting
  if (isEmptyTile(dropZone.targetTileId)) {
    return replaceEmptyTile(workingTree, dropZone.targetTileId, draggedTileId)
  }

  // Find the path to the target tile in the working tree
  const targetPath = findPathToTile(workingTree, dropZone.targetTileId)
  if (!targetPath) {
    // Target tile not found in tree - this can happen if we removed it
    // Just insert at root level
    return insertTerminalIntoTree(workingTree, draggedTileId)
  }

  // Insert at the target position
  return insertAtPosition(workingTree, draggedTileId, targetPath, dropZone.position)
}

/**
 * Calculate which drop zone a point is in relative to a tile's bounds
 * @param x - Mouse X position
 * @param y - Mouse Y position
 * @param bounds - The tile's bounding rectangle
 * @returns The drop position or null if not in a drop zone
 */
export function calculateDropZone(
  x: number,
  y: number,
  bounds: DOMRect
): DropPosition | null {
  // Calculate relative position (0-1) within the bounds
  const relX = (x - bounds.left) / bounds.width
  const relY = (y - bounds.top) / bounds.height

  // Define edge threshold - larger = more forgiving zones
  const edgeThreshold = 0.30
  // Define center dead zone - area where no drop zone is active
  const centerStart = 0.35
  const centerEnd = 0.65

  // Check if in center dead zone (both X and Y)
  if (relX > centerStart && relX < centerEnd && relY > centerStart && relY < centerEnd) {
    return null
  }

  // Determine which edge is closest
  const distLeft = relX
  const distRight = 1 - relX
  const distTop = relY
  const distBottom = 1 - relY

  const minDist = Math.min(distLeft, distRight, distTop, distBottom)

  // Only activate if within the edge threshold
  if (minDist > edgeThreshold) {
    return null
  }

  // Return the closest edge
  if (minDist === distLeft) return 'left'
  if (minDist === distRight) return 'right'
  if (minDist === distTop) return 'top'
  return 'bottom'
}

/**
 * Get all pane IDs from a subtree
 */
function getAllIdsFromSubtree(tree: MosaicNode<string> | null): string[] {
  if (tree === null) return []
  if (typeof tree === 'string') return [tree]
  return [
    ...getAllIdsFromSubtree(tree.first),
    ...getAllIdsFromSubtree(tree.second),
  ]
}

/**
 * Check if a subtree contains any locked panes
 */
export function containsLockedPane(
  tree: MosaicNode<string> | null,
  lockedIds: Set<string>
): boolean {
  if (tree === null) return false
  if (typeof tree === 'string') return lockedIds.has(tree)
  return containsLockedPane(tree.first, lockedIds) || containsLockedPane(tree.second, lockedIds)
}

/**
 * Check if a subtree contains any unlocked panes
 */
function containsUnlockedPane(
  tree: MosaicNode<string> | null,
  lockedIds: Set<string>
): boolean {
  if (tree === null) return false
  if (typeof tree === 'string') return !lockedIds.has(tree)
  return containsUnlockedPane(tree.first, lockedIds) || containsUnlockedPane(tree.second, lockedIds)
}

/**
 * Replace unlocked-only subtrees with a new layout, preserving locked subtrees exactly
 *
 * The strategy:
 * - If a subtree contains ONLY locked panes, keep it exactly as-is
 * - If a subtree contains ONLY unlocked panes, replace it with the preset layout for those panes
 * - If a subtree is mixed, recurse and handle each side separately
 */
function transformTreePreservingLocked(
  tree: MosaicNode<string> | null,
  lockedIds: Set<string>,
  presetType: LayoutPresetType,
  activeId?: string | null,
  gridConfig?: GridConfig
): { tree: MosaicNode<string> | null; minimizedIds: string[] } {
  if (tree === null) return { tree: null, minimizedIds: [] }

  // Leaf node
  if (typeof tree === 'string') {
    // Drop empty tiles so they don't survive into the new layout
    if (isEmptyTile(tree)) return { tree: null, minimizedIds: [] }
    // Keep locked panes, keep unlocked panes as-is (single pane can't be rearranged)
    return { tree, minimizedIds: [] }
  }

  // Branch node - check what each side contains
  const firstHasLocked = containsLockedPane(tree.first, lockedIds)
  const firstHasUnlocked = containsUnlockedPane(tree.first, lockedIds)
  const secondHasLocked = containsLockedPane(tree.second, lockedIds)
  const secondHasUnlocked = containsUnlockedPane(tree.second, lockedIds)

  // Case 1: First is fully unlocked, second has locked panes
  if (firstHasUnlocked && !firstHasLocked && secondHasLocked) {
    const unlockedIds = getAllIdsFromSubtree(tree.first).filter(id => !isEmptyTile(id))
    const { layoutTree: newFirst, minimizedIds: mins1 } = createLayoutByPreset(presetType, unlockedIds, activeId, gridConfig)
    const { tree: newSecond, minimizedIds: mins2 } = transformTreePreservingLocked(tree.second, lockedIds, presetType, activeId, gridConfig)

    if (newFirst === null) {
      return { tree: newSecond, minimizedIds: [...mins1, ...mins2] }
    }
    if (newSecond === null) {
      return { tree: newFirst, minimizedIds: [...mins1, ...mins2] }
    }

    return {
      tree: {
        direction: tree.direction,
        first: newFirst,
        second: newSecond,
        splitPercentage: tree.splitPercentage,
      },
      minimizedIds: [...mins1, ...mins2],
    }
  }

  // Case 2: Second is fully unlocked, first has locked panes
  if (secondHasUnlocked && !secondHasLocked && firstHasLocked) {
    const { tree: newFirst, minimizedIds: mins1 } = transformTreePreservingLocked(tree.first, lockedIds, presetType, activeId, gridConfig)
    const unlockedIds = getAllIdsFromSubtree(tree.second).filter(id => !isEmptyTile(id))
    const { layoutTree: newSecond, minimizedIds: mins2 } = createLayoutByPreset(presetType, unlockedIds, activeId, gridConfig)

    if (newFirst === null) {
      return { tree: newSecond, minimizedIds: [...mins1, ...mins2] }
    }
    if (newSecond === null) {
      return { tree: newFirst, minimizedIds: [...mins1, ...mins2] }
    }

    return {
      tree: {
        direction: tree.direction,
        first: newFirst,
        second: newSecond,
        splitPercentage: tree.splitPercentage,
      },
      minimizedIds: [...mins1, ...mins2],
    }
  }

  // Case 3: Both sides have locked panes (or one side is mixed)
  // Recurse into both sides
  if ((firstHasLocked && secondHasLocked) || (firstHasLocked && firstHasUnlocked) || (secondHasLocked && secondHasUnlocked)) {
    const { tree: newFirst, minimizedIds: mins1 } = transformTreePreservingLocked(tree.first, lockedIds, presetType, activeId, gridConfig)
    const { tree: newSecond, minimizedIds: mins2 } = transformTreePreservingLocked(tree.second, lockedIds, presetType, activeId, gridConfig)

    if (newFirst === null && newSecond === null) {
      return { tree: null, minimizedIds: [...mins1, ...mins2] }
    }
    if (newFirst === null) {
      return { tree: newSecond, minimizedIds: [...mins1, ...mins2] }
    }
    if (newSecond === null) {
      return { tree: newFirst, minimizedIds: [...mins1, ...mins2] }
    }

    return {
      tree: {
        direction: tree.direction,
        first: newFirst,
        second: newSecond,
        splitPercentage: tree.splitPercentage,
      },
      minimizedIds: [...mins1, ...mins2],
    }
  }

  // Case 4: Neither side has locked panes - replace entire subtree with preset
  const allUnlockedIds = getAllIdsFromSubtree(tree).filter(id => !isEmptyTile(id))
  const { layoutTree, minimizedIds } = createLayoutByPreset(presetType, allUnlockedIds, activeId, gridConfig)
  return { tree: layoutTree, minimizedIds }
}

/**
 * Create a layout that preserves locked panes in their original positions
 * while rearranging unlocked panes according to the specified preset
 */
export function createLayoutPreservingLocked(
  originalTree: MosaicNode<string> | null,
  presetType: LayoutPresetType,
  allIds: string[],
  lockedIds: Set<string>,
  activeId?: string | null,
  gridConfig?: GridConfig
): { layoutTree: MosaicNode<string> | null; minimizedIds: string[] } {
  // If no locked panes, just use the normal preset creation
  if (lockedIds.size === 0) {
    return createLayoutByPreset(presetType, allIds, activeId, gridConfig)
  }

  // Separate locked and unlocked IDs
  const unlockedIds = allIds.filter(id => !lockedIds.has(id))

  // If all panes are locked, don't change the layout at all
  if (unlockedIds.length === 0) {
    return { layoutTree: originalTree, minimizedIds: [] }
  }

  // If tree is null, create fresh layout
  if (originalTree === null) {
    return createLayoutByPreset(presetType, allIds, activeId, gridConfig)
  }

  // If single pane, nothing to rearrange
  if (typeof originalTree === 'string') {
    return { layoutTree: originalTree, minimizedIds: [] }
  }

  // Transform the tree, preserving locked pane subtrees and replacing unlocked subtrees
  const { tree: newTree, minimizedIds } = transformTreePreservingLocked(
    originalTree,
    lockedIds,
    presetType,
    activeId,
    gridConfig
  )

  return { layoutTree: newTree, minimizedIds }
}

/**
 * Preserve split percentages adjacent to locked panes when the user drags a split bar.
 * Walks old and new trees in parallel. At each branch node, if either child subtree
 * contains a locked pane, the old splitPercentage is preserved instead of the new one.
 * If tree structures differ (e.g. drag-drop changed the shape), returns newTree as-is.
 */
export function preserveLockedSplitPercentages(
  oldTree: MosaicNode<string> | null,
  newTree: MosaicNode<string> | null,
  lockedIds: Set<string>
): MosaicNode<string> | null {
  // No locked panes - nothing to protect
  if (lockedIds.size === 0) return newTree

  // Base cases: if either tree is null or a leaf, return newTree
  if (oldTree === null || newTree === null) return newTree
  if (typeof oldTree === 'string' || typeof newTree === 'string') return newTree

  // If directions differ, the tree structure changed - return newTree as-is
  if (oldTree.direction !== newTree.direction) return newTree

  // Recurse into both children
  const newFirst = preserveLockedSplitPercentages(oldTree.first, newTree.first, lockedIds)
  const newSecond = preserveLockedSplitPercentages(oldTree.second, newTree.second, lockedIds)

  // If either child subtree contains a locked pane, preserve the old splitPercentage
  // Exception: allow resizing when one side is an empty tile (empty space should always be resizable)
  const firstIsEmpty = typeof newTree.first === 'string' && isEmptyTile(newTree.first)
  const secondIsEmpty = typeof newTree.second === 'string' && isEmptyTile(newTree.second)
  const hasLocked = !firstIsEmpty && !secondIsEmpty &&
    (containsLockedPane(newTree.first, lockedIds) || containsLockedPane(newTree.second, lockedIds))
  const splitPercentage = hasLocked ? oldTree.splitPercentage : newTree.splitPercentage

  return {
    direction: newTree.direction,
    first: newFirst!,
    second: newSecond!,
    splitPercentage,
  }
}

/**
 * Lock-aware version of removeTerminalFromTree.
 * When removing a terminal causes a branch to collapse and the surviving sibling
 * contains a locked pane, auto-replaces the removed pane with the first available
 * minimized pane to preserve the branch structure and split percentage.
 *
 * @returns { tree, restoredId } where restoredId is the minimized pane that was
 *   auto-restored into the vacated spot, or null if none was available.
 */
export function removeTerminalPreservingLocked(
  tree: MosaicNode<string> | null,
  terminalId: string,
  lockedIds: Set<string>,
  minimizedIds: string[]
): { tree: MosaicNode<string> | null; restoredId: string | null } {
  // No locked panes - fall back to normal removal
  if (lockedIds.size === 0) {
    return { tree: removeTerminalFromTree(tree, terminalId), restoredId: null }
  }

  if (tree === null) return { tree: null, restoredId: null }
  if (typeof tree === 'string') {
    if (tree === terminalId) {
      // This leaf is the terminal to remove.
      // At this level we can't check the sibling - the parent handles that.
      return { tree: null, restoredId: null }
    }
    return { tree, restoredId: null }
  }

  // Check which branch contains the terminal to remove
  const inFirst = terminalExistsInTree(tree.first, terminalId)
  const inSecond = terminalExistsInTree(tree.second, terminalId)

  if (!inFirst && !inSecond) {
    // Terminal not in this subtree
    return { tree, restoredId: null }
  }

  // Case: terminal is a direct child leaf of this branch
  if (inFirst && typeof tree.first === 'string' && tree.first === terminalId) {
    // Removing the first child - sibling is second
    if (containsLockedPane(tree.second, lockedIds)) {
      // Sibling has a locked pane - replace with minimized pane or empty tile
      const replacement = minimizedIds.length > 0 ? minimizedIds[0] : createEmptyTileId()
      return {
        tree: { ...tree, first: replacement },
        restoredId: minimizedIds.length > 0 ? replacement : null,
      }
    }
    // No locked sibling - normal collapse
    return { tree: tree.second, restoredId: null }
  }

  if (inSecond && typeof tree.second === 'string' && tree.second === terminalId) {
    // Removing the second child - sibling is first
    if (containsLockedPane(tree.first, lockedIds)) {
      // Sibling has a locked pane - replace with minimized pane or empty tile
      const replacement = minimizedIds.length > 0 ? minimizedIds[0] : createEmptyTileId()
      return {
        tree: { ...tree, second: replacement },
        restoredId: minimizedIds.length > 0 ? replacement : null,
      }
    }
    // No locked sibling - normal collapse
    return { tree: tree.first, restoredId: null }
  }

  // Terminal is deeper in the tree - recurse into the branch that contains it
  if (inFirst) {
    const result = removeTerminalPreservingLocked(tree.first, terminalId, lockedIds, minimizedIds)
    if (result.tree === null) {
      // The entire first subtree collapsed - check if second has locked panes
      if (containsLockedPane(tree.second, lockedIds)) {
        const replacement = minimizedIds.length > 0 ? minimizedIds[0] : createEmptyTileId()
        return {
          tree: { ...tree, first: replacement },
          restoredId: minimizedIds.length > 0 ? replacement : null,
        }
      }
      return { tree: tree.second, restoredId: null }
    }
    return {
      tree: { ...tree, first: result.tree },
      restoredId: result.restoredId,
    }
  }

  // inSecond
  const result = removeTerminalPreservingLocked(tree.second, terminalId, lockedIds, minimizedIds)
  if (result.tree === null) {
    // The entire second subtree collapsed - check if first has locked panes
    if (containsLockedPane(tree.first, lockedIds)) {
      const replacement = minimizedIds.length > 0 ? minimizedIds[0] : createEmptyTileId()
      return {
        tree: { ...tree, second: replacement },
        restoredId: minimizedIds.length > 0 ? replacement : null,
      }
    }
    return { tree: tree.first, restoredId: null }
  }
  return {
    tree: { ...tree, second: result.tree },
    restoredId: result.restoredId,
  }
}
