/**
 * The `preview` tile: an address bar plus an embedded child webview
 * (`ctx.native.createChildWebview`, trusted only) covering the viewport area
 * under the toolbar. The host positions it from the tile geometry and hides it
 * whenever an overlay covers the tile — including this tile's own bookmark
 * panel, which registers with `ctx.overlay`. Works the same in a pane and in a
 * flyout. Bookmarks are per project (./bookmarks.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { JsonValue, PluginContext, TileProps } from '@quadflow/plugin-api'
import { claimTileState } from '@quadflow/plugin-kit'
import { bookmarksModel } from './bookmarks'
import { VIEWPORT_SELECTOR, getWebview, isLocalUrl, normalizeUrl, setWebview, trackMounted } from './webviews'

type ViewMode = 'desktop' | 'mobile'
interface PreviewState {
  url?: string
  linkedScriptTabId?: string
  zoom?: number
  viewMode?: ViewMode
}

function stateOf(v: JsonValue): PreviewState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const o = v as Record<string, JsonValue>
  return {
    url: typeof o.url === 'string' ? o.url : undefined,
    linkedScriptTabId: typeof o.linkedScriptTabId === 'string' ? o.linkedScriptTabId : undefined,
    zoom: typeof o.zoom === 'number' ? o.zoom : undefined,
    viewMode: o.viewMode === 'mobile' ? 'mobile' : o.viewMode === 'desktop' ? 'desktop' : undefined,
  }
}

const icon = (d: string, extra?: string) => (
  <svg className={`w-4 h-4 ${extra ?? ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
  </svg>
)
const ICON = {
  back: 'M15 19l-7-7 7-7',
  forward: 'M9 5l7 7-7 7',
  reload: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  list: 'M4 6h16M4 12h16M4 18h16',
  external: 'M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14',
  check: 'M5 13l4 4L19 7',
  warn: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  x: 'M6 18L18 6M6 6l12 12',
}
const STAR_OUTLINE =
  'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z'

const btn = 'p-1.5 text-vibe-muted hover:text-vibe-text rounded transition-colors disabled:opacity-30'

async function waitForServer(url: string, aborted: () => boolean, onTry: (i: number, max: number) => void): Promise<boolean> {
  const max = 30
  for (let i = 0; i < max; i++) {
    if (aborted()) return false
    onTry(i + 1, max)
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(2000) })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  return false
}

export function WebPreviewTile(props: TileProps) {
  const { ctx, instance } = props
  const [initial] = useState(() => stateOf(claimTileState(ctx, 'preview', instance.state)))
  const existing = getWebview(instance.id)
  const [currentUrl, setCurrentUrl] = useState(existing?.url ?? initial.url ?? '')
  const [urlBar, setUrlBar] = useState(existing?.url ?? initial.url ?? '')
  const [linkedScriptTabId, setLinked] = useState(initial.linkedScriptTabId)
  const [zoom, setZoom] = useState(initial.zoom ?? 100)
  const [viewMode, setViewMode] = useState<ViewMode>(initial.viewMode ?? 'desktop')
  const [pollStatus, setPollStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hasView, setHasView] = useState(!!existing)
  const [capture, setCapture] = useState<'idle' | 'copied' | 'error'>('idle')
  const [menuOpen, setMenuOpen] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const pollToken = useRef(0)

  const supported = ctx.api.has('native.createChildWebview')
  const project = ctx.project.current()
  const bm = bookmarksModel(ctx)
  const bookmarks = bm.use((s) => s.bookmarks)
  const currentBookmark = bookmarks.find((b) => b.url === currentUrl)

  // Persist what a remount / restart needs (setState identity changes with the metadata).
  const persist = useRef(props.setState)
  persist.current = props.setState
  useEffect(() => {
    const s: Record<string, JsonValue> = { zoom, viewMode }
    if (currentUrl) s.url = currentUrl
    if (linkedScriptTabId) s.linkedScriptTabId = linkedScriptTabId
    persist.current(s)
  }, [currentUrl, linkedScriptTabId, zoom, viewMode])

  const applyZoom = useCallback(
    (level: number) => void getWebview(instance.id)?.wv.eval(`document.body && (document.body.style.zoom = '${level / 100}')`).catch(() => {}),
    [instance.id],
  )

  const navigate = useCallback(
    async (raw: string, linked?: string) => {
      const url = normalizeUrl(raw)
      if (!url || !supported) return
      setUrlBar(url)
      setError(null)
      if (linked !== undefined) setLinked(linked || undefined)
      const token = ++pollToken.current
      if (isLocalUrl(url)) {
        const ok = await waitForServer(url, () => pollToken.current !== token, (i, max) => setPollStatus(`Waiting for server... (${i}/${max})`))
        if (pollToken.current !== token) return
        setPollStatus('')
        if (!ok) {
          setError('Server did not respond within 30 seconds')
          return
        }
      }
      try {
        const entry = getWebview(instance.id)
        if (entry) {
          await entry.wv.navigate(url)
          setWebview(instance.id, { ...entry, url })
        } else {
          const wv = await ctx.native.createChildWebview({ instanceId: instance.id, url, anchor: VIEWPORT_SELECTOR })
          setWebview(instance.id, { wv, url })
        }
        setHasView(true)
        setCurrentUrl(url)
        // The zoom lives in the page: re-apply once the new document is there.
        if (zoom !== 100) setTimeout(() => applyZoom(zoom), 600)
      } catch (e) {
        setError(`Failed to open the page: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [ctx, instance.id, supported, zoom, applyZoom],
  )

  // First mount: re-use the live webview (remount), else load the saved URL.
  useEffect(() => {
    if (!getWebview(instance.id) && initial.url) void navigate(initial.url)
    return () => {
      pollToken.current++ // abort a pending readiness poll; the webview itself stays (hidden)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => trackMounted(instance.id, (url) => void navigate(url)), [instance.id, navigate])

  // Whether the host currently shows the native view (tile visible, nothing on top): exposed
  // as `data-webview-shown` for diagnostics and tests.
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (!ctx.api.has('native.onTileGeometry')) return
    return ctx.native.onTileGeometry(instance.id, (g) => setShown(g.visible))
  }, [ctx, instance.id])

  // The bookmark panel is an overlay: the host hides the webview while it is open.
  useEffect(() => {
    ctx.overlay.register(`bookmarks-${instance.id}`, menuOpen)
    return () => ctx.overlay.register(`bookmarks-${instance.id}`, false)
  }, [ctx, instance.id, menuOpen])

  const evalPage = (js: string) => void getWebview(instance.id)?.wv.eval(js).catch(() => {})
  const setZoomLevel = (z: number) => {
    setZoom(z)
    applyZoom(z)
  }

  const screenshot = async () => {
    const el = viewportRef.current
    if (!el || !currentUrl) return
    try {
      const g = ctx.native.tileGeometry(instance.id)
      const r = el.getBoundingClientRect()
      const s = g.scaleFactor
      const png = await ctx.native.captureRegion({
        x: Math.round(g.physical.x + (r.left - g.css.x) * s),
        y: Math.round(g.physical.y + (r.top - g.css.y) * s),
        width: Math.round(r.width * s),
        height: Math.round(r.height * s),
      })
      await ctx.clipboard.writeImage(png)
      setCapture('copied')
    } catch (e) {
      ctx.log.warn('screenshot failed:', e)
      setCapture('error')
    }
    setTimeout(() => setCapture('idle'), 1500)
  }

  if (!supported) {
    return (
      <div className="h-full flex items-center justify-center text-vibe-muted text-sm px-6 text-center">
        This host cannot embed web pages in plugin tiles (native.createChildWebview).
      </div>
    )
  }

  const showPlaceholder = !hasView || !!pollStatus || !!error
  return (
    <div
      className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden"
      data-testid="web-preview-tile"
      data-webview-shown={hasView && !showPlaceholder && shown ? 'true' : 'false'}
    >
      <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-vibe-border bg-vibe-bg-lighter">
        <button onClick={() => evalPage('history.back()')} className={btn} title="Back">
          {icon(ICON.back)}
        </button>
        <button onClick={() => evalPage('history.forward()')} className={btn} title="Forward">
          {icon(ICON.forward)}
        </button>
        <button onClick={() => evalPage('location.reload()')} className={btn} title="Reload">
          {icon(ICON.reload)}
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void navigate(urlBar)
          }}
          className="flex-1 flex items-center min-w-0"
        >
          <input
            type="text"
            value={urlBar}
            onChange={(e) => setUrlBar(e.target.value)}
            placeholder="http://localhost:3000"
            data-testid="web-preview-url"
            className="flex-1 min-w-0 px-3 py-1 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-vibe-primary font-mono"
          />
          <button type="submit" data-testid="web-preview-go" className="ml-1 px-2 py-1 text-xs bg-vibe-primary text-qf-on-primary hover:bg-vibe-primary-hover rounded transition-colors">
            Go
          </button>
        </form>

        <div className="flex items-center gap-0.5 mx-1 border-l border-r border-vibe-border px-1.5">
          <button onClick={() => setZoomLevel(Math.max(zoom - 10, 30))} disabled={!currentUrl || zoom <= 30} className={btn} title="Zoom out">
            {icon('M20 12H4', 'w-3.5 h-3.5')}
          </button>
          <button onClick={() => setZoomLevel(100)} disabled={!currentUrl} className="px-1 text-[10px] font-mono text-vibe-muted hover:text-vibe-text rounded disabled:opacity-30 min-w-[36px] text-center" title="Reset zoom">
            {zoom}%
          </button>
          <button onClick={() => setZoomLevel(Math.min(zoom + 10, 200))} disabled={!currentUrl || zoom >= 200} className={btn} title="Zoom in">
            {icon('M12 4v16m8-8H4', 'w-3.5 h-3.5')}
          </button>
        </div>

        <button
          onClick={() => void (currentBookmark ? bm.remove(currentBookmark.id) : bm.add(currentUrl))}
          disabled={!currentUrl || !project}
          data-testid="web-preview-bookmark"
          data-bookmarked={currentBookmark ? 'true' : 'false'}
          className={`p-1.5 rounded transition-colors disabled:opacity-30 ${currentBookmark ? 'text-yellow-400' : 'text-vibe-muted hover:text-vibe-text'}`}
          title={!project ? 'No active project' : currentBookmark ? 'Remove bookmark' : 'Bookmark this page'}
        >
          {currentBookmark ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
            </svg>
          ) : (
            icon(STAR_OUTLINE)
          )}
        </button>

        <BookmarksMenu ctx={ctx} open={menuOpen} setOpen={setMenuOpen} onOpen={(url) => void navigate(url)} disabled={!project} />

        <button
          onClick={() => setViewMode((m) => (m === 'desktop' ? 'mobile' : 'desktop'))}
          disabled={!currentUrl}
          className={`p-1.5 rounded transition-colors disabled:opacity-30 ${viewMode === 'mobile' ? 'text-vibe-primary' : 'text-vibe-muted hover:text-vibe-text'}`}
          title={viewMode === 'mobile' ? 'Switch to desktop view' : 'Switch to mobile view'}
        >
          {viewMode === 'mobile' ? icon('M11 18h2M9 3h6a2 2 0 012 2v14a2 2 0 01-2 2H9a2 2 0 01-2-2V5a2 2 0 012-2z') : icon('M5 4h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zM8 20h8M12 16v4')}
        </button>

        {ctx.api.has('native.captureRegion') && (
          <button
            onClick={() => void screenshot()}
            disabled={!currentUrl || showPlaceholder}
            className={`p-1.5 rounded transition-colors disabled:opacity-30 ${capture === 'copied' ? 'text-green-400' : capture === 'error' ? 'text-red-400' : 'text-vibe-muted hover:text-vibe-text'}`}
            title={capture === 'copied' ? 'Copied!' : capture === 'error' ? 'Failed to copy' : 'Copy screenshot to clipboard'}
          >
            {capture === 'copied'
              ? icon(ICON.check)
              : capture === 'error'
                ? icon(ICON.warn)
                : icon('M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9zM15 13a3 3 0 11-6 0 3 3 0 016 0z')}
          </button>
        )}

        <button onClick={() => currentUrl && void ctx.shell.openExternal(currentUrl).catch((e) => ctx.log.warn(e))} disabled={!currentUrl} className={btn} title="Open in browser">
          {icon(ICON.external)}
        </button>
      </div>

      <div className="flex-1 flex justify-center overflow-hidden bg-vibe-bg min-h-0">
        <div
          ref={viewportRef}
          // While a placeholder shows, the anchor is absent and the host hides the webview.
          {...(showPlaceholder ? {} : { 'data-webpreview-viewport': '' })}
          data-testid="web-preview-viewport"
          className={`relative h-full ${viewMode === 'mobile' ? 'w-[390px] max-w-full border-x border-vibe-border' : 'w-full'}`}
        >
          {pollStatus ? (
            <Centered>
              <div className="w-8 h-8 mx-auto mb-3 border-2 border-vibe-primary border-t-transparent rounded-full animate-spin" />
              <p>{pollStatus}</p>
            </Centered>
          ) : error ? (
            <Centered>
              <p className="text-red-400">{error}</p>
              <button onClick={() => void navigate(urlBar)} className="mt-3 px-3 py-1.5 text-sm text-vibe-primary hover:underline">
                Retry
              </button>
            </Centered>
          ) : !hasView ? (
            <Centered>
              <p className="text-lg">Web Preview</p>
              <p className="text-sm mt-1">Enter a URL above to preview a website</p>
              <p className="text-xs mt-2 opacity-50">Tip: a "server" script with a preview URL opens this panel automatically</p>
            </Centered>
          ) : null}
        </div>
      </div>

      {linkedScriptTabId && (
        <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1 border-t border-vibe-border bg-vibe-bg-lighter text-xs text-vibe-muted">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span>Linked to running script</span>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-vibe-muted">
      <div className="text-center">{children}</div>
    </div>
  )
}

function BookmarksMenu({
  ctx,
  open,
  setOpen,
  onOpen,
  disabled,
}: {
  ctx: PluginContext
  open: boolean
  setOpen(o: boolean): void
  onOpen(url: string): void
  disabled: boolean
}) {
  const bm = bookmarksModel(ctx)
  const bookmarks = bm.use((s) => s.bookmarks)
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setEditing(null)
      }
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  const commit = async () => {
    if (editing && title.trim()) await bm.rename(editing, title)
    setEditing(null)
    setTitle('')
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} disabled={disabled} className={btn} title={disabled ? 'No active project' : 'Bookmarks'} data-testid="web-preview-bookmarks">
        {icon(ICON.list)}
      </button>
      {open && (
        <div
          data-qf-overlay=""
          data-testid="web-preview-bookmarks-panel"
          className="absolute right-0 top-full mt-0.5 w-80 max-h-96 overflow-y-auto bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-[60]"
        >
          <div className="px-3 py-2 border-b border-vibe-border text-xs text-vibe-muted uppercase tracking-wide">Bookmarks</div>
          {bookmarks.length === 0 ? (
            <div className="px-3 py-4 text-sm text-vibe-muted text-center">No bookmarks yet. Click the ★ to save the current page.</div>
          ) : (
            <ul className="py-1">
              {bookmarks.map((b) => (
                <li key={b.id} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-vibe-bg-lighter" data-testid="web-preview-bookmark-row">
                  <button
                    onClick={() => {
                      onOpen(b.url)
                      setOpen(false)
                      setEditing(null)
                    }}
                    className="flex-1 min-w-0 text-left"
                    title={b.url}
                  >
                    {editing === b.id ? (
                      <input
                        autoFocus
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onBlur={() => void commit()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commit()
                          else if (e.key === 'Escape') setEditing(null)
                          e.stopPropagation()
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full px-1.5 py-0.5 bg-vibe-bg border border-vibe-primary rounded text-sm text-vibe-text focus:outline-none"
                      />
                    ) : (
                      <div className="text-sm text-vibe-text truncate">{b.title}</div>
                    )}
                    <div className="text-xs text-vibe-muted truncate font-mono">{b.url}</div>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditing(b.id)
                      setTitle(b.title)
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-vibe-muted hover:text-vibe-text rounded transition-all"
                    title="Rename"
                  >
                    {icon(ICON.edit, 'w-3.5 h-3.5')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void bm.remove(b.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-vibe-muted hover:text-red-400 rounded transition-all"
                    title="Remove"
                  >
                    {icon(ICON.x, 'w-3.5 h-3.5')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
