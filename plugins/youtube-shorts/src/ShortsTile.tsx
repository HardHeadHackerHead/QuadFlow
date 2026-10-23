/**
 * YouTube Shorts player: a child webview on the tile (`ctx.native.createChildWebview`,
 * permission `native:webview`) with auto-scroll to the next short, a countdown, skip and
 * volume / mute — injected into the page with `webview.eval`. Ported from the shell's
 * YouTubeShortsToolView; state lives in ./model.ts so palette commands can drive it.
 *
 * The webview covers only the video area (`anchor`: that element, API 1.4) and uses a
 * mobile user agent (`userAgent`, API 1.4). "Controls" (button / palette command) still opens
 * as an overlay (`ctx.overlay.register` → the host hides the webview, playback continues).
 * Not ported yet: "pop out to window" (`ctx.native.openWindow` exists since API 1.4).
 */
import { useEffect, useRef, useState } from 'react'
import type { ChildWebview, PluginContext, TileProps } from '@quadflow/plugin-api'
import {
  HOME_URL,
  MOBILE_USER_AGENT,
  SHORTS_URL,
  applyVolumeSoon,
  formatTime,
  navigate,
  next,
  searchUrl,
  setIntervalSecs,
  setVolume,
  startTicker,
  stopTicker,
  toggleAuto,
  toggleMute,
  useShorts,
} from './model'

const OVERLAY_ID = 'controls'

export function setControlsOpen(ctx: PluginContext, open: boolean) {
  useShorts.setState({ controlsOpen: open })
  ctx.overlay.register(OVERLAY_ID, open)
}

export function ShortsTile({ ctx, instance }: TileProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const { webview, autoScroll, interval, remaining, volume, muted, controlsOpen } = useShorts()
  const supported = ctx.api.has('native.createChildWebview')

  // One child webview for the tile's lifetime.
  useEffect(() => {
    if (!supported) return
    let wv: ChildWebview | null = null
    let disposed = false
    const opts = {
      instanceId: instance.id,
      url: useShorts.getState().url || SHORTS_URL,
      anchor: surfaceRef.current ?? undefined,
      userAgent: MOBILE_USER_AGENT,
    }
    ctx.native
      .createChildWebview(opts)
      .then((w) => {
        if (disposed) {
          void w.close()
          return
        }
        wv = w
        useShorts.setState({ webview: w })
        setIsLoading(false)
        applyVolumeSoon()
      })
      .catch((e) => {
        setIsLoading(false)
        setError(e instanceof Error ? e.message : String(e))
      })
    startTicker()
    return () => {
      disposed = true
      stopTicker()
      if (useShorts.getState().webview === wv) useShorts.setState({ webview: null })
      void wv?.close()
      ctx.overlay.register(OVERLAY_ID, false)
      useShorts.setState({ controlsOpen: false })
    }
  }, [ctx, instance.id, supported])

  // The host hides the webview under overlays; show a placeholder instead.
  useEffect(() => ctx.native.onTileGeometry(instance.id, (g) => setHidden(!g.visible)), [ctx, instance.id])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery.trim()) navigate(searchUrl(searchQuery))
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg">
      {/* Top Toolbar (+ auto-scroll row): an overlay while "Controls" is open */}
      <div {...(controlsOpen ? { 'data-qf-overlay': '' } : {})} className="flex-shrink-0">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-vibe-surface border-b border-vibe-border z-10 flex-shrink-0">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => {
              setSearchQuery('')
              navigate(SHORTS_URL)
            }}
            className="p-1.5 text-vibe-muted hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            title="Shorts Feed"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z" />
            </svg>
          </button>
          <button
            onClick={() => {
              setSearchQuery('')
              navigate(HOME_URL)
            }}
            className="p-1.5 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="YouTube Home"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </button>
          <button
            onClick={() => navigate(useShorts.getState().url)}
            className="p-1.5 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSearch} className="flex-1 flex items-center gap-1">
          <div className="flex-1 relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="w-full px-2 py-1 pl-7 bg-vibe-bg border border-vibe-border rounded text-xs text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-red-500/50"
            />
            <svg className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <button type="submit" className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors">
            Go
          </button>
        </form>
        {webview && (
          <button
            onClick={() => setControlsOpen(ctx, !controlsOpen)}
            data-testid="shorts-controls"
            className="px-2 py-1 text-xs rounded border border-vibe-border text-vibe-muted hover:text-vibe-text"
            title={controlsOpen ? 'Back to the video' : 'Show the controls over the video'}
          >
            {controlsOpen ? 'Back to video' : 'Controls'}
          </button>
        )}
      </div>

      {/* Auto-scroll + volume */}
      <div className="flex items-center gap-2 px-2 py-1 bg-vibe-bg border-b border-vibe-border flex-shrink-0">
        <button
          onClick={toggleAuto}
          data-testid="shorts-auto"
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
            autoScroll
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'bg-vibe-surface text-vibe-muted border border-vibe-border hover:text-vibe-text'
          }`}
          title={autoScroll ? 'Stop auto-scroll' : 'Start auto-scroll'}
        >
          {autoScroll ? (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
          Auto
        </button>

        {autoScroll && (
          <div className="flex items-center gap-1 px-2 py-1 bg-vibe-surface rounded border border-vibe-border">
            <span className="text-xs text-vibe-text font-mono" data-testid="shorts-countdown">{formatTime(remaining)}</span>
          </div>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIntervalSecs(interval - 5)}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="Decrease interval"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span className="text-xs text-vibe-muted min-w-[40px] text-center" data-testid="shorts-interval">{interval}s</span>
          <button
            onClick={() => setIntervalSecs(interval + 5)}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="Increase interval"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>

        <button
          onClick={next}
          className="flex items-center gap-1 px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded hover:bg-vibe-border/50 transition-colors"
          title="Skip to next"
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
          Next
        </button>

        <div className="w-px h-5 bg-vibe-border mx-1" />

        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleMute}
            className={`p-1 rounded transition-colors ${muted ? 'text-red-400 hover:bg-red-500/10' : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'}`}
            title={muted ? 'Unmute' : 'Mute'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
              {muted || volume === 0 ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072" />
              )}
            </svg>
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(parseInt(e.target.value))}
            className="w-16 h-1 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-red-500"
            title={`Volume: ${muted ? 0 : volume}%`}
          />
          <span className="text-xs text-vibe-muted w-6 text-right">{muted ? 0 : volume}</span>
        </div>
      </div>

      </div>

      {/* The child webview is placed over this area (or, on today's host, the whole tile). */}
      <div ref={surfaceRef} className="flex-1 relative bg-black min-h-0" data-testid="shorts-surface">
        {!supported && (
          <div className="absolute inset-0 flex items-center justify-center bg-vibe-bg text-sm text-vibe-muted p-6 text-center">
            Embedded web views are not available in this QuadFlow (or this plugin was not granted native:webview).
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-vibe-bg text-sm text-red-400 p-6 text-center">{error}</div>
        )}
        {supported && isLoading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-vibe-bg z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-vibe-muted text-sm">Loading YouTube...</span>
            </div>
          </div>
        )}
        {hidden && webview && !controlsOpen && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-gradient-to-b from-black via-zinc-900 to-black">
            <div className="text-center px-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-red-600 to-red-700 rounded-2xl flex items-center justify-center">
                <svg className="w-8 h-8 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <p className="text-white/90 font-medium text-sm tracking-wide">Still Playing</p>
              <p className="text-white/40 text-xs mt-1">Will return when the menu closes</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
