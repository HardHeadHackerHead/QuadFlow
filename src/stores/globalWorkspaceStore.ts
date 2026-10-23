import { create } from 'zustand'
import type { MosaicNode } from 'react-mosaic-component'
import {
  ToolInstance,
  GlobalWorkspace,
  PROJECT_MOSAIC_LEAF,
  SessionToolInstance,
  SessionTerminal,
  isGlobalWsTile,
  parseGlobalWsTileId,
  makeGlobalWsTileId,
} from '../types'
import * as appData from '../lib/appData'
import { terminalApi } from '../lib/tauri-api'
import { getTerminalBuffer } from '../lib/terminalRegistry'
import { useToolStore } from './toolStore'
import { isToolLeaf, newToolLeafId } from '../lib/layoutIds'

// Capture the xterm scrollback for `terminalId` and stash it on the terminal
// state as pendingBufferContent so the next TerminalView mount restores it.
// Used whenever a terminal/tool is moved between the project tree and a
// global workspace tree — without this, the React unmount/remount produces a
// fresh empty xterm and the user thinks the terminal "stopped working".
function preserveTerminalBuffer(terminalId: string | undefined) {
  if (!terminalId) return
  try {
    const buf = getTerminalBuffer(terminalId)
    if (!buf) return
    // Lazy import to avoid a circular dep at module load.
    import('./terminalStore').then(({ useTerminalStore }) => {
      useTerminalStore.getState().updateTerminal(terminalId, { pendingBufferContent: buf })
    })
  } catch {
    /* getTerminalBuffer can throw on disposed instances — ignore */
  }
}

interface GlobalWorkspaceStore {
  workspaces: Map<string, GlobalWorkspace>           // raw workspaceId → workspace
  frameTree: MosaicNode<string> | null                // outer mosaic (leaves: __project__ + globalWs:<id>)
  globallyEnabled: boolean
  globalToolInstances: Map<string, ToolInstance>      // instance id → instance (each has workspaceId in metadata)
  loaded: boolean

  loadFromDb: () => Promise<void>

