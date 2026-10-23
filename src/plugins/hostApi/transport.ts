/**
 * Trusted transport (plugin-system.md §7.2): privileged calls go straight to
 * the Rust dispatch table through `plugin_invoke` / `plugin_subscribe`.
 * The sandbox bridge (PL-6) calls the same functions on behalf of a frame.
 */
import { Channel } from '@tauri-apps/api/core'
import { HostError, type Disposable, type HostErrorCode, type JsonValue } from '@quadflow/plugin-api'
import { commands, type CoreError } from '../../generated/bindings'

export interface HostTransport {
  invoke<T = JsonValue>(method: string, params?: Record<string, unknown>): Promise<T>
  /** `onItem` receives every stream item; returns an unsubscribe. */
  subscribe(topic: string, params: Record<string, unknown>, onItem: (item: JsonValue) => void): {
    ready: Promise<void>
    dispose: Disposable
  }
}

export function toHostError(e: unknown): HostError {
  if (e instanceof HostError) return e
  const ce = e as Partial<CoreError> | undefined
  if (ce && typeof ce === 'object' && typeof ce.code === 'string' && typeof ce.message === 'string') {
    return new HostError(ce.code as HostErrorCode, ce.message, (ce as { details?: JsonValue }).details)
  }
  return new HostError('internal', e instanceof Error ? e.message : String(e))
}

/** Strip `undefined` so Rust sees missing (= default) params. */
function clean(params: Record<string, unknown> | undefined): JsonValue {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) out[k] = v as JsonValue
  return out
}

export function trustedTransport(pluginId: string): HostTransport {
  return {
    async invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      let r: Awaited<ReturnType<typeof commands.pluginInvoke>>
      try {
        r = await commands.pluginInvoke(pluginId, method, clean(params))
      } catch (e) {
        throw toHostError(e)
      }
      if (r.status === 'error') throw toHostError(r.error)
      return r.data as T
    },
    subscribe(topic, params, onItem) {
      let id: number | null = null
      let disposed = false
      const channel = new Channel<JsonValue>()
      channel.onmessage = (item) => {
        if (!disposed) onItem(item)
      }
      const ready = commands.pluginSubscribe(pluginId, topic, clean(params), channel).then((r) => {
        if (r.status === 'error') throw toHostError(r.error)
        id = r.data
        if (disposed) void commands.pluginUnsubscribe(r.data)
      })
      return {
        ready,
        dispose: () => {
          if (disposed) return
          disposed = true
          if (id !== null) void commands.pluginUnsubscribe(id)
        },
      }
    },
  }
}

let methodsPromise: Promise<Set<string>> | null = null
let methods: Set<string> | null = null

/**
 * Methods/topics the Rust host serves (fetched once; the first call of this
 * document also resets stale subscriptions from a previous page load).
 */
export function loadHostMethods(): Promise<Set<string>> {
  if (!methodsPromise) {
    methodsPromise = commands
      .pluginHostMethods(true)
      .then((r) => {
        if (r.status === 'error') throw toHostError(r.error)
        methods = new Set(r.data)
        return methods
      })
      .catch((e) => {
        methodsPromise = null
        throw e
      })
  }
  return methodsPromise
}

/** Synchronous view (empty until `loadHostMethods()` resolved). */
export function hostMethods(): Set<string> {
  return methods ?? new Set()
}
