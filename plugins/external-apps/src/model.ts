/**
 * External Apps state, one per plugin context.
 *
 * All native work runs in the plugin's Rust sidecar (`sidecar/`); this model is
 * the UI's view of it:
 *  - `call()`: a sidecar request with QuadFlow's main window handle attached
 *    (`ctx.native.mainWindowHandle()`, needs `native:windows`);
 *  - `embeds`: which tile instance embeds which window (mirrors the sidecar's
 *    table — the hwnd is per instance, in the tile's own state, never in the
 *    shared tool config);
 *  - tile lifetime: an unmounted embed is hidden at once (layout changes and
 *    workspace switches unmount tiles too). It is detached when the tile is
 *    closed for good: `ui.onTileClosed` (API 1.2), or — on older hosts — after a
 *    grace period unless the tile came back or the workspace changed (then it
 *    stays parked, hidden);
 *  - toolbar links: what each "App / Window Link" toolbar button opens, in
 *    plugin storage keyed by its tool config id (commands cannot read a tool
 *    config's settings — see the report's API gaps).
 */
import { create } from 'zustand'
import type { Disposable, JsonValue, PluginContext } from '@quadflow/plugin-api'

export interface WindowInfo {
  hwnd: number
  pid: number
  title: string
  processName: string
  /** Set when the window is embedded (by that tile instance). */
  embeddedBy?: string
}

export interface EmbedRecord {
  hwnd: number
  pid: number
  title: string
  processName: string
  instanceId: string
  hung: boolean
}

export interface AppTarget {
  path: string
  args?: string[]
  cwd?: string
}

/** What a toolbar link button opens. */
export type LinkTarget =
  | { kind: 'window'; processName: string; windowTitle?: string }
  | { kind: 'app'; path: string; args?: string[]; cwd?: string }

export interface LaunchResult {
  pid: number
  alreadyRunning: boolean
  boundToQuadflow?: boolean
}

interface EmbedState {
  /** instanceId → live embed. */
  byInstance: Record<string, EmbedRecord>
  /** Bumped when the set of free windows changed (sidecar restart, detach, window gone): pickers reload. */
  listVersion: number
}

/** Unmount → detach delay when no workspace change explains the unmount. */
export const CLOSE_GRACE_MS = 1500

export interface ExternalAppsModel {
  ctx: PluginContext
  /** Windows-only native features (embed, window list, focus). */
  nativeAvailable: boolean
  embeds: ReturnType<typeof createEmbedStore>
  call<T = JsonValue>(method: string, params?: Record<string, JsonValue | undefined>, timeoutMs?: number): Promise<T>
  listWindows(): Promise<WindowInfo[]>
  attach(instanceId: string, hwnd: number): Promise<EmbedRecord>
  detach(instanceId: string, opts?: { focus?: boolean }): Promise<void>
  refreshEmbeds(): Promise<void>
  launch(key: string, app: AppTarget): Promise<LaunchResult>
  /** Launch (or reuse) and wait for the app's window. */
  launchWindow(key: string, app: AppTarget, timeoutMs?: number): Promise<WindowInfo | null>
  tileMounted(instanceId: string): void
  tileUnmounted(instanceId: string): void
  getLink(toolConfigId: string): Promise<LinkTarget | undefined>
  setLink(toolConfigId: string, target: LinkTarget | null): Promise<void>
  dispose(): void
}

