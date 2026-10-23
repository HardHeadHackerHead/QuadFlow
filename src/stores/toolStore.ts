import { create } from 'zustand'
import { ToolConfig, ToolInstance, ToolOpenMode, ToolPinDisplay, SessionToolInstance } from '../types'
import * as appData from '../lib/appData'
import { terminalApi } from '../lib/tauri-api'
import { notifyTileClosed } from '../plugins/hostApi/tiles'
import { newToolLeafId } from '../lib/layoutIds'

interface ToolStore {
  toolConfigs: Map<string, ToolConfig>
  toolInstances: Map<string, ToolInstance>
  showToolConfigModal: boolean
  editingToolId: string | null
  minimizedTools: string[]
  activeFlyout: { configId: string; anchorRect: DOMRect } | null
  flyoutInstances: Map<string, string>  // configId -> instanceId for TUI flyout persistence

  // Actions
  loadToolConfigs: () => Promise<void>
  /** Create a config for a plugin contribution (`{ pluginId, contributionId }`). */
  addToolConfig: (name: string, ref: appData.ToolContributionRef, options?: {
    icon?: string
    executablePath?: string
    args?: string[]
    workingDirectory?: string
    settings?: Record<string, unknown>
    quickLaunch?: boolean
    pinned?: boolean
    openMode?: ToolOpenMode
    pinDisplay?: ToolPinDisplay
    color?: string
  }) => Promise<ToolConfig>
  updateToolConfig: (id: string, updates: appData.ToolConfigUpdates) => Promise<void>
  deleteToolConfig: (id: string) => Promise<void>
  reorderToolConfigs: (orderedIds: string[]) => Promise<void>
  reorderPinnedTools: (orderedIds: string[]) => Promise<void>
  openTool: (configId: string, metadata?: Record<string, unknown>) => Promise<string>  // Returns instance ID
  closeTool: (instanceId: string) => void
  minimizeTool: (instanceId: string) => void
  restoreTool: (instanceId: string) => void
  setShowToolConfigModal: (show: boolean) => void
  setEditingToolId: (id: string | null) => void
  getEnabledTools: () => ToolConfig[]
  getHiddenTools: () => ToolConfig[]
  getPinnedTools: () => ToolConfig[]
  getQuickLaunchTools: () => ToolConfig[]
  toggleToolPinned: (id: string) => Promise<void>
  toggleQuickLaunch: (id: string) => Promise<void>
  setToolColor: (id: string, color: string | undefined) => Promise<void>
  hideToolFromDropdown: (id: string) => Promise<void>
  showToolInDropdown: (id: string) => Promise<void>
  getToolInstancesArray: () => ToolInstance[]
  getMinimizedToolInstances: () => ToolInstance[]
  clearToolInstances: () => void
  restoreToolInstances: (savedInstances: SessionToolInstance[], isStale?: () => boolean) => Promise<void>
  // Transfer between session and global workspace stores (does NOT kill PTY).
  detachInstanceForTransfer: (instanceId: string) => ToolInstance | undefined
  attachInstanceFromTransfer: (instance: ToolInstance) => void
  // Instance updates
  updateTool: (id: string, updates: Partial<ToolInstance>) => void
  // Flyout management
  openFlyout: (configId: string, anchorRect: DOMRect) => void | Promise<void>
  /** The flyout's tile instance for `configId`, created when missing; null when that failed. */
  ensureFlyoutInstance: (configId: string) => Promise<string | null>
  closeFlyout: () => void
  closeFlyoutInstance: (configId: string) => void
  popFlyoutToPane: (configId: string) => string | null
  // Attention management
  setToolAttention: (id: string, needsAttention: boolean) => void
  clearAllAttention: () => void
  // Lock management
  toggleToolLock: (id: string) => void | Promise<void>
  isToolLocked: (id: string) => boolean
  getLockedToolIds: () => string[]
  // Reset built-in tools to defaults
  resetToDefaults: () => Promise<void>
}

