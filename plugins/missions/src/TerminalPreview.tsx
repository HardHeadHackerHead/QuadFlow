/**
 * Read-only live preview of a member's agent terminal: scrollback from
 * `ctx.terminals.readBuffer`, then `ctx.terminals.onData`. Unlike
 * `terminals.attach` it never resizes the PTY (the agent's real tile owns its
 * size) and never sends input.
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PluginContext, ThemeSnapshot } from '@quadflow/plugin-api'

const xtermTheme = (t: ThemeSnapshot) => ({
  background: t.terminal['bg'],
  foreground: t.terminal['fg'],
  cursor: t.terminal['cursor'],
  black: t.terminal['black'],
  red: t.terminal['red'],
  green: t.terminal['green'],
  yellow: t.terminal['yellow'],
  blue: t.terminal['blue'],
  magenta: t.terminal['magenta'],
  cyan: t.terminal['cyan'],
  white: t.terminal['white'],
})

export function TerminalPreview({ ctx, terminalId, height = 120, onClick }: { ctx: PluginContext; terminalId: string; height?: number; onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const theme = ctx.ui.theme()
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      fontSize: 11,
      lineHeight: 1.2,
      scrollback: 1000,
      fontFamily: theme.scalars['font-mono'] || "'Cascadia Code', 'Fira Code', Consolas, monospace",
      theme: xtermTheme(theme),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    let disposed = false
    const offTheme = ctx.ui.onThemeChange((t) => {
      if (!disposed) term.options.theme = xtermTheme(t)
    })
    const doFit = () => {
      if (disposed) return
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
    }
    requestAnimationFrame(doFit)
    const ro = new ResizeObserver(doFit)
    ro.observe(el)
    let live: string[] | null = []
    // Scrollback first, then live output (chunks that arrive meanwhile are queued).
    ctx.terminals
      .readBuffer(terminalId, 64 * 1024)
      .then((s) => {
        if (disposed) return
        if (s) term.write(s)
        for (const c of live ?? []) term.write(c)
        live = null
        term.scrollToBottom()
      })
      .catch(() => {
        live = null
      })
    const off = ctx.terminals.onData(terminalId, (chunk) => {
      if (disposed) return
      if (live) live.push(chunk)
      else term.write(chunk)
    })
    return () => {
      disposed = true
      ro.disconnect()
      offTheme()
      off()
      term.dispose()
    }
  }, [ctx, terminalId])

  return (
    <div
      ref={ref}
      data-testid="member-terminal-preview"
      className={`w-full rounded overflow-hidden ${onClick ? 'cursor-pointer' : ''}`}
      style={{ height }}
      onClick={onClick}
      title={onClick ? 'Show the agent terminal' : undefined}
    />
  )
}
