/**
 * Plugin loading (plugin-system.md §8.3 step 4, §8.4).
 *
 * Trusted: `import()` of the plugin's `ui.entry` from `qfplugin://`; bare
 * imports of the shared specifiers resolve through the document import map to
 * the host's module instances. The manifest's `ui.style` is injected as a
 * stylesheet link. `activate(ctx)` runs once per load, the first time the
 * plugin is needed (a tile opens, a command runs) or at startup for `onStartup`.
 *
 * Sandboxed: the same lifecycle, but `activate()` and the command handlers run
 * in the plugin's background frame (./sandbox.ts); the loaded "module" is a
 * host-side stand-in whose commands call into that frame, and tiles render in
 * their own frames (`SandboxedTile`). `ctx` is the plugin's host context, which
 * the RPC bridge serves to its frames.
 */
import type { PluginContext, PluginModule } from '@quadflow/plugin-api'
import { createHostContext, disposeHostContext, emitHostEvent, wireSystemNotifications } from './hostApi'
import { usePluginRegistry, type PluginInfo } from './registry'
import { sandboxedModule, startBackgroundFrame } from './sandbox'
import { pluginUrl } from './urls'

export interface LoadedPluginModule {
  id: string
  module: PluginModule
  ctx: PluginContext
  generation: number
  /** Cache-buster of this load (`v=` query value). Sandboxed tile frames reuse it. */
  bust: string
}

/**
 * The `v=` cache-buster of a plugin's entry, style and frames. The ES module map and the HTTP
 * cache are per URL, so a re-import needs a new one: dev plugins get a timestamp on every load;
 * other plugins `<version>.<generation>` — a new version (update, rollback, reinstall) or a
 * registry reload (generation bump) means a new URL, an unchanged plugin keeps a cacheable one.
 * Relative chunk imports need no buster: the build hashes chunk names.
 */
export function cacheBuster(info: PluginInfo, generation: number): string {
  return info.origin === 'dev' ? String(Date.now()) : `${info.version ?? '0.0.0'}.${generation}`
}

const loaded = new Map<string, { generation: number; promise: Promise<LoadedPluginModule> }>()

export class PluginLoadError extends Error {
  constructor(public pluginId: string, message: string) {
    super(message)
    this.name = 'PluginLoadError'
  }
}

function styleId(pluginId: string) {
  return `qf-plugin-style-${pluginId}`
}

function injectStyle(info: PluginInfo, bust: string) {
  const style = info.manifest?.ui?.style
  document.getElementById(styleId(info.id))?.remove()
  if (!style) return
  const link = document.createElement('link')
  link.id = styleId(info.id)
  link.rel = 'stylesheet'
  link.href = `${pluginUrl(info.id, style)}?v=${encodeURIComponent(bust)}`
  link.dataset.qfPlugin = info.id
  document.head.appendChild(link)
}

function checkLoadable(info: PluginInfo | undefined, id: string): PluginInfo {
  if (!info) throw new PluginLoadError(id, `Plugin "${id}" is not installed`)
  if (info.status.kind !== 'active') {
    throw new PluginLoadError(id, `Plugin "${id}" is not active (${info.status.kind})`)
  }
  if (!info.manifest?.ui?.entry) throw new PluginLoadError(id, `Plugin "${id}" has no UI entry`)
  return info
}

/**
 * Internal plugins whose UI module ships inside the host bundle: `core` (the
 * shell's terminals, agents and session history — they drive the shell's own
 * stores). Only their `bundled` copy may use this; any other origin loads `ui.entry`.
 */
const INTERNAL_MODULES: Record<string, () => Promise<{ default?: unknown }>> = {
  core: () => import('./core'),
}

async function startSandboxed(info: PluginInfo, generation: number): Promise<LoadedPluginModule> {
  wireSystemNotifications()
  const ctx = await createHostContext(info)
  const bust = cacheBuster(info, generation)
  let bg
  try {
    bg = await startBackgroundFrame(info, ctx, bust)
  } catch (e) {
    throw new PluginLoadError(info.id, e instanceof Error ? e.message : String(e))
  }
  emitHostEvent('plugin.activated', { pluginId: info.id })
  return { id: info.id, module: sandboxedModule(info, bg), ctx, generation, bust }
}