function createEmbedStore() {
  return create<EmbedState>(() => ({ byInstance: {}, listVersion: 0 }))
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export function exeName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const models = new WeakMap<PluginContext, ExternalAppsModel>()

export function externalAppsModel(ctx: PluginContext): ExternalAppsModel {
  let m = models.get(ctx)
  if (!m) {
    m = createModel(ctx)
    models.set(ctx, m)
  }
  return m
}

/** The model if one was created (deactivate must not create one). */
export function existingModel(ctx: PluginContext): ExternalAppsModel | undefined {
  return models.get(ctx)
}

function createModel(ctx: PluginContext): ExternalAppsModel {
  const embeds = createEmbedStore()
  const nativeAvailable = ctx.api.has('native.mainWindowHandle') && ctx.api.has('sidecar.request')
  const closeEvents = ctx.api.has('ui.onTileClosed')
  let mainHandle: Promise<string> | null = null
  const mainWindow = () => {
    mainHandle ??= ctx.native.mainWindowHandle().catch((e) => {
      mainHandle = null
      throw e
    })
    return mainHandle
  }

  const disposables: Disposable[] = []
  const mounted = new Map<string, number>()
  const pendingClose = new Map<string, ReturnType<typeof setTimeout>>()
  /** Workspace each embedding instance was last mounted in. */
  const mountWorkspace = new Map<string, string | null>()
  let lastWorkspaceChange = 0

  const call = async <T = JsonValue>(method: string, params: Record<string, JsonValue | undefined> = {}, timeoutMs = 10_000): Promise<T> => {
    const main = nativeAvailable ? await mainWindow() : undefined
    const clean: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = v
    if (main) clean.main = main
    return ctx.sidecar.request<T>(method, clean, { timeoutMs })
  }

  const setEmbed = (instanceId: string, rec: EmbedRecord | null) =>
    embeds.setState((s) => {
      const byInstance = { ...s.byInstance }
      if (rec) byInstance[instanceId] = rec
      else delete byInstance[instanceId]
      return { byInstance }
    })

  const bumpList = () => embeds.setState((s) => ({ listVersion: s.listVersion + 1 }))

  const instanceOfHwnd = (hwnd: number) =>
    Object.values(embeds.getState().byInstance).find((r) => r.hwnd === hwnd)?.instanceId

  const refreshEmbeds = async () => {
    if (!nativeAvailable) return
    const list = await call<EmbedRecord[]>('embed.list')
    const byInstance: Record<string, EmbedRecord> = {}
    for (const r of list) byInstance[r.instanceId] = r
    embeds.setState({ byInstance })
  }

  const detach = async (instanceId: string, opts: { focus?: boolean } = {}) => {
    const rec = embeds.getState().byInstance[instanceId]
    if (!rec) return
    setEmbed(instanceId, null)
    try {
      await call('embed.detach', { hwnd: rec.hwnd, focus: opts.focus ?? true })
    } catch (e) {
      ctx.log.warn('detach failed', errorText(e))
    }
    bumpList()
  }

  if (nativeAvailable) {
    disposables.push(
      ctx.sidecar.onNotification('windowGone', (p) => {
        const hwnd = (p as { hwnd?: number } | null)?.hwnd
        const id = typeof hwnd === 'number' ? instanceOfHwnd(hwnd) : undefined
        if (id) setEmbed(id, null)
        bumpList()
      }),
      ctx.sidecar.onNotification('windowHung', (p) => {
        const { hwnd, hung } = (p ?? {}) as { hwnd?: number; hung?: boolean }
        const id = typeof hwnd === 'number' ? instanceOfHwnd(hwnd) : undefined
        const rec = id ? embeds.getState().byInstance[id] : undefined
        if (id && rec) setEmbed(id, { ...rec, hung: !!hung })
      }),
      ctx.sidecar.onStatus((s) => {
        if (s.state === 'running') {
          // A restarted sidecar restored (detached) what the crashed one embedded.
          bumpList()
          void refreshEmbeds().catch(() => {})
        } else if (s.state === 'failed' || s.state === 'stopped') {
          embeds.setState({ byInstance: {} })
        }
      }),
      ctx.workspace.onDidChange(() => {
        lastWorkspaceChange = Date.now()
      }),
    )
    // API 1.2: the host says when a tile is closed for good — no guessing needed.
    if (closeEvents) {
      disposables.push(
        ctx.ui.onTileClosed(({ instanceId, contributionId }) => {
          if (contributionId !== 'app') return
          const t = pendingClose.get(instanceId)
          if (t) clearTimeout(t)
          pendingClose.delete(instanceId)
          mounted.delete(instanceId)
          mountWorkspace.delete(instanceId)
          void detach(instanceId, { focus: false })
        }),
      )
    }
  }

  const model: ExternalAppsModel = {
    ctx,
    nativeAvailable,
    embeds,
    call,
    listWindows: () => call<WindowInfo[]>('windows.list'),
    async attach(instanceId, hwnd) {
      const rec = await call<EmbedRecord>('embed.attach', { hwnd, instanceId })
      setEmbed(instanceId, rec)
      mountWorkspace.set(instanceId, ctx.workspace.current()?.id ?? null)
      return rec
    },
    detach,
    refreshEmbeds,
    launch: (key, app) => call<LaunchResult>('apps.launch', { key, path: app.path, args: app.args ?? [], cwd: app.cwd }),
    async launchWindow(key, app, timeoutMs = 15_000) {
      const before = nativeAvailable ? (await model.listWindows()).map((w) => w.hwnd) : []
      const r = await model.launch(key, app)
      if (!nativeAvailable) return null
      return call<WindowInfo | null>(
        'apps.findWindow',
        { pid: r.pid, processName: exeName(app.path), timeoutMs, exclude: r.alreadyRunning ? [] : before },
        timeoutMs + 5_000,
      )
    },
    tileMounted(instanceId) {
      mounted.set(instanceId, (mounted.get(instanceId) ?? 0) + 1)
      const t = pendingClose.get(instanceId)
      if (t) {
        clearTimeout(t)
        pendingClose.delete(instanceId)
      }
      if (embeds.getState().byInstance[instanceId]) mountWorkspace.set(instanceId, ctx.workspace.current()?.id ?? null)
    },
    tileUnmounted(instanceId) {
      const n = (mounted.get(instanceId) ?? 1) - 1
      if (n > 0) {
        mounted.set(instanceId, n)
        return
      }
      mounted.delete(instanceId)
      // With `ui.onTileClosed` an unmount is never a close: stay embedded, hidden.
      if (closeEvents || !embeds.getState().byInstance[instanceId]) return
      const unmountedAt = Date.now()
      pendingClose.set(
        instanceId,
        setTimeout(() => {
          pendingClose.delete(instanceId)
          if (mounted.has(instanceId)) return
          const ws = ctx.workspace.current()?.id ?? null
          const switched = ws !== (mountWorkspace.get(instanceId) ?? null) || Math.abs(lastWorkspaceChange - unmountedAt) < CLOSE_GRACE_MS * 2
          if (switched) return // parked: hidden until its workspace is shown again
          mountWorkspace.delete(instanceId)
          void detach(instanceId, { focus: false })
        }, CLOSE_GRACE_MS),
      )
    },
    async getLink(toolConfigId) {
      return (await ctx.storage.get<LinkTarget>(`link:${toolConfigId}`)) ?? undefined
    },
    async setLink(toolConfigId, target) {
      if (target) await ctx.storage.set(`link:${toolConfigId}`, target as unknown as JsonValue)
      else await ctx.storage.delete(`link:${toolConfigId}`)
    },
    dispose() {
      for (const t of pendingClose.values()) clearTimeout(t)
      pendingClose.clear()
      for (const d of disposables) d()
      disposables.length = 0
    },
  }
  if (nativeAvailable) void refreshEmbeds().catch(() => {})
  return model
}
