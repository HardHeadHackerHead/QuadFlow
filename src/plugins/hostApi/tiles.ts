/**
 * Live plugin tiles (registered by `TileHost`): what `ui.closeTile/focusTile`,
 * `notifications.attention` and `native.tileGeometry/onTileGeometry` act on,
 * plus the overlay/z-order contract (plugin-system.md §6.7).
 *
 * `visible` is false whenever the tile is not shown (hidden flyout, other
 * workspace, minimized — TileHost's `visible` prop / zero size / detached),
 * the document is hidden, or a registered overlay intersects the tile.
 */
import type { Disposable, Rect, TileGeometry } from '@quadflow/plugin-api'
import { useOverlayStore } from '../../stores/overlayStore'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface TileEntry {
  instanceId: string
  pluginId: string
  contributionId: string
  el: HTMLElement
  visible: boolean
  setAttention(on: boolean): void
  close(): void
}

const tiles = new Map<string, TileEntry>()
const geometryListeners = new Map<string, Set<(g: TileGeometry) => void>>()
const tileListeners = new Set<(e: TileEntry, added: boolean) => void>()
const lastGeometry = new Map<string, string>()

let windowOrigin = { x: 0, y: 0 }
let originTracking = false

function trackWindowOrigin() {
  if (originTracking) return
  originTracking = true
  try {
    const w = getCurrentWindow()
    const update = () =>
      w
        .innerPosition()
        .then((p) => {
          windowOrigin = { x: p.x, y: p.y }
          notifyAll()
        })
        .catch(() => {})
    void update()
    void w.onMoved(() => void update())
    void w.onResized(() => void update())
  } catch {
    // Not in a Tauri window (tests): physical = css * dpr.
  }
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Rects of open overlays (DOM surfaces marked as dialogs/menus/popovers). */
export function overlayRects(): Rect[] {
  if (Object.keys(useOverlayStore.getState().activeOverlays).length === 0) return []
  const els = document.querySelectorAll(
    '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-qf-overlay], [data-overlay]',
  )
  const out: Rect[] = []
  els.forEach((el) => {
    const r = rectOf(el)
    if (r.width > 0 && r.height > 0) out.push(r)
  })
  return out
}

export function anyOverlayOpen(): boolean {
  return Object.keys(useOverlayStore.getState().activeOverlays).length > 0
}

export function geometryOf(instanceId: string): TileGeometry {
  const t = tiles.get(instanceId)
  const scaleFactor = window.devicePixelRatio || 1
  if (!t || !t.el.isConnected) {
    const zero = { x: 0, y: 0, width: 0, height: 0 }
    return { css: zero, physical: zero, scaleFactor, visible: false }
  }
  const css = rectOf(t.el)
  const physical = {
    x: Math.round(windowOrigin.x + css.x * scaleFactor),
    y: Math.round(windowOrigin.y + css.y * scaleFactor),
    width: Math.round(css.width * scaleFactor),
    height: Math.round(css.height * scaleFactor),
  }
  let visible = t.visible && css.width > 0 && css.height > 0 && document.visibilityState === 'visible'
  if (visible && anyOverlayOpen()) {
    const rects = overlayRects()
    // An overlay we cannot locate counts as covering everything.
    visible = rects.length > 0 ? !rects.some((r) => intersects(r, css)) : false
  }
  return { css, physical, scaleFactor, visible }
}

function notify(instanceId: string) {
  const ls = geometryListeners.get(instanceId)
  if (!ls || ls.size === 0) return
  const g = geometryOf(instanceId)
  const key = JSON.stringify(g)
  if (lastGeometry.get(instanceId) === key) return
  lastGeometry.set(instanceId, key)
  ls.forEach((cb) => cb(g))
}

function notifyAll() {
  geometryListeners.forEach((_ls, id) => notify(id))
}

let globalHooks = false
function installGlobalHooks() {
  if (globalHooks) return
  globalHooks = true
  trackWindowOrigin()
  useOverlayStore.subscribe(() => notifyAll())
  window.addEventListener('resize', notifyAll)
  document.addEventListener('visibilitychange', notifyAll)
  // Layout changes (splits, drags) can move tiles without resizing them.
  window.setInterval(() => {
    if (geometryListeners.size > 0) notifyAll()
  }, 250)
}

const observers = new Map<string, ResizeObserver>()

export function registerTile(e: TileEntry): Disposable {
  installGlobalHooks()
  tiles.set(e.instanceId, e)
  const ro = new ResizeObserver(() => notify(e.instanceId))
  ro.observe(e.el)
  observers.get(e.instanceId)?.disconnect()
  observers.set(e.instanceId, ro)
  tileListeners.forEach((cb) => cb(e, true))
  notify(e.instanceId)
  return () => {
    if (tiles.get(e.instanceId) !== e) return
    tiles.delete(e.instanceId)
    observers.get(e.instanceId)?.disconnect()
    observers.delete(e.instanceId)
    tileListeners.forEach((cb) => cb(e, false))
    notify(e.instanceId)
  }
}

/** TileHost: the tile's `visible` prop changed. */
export function setTileVisible(instanceId: string, visible: boolean) {
  const t = tiles.get(instanceId)
  if (t && t.visible !== visible) {
    t.visible = visible
    notify(instanceId)
  }
}

export function getTile(instanceId: string): TileEntry | undefined {
  return tiles.get(instanceId)
}

export function onTileGeometry(instanceId: string, cb: (g: TileGeometry) => void): Disposable {
  installGlobalHooks()
  let ls = geometryListeners.get(instanceId)
  if (!ls) geometryListeners.set(instanceId, (ls = new Set()))
  ls.add(cb)
  lastGeometry.delete(instanceId)
  notify(instanceId)
  return () => {
    ls!.delete(cb)
    if (ls!.size === 0) {
      geometryListeners.delete(instanceId)
      lastGeometry.delete(instanceId)
    }
  }
}

// ---- tile closed (ui.onTileClosed, API 1.2) ----

type TileClosedListener = (e: { instanceId: string; contributionId: string }) => void
const closedListeners = new Map<string, Set<TileClosedListener>>()

/** `ui.onTileClosed` of `pluginId`: its tiles closed for good (toolStore.closeTool). */
export function onTileClosed(pluginId: string, cb: TileClosedListener): Disposable {
  let ls = closedListeners.get(pluginId)
  if (!ls) closedListeners.set(pluginId, (ls = new Set()))
  ls.add(cb)
  return () => {
    ls!.delete(cb)
    if (ls!.size === 0) closedListeners.delete(pluginId)
  }
}

/** Called by the tool store when a tile instance is closed (not merely unmounted). */
export function notifyTileClosed(pluginId: string, contributionId: string, instanceId: string): void {
  closedListeners.get(pluginId)?.forEach((cb) => {
    try {
      cb({ instanceId, contributionId })
    } catch (e) {
      console.error(`[plugins] ${pluginId} onTileClosed:`, e)
    }
  })
}

/** Fires when a tile of `pluginId` is registered (e.g. after `ui.openTile`). */
export function onTileAdded(pluginId: string, contributionId: string, cb: (instanceId: string) => void): Disposable {
  const l = (e: TileEntry, added: boolean) => {
    if (added && e.pluginId === pluginId && e.contributionId === contributionId) cb(e.instanceId)
  }
  tileListeners.add(l)
  return () => tileListeners.delete(l)
}