export const useToolStore = create<ToolStore>((set, get) => ({
  toolConfigs: new Map(),
  toolInstances: new Map(),
  showToolConfigModal: false,
  editingToolId: null,
  minimizedTools: [],
  activeFlyout: null,
  flyoutInstances: new Map(),

  loadToolConfigs: async () => {
    try {
      const tools = await appData.listToolConfigs()
      const toolConfigs = new Map(tools.map(t => [t.id, t]))
      set({ toolConfigs })
    } catch (error) {
      console.error('Failed to load tool configs:', error)
    }
  },

  addToolConfig: async (name, ref, options) => {
    const newTool = await appData.createToolConfig(name, ref, options)
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      toolConfigs.set(newTool.id, newTool)
      return { toolConfigs }
    })
    return newTool
  },

  updateToolConfig: async (id, updates) => {
    const updated = await appData.updateToolConfig(id, updates)
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      toolConfigs.set(id, updated)
      return { toolConfigs }
    })
  },

  deleteToolConfig: async (id) => {
    // Prevent deletion of built-in tools
    const config = get().toolConfigs.get(id)
    if (config?.builtIn) return

    // Clean up any flyout instance for this config
    get().closeFlyoutInstance(id)
    await appData.deleteToolConfig(id)
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      toolConfigs.delete(id)
      return { toolConfigs }
    })
  },

  reorderToolConfigs: async (orderedIds) => {
    await appData.reorderToolConfigs(orderedIds, 'sort')
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      orderedIds.forEach((id, index) => {
        const tool = toolConfigs.get(id)
        if (tool) {
          toolConfigs.set(id, { ...tool, order: index })
        }
      })
      return { toolConfigs }
    })
  },

  reorderPinnedTools: async (orderedIds) => {
    await appData.reorderToolConfigs(orderedIds, 'pin')
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      orderedIds.forEach((id, index) => {
        const tool = toolConfigs.get(id)
        if (tool) {
          toolConfigs.set(id, { ...tool, pinOrder: index })
        }
      })
      return { toolConfigs }
    })
  },

  openTool: async (configId: string, metadata?: Record<string, unknown>) => {
    const config = get().toolConfigs.get(configId)
    if (!config) {
      throw new Error(`Tool config not found: ${configId}`)
    }

    // Toolbar-item configs (terminal, AI agent, …) never get here: callers
    // go through activateTool (src/plugins/tools.tsx), which runs their command.
    const instanceId = newToolLeafId()

    const instance: ToolInstance = {
      id: instanceId,
      configId,
      title: config.name,
      status: 'active',
      createdAt: Date.now(),
      metadata,
    }

    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      toolInstances.set(instanceId, instance)
      return { toolInstances }
    })

    return instanceId
  },

  closeTool: (instanceId: string) => {
    const instance = get().toolInstances.get(instanceId)
    if (instance?.terminalId) {
      // Kill the PTY process using the actual terminal ID
      terminalApi.kill(instance.terminalId).catch(console.error)
    }
    // Explicit close (component unmount only hides a tile, since mosaic may
    // remount it): plugins hear about it through `ui.onTileClosed` and release
    // their native resources (PTYs, child webviews, embedded windows).
    if (instance) {
      const config = get().toolConfigs.get(instance.configId)
      if (config) {
        notifyTileClosed(config.pluginId, config.contributionId, instanceId)
      }
    }

    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      toolInstances.delete(instanceId)
      const minimizedTools = state.minimizedTools.filter(id => id !== instanceId)
      // Also clean flyoutInstances if this instance was a flyout
      const flyoutInstances = new Map(state.flyoutInstances)
      for (const [configId, instId] of flyoutInstances) {
        if (instId === instanceId) {
          flyoutInstances.delete(configId)
          break
        }
      }
      return { toolInstances, minimizedTools, flyoutInstances }
    })
  },

  // Detach an instance from the session toolStore without killing its PTY,
  // so it can be re-attached to the global workspace store. Also strips it
  // from minimizedTools and flyoutInstances.
  detachInstanceForTransfer: (instanceId: string) => {
    const instance = get().toolInstances.get(instanceId)
    if (!instance) return undefined
    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      toolInstances.delete(instanceId)
      const minimizedTools = state.minimizedTools.filter(id => id !== instanceId)
      const flyoutInstances = new Map(state.flyoutInstances)
      for (const [configId, instId] of flyoutInstances) {
        if (instId === instanceId) {
          flyoutInstances.delete(configId)
          break
        }
      }
      return { toolInstances, minimizedTools, flyoutInstances }
    })
    return instance
  },

  // Re-attach a previously-detached instance back into the session toolStore.
  attachInstanceFromTransfer: (instance: ToolInstance) => {
    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      toolInstances.set(instance.id, instance)
      return { toolInstances }
    })
  },

  minimizeTool: (instanceId: string) => {
    set((state) => {
      if (state.minimizedTools.includes(instanceId)) return state
      return { minimizedTools: [...state.minimizedTools, instanceId] }
    })
  },

  restoreTool: (instanceId: string) => {
    set((state) => {
      if (!state.minimizedTools.includes(instanceId)) return state
      return { minimizedTools: state.minimizedTools.filter(id => id !== instanceId) }
    })
  },

  setShowToolConfigModal: (show: boolean) => {
    set({ showToolConfigModal: show })
  },

  setEditingToolId: (id: string | null) => {
    set({ editingToolId: id })
  },

  getEnabledTools: () => {
    const configs = Array.from(get().toolConfigs.values())
    return configs
      .filter(t => t.enabled)
      .sort((a, b) => a.order - b.order)
  },

  getHiddenTools: () => {
    const configs = Array.from(get().toolConfigs.values())
    return configs
      .filter(t => !t.enabled)
      .sort((a, b) => a.order - b.order)
  },

  getPinnedTools: () => {
    const configs = Array.from(get().toolConfigs.values())
    return configs
      .filter(t => t.pinned)
      .sort((a, b) => (a.pinOrder ?? a.order) - (b.pinOrder ?? b.order))
  },

  getQuickLaunchTools: () => {
    const configs = Array.from(get().toolConfigs.values())
    return configs
      .filter(t => t.quickLaunch)
      .sort((a, b) => a.order - b.order)
  },

  toggleToolPinned: async (id: string) => {
    const config = get().toolConfigs.get(id)
    if (!config) return

    const newPinned = !config.pinned

    // When unpinning, close any flyout instance for this tool
    if (!newPinned) {
      get().closeFlyoutInstance(id)
    }

    // When pinning, assign pinOrder = max(existing) + 1 so it appears at the end
    // Also default pinDisplay to 'icon-and-name' to show the full name
    let pinOrder: number | undefined = config.pinOrder
    let pinDisplay: 'icon' | 'icon-and-name' | undefined = undefined
    if (newPinned) {
      const pinnedTools = Array.from(get().toolConfigs.values()).filter(t => t.pinned)
      const maxPinOrder = pinnedTools.reduce((max, t) => Math.max(max, t.pinOrder ?? t.order), -1)
      pinOrder = maxPinOrder + 1
      pinDisplay = 'icon-and-name'
    }

    await appData.updateToolConfig(id, { pinned: newPinned, pinOrder, ...(pinDisplay && { pinDisplay }) })

    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      const existing = toolConfigs.get(id)
      if (existing) {
        toolConfigs.set(id, {
          ...existing,
          pinned: newPinned,
          pinOrder,
          ...(pinDisplay && { pinDisplay }),
          updatedAt: Date.now()
        })
      }
      return { toolConfigs }
    })
  },

  toggleQuickLaunch: async (id: string) => {
    const config = get().toolConfigs.get(id)
    if (!config) return

    const newQuickLaunch = !config.quickLaunch
    await appData.updateToolConfig(id, { quickLaunch: newQuickLaunch })

    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      const existing = toolConfigs.get(id)
      if (existing) {
        toolConfigs.set(id, {
          ...existing,
          quickLaunch: newQuickLaunch,
          updatedAt: Date.now()
        })
      }
      return { toolConfigs }
    })
  },

  setToolColor: async (id: string, color: string | undefined) => {
    await appData.updateToolConfig(id, { color })
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      const existing = toolConfigs.get(id)
      if (existing) {
        toolConfigs.set(id, { ...existing, color, updatedAt: Date.now() })
      }
      return { toolConfigs }
    })
  },

  hideToolFromDropdown: async (id: string) => {
    await appData.updateToolConfig(id, { enabled: false })
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      const existing = toolConfigs.get(id)
      if (existing) {
        toolConfigs.set(id, { ...existing, enabled: false, updatedAt: Date.now() })
      }
      return { toolConfigs }
    })
  },

  showToolInDropdown: async (id: string) => {
    await appData.updateToolConfig(id, { enabled: true })
    set((state) => {
      const toolConfigs = new Map(state.toolConfigs)
      const existing = toolConfigs.get(id)
      if (existing) {
        toolConfigs.set(id, { ...existing, enabled: true, updatedAt: Date.now() })
      }
      return { toolConfigs }
    })
  },

  getToolInstancesArray: () => {
    return Array.from(get().toolInstances.values())
  },

  getMinimizedToolInstances: () => {
    const state = get()
    return state.minimizedTools
      .map(id => state.toolInstances.get(id))
      .filter((t): t is ToolInstance => t !== undefined)
  },

  clearToolInstances: () => {
    // Boundary: this only clears the per-session toolStore. Instances pinned
    // to a global workspace (scope === 'global') live in globalWorkspaceStore
    // — they must not be cleared here. Session-scoped instances also stop
    // being cleared if they happen to be marked global (defensive).
    const instances = get().toolInstances
    instances.forEach((instance) => {
      if (instance.scope === 'global') return
      if (instance.terminalId) {
        terminalApi.kill(instance.terminalId).catch(console.error)
      }
    })
    set((state) => {
      const kept = new Map<string, ToolInstance>()
      state.toolInstances.forEach((t, id) => { if (t.scope === 'global') kept.set(id, t) })
      const keptMinimized = state.minimizedTools.filter(id => kept.has(id))
      const keptFlyouts = new Map<string, string>()
      state.flyoutInstances.forEach((instId, configId) => {
        if (kept.has(instId)) keptFlyouts.set(configId, instId)
      })
      return { toolInstances: kept, minimizedTools: keptMinimized, flyoutInstances: keptFlyouts }
    })
  },

  restoreToolInstances: async (savedInstances: SessionToolInstance[], isStale?: () => boolean) => {
    // Clear existing first
    get().clearToolInstances()

    for (const saved of savedInstances) {
      if (isStale?.()) return
      const config = get().toolConfigs.get(saved.configId)
      if (!config) continue  // Skip if config doesn't exist anymore

      const instance: ToolInstance = {
        id: saved.id,
        configId: saved.configId,
        title: saved.title,
        status: saved.status as 'active' | 'closed' | 'error',
        createdAt: Date.now(),
        isLocked: saved.isLocked,
        isFlyoutInstance: saved.isFlyoutInstance,
        commandLaunched: saved.commandLaunched,
        metadata: saved.metadata ? JSON.parse(saved.metadata) : undefined,
      }

      set((state) => {
        const toolInstances = new Map(state.toolInstances)
        toolInstances.set(instance.id, instance)
        const minimizedTools = saved.isMinimized
          ? [...state.minimizedTools, instance.id]
          : state.minimizedTools
        // Rebuild flyoutInstances from saved isFlyoutInstance entries
        const flyoutInstances = new Map(state.flyoutInstances)
        if (saved.isFlyoutInstance) {
          flyoutInstances.set(saved.configId, instance.id)
        }
        return { toolInstances, minimizedTools, flyoutInstances }
      })
    }
  },

  // Flyout management
  openFlyout: async (configId: string, anchorRect: DOMRect) => {
    if (!get().toolConfigs.get(configId)) return

    // Every flyout is backed by a tile instance that is not in the layout
    // tree (plugin-system.md §5.2): it survives close/reopen (a TUI keeps its
    // PTY), keeps its plugin state and can be popped into a pane.
    if (!(await get().ensureFlyoutInstance(configId))) return
    set({ activeFlyout: { configId, anchorRect } })
  },

  ensureFlyoutInstance: async (configId: string) => {
    const existingInstanceId = get().flyoutInstances.get(configId)
    if (existingInstanceId && get().toolInstances.get(existingInstanceId)) return existingInstanceId
    try {
      const instanceId = await get().openTool(configId)
      get().updateTool(instanceId, { isFlyoutInstance: true })
      set((state) => {
        const flyoutInstances = new Map(state.flyoutInstances)
        flyoutInstances.set(configId, instanceId)
        return { flyoutInstances }
      })
      return instanceId
    } catch (error) {
      console.error('Failed to create flyout instance:', error)
      return null
    }
  },

  closeFlyout: () => {
    set({ activeFlyout: null })
  },

  closeFlyoutInstance: (configId: string) => {
    const instanceId = get().flyoutInstances.get(configId)
    if (!instanceId) return

    // Same teardown as closing a pane (PTY, embedded window, web preview).
    get().closeTool(instanceId)

    set((state) => {
      const flyoutInstances = new Map(state.flyoutInstances)
      flyoutInstances.delete(configId)
      // Close the flyout panel if it's showing this config
      const activeFlyout = state.activeFlyout?.configId === configId ? null : state.activeFlyout
      return { flyoutInstances, activeFlyout }
    })
  },

  popFlyoutToPane: (configId: string) => {
    const instanceId = get().flyoutInstances.get(configId)
    if (!instanceId) return null

    // Remove from flyout registry, clear isFlyoutInstance flag
    set((state) => {
      const flyoutInstances = new Map(state.flyoutInstances)
      flyoutInstances.delete(configId)
      const toolInstances = new Map(state.toolInstances)
      const instance = toolInstances.get(instanceId)
      if (instance) {
        toolInstances.set(instanceId, { ...instance, isFlyoutInstance: false })
      }
      return { flyoutInstances, toolInstances, activeFlyout: null }
    })

    return instanceId
  },

  // Attention management
  updateTool: (id: string, updates: Partial<ToolInstance>) => {
    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      const instance = toolInstances.get(id)
      if (instance) {
        toolInstances.set(id, { ...instance, ...updates })
      }
      return { toolInstances }
    })
  },

  setToolAttention: (id: string, needsAttention: boolean) => {
    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      const instance = toolInstances.get(id)
      if (instance) {
        toolInstances.set(id, { ...instance, needsAttention })
      }
      return { toolInstances }
    })
  },

  clearAllAttention: () => {
    set((state) => {
      const toolInstances = new Map(state.toolInstances)
      toolInstances.forEach((instance, id) => {
        if (instance.needsAttention) {
          toolInstances.set(id, { ...instance, needsAttention: false })
        }
      })
      return { toolInstances }
    })
  },

  // Lock management
  toggleToolLock: async (id: string) => {
    const state = get()
    const instance = state.toolInstances.get(id)
    if (!instance) return

    const nowLocked = !instance.isLocked
    const toolInstances = new Map(state.toolInstances)
    toolInstances.set(id, { ...instance, isLocked: nowLocked })
    set({ toolInstances })

    // If unlocking, collapse any empty tiles no longer adjacent to locked panes
    if (!nowLocked) {
      const { collapseUnneededEmptyTiles } = await import('../lib/layoutUtils')
      const { useTerminalStore } = await import('./terminalStore')
      const termStore = useTerminalStore.getState()
      const lockedTerminalIds = Array.from(termStore.terminals.values() as Iterable<any>)
        .filter((t: any) => t.isLocked)
        .map((t: any) => t.id)
      const lockedToolIds = Array.from(toolInstances.values())
        .filter(t => t.isLocked)
        .map(t => t.id)
      const lockedIds = new Set([...lockedTerminalIds, ...lockedToolIds])
      const newTree = collapseUnneededEmptyTiles(termStore.layoutTree, lockedIds)
      termStore.setLayoutTree(newTree)
    }
  },

  isToolLocked: (id: string) => {
    const instance = get().toolInstances.get(id)
    return instance?.isLocked ?? false
  },

  getLockedToolIds: () => {
    return Array.from(get().toolInstances.values())
      .filter((t) => t.isLocked)
      .map((t) => t.id)
  },

  resetToDefaults: async () => {
    const tools = await appData.resetBuiltInToolConfigs()
    set({ toolConfigs: new Map(tools.map(t => [t.id, t])) })
  },
}))

/** Tool instances that are panes (flyout instances live outside the layout and are not counted). */
export function countPaneTools(instances: Map<string, ToolInstance>): number {
  let n = 0
  for (const i of instances.values()) if (!i.isFlyoutInstance) n++
  return n
}
