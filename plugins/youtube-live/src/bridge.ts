/**
 * The plugin's link to its sidecar. `invoke('youtube_<cmd>', args)` is a sidecar
 * request `<cmd>` with the same args the old Tauri command took; `listen('youtube:<event>')`
 * is the sidecar's `ui/<event>` notification. Keeping the old call shapes keeps the
 * ported views a near-verbatim copy of the pre-plugin tool.
 */
import type { Disposable, JsonValue, PluginContext } from '@quadflow/plugin-api'

let current: PluginContext | null = null

/** Called by every tile / command before it touches the sidecar. */
export function bindContext(ctx: PluginContext) {
  current = ctx
}

export function getCtx(): PluginContext {
  if (!current) throw new Error('youtube-live: plugin context not bound yet')
  return current
}

export type UnlistenFn = () => void

/** Long-running sidecar calls (network round trips through the host). */
const SLOW = new Set(['connect_stream', 'search_streams', 'create_poll', 'create_poll_from_template', 'generate_ai_poll', 'tts_speak', 'refresh_oauth_token', 'promote_to_issue'])

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const method = cmd.replace(/^youtube_/, '')
  // The OAuth flow waits up to 120 s for the browser redirect.
  const timeoutMs = method === 'start_oauth_flow' ? 150_000 : SLOW.has(method) ? 90_000 : 30_000
  try {
    return await getCtx().sidecar.request<T>(method, (args ?? {}) as JsonValue, { timeoutMs })
  } catch (e) {
    // Old callers display `${error}`: surface the sidecar's message, not "Error: …".
    throw e instanceof Error ? e.message : e
  }
}

export function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  const d: Disposable = getCtx().sidecar.onNotification(event.replace(/^youtube:/, ''), (p) => cb({ payload: p as T }))
  return Promise.resolve(() => d())
}

/** `@tauri-apps/plugin-dialog`'s `open` for a single file. */
export async function open(o: { directory?: boolean; multiple?: boolean; title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null> {
  const picked = await getCtx().ui.pickFile({ multiple: false, filters: o.filters })
  return picked?.[0] ?? null
}
