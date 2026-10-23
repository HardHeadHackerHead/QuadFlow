import { create } from 'zustand'
import { MosaicNode } from 'react-mosaic-component'
import { TerminalState, TerminalInfo, SessionTerminal, ToolInstance } from '../types'
import { terminalApi } from '../lib/tauri-api'
import {
  insertTerminalFillEmpty,
  removeTerminalFromTree,
  removeTerminalPreservingLocked,
  getTerminalIdsFromTree,
  createDefaultLayoutTree,
  serializeLayoutTree,
  deserializeLayoutTree,
  createLayoutPreservingLocked,
  collapseUnneededEmptyTiles,
  isEmptyTile,
  swapWithMain,
  LAYOUT_PRESETS,
  LayoutPresetType,
  GridConfig,
} from '../lib/layoutUtils'
import { useToolStore } from './toolStore'
import { useAppSettingsStore } from './appSettingsStore'

// Module-level activity map to avoid Zustand re-renders on every byte of output
// TerminalView writes to this directly; the idle checker reads from it
export const terminalActivityMap = new Map<string, number>()

let idleCheckerInterval: ReturnType<typeof setInterval> | null = null

interface TerminalStore {
  terminals: Map<string, TerminalState>
  activeTerminalId: string | null
  globalWorkingDirectory: string
  layoutTree: MosaicNode<string> | null
  minimizedTerminals: string[]
  currentLayoutPreset: LayoutPresetType

  // Actions
  addTerminal: (info: TerminalInfo) => void
  removeTerminal: (id: string) => void
  setActiveTerminal: (id: string | null) => void
  updateTerminal: (id: string, updates: Partial<TerminalState>) => void
  setGlobalWorkingDirectory: (dir: string) => void
  setLayoutTree: (tree: MosaicNode<string> | null) => void
  minimizeTerminal: (id: string) => void
  restoreTerminal: (id: string) => void
  removeFromMinimizedList: (id: string) => void // Remove from minimized without inserting to tree
  resetLayout: () => void
  cycleLayoutPreset: () => void
  setLayoutPreset: (presetType: LayoutPresetType) => void
  getCurrentPreset: () => typeof LAYOUT_PRESETS[number]
  getTerminalsArray: () => TerminalState[]
  getVisibleTerminals: () => TerminalState[]
  getMinimizedTerminals: () => TerminalState[]
  getLockedTerminalIds: () => string[]
  getSerializedLayoutTree: () => string | null
  clearTerminals: () => void
  // `isStale`: a newer workspace/project switch superseded this restore — stop creating PTYs.
  restoreTerminals: (savedTerminals: SessionTerminal[], workingDirectory: string, layoutTreeJson?: string | null, additionalValidIds?: string[], isStale?: () => boolean) => Promise<void>
  // Attention management
  setTerminalAttention: (id: string, needsAttention: boolean) => void
  clearAllAttention: () => void
  // Idle management
  setTerminalIdle: (id: string, isIdle: boolean) => void
  checkIdleTerminals: () => void
  startIdleChecker: () => void
  stopIdleChecker: () => void
  // Lock management
  toggleTerminalLock: (id: string) => void
  isTerminalLocked: (id: string) => boolean
  // Promote a pane to main position (swap with current main)
  promoteToMain: (id: string) => void
  // Empty space management
  removeAllEmptySpace: () => void
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  // '' = no active project (several consumers treat it as that sentinel).
  // Terminals created with an empty cwd start in the OS home dir — resolved by
  // the backend (dirs::home_dir), so no platform path is hardcoded here.
  globalWorkingDirectory: '',
  layoutTree: null,
  minimizedTerminals: [],
  currentLayoutPreset: 'grid' as LayoutPresetType,

  addTerminal: (info: TerminalInfo) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      const now = Date.now()
      const newTerminal: TerminalState = {
        id: info.id,
        title: `Terminal ${terminals.size + 1}`,
        titleSource: 'default',
        originalPrompt: null,
        summary: null,
        workingDirectory: info.cwd,
        gridPosition: terminals.size, // Keep for backwards compatibility
        status: 'active',
        createdAt: now,
        pid: info.pid,
        isLoading: false,
        lastActivityAt: now,
      }
      terminals.set(info.id, newTerminal)
      terminalActivityMap.set(info.id, now)

