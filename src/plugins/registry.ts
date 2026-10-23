/**
 * Frontend plugin registry (plugin-system.md §5.4): the installed plugins and
 * the flattened contributions of active ones, read from the Rust registry
 * (`plugins_list`, `plugins_contributions`).
 */
import { create } from 'zustand'
import { call } from '../lib/core'
import {
  commands,
  type Contributions_Serialize,
  type PluginInfo_Serialize,
  type TileContribution_Serialize,
} from '../generated/bindings'

export type PluginInfo = PluginInfo_Serialize
export type PluginContributions = Contributions_Serialize
export type PluginTileContribution = TileContribution_Serialize

export type PluginRegistryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface PluginRegistryState {
  plugins: PluginInfo[]
  contributions: PluginContributions | null
  status: PluginRegistryStatus
  error: string | null
  /** Bumped by `reload(id)`; the loader re-imports modules whose generation changed. */
  generations: Record<string, number>

  /** Load (or refresh) plugins + contributions. Concurrent calls share one request. */
  load(): Promise<void>
  /** Refresh the registry and mark `id` for re-import (dev reload, enable/disable). */
  reload(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>

  getPlugin(id: string): PluginInfo | undefined
  getTile(pluginId: string, contributionId: string): PluginTileContribution | undefined
}

let inflight: Promise<void> | null = null

export const usePluginRegistry = create<PluginRegistryState>((set, get) => ({
  plugins: [],
  contributions: null,
  status: 'idle',
  error: null,
  generations: {},

  load() {
    if (inflight) return inflight
    set({ status: get().status === 'ready' ? 'ready' : 'loading' })
    inflight = (async () => {
      try {
        const [plugins, contributions] = await Promise.all([
          call(commands.pluginsList(false)),
          call(commands.pluginsContributions()),
        ])
        set({ plugins, contributions, status: 'ready', error: null })
      } catch (e) {
        console.error('[plugins] failed to load the plugin registry:', e)
        set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      } finally {
        inflight = null
      }
    })()
    return inflight
  },

  async reload(id) {
    await get().load()
    set((s) => ({ generations: { ...s.generations, [id]: (s.generations[id] ?? 0) + 1 } }))
  },

  async enable(id) {
    await call(commands.pluginsEnable(id))
    await get().reload(id)
  },

  async disable(id) {
    await call(commands.pluginsDisable(id))
    await get().reload(id)
  },

  getPlugin(id) {
    return get().plugins.find((p) => p.id === id)
  },

  getTile(pluginId, contributionId) {
    return get().contributions?.tiles.find((t) => t.pluginId === pluginId && t.contribution.id === contributionId)
  },
}))

/** Ensure the registry has been loaded at least once. */
export function ensurePluginRegistry(): Promise<void> {
  const s = usePluginRegistry.getState()
  return s.status === 'ready' ? Promise.resolve() : s.load()
}
