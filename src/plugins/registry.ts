/**
 * Frontend plugin registry (plugin-system.md §5.4): the installed plugins and
 * the flattened contributions of active ones, read from the Rust registry
 * (`plugins_list`, `plugins_contributions`).
 *
 * Every refresh diffs the new plugin list against the previous one (§12.4): a
 * plugin whose version, root, origin, isolation, status or manifest changed —
 * install, update, rollback, uninstall, enable/disable, from Settings or from
 * the CLI in another process — gets its generation bumped (the loader then
 * re-imports its module, tiles remount) and is reported to `onPluginChanges`
 * listeners (`liveReload.ts` re-activates it and shows the toast).
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

/** What happened to a plugin between two registry snapshots. */
export type PluginChangeKind =
  | 'installed'
  | 'uninstalled'
  | 'updated'
  | 'rolledBack'
  | 'enabled'
  | 'disabled'
  | 'changed'
  /** `reload(id)` without a registry change (dev rebuild, "Reload" buttons). */
  | 'reloaded'

export interface PluginChange {
  id: string
  kind: PluginChangeKind
  before?: PluginInfo
  after?: PluginInfo
}

interface PluginRegistryState {
  plugins: PluginInfo[]
  contributions: PluginContributions | null
  status: PluginRegistryStatus
  error: string | null
  /** Bumped for every changed plugin; the loader re-imports modules whose generation changed. */
  generations: Record<string, number>

  /** Load (or refresh) plugins + contributions; changed plugins are reloaded. */
  load(): Promise<void>
  /** Refresh the registry and reload `id` even if it did not change (dev reload, "Reload"). */
  reload(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>

  getPlugin(id: string): PluginInfo | undefined
  getTile(pluginId: string, contributionId: string): PluginTileContribution | undefined
}

/** The parts of a plugin that decide which code runs and whether it runs. */
function fingerprint(p: PluginInfo): string {
  return JSON.stringify([p.version, p.root, p.origin, p.isolation, p.status.kind, p.enabled, p.manifest])
}

/** Numeric compare of dotted versions (pre-release tags ignored); 0 when equal or unknown. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parts = (v: string) => v.split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  if (!a || !b) return 0
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** Plugins that changed between two snapshots (plus `forced` ids as `reloaded`). */
export function diffPlugins(before: PluginInfo[], after: PluginInfo[], forced: Iterable<string> = []): PluginChange[] {
  const prev = new Map(before.map((p) => [p.id, p]))
  const next = new Map(after.map((p) => [p.id, p]))
  const out: PluginChange[] = []
  for (const id of new Set([...prev.keys(), ...next.keys()])) {
    const b = prev.get(id)
    const a = next.get(id)
    if (!b && a) out.push({ id, kind: 'installed', after: a })
    else if (b && !a) out.push({ id, kind: 'uninstalled', before: b })
    else if (a && b && fingerprint(a) !== fingerprint(b)) {
      const wasActive = b.status.kind === 'active'
      const isActive = a.status.kind === 'active'
      const cmp = compareVersions(a.version, b.version)
      const kind: PluginChangeKind =
        wasActive && !isActive ? 'disabled'
        : !wasActive && isActive && a.version === b.version ? 'enabled'
        : cmp > 0 ? 'updated'
        : cmp < 0 ? 'rolledBack'
        : 'changed'
      out.push({ id, kind, before: b, after: a })
    }
  }
  for (const id of forced) {
    if (!out.some((c) => c.id === id)) out.push({ id, kind: 'reloaded', before: prev.get(id), after: next.get(id) })
  }
  return out
}

type ChangeListener = (changes: PluginChange[]) => void
const changeListeners = new Set<ChangeListener>()

/** Called after each registry refresh that changed (or force-reloaded) plugins. */
export function onPluginChanges(listener: ChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

let inflight: Promise<void> | null = null
let queued: Promise<void> | null = null
/** Ids `reload(id)` asked for, applied by the next refresh. */
const forced = new Set<string>()

export const usePluginRegistry = create<PluginRegistryState>((set, get) => {
  const refresh = async () => {
    try {
      const [plugins, contributions] = await Promise.all([
        call(commands.pluginsList(false)),
        call(commands.pluginsContributions()),
      ])
      const s = get()
      const force = [...forced]
      forced.clear()
      // The first load has nothing to compare with: everything is new, nothing is loaded yet.
      const changes = s.status === 'ready' || s.plugins.length ? diffPlugins(s.plugins, plugins, force) : []
      const generations = { ...s.generations }
      for (const c of changes) generations[c.id] = (generations[c.id] ?? 0) + 1
      set({ plugins, contributions, status: 'ready', error: null, ...(changes.length ? { generations } : {}) })
      if (changes.length) {
        for (const l of changeListeners) {
          try {
            l(changes)
          } catch (e) {
            console.error('[plugins] change listener failed:', e)
          }
        }
      }
    } catch (e) {
      console.error('[plugins] failed to load the plugin registry:', e)
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    plugins: [],
    contributions: null,
    status: 'idle',
    error: null,
    generations: {},

    load() {
      // One request at a time; a call while one runs gets one fresh request after it (it may
      // have been made because something changed after the running request started).
      if (inflight) {
        if (!queued) {
          queued = inflight.then(() => {
            queued = null
            return get().load()
          })
        }
        return queued
      }
      set({ status: get().status === 'ready' ? 'ready' : 'loading' })
      const p = refresh().finally(() => {
        if (inflight === p) inflight = null
      })
      inflight = p
      return p
    },

    async reload(id) {
      forced.add(id)
      await get().load()
    },

    async enable(id) {
      await call(commands.pluginsEnable(id))
      await get().load()
    },

    async disable(id) {
      await call(commands.pluginsDisable(id))
      await get().load()
    },

    getPlugin(id) {
      return get().plugins.find((p) => p.id === id)
    },

    getTile(pluginId, contributionId) {
      return get().contributions?.tiles.find((t) => t.pluginId === pluginId && t.contribution.id === contributionId)
    },
  }
})

/** Ensure the registry has been loaded at least once. */
export function ensurePluginRegistry(): Promise<void> {
  const s = usePluginRegistry.getState()
  return s.status === 'ready' ? Promise.resolve() : s.load()
}