      // Insert into layout tree, filling empty space first
      const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
      const lockedTerminalIds = Array.from(terminals.values()).filter(t => t.isLocked).map(t => t.id)
      const toolStore = useToolStore.getState()
      const lockedToolIds = Array.from(toolStore.toolInstances.values()).filter((t: any) => t.isLocked).map((t: any) => t.id)
      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])
      const newLayoutTree = insertTerminalFillEmpty(state.layoutTree, info.id, state.activeTerminalId, splitDir, lockedIds)

      return {
        terminals,
        activeTerminalId: info.id,
        layoutTree: newLayoutTree,
      }
    })
  },

  removeTerminal: (id: string) => {
    terminalActivityMap.delete(id)
    set((state) => {
      const terminals = new Map(state.terminals)
      terminals.delete(id)

      // Remove from minimized list if present
      let minimizedTerminals = state.minimizedTerminals.filter((tid) => tid !== id)

      // Compute locked IDs (terminals + tools)
      const lockedTerminalIds = Array.from(terminals.values())
        .filter((t) => t.isLocked)
        .map((t) => t.id)
      const toolStore = useToolStore.getState()
      const lockedToolIds = Array.from(toolStore.toolInstances.values())
        .filter((t) => t.isLocked)
        .map((t) => t.id)
      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])

      // All minimized panes (terminals + tools) available for replacement
      const allMinimized = [...minimizedTerminals, ...toolStore.minimizedTools]

      // Lock-aware removal: may auto-restore a minimized pane into the vacated spot
      const { tree: newLayoutTree, restoredId } = removeTerminalPreservingLocked(
        state.layoutTree, id, lockedIds, allMinimized
      )

      // If a pane was auto-restored, remove it from the appropriate minimized list
      if (restoredId) {
        if (minimizedTerminals.includes(restoredId)) {
          minimizedTerminals = minimizedTerminals.filter((tid) => tid !== restoredId)
        } else if (toolStore.minimizedTools.includes(restoredId)) {
          toolStore.restoreTool(restoredId)
        }
      }

      // Update gridPositions for backwards compatibility
      let index = 0
      terminals.forEach((terminal) => {
        terminal.gridPosition = index++
      })

      return {
        terminals,
        layoutTree: newLayoutTree,
        minimizedTerminals,
        activeTerminalId:
          state.activeTerminalId === id
            ? terminals.size > 0
              ? terminals.keys().next().value
              : null
            : state.activeTerminalId,
      }
    })
  },

  setActiveTerminal: (id: string | null) => {
    set({ activeTerminalId: id })
  },

  updateTerminal: (id: string, updates: Partial<TerminalState>) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      const terminal = terminals.get(id)
      if (terminal) {
        terminals.set(id, { ...terminal, ...updates })
      }
      return { terminals }
    })
  },

  setGlobalWorkingDirectory: (dir: string) => {
    set({ globalWorkingDirectory: dir })
  },

  setLayoutTree: (tree: MosaicNode<string> | null) => {
    set({ layoutTree: tree })
  },

  minimizeTerminal: (id: string) => {
    set((state) => {
      // Don't minimize if already minimized
      if (state.minimizedTerminals.includes(id)) return state

      // Compute locked IDs (terminals + tools)
      const lockedTerminalIds = Array.from(state.terminals.values())
        .filter((t) => t.isLocked)
        .map((t) => t.id)
      const toolStore = useToolStore.getState()
      const lockedToolIds = Array.from(toolStore.toolInstances.values())
        .filter((t) => t.isLocked)
        .map((t) => t.id)
      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])

      // Use existing minimized panes (before adding this one) for replacement
      const allMinimized = [...state.minimizedTerminals, ...toolStore.minimizedTools]

      // Lock-aware removal
      const { tree: newLayoutTree, restoredId } = removeTerminalPreservingLocked(
        state.layoutTree, id, lockedIds, allMinimized
      )

      // Add to minimized list
      let minimizedTerminals = [...state.minimizedTerminals, id]

      // If a pane was auto-restored, remove it from the appropriate minimized list
      if (restoredId) {
        if (minimizedTerminals.includes(restoredId)) {
          minimizedTerminals = minimizedTerminals.filter((tid) => tid !== restoredId)
        } else if (toolStore.minimizedTools.includes(restoredId)) {
          toolStore.restoreTool(restoredId)
        }
      }

      // Update active terminal if needed (skip empty tiles)
      let newActiveId = state.activeTerminalId
      if (state.activeTerminalId === id) {
        const visibleIds = getTerminalIdsFromTree(newLayoutTree).filter(vid => !isEmptyTile(vid))
        newActiveId = visibleIds.length > 0 ? visibleIds[0] : null
      }

      return {
        layoutTree: newLayoutTree,
        minimizedTerminals,
        activeTerminalId: newActiveId,
      }
    })
  },

  restoreTerminal: (id: string) => {
    set((state) => {
      // Don't restore if not minimized
      if (!state.minimizedTerminals.includes(id)) return state

      // Remove from minimized list
      const minimizedTerminals = state.minimizedTerminals.filter((tid) => tid !== id)

      // Add back to layout tree, filling empty space first
      const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
      const newLayoutTree = insertTerminalFillEmpty(state.layoutTree, id, state.activeTerminalId, splitDir)

      return {
        layoutTree: newLayoutTree,
        minimizedTerminals,
        activeTerminalId: id,
      }
    })
  },

  // Remove from minimized list only (used when preview system already inserted into tree)
  removeFromMinimizedList: (id: string) => {
    set((state) => {
      if (!state.minimizedTerminals.includes(id)) return state

      return {
        minimizedTerminals: state.minimizedTerminals.filter((tid) => tid !== id),
        activeTerminalId: id,
      }
    })
  },

  resetLayout: () => {
    set((state) => {
      // Get all terminal IDs (both visible and minimized), excluding empty tiles
      const visibleIds = getTerminalIdsFromTree(state.layoutTree).filter(id => !isEmptyTile(id))
      const allIds = [...visibleIds, ...state.minimizedTerminals]

      // Sort by gridPosition for consistent ordering
      const sortedIds = allIds.sort((a, b) => {
        const termA = state.terminals.get(a)
        const termB = state.terminals.get(b)
        return (termA?.gridPosition ?? 0) - (termB?.gridPosition ?? 0)
      })

      // Create a fresh balanced layout
      const newLayoutTree = createDefaultLayoutTree(sortedIds)

      return {
        layoutTree: newLayoutTree,
        minimizedTerminals: [],
        currentLayoutPreset: 'grid' as LayoutPresetType,
      }
    })
  },

  cycleLayoutPreset: () => {
    set((state) => {
      // Get enabled presets from appSettingsStore (respects user order)
      const appSettings = useAppSettingsStore.getState()
      const enabledPresets = appSettings.getEnabledLayoutPresets()
      if (enabledPresets.length === 0) return state

      // Find current index in enabled list, then advance
      const currentIndex = enabledPresets.indexOf(state.currentLayoutPreset)
      const nextIndex = (currentIndex + 1) % enabledPresets.length
      const nextPresetType = enabledPresets[nextIndex]

      // Only get visible terminal IDs (excluding empty tiles) - don't touch minimized ones
      const visibleIds = getTerminalIdsFromTree(state.layoutTree).filter(id => !isEmptyTile(id))

      // Sort by gridPosition for consistent ordering (tools without gridPosition default to 0)
      const sortedIds = [...visibleIds].sort((a, b) => {
        const termA = state.terminals.get(a)
        const termB = state.terminals.get(b)
        return (termA?.gridPosition ?? 0) - (termB?.gridPosition ?? 0)
      })

      // Get locked terminal IDs
      const lockedTerminalIds = Array.from(state.terminals.values())
        .filter((t) => t.isLocked && visibleIds.includes(t.id))
        .map((t) => t.id)

      // Get locked tool IDs from tool store
      const toolStore = useToolStore.getState()
      const toolInstancesArray = Array.from(toolStore.toolInstances.values()) as ToolInstance[]
      const lockedToolIds = toolInstancesArray
        .filter((t) => t.isLocked && visibleIds.includes(t.id))
        .map((t) => t.id)

      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])

      // Get grid config if switching to grid preset
      const gridConfig: GridConfig | undefined = nextPresetType === 'grid'
        ? appSettings.layoutPresets.gridConfig
        : undefined

      // Create layout based on preset, preserving locked pane positions
      const { layoutTree, minimizedIds: newMinimizedIds } = createLayoutPreservingLocked(
        state.layoutTree,
        nextPresetType,
        sortedIds,
        lockedIds,
        state.activeTerminalId,
        gridConfig
      )

      // Keep existing minimized terminals and add any new ones from the preset (e.g., focus mode)
      // But never minimize locked terminals
      const filteredNewMinimizedIds = newMinimizedIds.filter(id => !lockedIds.has(id))
      // Route to the correct store: terminal IDs → minimizedTerminals, tool IDs → toolStore.minimizedTools.
      // Without this split, tool IDs end up in minimizedTerminals where the bar can't render them.
      const newMinimizedTerminalIds = filteredNewMinimizedIds.filter(id => state.terminals.has(id))
      const newMinimizedToolIds = filteredNewMinimizedIds.filter(id => toolStore.toolInstances.has(id))

      if (newMinimizedToolIds.length > 0) {
        useToolStore.setState((ts) => {
          const merged = [...ts.minimizedTools]
          for (const id of newMinimizedToolIds) {
            if (!merged.includes(id)) merged.push(id)
          }
          return { minimizedTools: merged }
        })
      }

      const allMinimizedIds = [...state.minimizedTerminals, ...newMinimizedTerminalIds]

      return {
        layoutTree,
        minimizedTerminals: allMinimizedIds,
        currentLayoutPreset: nextPresetType,
      }
    })
  },

  setLayoutPreset: (presetType: LayoutPresetType) => {
    set((state) => {
      // Only get visible terminal IDs (excluding empty tiles) - don't touch minimized ones
      const visibleIds = getTerminalIdsFromTree(state.layoutTree).filter(id => !isEmptyTile(id))

      // Sort by gridPosition for consistent ordering (tools without gridPosition default to 0)
      const sortedIds = [...visibleIds].sort((a, b) => {
        const termA = state.terminals.get(a)
        const termB = state.terminals.get(b)
        return (termA?.gridPosition ?? 0) - (termB?.gridPosition ?? 0)
      })

      // Get locked terminal IDs
      const lockedTerminalIds = Array.from(state.terminals.values())
        .filter((t) => t.isLocked && visibleIds.includes(t.id))
        .map((t) => t.id)

      // Get locked tool IDs from tool store
      const toolStore = useToolStore.getState()
      const toolInstancesArray = Array.from(toolStore.toolInstances.values()) as ToolInstance[]
      const lockedToolIds = toolInstancesArray
        .filter((t) => t.isLocked && visibleIds.includes(t.id))
        .map((t) => t.id)

      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])

      // Get grid config if switching to grid preset
      const gridConfig: GridConfig | undefined = presetType === 'grid'
        ? useAppSettingsStore.getState().layoutPresets.gridConfig
        : undefined

      // Create layout based on preset, preserving locked pane positions
      const { layoutTree, minimizedIds: newMinimizedIds } = createLayoutPreservingLocked(
        state.layoutTree,
        presetType,
        sortedIds,
        lockedIds,
        state.activeTerminalId,
        gridConfig
      )

      // Keep existing minimized terminals and add any new ones from the preset (e.g., focus mode)
      // But never minimize locked terminals
      const filteredNewMinimizedIds = newMinimizedIds.filter(id => !lockedIds.has(id))
      // Route to the correct store: terminal IDs → minimizedTerminals, tool IDs → toolStore.minimizedTools.
      // Without this split, tool IDs end up in minimizedTerminals where the bar can't render them.
      const newMinimizedTerminalIds = filteredNewMinimizedIds.filter(id => state.terminals.has(id))
      const newMinimizedToolIds = filteredNewMinimizedIds.filter(id => toolStore.toolInstances.has(id))

      if (newMinimizedToolIds.length > 0) {
        useToolStore.setState((ts) => {
          const merged = [...ts.minimizedTools]
          for (const id of newMinimizedToolIds) {
            if (!merged.includes(id)) merged.push(id)
          }
          return { minimizedTools: merged }
        })
      }

      const allMinimizedIds = [...state.minimizedTerminals, ...newMinimizedTerminalIds]

      return {
        layoutTree,
        minimizedTerminals: allMinimizedIds,
        currentLayoutPreset: presetType,
      }
    })
  },

  getCurrentPreset: () => {
    const current = get().currentLayoutPreset
    return LAYOUT_PRESETS.find(p => p.type === current) || LAYOUT_PRESETS[0]
  },

  getTerminalsArray: () => {
    return Array.from(get().terminals.values()).sort(
      (a, b) => a.gridPosition - b.gridPosition
    )
  },

  getVisibleTerminals: () => {
    const state = get()
    const visibleIds = getTerminalIdsFromTree(state.layoutTree)
    return visibleIds
      .map((id) => state.terminals.get(id))
      .filter((t): t is TerminalState => t !== undefined)
  },

  getMinimizedTerminals: () => {
    const state = get()
    return state.minimizedTerminals
      .map((id) => state.terminals.get(id))
      .filter((t): t is TerminalState => t !== undefined)
  },

  getLockedTerminalIds: () => {
    const state = get()
    return Array.from(state.terminals.values())
      .filter((t) => t.isLocked)
      .map((t) => t.id)
  },

  getSerializedLayoutTree: () => {
    return serializeLayoutTree(get().layoutTree)
  },

  clearTerminals: () => {
    // Globally-pinned terminals (scope === 'global') survive session/project
    // switches. Keep them in the Map; remove only session-scoped ones.
    set((state) => {
      const kept = new Map<string, typeof state.terminals extends Map<string, infer V> ? V : never>()
      state.terminals.forEach((t, id) => {
        if (t.scope === 'global') kept.set(id, t)
      })
      const keptMinimized = state.minimizedTerminals.filter(id => kept.has(id))
      return {
        terminals: kept,
        activeTerminalId: null,
        layoutTree: null,
        minimizedTerminals: keptMinimized,
      }
    })
  },

  restoreTerminals: async (savedTerminals: SessionTerminal[], workingDirectory: string, layoutTreeJson?: string | null, additionalValidIds?: string[], isStale?: () => boolean) => {
    // Clear existing terminals first
    get().clearTerminals()

    // Track created terminal IDs for layout
    const createdTerminalIds: string[] = []
    const minimizedIds: string[] = []

    // Create new terminals based on saved state
    for (const saved of [...savedTerminals].sort((a, b) => a.gridPosition - b.gridPosition)) {
      if (isStale?.()) return
      try {
        const cwd = saved.workingDirectory || workingDirectory
        // Preserve the original terminal ID when restoring
        const info = await terminalApi.create({ cwd, id: saved.id })

        // Detect reattach vs fresh PTY:
        // - reattached → existing live PTY (its agent is still running: no overlay)
        // - otherwise → new PTY created (the agent is gone: the resume overlay shows)
        const isReattached = info.reattached === true
        const hasAutoResumed = isReattached && saved.agent ? true : undefined

        createdTerminalIds.push(info.id)
        if (saved.isMinimized) {
          minimizedIds.push(info.id)
        }

        // Add terminal with restored metadata (but don't touch layout tree yet)
        set((state) => {
          const terminals = new Map(state.terminals)
          const restoredNow = Date.now()
          const newTerminal: TerminalState = {
            id: info.id,
            title: saved.title || `Terminal ${terminals.size + 1}`,
            titleSource: saved.titleSource || (saved.title ? 'manual' : 'default'),
            originalPrompt: saved.originalPrompt || null,
            summary: null,
            workingDirectory: info.cwd,
            gridPosition: saved.gridPosition,
            status: 'active',
            createdAt: restoredNow,
            pid: info.pid,
            isLoading: false,
            lastActivityAt: restoredNow,
            pendingBufferContent: isReattached ? undefined : saved.bufferContent,
            agent: saved.agent ?? null,
            role: saved.role,
            customRoleLabel: saved.customRoleLabel,
            isLocked: saved.isLocked,
            hasAutoResumed,
          }
          terminals.set(info.id, newTerminal)
          terminalActivityMap.set(info.id, restoredNow)
          return {
            terminals,
            activeTerminalId: state.activeTerminalId || info.id,
          }
        })
      } catch (error) {
        console.error('Failed to restore terminal:', error)
      }
    }

    if (isStale?.()) return

    // After all terminals are created, set up the layout
    const visibleIds = createdTerminalIds.filter((id) => !minimizedIds.includes(id))

    // Combine terminal visible IDs with additional valid IDs (e.g. tool instance IDs)
    const allValidIds = [...visibleIds, ...(additionalValidIds ?? [])]

    // Try to restore saved layout tree, or create a default one
    let layoutTree: MosaicNode<string> | null = null
    if (layoutTreeJson) {
      layoutTree = deserializeLayoutTree(layoutTreeJson)
      // Validate that the layout tree contains the correct terminal and tool IDs
      // (empty placeholder tiles are allowed and don't need to match)
      const treeIds = layoutTree ? getTerminalIdsFromTree(layoutTree) : []
      const nonEmptyTreeIds = treeIds.filter(id => !isEmptyTile(id))
      const validSet = new Set(allValidIds)
      const allValid = nonEmptyTreeIds.every((id) => validSet.has(id)) && nonEmptyTreeIds.length === allValidIds.length
      if (!allValid) {
        // Layout tree doesn't match current terminals/tools, create a new one
        layoutTree = createDefaultLayoutTree(allValidIds)
      }
    } else {
      // No saved layout, create default
      layoutTree = createDefaultLayoutTree(allValidIds)
    }

    set({
      layoutTree,
      minimizedTerminals: minimizedIds,
    })
  },

  // Attention management
  setTerminalAttention: (id: string, needsAttention: boolean) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      const terminal = terminals.get(id)
      if (terminal) {
        terminals.set(id, { ...terminal, needsAttention })
      }
      return { terminals }
    })
  },

  clearAllAttention: () => {
    set((state) => {
      const terminals = new Map(state.terminals)
      terminals.forEach((terminal, id) => {
        if (terminal.needsAttention) {
          terminals.set(id, { ...terminal, needsAttention: false })
        }
      })
      return { terminals }
    })
  },

  // Idle management
  setTerminalIdle: (id: string, isIdle: boolean) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      const terminal = terminals.get(id)
      if (terminal && terminal.isIdle !== isIdle) {
        terminals.set(id, { ...terminal, isIdle })
      }
      return { terminals }
    })
  },

  checkIdleTerminals: () => {
    const { theme } = useAppSettingsStore.getState()
    if (!theme.idleGlowEnabled) {
      // If disabled, clear any existing idle states
      const state = get()
      const terminals = state.terminals
      let hasIdle = false
      terminals.forEach((t) => { if (t.isIdle) hasIdle = true })
      if (hasIdle) {
        set((state) => {
          const terminals = new Map(state.terminals)
          terminals.forEach((terminal, id) => {
            if (terminal.isIdle) {
              terminals.set(id, { ...terminal, isIdle: false })
            }
          })
          return { terminals }
        })
      }
      return
    }

    const now = Date.now()
    const thresholdMs = theme.idleTimeoutSeconds * 1000
    const state = get()

    state.terminals.forEach((terminal, id) => {
      if (terminal.status !== 'active') return
      const lastActivity = terminalActivityMap.get(id) ?? terminal.lastActivityAt ?? terminal.createdAt
      const isIdleNow = (now - lastActivity) >= thresholdMs
      if (terminal.isIdle !== isIdleNow) {
        get().setTerminalIdle(id, isIdleNow)
      }
    })
  },

  startIdleChecker: () => {
    if (idleCheckerInterval) return
    idleCheckerInterval = setInterval(() => {
      get().checkIdleTerminals()
    }, 5000)
  },

  stopIdleChecker: () => {
    if (idleCheckerInterval) {
      clearInterval(idleCheckerInterval)
      idleCheckerInterval = null
    }
  },

  // Lock management
  toggleTerminalLock: (id: string) => {
    set((state) => {
      const terminals = new Map(state.terminals)
      const terminal = terminals.get(id)
      if (!terminal) return state

      const nowLocked = !terminal.isLocked
      terminals.set(id, { ...terminal, isLocked: nowLocked })

      // If unlocking, collapse any empty tiles no longer adjacent to locked panes
      if (!nowLocked) {
        const lockedTerminalIds = Array.from(terminals.values())
          .filter(t => t.isLocked)
          .map(t => t.id)
        const toolStore = useToolStore.getState()
        const lockedToolIds = Array.from(toolStore.toolInstances.values())
          .filter((t: any) => t.isLocked)
          .map((t: any) => t.id)
        const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])
        const newTree = collapseUnneededEmptyTiles(state.layoutTree, lockedIds)
        return { terminals, layoutTree: newTree }
      }

      return { terminals }
    })
  },

  isTerminalLocked: (id: string) => {
    const terminal = get().terminals.get(id)
    return terminal?.isLocked ?? false
  },

  promoteToMain: (id: string) => {
    set((state) => {
      const preset = state.currentLayoutPreset
      if (preset !== 'mainBottom' && preset !== 'mainSidebar') return state
      const newTree = swapWithMain(state.layoutTree, id)
      if (newTree === state.layoutTree) return state
      return { layoutTree: newTree, activeTerminalId: id }
    })
  },

  // Remove all empty tiles from the layout tree (fills empty space)
  removeAllEmptySpace: () => {
    set((state) => {
      let tree = state.layoutTree
      if (!tree) return state

      // Find and remove all empty tiles
      const ids = getTerminalIdsFromTree(tree)
      const emptyIds = ids.filter(id => isEmptyTile(id))
      if (emptyIds.length === 0) return state

      for (const emptyId of emptyIds) {
        if (tree) {
          tree = removeTerminalFromTree(tree, emptyId)
        }
      }
      return { layoutTree: tree }
    })
  },
}))

// Auto-start idle checker on module init
if (typeof window !== 'undefined') {
  useTerminalStore.getState().startIdleChecker()
}