async function importModule(info: PluginInfo, generation: number): Promise<LoadedPluginModule> {
  if (info.isolation === 'sandboxed') return startSandboxed(info, generation)
  const bust = cacheBuster(info, generation)
  const url = `${pluginUrl(info.id, info.manifest!.ui!.entry)}?v=${encodeURIComponent(bust)}`
  const internal = info.origin === 'bundled' ? INTERNAL_MODULES[info.id] : undefined
  if (!internal) injectStyle(info, bust)
  let ns: { default?: unknown }
  try {
    ns = internal ? await internal() : await import(/* @vite-ignore */ url)
  } catch (e) {
    throw new PluginLoadError(info.id, `Failed to load ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const module = ns.default as PluginModule | undefined
  if (!module || typeof module !== 'object') {
    throw new PluginLoadError(info.id, `${info.manifest!.ui!.entry} has no default export (use definePlugin())`)
  }
  wireSystemNotifications()
  const ctx = await createHostContext(info)
  if (module.activate) {
    try {
      await module.activate(ctx)
    } catch (e) {
      throw new PluginLoadError(info.id, `activate() failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  emitHostEvent('plugin.activated', { pluginId: info.id })
  return { id: info.id, module, ctx, generation, bust }
}

/** Load (once per registry generation) and activate a trusted plugin's UI module. */
export function loadPluginModule(pluginId: string): Promise<LoadedPluginModule> {
  const { getPlugin, generations } = usePluginRegistry.getState()
  const generation = generations[pluginId] ?? 0
  const cached = loaded.get(pluginId)
  if (cached && cached.generation === generation) return cached.promise

  const previous = cached?.promise
  const promise = (async () => {
    if (previous) {
      // Reload (new generation): the old module goes first, with what it registered —
      // command handlers and its context (settings snapshot, caches).
      await deactivate(previous)
      disposeHostContext(pluginId)
    }
    const info = checkLoadable(getPlugin(pluginId), pluginId)
    return importModule(info, generation)
  })()
  // A failed load is retried on the next request.
  promise.catch(() => {
    if (loaded.get(pluginId)?.promise === promise) loaded.delete(pluginId)
  })
  loaded.set(pluginId, { generation, promise })
  return promise
}

async function deactivate(p: Promise<LoadedPluginModule>) {
  try {
    const m = await p
    await m.module.deactivate?.()
    emitHostEvent('plugin.deactivated', { pluginId: m.id })
  } catch {
    // Previous load failed or deactivate threw: nothing to undo.
  }
}

/** Has the plugin's module been loaded (or is it loading) in this window? */
export function isPluginLoaded(pluginId: string): boolean {
  return loaded.has(pluginId)
}

/** Deactivate and forget a plugin's module (disable / uninstall). */
export async function unloadPlugin(pluginId: string): Promise<void> {
  const cached = loaded.get(pluginId)
  loaded.delete(pluginId)
  if (cached) await deactivate(cached.promise)
  document.getElementById(styleId(pluginId))?.remove()
  disposeHostContext(pluginId)
}

/**
 * App exit / relaunch: run every loaded plugin's `deactivate()` (in parallel,
 * each bounded by `timeoutMs`) while the main window still exists, so plugins
 * can release native resources tied to it (External Apps gives embedded
 * windows back before their parent window is destroyed).
 */
export async function deactivateAllPlugins(timeoutMs = 2500): Promise<void> {
  const all = Array.from(loaded.values())
  loaded.clear()
  await Promise.all(
    all.map((c) => Promise.race([deactivate(c.promise), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))])),
  )
}

/** Activate every active plugin whose manifest lists `onStartup` (sandboxed ones in their background frame). */
export async function activateStartupPlugins(): Promise<void> {
  const { plugins } = usePluginRegistry.getState()
  await Promise.all(
    plugins
      .filter((p) => p.status.kind === 'active' && p.manifest?.activation?.includes('onStartup'))
      .map((p) => loadPluginModule(p.id).catch((e) => console.error(`[plugins] ${p.id}:`, e))),
  )
}
