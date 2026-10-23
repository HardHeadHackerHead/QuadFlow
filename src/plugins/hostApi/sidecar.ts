/**
 * `ctx.sidecar` (plugin-system.md §6.7, §10.5): a plugin's UI talks to its own
 * sidecar through the `plugin_sidecar_*` commands (the supervisor starts it on
 * demand). Sidecar notifications arrive as the Tauri event `plugin-sidecar`:
 *  - `ui/<name>`  → `ctx.sidecar.onNotification(name, …)` of that plugin;
 *  - `host/emit`  → the plugin event bus as `"<pluginId>:<topic>"` (`ctx.events.onPlugin`).
 */
import type { Disposable, JsonValue, SidecarApi, SidecarStatus } from '@quadflow/plugin-api'
import { listen } from '@tauri-apps/api/event'
import { commands, type PluginSidecarStatus } from '../../generated/bindings'
import { toHostError } from './transport'
import { emitPluginEvent } from './events'

type Cb = (params: JsonValue) => void
const listeners = new Map<string, Set<Cb>>()
const statusListeners = new Set<(s: PluginSidecarStatus) => void>()
let wired = false

function wire() {
  if (wired) return
  wired = true
  void listen<{ pluginId: string; method: string; params: JsonValue }>('plugin-sidecar', (ev) => {
    const { pluginId, method, params } = ev.payload
    if (method === 'host/emit') {
      const p = (params ?? {}) as { topic?: unknown; payload?: JsonValue }
      if (typeof p.topic === 'string' && p.topic) emitPluginEvent(pluginId, p.topic, p.payload ?? null)
      return
    }
    if (!method.startsWith('ui/')) return
    listeners.get(`${pluginId}\u0000${method.slice(3)}`)?.forEach((cb) => {
      try {
        cb(params ?? null)
      } catch (e) {
        console.error(`[plugin:${pluginId}] sidecar notification handler threw`, e)
      }
    })
  })
  void listen<PluginSidecarStatus>('plugin-sidecar-status', (ev) => statusListeners.forEach((cb) => cb(ev.payload)))
}

/** Shell-side subscription to every sidecar's status (Settings → Plugins). */
export function onSidecarStatus(cb: (s: PluginSidecarStatus) => void): Disposable {
  wire()
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

async function unwrap<T>(p: Promise<{ status: 'ok'; data: T } | { status: 'error'; error: unknown }>): Promise<T> {
  let r: Awaited<typeof p>
  try {
    r = await p
  } catch (e) {
    throw toHostError(e)
  }
  if (r.status === 'error') throw toHostError(r.error)
  return r.data
}

function toStatus(s: PluginSidecarStatus): SidecarStatus {
  return { state: s.state, restarts: s.restarts, lastError: s.lastError ?? undefined, pid: s.pid ?? undefined }
}

export function createSidecarApi(pluginId: string, warn: (...a: unknown[]) => void): SidecarApi {
  wire()
  return {
    request: <T,>(method: string, params?: JsonValue, opts?: { timeoutMs?: number }) =>
      unwrap(commands.pluginSidecarRequest(pluginId, method, params ?? null, opts?.timeoutMs ?? null)) as Promise<T>,
    notify: (method, params) => {
      unwrap(commands.pluginSidecarNotify(pluginId, method, params ?? null)).catch((e) => warn(`sidecar.notify(${method}) failed:`, e))
    },
    onNotification: (name, cb) => {
      const key = `${pluginId}\u0000${name}`
      let s = listeners.get(key)
      if (!s) listeners.set(key, (s = new Set()))
      s.add(cb)
      return () => s!.delete(cb)
    },
    status: async () => toStatus(await unwrap(commands.pluginSidecarStatus(pluginId))),
    restart: async () => {
      await unwrap(commands.pluginSidecarRestart(pluginId))
    },
    onStatus: (cb) => {
      wire()
      const l = (s: PluginSidecarStatus) => {
        if (s.pluginId === pluginId) cb(toStatus(s))
      }
      statusListeners.add(l)
      return () => statusListeners.delete(l)
    },
    logs: () => unwrap(commands.pluginSidecarLogs(pluginId)),
  }
}
