/**
 * The External App tile: one tool for an external application.
 *
 *  - Launch the configured program (tool settings: executable, arguments,
 *    working directory) or focus it when it already runs;
 *  - pick any open window to focus it, link it to a toolbar button, or embed it
 *    into this tile;
 *  - embedded: the foreign window is a child of QuadFlow's main window, kept on
 *    the tile's body and hidden whenever the tile is hidden or an overlay
 *    (modal, menu, palette) covers it.
 *
 * Merges the former App Launcher, Window Link and Embed Window tools.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JsonValue, TileProps } from '@quadflow/plugin-api'
import { Button, EmptyState, Icon, IconButton, SearchInput, Spinner } from '@quadflow/ui'
import { claimTileState, isEmptyTileState } from '@quadflow/plugin-kit'
import {
  errorText,
  exeName,
  externalAppsModel,
  type AppTarget,
  type EmbedRecord,
  type ExternalAppsModel,
  type WindowInfo,
} from './model'

/** Per-instance state (persisted with the tile, never in the shared tool config). */
export interface TileState {
  /** Last embedded window — for "Reattach" after a restart or Pop Out. */
  last?: { hwnd: number; pid: number; title: string; processName: string }
  /** Program picked in this tile when the tool config has none. */
  app?: AppTarget
  /** Opened by a toolbar link button that has no target yet. */
  setupFor?: string
  /** Opened by drag-to-embed: embed this window on mount. */
  embedHwnd?: number
}

function readState(v: JsonValue): TileState {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as unknown as TileState) : {}
}

function configApp(settings: JsonValue): AppTarget | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined
  const s = settings as Record<string, JsonValue>
  const path = typeof s.executablePath === 'string' ? s.executablePath.trim() : ''
  if (!path) return undefined
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : undefined
  const cwd = typeof s.workingDirectory === 'string' && s.workingDirectory.trim() ? s.workingDirectory.trim() : undefined
  return { path, args, cwd }
}

function embedOnLaunch(settings: JsonValue): boolean {
  return !!settings && typeof settings === 'object' && !Array.isArray(settings) && (settings as Record<string, JsonValue>).embedOnLaunch === true
}

export function ExternalAppTile(props: TileProps) {
  const { ctx, instance, setState } = props
  const model = externalAppsModel(ctx)
  // A tile opened by a command starts from the state it was opened with.
  const [claimed] = useState(() => claimTileState(ctx, 'app', instance.state))
  const fresh = isEmptyTileState(instance.state)
  useEffect(() => {
    if (fresh && !isEmptyTileState(claimed)) setState(claimed)
  }, [fresh, claimed, setState])
  const state = readState(fresh ? claimed : instance.state)
  const rec = model.embeds((s) => s.byInstance[instance.id])

  // Mount / unmount bookkeeping (close detection, see model.tileUnmounted).
  useEffect(() => {
    model.tileMounted(instance.id)
    return () => model.tileUnmounted(instance.id)
  }, [model, instance.id])

  if (!model.nativeAvailable) {
    return <AppOnly {...props} model={model} state={state} />
  }
  if (rec) return <EmbeddedView {...props} model={model} rec={rec} state={state} />
  return <PickerView {...props} model={model} state={state} />
}

type ViewProps = TileProps & { model: ExternalAppsModel; state: TileState }

// ---------------------------------------------------------------------------
// Embedded
// ---------------------------------------------------------------------------