  // Workspace CRUD
  createWorkspace: (name: string) => Promise<string>
  renameWorkspace: (id: string, name: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setWorkspaceEnabled: (id: string, enabled: boolean) => Promise<void>
  setWorkspaceMinimized: (id: string, minimized: boolean) => Promise<void>
  setWorkspaceLayoutTree: (id: string, tree: MosaicNode<string> | null) => void

  // Frame mosaic (globally shared)
  setFrameTree: (tree: MosaicNode<string> | null) => void
  setGloballyEnabled: (v: boolean) => Promise<void>
  // Move a workspace one position over within the frame's leaf order.
  // Direction 'left' = toward the start of the in-order leaf walk;
  // 'right' = toward the end. Returns false if already at the boundary.
  moveWorkspaceInFrame: (workspaceId: string, direction: 'left' | 'right') => boolean
  canMoveWorkspaceInFrame: (workspaceId: string, direction: 'left' | 'right') => boolean

  // Live (effective) frame derived from frameTree, workspaces, globallyEnabled.
  getEffectiveFrameTree: () => MosaicNode<string> | null

  // Tool instance management — every global instance belongs to exactly one workspace.
  openInWorkspace: (workspaceId: string, configId: string, metadata?: Record<string, unknown>) => Promise<string>
  closeWorkspaceInstance: (instanceId: string) => Promise<void>
  pinInstanceToWorkspace: (instanceId: string, workspaceId: string) => Promise<void>
  unpinInstance: (instanceId: string) => Promise<void>
  getInstancesForWorkspace: (workspaceId: string) => ToolInstance[]
  getGlobalInstance: (id: string) => ToolInstance | undefined

  // Terminal pinning — terminal data stays in useTerminalStore.terminals; we
  // just track which terminal ids belong to which workspace and add their id
  // to the workspace's sub-layout tree.
  pinTerminalToWorkspace: (terminalId: string, workspaceId: string) => Promise<void>
  unpinTerminal: (terminalId: string) => Promise<void>
  // Strip a leaf id from whichever workspace's sub-tree currently contains it,
  // also clearing the global terminal flag if applicable. Used by the close
  // button on a global pane so the dangling leaf doesn't outlive the data it
  // was pointing at.
  removeLeafFromAnyWorkspace: (leafId: string) => void
  globalTerminalIds: Set<string>          // ids of terminals that should survive session/project switch
  isGlobalTerminal: (id: string) => boolean

  persistInstances: () => Promise<void>
}

// ---------- Tree helpers ----------

function insertLeafIntoTree(
  tree: MosaicNode<string> | null,
  id: string,
  direction: 'row' | 'column' = 'row',
): MosaicNode<string> {
  if (tree === null) return id
  return { direction, first: tree, second: id, splitPercentage: 60 }
}

function removeLeafFromTree(
  tree: MosaicNode<string> | null,
  id: string,
): MosaicNode<string> | null {
  if (tree === null) return null
  if (typeof tree === 'string') return tree === id ? null : tree
  const first = removeLeafFromTree(tree.first, id)
  const second = removeLeafFromTree(tree.second, id)
  if (first === null && second === null) return null
  if (first === null) return second
  if (second === null) return first
  return { ...tree, first, second }
}

function collectLeafIds(tree: MosaicNode<string> | null, out: Set<string>): void {
  if (tree === null) return
  if (typeof tree === 'string') { out.add(tree); return }
  collectLeafIds(tree.first, out)
  collectLeafIds(tree.second, out)
}

function workspaceTileIdsInTree(tree: MosaicNode<string> | null): string[] {
  const ids = new Set<string>()
  collectLeafIds(tree, ids)
  return Array.from(ids).filter(isGlobalWsTile)
}

// In-order walk: 'first' before 'second' for both row and column splits, so
// the order corresponds to left→right (rows) and top→bottom (columns) when
// flattened. Used by the arrow-button reposition controls.
function leavesInOrder(tree: MosaicNode<string> | null): string[] {
  const out: string[] = []
  const walk = (node: MosaicNode<string> | null) => {
    if (node === null) return
    if (typeof node === 'string') { out.push(node); return }
    walk(node.first)
    walk(node.second)
  }
  walk(tree)
  return out
}

// Swap two leaves in a mosaic tree while preserving each leaf's *visual size*.
//
// The naïve approach (rename leaf ids in place) keeps the tree shape but means
// the swapped leaves inherit each other's old size, because splitPercentage
// governs the `first` slot, not the leaf id. To keep sizes constant when two
// leaves are direct siblings of a single split, we instead swap that split's
// `first`/`second` children and invert `splitPercentage` (P → 100-P). For the
// rarer non-sibling case we fall back to leaf renaming — sizes will swap
// along with positions, which is acceptable for that edge case.
function swapLeafPair(
  tree: MosaicNode<string>,
  a: string,
  b: string,
): MosaicNode<string> {
  // Find a parent split whose two direct children are exactly { a, b }.
  const findSiblingsParent = (node: MosaicNode<string>): MosaicNode<string> | null => {
    if (typeof node === 'string') return null
    const firstId = typeof node.first === 'string' ? node.first : null
    const secondId = typeof node.second === 'string' ? node.second : null
    if ((firstId === a && secondId === b) || (firstId === b && secondId === a)) {
      return node
    }
    return (
      findSiblingsParent(node.first as MosaicNode<string>) ||
      findSiblingsParent(node.second as MosaicNode<string>)
    )
  }
  const siblingsParent = findSiblingsParent(tree)

  const recurse = (node: MosaicNode<string>): MosaicNode<string> => {
    if (typeof node === 'string') {
      if (node === a) return b
      if (node === b) return a
      return node
    }
    if (node === siblingsParent) {
      // Sibling case: swap slots and invert percentage to keep both sizes.
      const sp = node.splitPercentage ?? 50
      return {
        ...node,
        first: node.second,
        second: node.first,
        splitPercentage: 100 - sp,
      }
    }
    return { ...node, first: recurse(node.first), second: recurse(node.second) }
  }
  return recurse(tree)
}

function ensureProjectLeaf(tree: MosaicNode<string> | null): MosaicNode<string> {
  // Always guarantee a __project__ leaf exists somewhere in the frame.
  if (tree === null) return PROJECT_MOSAIC_LEAF
  const ids = new Set<string>()
  collectLeafIds(tree, ids)
  if (ids.has(PROJECT_MOSAIC_LEAF)) return tree
  // Project leaf was removed — re-attach it as a 50/50 row split.
  return { direction: 'row', first: PROJECT_MOSAIC_LEAF, second: tree, splitPercentage: 50 }
}

function instanceToPersistable(instance: ToolInstance): SessionToolInstance & { workspaceId?: string } {
  return {
    id: instance.id,
    configId: instance.configId,
    title: instance.title,
    status: instance.status,
    terminalId: instance.terminalId,
    isLocked: instance.isLocked,
    isFlyoutInstance: instance.isFlyoutInstance,
    commandLaunched: instance.commandLaunched,
    metadata: instance.metadata ? JSON.stringify(instance.metadata) : undefined,
    workspaceId: (instance.metadata?.workspaceId as string | undefined) ?? undefined,
  }
}

function generateInstanceId(): string {
  return newToolLeafId()
}

function generateWorkspaceId(): string {
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// ---------- Persistence helpers ----------

async function persistFrame(): Promise<void> {
  const { frameTree, globallyEnabled } = useGlobalWorkspaceStore.getState()
  await appData.saveGlobalFrame({ frameTree, globallyEnabled })
}

async function persistWorkspace(id: string): Promise<void> {
  const ws = useGlobalWorkspaceStore.getState().workspaces.get(id)
  if (ws) await appData.upsertGlobalWorkspace(ws)
}

/**
 * Terminals pinned to a global workspace belong to no project workspace; the
 * workspace controller snapshots them into `shell.globalTerminals`. Recreate
 * their PTYs (same ids) as global-scope terminals. Returns the ids restored.
 */
async function restoreGlobalTerminals(wanted: Set<string>): Promise<Set<string>> {
  const restored = new Set<string>()
  if (wanted.size === 0) return restored
  let saved: (SessionTerminal & { globalWorkspaceId?: string })[] = []
  try {
    saved = (await appData.getSetting<typeof saved>('shell', 'globalTerminals')) ?? []
  } catch (e) {
    console.error('[globalWorkspace] read globalTerminals failed:', e)
  }
  const { useTerminalStore } = await import('./terminalStore')
  for (const t of saved) {
    if (!wanted.has(t.id)) continue
    try {
      const info = await terminalApi.create({ cwd: t.workingDirectory, id: t.id })
      const now = Date.now()
      useTerminalStore.setState((state) => {
        const terminals = new Map(state.terminals)
        terminals.set(info.id, {
          id: info.id,
          title: t.title || 'Terminal',
          titleSource: t.titleSource ?? 'default',
          originalPrompt: t.originalPrompt ?? null,
          summary: null,
          workingDirectory: info.cwd,
          gridPosition: t.gridPosition ?? 0,
          status: 'active',
          createdAt: now,
          pid: info.pid,
          isLoading: false,
          lastActivityAt: now,
          pendingBufferContent: info.reattached ? undefined : t.bufferContent,
          agent: t.agent ?? null,
          role: t.role,
          customRoleLabel: t.customRoleLabel,
          isLocked: t.isLocked,
          hasAutoResumed: info.reattached && t.agent ? true : undefined,
          scope: 'global',
          globalWorkspaceId: t.globalWorkspaceId,
        })
        return { terminals }
      })
      restored.add(info.id)
    } catch (e) {
      console.error('[globalWorkspace] restore global terminal failed:', e)
    }
  }
  return restored
}

// ---------- Store ----------

export const useGlobalWorkspaceStore = create<GlobalWorkspaceStore>((set, get) => ({
  workspaces: new Map(),
  frameTree: null,
  globallyEnabled: true,
  globalToolInstances: new Map(),
  globalTerminalIds: new Set(),
  loaded: false,

  loadFromDb: async () => {
    try {
      const { workspaces: wsList, frame, instances: savedInstances } = await appData.loadGlobalWorkspaces()

      // Dedupe each workspace's sub_layout_tree at load time. If any tree
      // contained a duplicate id (from corrupted persisted state), the cleaned
      // version is written back so the bad data goes away once and for all.
      const { dedupeTreeLeaves } = await import('../lib/layoutUtils')
      const workspaces = new Map<string, GlobalWorkspace>()
      for (const ws of wsList) {
        const cleaned = dedupeTreeLeaves(ws.layoutTree)
        const treeChanged = JSON.stringify(cleaned) !== JSON.stringify(ws.layoutTree)
        const stored: GlobalWorkspace = treeChanged ? { ...ws, layoutTree: cleaned } : ws
        workspaces.set(ws.id, stored)
        if (treeChanged) {
          appData.upsertGlobalWorkspace({ ...ws, layoutTree: cleaned })
            .catch(e => console.error('[globalWorkspace] persist deduped sub_layout_tree:', e))
        }
      }
      // Track terminal ids that live inside any global workspace, so the
      // project's layout tree can be defensively cleansed of them at render.
      const seedGlobalTerminalIds = new Set<string>()
      const isToolId = isToolLeaf
      for (const ws of workspaces.values()) {
        const ids = new Set<string>()
        const walk = (n: import('react-mosaic-component').MosaicNode<string> | null): void => {
          if (n === null) return
          if (typeof n === 'string') { ids.add(n); return }
          walk(n.first); walk(n.second)
        }
        walk(ws.layoutTree)
        ids.forEach(id => { if (!isToolId(id)) seedGlobalTerminalIds.add(id) })
      }
      const toolConfigs = useToolStore.getState().toolConfigs
      const instances = new Map<string, ToolInstance>()

      for (const s of savedInstances) {
        const cfg = toolConfigs.get(s.configId)
        if (!cfg) continue
        // Drop orphans whose workspace was deleted.
        if (!s.workspaceId || !workspaces.has(s.workspaceId)) continue

        const meta: Record<string, unknown> = s.metadata ? JSON.parse(s.metadata) : {}
        meta.workspaceId = s.workspaceId

        const instance: ToolInstance = {
          id: s.id,
          configId: s.configId,
          title: s.title,
          status: s.status as 'active' | 'closed' | 'error',
          createdAt: Date.now(),
          isLocked: s.isLocked,
          isFlyoutInstance: s.isFlyoutInstance,
          commandLaunched: s.commandLaunched,
          metadata: meta,
          scope: 'global',
        }
        instances.set(instance.id, instance)
      }

      // Dedupe the frame tree too, persist if it changed.
      const cleanedFrame = dedupeTreeLeaves(frame.frameTree)
      if (JSON.stringify(cleanedFrame) !== JSON.stringify(frame.frameTree)) {
        appData.saveGlobalFrame({ frameTree: cleanedFrame, globallyEnabled: frame.globallyEnabled })
          .catch(e => console.error('[globalWorkspace] persist deduped frame_tree:', e))
      }

      set({
        workspaces,
        frameTree: cleanedFrame,
        globallyEnabled: frame.globallyEnabled,
        globalToolInstances: instances,
        globalTerminalIds: seedGlobalTerminalIds,
        loaded: true,
      })

      // Bring back the global terminals; drop leaves whose terminal is gone so
      // no workspace renders a dangling tile.
      const restored = await restoreGlobalTerminals(seedGlobalTerminalIds)
      for (const id of seedGlobalTerminalIds) {
        if (!restored.has(id)) get().removeLeafFromAnyWorkspace(id)
      }
    } catch (e) {
      console.error('[globalWorkspace] loadFromDb failed:', e)
      set({ loaded: true })
    }
  },

  createWorkspace: async (name: string) => {
    const id = generateWorkspaceId()
    const order = get().workspaces.size
    try {
      const now = Date.now()
      const ws = await appData.upsertGlobalWorkspace({ id, name, enabled: true, minimized: false, layoutTree: null, displayOrder: order, createdAt: now, updatedAt: now })
      set((state) => {
        const workspaces = new Map(state.workspaces)
        workspaces.set(id, ws)
        // Add the new workspace's tile to the frame tree.
        const tileId = makeGlobalWsTileId(id)
        const frameTree = ensureProjectLeaf(insertLeafIntoTree(state.frameTree, tileId))
        return { workspaces, frameTree }
      })
      // Persist the frame change.
      await persistFrame()
    } catch (e) {
      console.error('[globalWorkspace] createWorkspace failed:', e)
      throw e
    }
    return id
  },

  renameWorkspace: async (id, name) => {
    const ws = get().workspaces.get(id)
    if (!ws) return
    await appData.upsertGlobalWorkspace({ ...ws, name })
    set((state) => {
      const workspaces = new Map(state.workspaces)
      workspaces.set(id, { ...ws, name, updatedAt: Date.now() })
      return { workspaces }
    })
  },

  deleteWorkspace: async (id) => {
    // Kill PTYs for this workspace's instances.
    const instances = get().getInstancesForWorkspace(id)
    for (const inst of instances) {
      if (inst.terminalId) {
        try { await terminalApi.kill(inst.terminalId) } catch { /* ignore */ }
      }
    }
    await appData.deleteGlobalWorkspace(id)
    set((state) => {
      const workspaces = new Map(state.workspaces)
      workspaces.delete(id)
      const globalToolInstances = new Map(state.globalToolInstances)
      for (const [instId, inst] of state.globalToolInstances) {
        if ((inst.metadata?.workspaceId as string | undefined) === id) {
          globalToolInstances.delete(instId)
        }
      }
      const tileId = makeGlobalWsTileId(id)
      const frameTree = ensureProjectLeaf(removeLeafFromTree(state.frameTree, tileId))
      return { workspaces, globalToolInstances, frameTree }
    })
    await persistFrame()
  },

  setWorkspaceEnabled: async (id, enabled) => {
    const ws = get().workspaces.get(id)
    if (!ws) return
    await appData.upsertGlobalWorkspace({ ...ws, enabled })
    set((state) => {
      const workspaces = new Map(state.workspaces)
      workspaces.set(id, { ...ws, enabled, updatedAt: Date.now() })
      return { workspaces }
    })
  },

  setWorkspaceMinimized: async (id, minimized) => {
    const ws = get().workspaces.get(id)
    if (!ws) return
    await appData.upsertGlobalWorkspace({ ...ws, minimized })
    set((state) => {
      const workspaces = new Map(state.workspaces)
      workspaces.set(id, { ...ws, minimized, updatedAt: Date.now() })
      return { workspaces }
    })
  },

  setWorkspaceLayoutTree: (id, tree) => {
    const ws = get().workspaces.get(id)
    if (!ws) return
    set((state) => {
      const workspaces = new Map(state.workspaces)
      workspaces.set(id, { ...ws, layoutTree: tree, updatedAt: Date.now() })
      return { workspaces }
    })
    appData.upsertGlobalWorkspace({ ...ws, layoutTree: tree })
      .catch(e => console.error('[globalWorkspace] setWorkspaceLayoutTree persist:', e))
  },

  setFrameTree: (tree) => {
    const safe = ensureProjectLeaf(tree)
    set({ frameTree: safe })
    persistFrame()
      .catch(e => console.error('[globalWorkspace] setFrameTree persist:', e))
  },

  setGloballyEnabled: async (v) => {
    set({ globallyEnabled: v })
    try {
      await persistFrame()
    } catch (e) {
      console.error('[globalWorkspace] setGloballyEnabled persist:', e)
    }
  },

  canMoveWorkspaceInFrame: (workspaceId, direction) => {
    const tree = get().frameTree
    if (!tree) return false
    const tileId = makeGlobalWsTileId(workspaceId)
    const leaves = leavesInOrder(tree)
    const idx = leaves.indexOf(tileId)
    if (idx === -1) return false
    return direction === 'left' ? idx > 0 : idx < leaves.length - 1
  },

  moveWorkspaceInFrame: (workspaceId, direction) => {
    const tree = get().frameTree
    if (!tree) return false
    const tileId = makeGlobalWsTileId(workspaceId)
    const leaves = leavesInOrder(tree)
    const idx = leaves.indexOf(tileId)
    if (idx === -1) return false
    const targetIdx = direction === 'left' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= leaves.length) return false
    const otherId = leaves[targetIdx]
    const swapped = swapLeafPair(tree, tileId, otherId)
    set({ frameTree: ensureProjectLeaf(swapped) })
    persistFrame()
      .catch(e => console.error('[globalWorkspace] moveWorkspaceInFrame persist:', e))
    return true
  },

  getEffectiveFrameTree: () => {
    const { frameTree, workspaces, globallyEnabled } = get()
    if (!globallyEnabled) return PROJECT_MOSAIC_LEAF
    let tree: MosaicNode<string> | null = ensureProjectLeaf(frameTree)
    // Strip leaves whose workspace is disabled or minimized.
    const liveTileIds = workspaceTileIdsInTree(tree)
    for (const tileId of liveTileIds) {
      const wsId = parseGlobalWsTileId(tileId)
      if (!wsId) continue
      const ws = workspaces.get(wsId)
      const shouldRender = ws && ws.enabled && !ws.minimized
      if (!shouldRender) {
        tree = removeLeafFromTree(tree, tileId)
      }
    }
    return ensureProjectLeaf(tree)
  },

  openInWorkspace: async (workspaceId, configId, metadata) => {
    const ws = get().workspaces.get(workspaceId)
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`)
    const config = useToolStore.getState().toolConfigs.get(configId)
    if (!config) throw new Error(`Tool config not found: ${configId}`)

    const instanceId = generateInstanceId()
    const meta: Record<string, unknown> = { ...(metadata ?? {}), workspaceId }
    const instance: ToolInstance = {
      id: instanceId,
      configId,
      title: config.name,
      status: 'active',
      createdAt: Date.now(),
      metadata: meta,
      scope: 'global',
    }

    set((state) => {
      const globalToolInstances = new Map(state.globalToolInstances)
      globalToolInstances.set(instanceId, instance)
      const workspaces = new Map(state.workspaces)
      const subTree = insertLeafIntoTree(ws.layoutTree, instanceId)
      workspaces.set(workspaceId, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
      return { globalToolInstances, workspaces }
    })

    await get().persistInstances().catch(e => console.error('[globalWorkspace] persistInstances:', e))
    await persistWorkspace(workspaceId)
      .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))

    return instanceId
  },

  closeWorkspaceInstance: async (instanceId) => {
    const instance = get().globalToolInstances.get(instanceId)
    if (!instance) return
    const workspaceId = instance.metadata?.workspaceId as string | undefined
    if (instance.terminalId) {
      try { await terminalApi.kill(instance.terminalId) } catch { /* ignore */ }
    }
    set((state) => {
      const globalToolInstances = new Map(state.globalToolInstances)
      globalToolInstances.delete(instanceId)
      let workspaces = state.workspaces
      if (workspaceId) {
        const ws = state.workspaces.get(workspaceId)
        if (ws) {
          workspaces = new Map(state.workspaces)
          const subTree = removeLeafFromTree(ws.layoutTree, instanceId)
          workspaces.set(workspaceId, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
        }
      }
      return { globalToolInstances, workspaces }
    })
    try { await get().persistInstances() } catch (e) { console.error('[globalWorkspace] delete failed:', e) }
    if (workspaceId) {
      const ws = get().workspaces.get(workspaceId)
      if (ws) {
        await appData.upsertGlobalWorkspace(ws)
          .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))
      }
    }
  },

  pinInstanceToWorkspace: async (instanceId, workspaceId) => {
    const ws = get().workspaces.get(workspaceId)
    if (!ws) return
    const sessionInstance = useToolStore.getState().toolInstances.get(instanceId)
    if (!sessionInstance) return

    // Capture xterm scrollback before the unmount so the new mount restores it.
    preserveTerminalBuffer(sessionInstance.terminalId)

    const meta: Record<string, unknown> = { ...(sessionInstance.metadata ?? {}), workspaceId }
    const moved: ToolInstance = { ...sessionInstance, scope: 'global', metadata: meta }
    useToolStore.getState().detachInstanceForTransfer(instanceId)

    set((state) => {
      const globalToolInstances = new Map(state.globalToolInstances)
      globalToolInstances.set(moved.id, moved)
      const workspaces = new Map(state.workspaces)
      // Strip any existing occurrence from this workspace's sub-tree before
      // inserting, so re-pinning never duplicates leaves.
      const cleanedSubTree = removeLeafFromTree(ws.layoutTree, moved.id)
      const subTree = insertLeafIntoTree(cleanedSubTree, moved.id)
      workspaces.set(workspaceId, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
      return { globalToolInstances, workspaces }
    })

    await get().persistInstances().catch(e => console.error('[globalWorkspace] persistInstances:', e))
    await persistWorkspace(workspaceId)
      .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))
  },

  unpinInstance: async (instanceId) => {
    const instance = get().globalToolInstances.get(instanceId)
    if (!instance) return
    const workspaceId = instance.metadata?.workspaceId as string | undefined

    // Capture xterm scrollback before the unmount so the new mount restores it.
    preserveTerminalBuffer(instance.terminalId)

    set((state) => {
      const globalToolInstances = new Map(state.globalToolInstances)
      globalToolInstances.delete(instanceId)
      let workspaces = state.workspaces
      if (workspaceId) {
        const ws = state.workspaces.get(workspaceId)
        if (ws) {
          workspaces = new Map(state.workspaces)
          const subTree = removeLeafFromTree(ws.layoutTree, instanceId)
          workspaces.set(workspaceId, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
        }
      }
      return { globalToolInstances, workspaces }
    })
    try { await get().persistInstances() } catch (e) { console.error('[globalWorkspace] delete failed:', e) }
    if (workspaceId) {
      const ws = get().workspaces.get(workspaceId)
      if (ws) {
        await appData.upsertGlobalWorkspace(ws)
          .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))
      }
    }

    // Hand back to current session toolStore + insert into project tree.
    const cleanedMeta: Record<string, unknown> | undefined = instance.metadata
      ? Object.fromEntries(Object.entries(instance.metadata).filter(([k]) => k !== 'workspaceId'))
      : undefined
    const reinjected: ToolInstance = { ...instance, scope: 'session', metadata: cleanedMeta }
    useToolStore.getState().attachInstanceFromTransfer(reinjected)

    try {
      const { useTerminalStore } = await import('./terminalStore')
      const { insertTerminalFillEmpty, removeTerminalFromTree } = await import('../lib/layoutUtils')
      const termStore = useTerminalStore.getState()
      // Defensive: strip any pre-existing occurrence of this id from the
      // project tree before inserting, so we never produce duplicate leaves
      // (react-mosaic refuses to render trees with duplicate ids).
      const stripped = removeTerminalFromTree(termStore.layoutTree, instanceId)
      const newTree = insertTerminalFillEmpty(stripped, instanceId, termStore.activeTerminalId)
      termStore.setLayoutTree(newTree)
      termStore.setActiveTerminal(instanceId)
    } catch (e) {
      console.error('[globalWorkspace] failed to insert unpinned tool into project tree:', e)
    }
  },

  getInstancesForWorkspace: (workspaceId) => {
    return Array.from(get().globalToolInstances.values()).filter(
      (inst) => (inst.metadata?.workspaceId as string | undefined) === workspaceId,
    )
  },

  getGlobalInstance: (id) => get().globalToolInstances.get(id),

  isGlobalTerminal: (id) => get().globalTerminalIds.has(id),

  removeLeafFromAnyWorkspace: (leafId) => {
    let owningWorkspaceId: string | undefined
    for (const [wsId, ws] of get().workspaces) {
      const ids = new Set<string>()
      collectLeafIds(ws.layoutTree, ids)
      if (ids.has(leafId)) { owningWorkspaceId = wsId; break }
    }
    if (!owningWorkspaceId) {
      // Still clear the global flag in case it was stranded without a tree leaf.
      if (get().globalTerminalIds.has(leafId)) {
        set((state) => {
          const globalTerminalIds = new Set(state.globalTerminalIds)
          globalTerminalIds.delete(leafId)
          return { globalTerminalIds }
        })
      }
      return
    }
    set((state) => {
      const workspaces = new Map(state.workspaces)
      const ws = state.workspaces.get(owningWorkspaceId!)
      if (ws) {
        const subTree = removeLeafFromTree(ws.layoutTree, leafId)
        workspaces.set(owningWorkspaceId!, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
      }
      const globalTerminalIds = new Set(state.globalTerminalIds)
      globalTerminalIds.delete(leafId)
      return { workspaces, globalTerminalIds }
    })
    const ws = get().workspaces.get(owningWorkspaceId!)
    if (ws) {
      appData.upsertGlobalWorkspace(ws)
        .catch(e => console.error('[globalWorkspace] removeLeafFromAnyWorkspace persist:', e))
    }
  },

  pinTerminalToWorkspace: async (terminalId, workspaceId) => {
    const ws = get().workspaces.get(workspaceId)
    if (!ws) return
    // Capture xterm scrollback before the unmount so the new mount restores it.
    preserveTerminalBuffer(terminalId)
    // If this terminal is currently in a different global workspace, strip
    // it from there first (one terminal can only live in one workspace).
    set((state) => {
      const workspaces = new Map(state.workspaces)
      let modifiedAny = false
      for (const [otherWsId, otherWs] of state.workspaces) {
        if (otherWsId === workspaceId) continue
        const ids = new Set<string>()
        collectLeafIds(otherWs.layoutTree, ids)
        if (ids.has(terminalId)) {
          const cleaned = removeLeafFromTree(otherWs.layoutTree, terminalId)
          workspaces.set(otherWsId, { ...otherWs, layoutTree: cleaned, updatedAt: Date.now() })
          modifiedAny = true
        }
      }
      // Strip any existing occurrence from the destination workspace too,
      // then insert.
      const dest = workspaces.get(workspaceId) ?? ws
      const cleanedSub = removeLeafFromTree(dest.layoutTree, terminalId)
      const subTree = insertLeafIntoTree(cleanedSub, terminalId)
      workspaces.set(workspaceId, { ...dest, layoutTree: subTree, updatedAt: Date.now() })
      const globalTerminalIds = new Set(state.globalTerminalIds)
      globalTerminalIds.add(terminalId)
      void modifiedAny
      return { workspaces, globalTerminalIds }
    })

    // Mark the terminal scope='global' so clearTerminals skips it.
    try {
      const { useTerminalStore } = await import('./terminalStore')
      useTerminalStore.getState().updateTerminal(terminalId, { scope: 'global', globalWorkspaceId: workspaceId })
    } catch (e) {
      console.error('[globalWorkspace] mark terminal global failed:', e)
    }

    await persistWorkspace(workspaceId)
      .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))
  },

  unpinTerminal: async (terminalId) => {
    // Capture xterm scrollback before the unmount so the new mount restores it.
    preserveTerminalBuffer(terminalId)
    // Find which workspace this terminal lives in.
    let owningWorkspaceId: string | undefined
    for (const [wsId, ws] of get().workspaces) {
      const ids = new Set<string>()
      collectLeafIds(ws.layoutTree, ids)
      if (ids.has(terminalId)) { owningWorkspaceId = wsId; break }
    }

    set((state) => {
      const workspaces = new Map(state.workspaces)
      if (owningWorkspaceId) {
        const ws = state.workspaces.get(owningWorkspaceId)
        if (ws) {
          const subTree = removeLeafFromTree(ws.layoutTree, terminalId)
          workspaces.set(owningWorkspaceId, { ...ws, layoutTree: subTree, updatedAt: Date.now() })
        }
      }
      const globalTerminalIds = new Set(state.globalTerminalIds)
      globalTerminalIds.delete(terminalId)
      return { workspaces, globalTerminalIds }
    })

    try {
      const { useTerminalStore } = await import('./terminalStore')
      useTerminalStore.getState().updateTerminal(terminalId, { scope: 'session', globalWorkspaceId: undefined })
      // Insert back into the project's layout tree near the active terminal.
      // Defensive: strip any pre-existing occurrence of this id first so we
      // never produce duplicate leaves (react-mosaic refuses to render trees
      // with duplicate ids).
      const { insertTerminalFillEmpty, removeTerminalFromTree } = await import('../lib/layoutUtils')
      const termStore = useTerminalStore.getState()
      const stripped = removeTerminalFromTree(termStore.layoutTree, terminalId)
      const newTree = insertTerminalFillEmpty(stripped, terminalId, termStore.activeTerminalId)
      termStore.setLayoutTree(newTree)
      termStore.setActiveTerminal(terminalId)
    } catch (e) {
      console.error('[globalWorkspace] unpin terminal restore failed:', e)
    }

    if (owningWorkspaceId) {
      const ws = get().workspaces.get(owningWorkspaceId)
      if (ws) {
        await appData.upsertGlobalWorkspace(ws)
          .catch(e => console.error('[globalWorkspace] persist sub_layout_tree:', e))
      }
    }
  },

  persistInstances: async () => {
    const arr = Array.from(get().globalToolInstances.values()).map(instanceToPersistable)
    await appData.saveGlobalToolInstances(arr)
  },
}))

// Cross-store lookup used by tile renderers that don't know which scope a tile belongs to.
export function getInstanceAnywhere(id: string): ToolInstance | undefined {
  return (
    useToolStore.getState().toolInstances.get(id) ||
    useGlobalWorkspaceStore.getState().globalToolInstances.get(id)
  )
}
