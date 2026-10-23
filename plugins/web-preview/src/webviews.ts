/**
 * Live child webviews by tile instance (module-level, outside React).
 *
 * A child webview is a native view the host keeps on the tile and hides
 * whenever the tile is not visible (overlay, hidden flyout, other workspace,
 * unmounted). Unmounting a tile therefore must NOT close it — the page (scroll,
 * JS state, playing media) survives a remount. It is closed when the tile is
 * closed for good (`ui.onTileClosed`, API 1.2; older hosts keep it hidden until
 * the plugin is unloaded).
 */
import type { ChildWebview, Disposable, PluginContext } from '@quadflow/plugin-api'

export interface WebviewEntry {
  wv: ChildWebview
  url: string
}

const entries = new Map<string, WebviewEntry>()
/** Mounted preview tiles: instance id -> navigate (for `web-preview/open-url`). */
const mounted = new Map<string, (url: string) => void>()

export const VIEWPORT_SELECTOR = '[data-webpreview-viewport]'

export function getWebview(instanceId: string): WebviewEntry | undefined {
  return entries.get(instanceId)
}

export function setWebview(instanceId: string, e: WebviewEntry): void {
  entries.set(instanceId, e)
}

export async function closeWebview(instanceId: string): Promise<void> {
  const e = entries.get(instanceId)
  if (!e) return
  entries.delete(instanceId)
  await e.wv.close().catch(() => {})
}

export async function closeAllWebviews(): Promise<void> {
  await Promise.all([...entries.keys()].map(closeWebview))
}

export function trackMounted(instanceId: string, navigate: (url: string) => void): Disposable {
  mounted.set(instanceId, navigate)
  return () => {
    if (mounted.get(instanceId) === navigate) mounted.delete(instanceId)
  }
}

/** The most recently mounted preview tile, if any. */
export function anyMounted(): [string, (url: string) => void] | null {
  const all = [...mounted.entries()]
  return all.length ? all[all.length - 1] : null
}

export function closeOnTileClosed(ctx: PluginContext): Disposable {
  if (!ctx.api.has('ui.onTileClosed')) return () => {}
  return ctx.ui.onTileClosed(({ instanceId }) => void closeWebview(instanceId))
}

/** `localhost:3000` → `http://localhost:3000`. */
export function normalizeUrl(raw: string): string {
  const u = raw.trim()
  if (!u) return ''
  return /^https?:\/\//i.test(u) ? u : `http://${u}`
}

/** Dev servers: poll until they answer (the app's CSP allows fetch to localhost only). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
  } catch {
    return false
  }
}