function EmbeddedView({ ctx, instance, visible, setState, setTitle, model, rec, state }: ViewProps & { rec: EmbedRecord }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    setTitle(rec.title || rec.processName || 'External App')
  }, [rec.title, rec.processName, setTitle])

  // Keep the native window on the container; hide it when the tile is hidden
  // or covered by an overlay. Bounds are main-window client px (CSS × DPR).
  useEffect(() => {
    let last = ''
    let alive = true
    const send = () => {
      const el = containerRef.current
      if (!el || !alive) return
      const g = ctx.native.tileGeometry(instance.id)
      const r = el.getBoundingClientRect()
      const s = window.devicePixelRatio || 1
      const vis = visible && g.visible && r.width > 1 && r.height > 1 && document.visibilityState === 'visible'
      const b = {
        x: Math.round(r.left * s),
        y: Math.round(r.top * s),
        width: Math.round(r.width * s),
        height: Math.round(r.height * s),
        visible: vis,
      }
      const key = JSON.stringify(b)
      if (key === last) return
      last = key
      setShown(vis)
      model.call('embed.bounds', { hwnd: rec.hwnd, ...b }).catch(() => {
        last = '' // retry on the next tick
      })
    }
    send()
    const offGeometry = ctx.native.onTileGeometry(instance.id, send)
    const offOverlay = ctx.overlay.onChange(send)
    const ro = new ResizeObserver(send)
    if (containerRef.current) ro.observe(containerRef.current)
    const iv = window.setInterval(send, 400)
    return () => {
      alive = false
      offGeometry()
      offOverlay()
      ro.disconnect()
      window.clearInterval(iv)
      // Unmount or re-layout: hide only. Closing for good is the model's call.
      if (model.embeds.getState().byInstance[instance.id]?.hwnd === rec.hwnd) {
        void model.call('embed.bounds', { hwnd: rec.hwnd, x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => {})
      }
    }
  }, [ctx, model, instance.id, rec.hwnd, visible])

  const focus = () => model.call('embed.focus', { hwnd: rec.hwnd }).catch((e) => ctx.notifications.toast({ kind: 'warning', title: 'Focus failed', body: errorText(e) }))
  const popOut = async () => {
    setState({ ...state, last: { hwnd: rec.hwnd, pid: rec.pid, title: rec.title, processName: rec.processName } } as unknown as JsonValue)
    await model.detach(instance.id)
  }
  const release = async () => {
    setState({ ...state, last: undefined } as unknown as JsonValue)
    await model.detach(instance.id)
  }

  return (
    <div className="flex h-full w-full flex-col bg-vibe-bg text-vibe-text" data-ext-app data-ext-mode="embedded">
      <div
        className="flex flex-shrink-0 cursor-pointer items-center gap-2 border-b border-vibe-border bg-vibe-surface/50 px-3 py-1.5"
        onClick={focus}
        title="Click to focus this window"
      >
        <div className={`h-2 w-2 flex-shrink-0 rounded-full ${rec.hung ? 'bg-amber-500' : 'bg-green-500'}`} />
        <span className="flex-1 truncate text-sm" title={rec.title}>
          {rec.title || 'Untitled window'}
        </span>
        <span className="flex-shrink-0 text-xs text-vibe-muted">{rec.processName}</span>
        <Button size="xs" variant="ghost" data-action="focus" onClick={(e) => { e.stopPropagation(); void focus() }}>
          Focus
        </Button>
        <Button size="xs" variant="outline" data-action="pop-out" title="Detach the window and keep this tile" onClick={(e) => { e.stopPropagation(); void popOut() }}>
          Pop Out
        </Button>
        <Button size="xs" variant="danger" data-action="release" title="Detach the window and clear this tile" onClick={(e) => { e.stopPropagation(); void release() }}>
          Release
        </Button>
      </div>
      {rec.hung && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-amber-600/30 bg-amber-900/20 px-3 py-1.5 text-xs text-amber-300">
          <span className="flex-1">{rec.processName || 'The app'} is not responding.</span>
          <Button size="xs" variant="outline" onClick={() => void popOut()}>
            Detach
          </Button>
        </div>
      )}
      {/* The native window covers this element. */}
      <div
        ref={containerRef}
        className="min-h-0 flex-1 bg-black/40"
        data-embed-container
        data-embed-hwnd={rec.hwnd}
        data-embed-visible={shown ? 'true' : 'false'}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Picker (launch / focus / link / embed)
// ---------------------------------------------------------------------------

function useAppStatus(model: ExternalAppsModel, key: string, enabled: boolean) {
  const [status, setStatus] = useState<{ running: boolean; pid: number | null }>({ running: false, pid: null })
  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      setStatus(await model.call<{ running: boolean; pid: number | null }>('apps.status', { key }))
    } catch {
      // sidecar not available: keep the last status
    }
  }, [model, key, enabled])
  useEffect(() => {
    void refresh()
    if (!enabled) return
    const iv = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(iv)
  }, [refresh, enabled])
  return { status, refresh }
}

function PickerView({ ctx, instance, config, setState, setTitle, model, state }: ViewProps) {
  const app = useMemo(() => configApp(config.settings) ?? state.app, [config.settings, state.app])
  const appKey = `config:${config.id}`
  const { status, refresh } = useAppStatus(model, appKey, !!app)
  const [windows, setWindows] = useState<WindowInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const listVersion = model.embeds((s) => s.listVersion)

  useEffect(() => {
    setTitle(app ? exeName(app.path) : config.name || 'External App')
  }, [app, config.name, setTitle])

  const loadWindows = useCallback(async () => {
    setLoading(true)
    try {
      setWindows(await model.listWindows())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [model])

  useEffect(() => {
    void loadWindows()
  }, [loadWindows, listVersion])

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await f()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const embed = (w: Pick<WindowInfo, 'hwnd'>) =>
    run('embed', async () => {
      const rec = await model.attach(instance.id, w.hwnd)
      setState({ ...state, setupFor: undefined, embedHwnd: undefined, last: { hwnd: rec.hwnd, pid: rec.pid, title: rec.title, processName: rec.processName } } as unknown as JsonValue)
    })

  // Drag-to-embed opened this tile for a window.
  const dropped = state.embedHwnd
  useEffect(() => {
    if (dropped) void embed({ hwnd: dropped })
  }, [dropped])

  const launch = (thenEmbed: boolean) =>
    run(thenEmbed ? 'launch-embed' : 'launch', async () => {
      if (!app) return
      if (thenEmbed) {
        const w = await model.launchWindow(appKey, app)
        if (!w) throw new Error(`${exeName(app.path)} started, but no window appeared to embed`)
        const rec = await model.attach(instance.id, w.hwnd)
        setState({ ...state, last: { hwnd: rec.hwnd, pid: rec.pid, title: rec.title, processName: rec.processName } } as unknown as JsonValue)
      } else {
        const r = await model.launch(appKey, app)
        if (r.boundToQuadflow) {
          ctx.notifications.toast({ kind: 'info', title: `${exeName(app.path)} started`, body: 'It will close when QuadFlow closes.' })
        }
      }
      await refresh()
    })

  const focusApp = () =>
    run('focus-app', async () => {
      const ok = await model.call<boolean>('apps.focus', { key: appKey })
      if (!ok) setError('Could not bring the window to the front')
    })

  const pickProgram = () =>
    run('pick', async () => {
      const picked = await ctx.ui.pickFile({ filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk'] }] })
      const path = picked?.[0]
      if (!path) return
      setState({ ...state, app: { path } } as unknown as JsonValue)
      if (state.setupFor) await finishSetup({ kind: 'app', path })
    })

  const finishSetup = async (target: Parameters<ExternalAppsModel['setLink']>[1]) => {
    if (!state.setupFor || !target) return
    await model.setLink(state.setupFor, target)
    setState({ ...state, setupFor: undefined } as unknown as JsonValue)
    ctx.notifications.toast({ kind: 'success', title: 'Toolbar button linked', body: target.kind === 'app' ? exeName(target.path) : target.windowTitle || target.processName })
  }

  const focusWindow = (w: WindowInfo) =>
    run(`focus:${w.hwnd}`, async () => {
      const ok = await model.call<boolean>('windows.focus', { hwnd: w.hwnd })
      if (!ok) setError('Windows did not let QuadFlow bring that window to the front')
    })

  const q = search.trim().toLowerCase()
  const free = windows.filter((w) => !w.embeddedBy)
  const filtered = q ? free.filter((w) => w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q)) : free
  const reattach = state.last
    ? free.find((w) => w.hwnd === state.last!.hwnd && w.pid === state.last!.pid) ??
      free.find((w) => w.title === state.last!.title && w.processName === state.last!.processName)
    : undefined

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-vibe-bg text-vibe-text" data-ext-app data-ext-mode="picker">
      {state.setupFor && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-vibe-primary/30 bg-vibe-primary/10 px-3 py-2 text-xs" data-setup-banner>
          <span className="flex-1">Choose what the toolbar button opens: link a window below, or a program.</span>
          {app && (
            <Button size="xs" variant="primary" onClick={() => void run('link-app', () => finishSetup({ kind: 'app', ...app }))}>
              Use {exeName(app.path)}
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={() => void pickProgram()}>
            Pick program…
          </Button>
          <IconButton label="Cancel" onClick={() => setState({ ...state, setupFor: undefined } as unknown as JsonValue)}>
            <Icon name="close" className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}

      {/* App */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-vibe-border px-3 py-3" data-app-section>
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-vibe-border bg-vibe-surface">
          <Icon name="external" className="h-4 w-4 text-vibe-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{app ? exeName(app.path) : 'No program set'}</div>
          <div className="truncate text-xs text-vibe-muted" title={app?.path}>
            {app ? [app.path, ...(app.args ?? [])].join(' ') : 'Set an executable in this tool’s settings, or pick one.'}
          </div>
        </div>
        {app && (
          <div className="flex flex-shrink-0 items-center gap-1.5" data-app-status={status.running ? 'running' : 'stopped'}>
            <div className={`h-2 w-2 rounded-full ${status.running ? 'bg-green-400' : 'bg-gray-500'}`} />
            <span className="text-xs text-vibe-muted">{status.running ? `PID ${status.pid}` : 'Stopped'}</span>
          </div>
        )}
        <div className="flex flex-shrink-0 gap-1.5">
          {app && status.running ? (
            <Button size="sm" variant="primary" data-action="focus-app" loading={busy === 'focus-app'} onClick={() => void focusApp()}>
              Focus
            </Button>
          ) : (
            app && (
              <Button size="sm" variant="primary" data-action="launch" loading={busy === 'launch'} onClick={() => void launch(false)}>
                Launch
              </Button>
            )
          )}
          {app && (
            <Button size="sm" variant="outline" data-action="launch-embed" loading={busy === 'launch-embed'} disabled={!!busy} onClick={() => void launch(true)}>
              {status.running ? 'Embed' : 'Launch & Embed'}
            </Button>
          )}
          {!configApp(config.settings) && (
            <Button size="sm" variant="ghost" data-action="pick-program" onClick={() => void pickProgram()}>
              {app ? 'Change…' : 'Pick program…'}
            </Button>
          )}
        </div>
      </div>
      {app && embedOnLaunch(config.settings) && !status.running && <AutoEmbed run={() => launch(true)} />}

      {error && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-red-600/30 bg-red-900/30 px-3 py-2" data-ext-error>
          <span className="flex-1 text-xs text-red-400">{error}</span>
          <IconButton label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}

      {reattach && (
        <button
          className="mx-3 mt-3 flex-shrink-0 rounded border border-vibe-primary/30 bg-vibe-primary/20 px-3 py-2 text-left text-sm text-vibe-primary hover:bg-vibe-primary/30 disabled:opacity-50"
          disabled={!!busy}
          data-action="reattach"
          onClick={() => void embed(reattach)}
        >
          Reattach: <span className="font-medium">{reattach.title}</span>
        </button>
      )}

      {/* Windows */}
      <div className="flex flex-shrink-0 items-center gap-2 px-3 pt-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search windows…" className="flex-1" />
        <IconButton label="Refresh window list" onClick={() => void loadWindows()} disabled={loading}>
          <Icon name="refresh" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3" data-window-list>
        {filtered.length === 0 ? (
          loading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : (
            <EmptyState title="No windows found" description="Open the app you want, then refresh." />
          )
        ) : (
          filtered.map((w) => (
            <div
              key={w.hwnd}
              className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-vibe-surface/50"
              data-window-row
              data-hwnd={w.hwnd}
              data-pid={w.pid}
              data-title={w.title}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{w.title || 'Untitled window'}</div>
                <div className="truncate text-xs text-vibe-muted">{w.processName}</div>
              </div>
              {state.setupFor && (
                <Button size="xs" variant="primary" data-action="link" onClick={() => void run('link', () => finishSetup({ kind: 'window', processName: w.processName, windowTitle: w.title }))}>
                  Link
                </Button>
              )}
              <Button size="xs" variant="ghost" data-action="focus-window" onClick={() => void focusWindow(w)}>
                Focus
              </Button>
              <Button size="xs" variant="outline" data-action="embed" disabled={!!busy} onClick={() => void embed(w)}>
                Embed
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** `embedOnLaunch`: start and embed once when the tile opens. */
function AutoEmbed({ run }: { run: () => Promise<void> }) {
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    done.current = true
    void run()
  }, [run])
  return null
}

// ---------------------------------------------------------------------------
// No native API (sandboxed / non-Windows host): launching only.
// ---------------------------------------------------------------------------

function AppOnly({ config, model, state }: ViewProps) {
  const app = configApp(config.settings) ?? state.app
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="h-full w-full bg-vibe-bg text-vibe-text" data-ext-app data-ext-mode="unsupported">
      <EmptyState
        title={app ? exeName(app.path) : 'External App'}
        description={error ?? 'Window linking and embedding need QuadFlow on Windows.'}
        action={
          app && model.ctx.api.has('sidecar.request') ? (
            <Button size="sm" variant="primary" onClick={() => model.launch(`config:${config.id}`, app).catch((e) => setError(errorText(e)))}>
              Launch
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}
