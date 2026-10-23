/**
 * `terminals.attach(id, el)` (trusted only, plugin-system.md §6.4): an xterm
 * view of a PTY mounted into a plugin's element. Output and input go through
 * the plugin's own permission-checked `terminals.onData` / `terminals.write`,
 * so a plugin can only attach to terminals it owns (or with `terminal:io`).
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Disposable } from '@quadflow/plugin-api'
import { getThemeSnapshot } from '@quadflow/ui'
import { getTerminalTheme, onTerminalThemeChange } from '../../lib/terminalTheme'
import { isModKey } from '../../lib/platformKeys'

export interface AttachDeps {
  onData(cb: (chunk: string) => void): Disposable
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  readBuffer(): Promise<string>
}

export function attachTerminal(el: HTMLElement, deps: AttachDeps, log: (e: unknown) => void): Disposable {
  const theme = getThemeSnapshot()
  const term = new Terminal({
    convertEol: false,
    fontFamily: theme.scalars['font-mono'] || 'monospace',
    fontSize: 13,
    // Same palette as the shell's own terminals, and it follows light/dark switches.
    theme: getTerminalTheme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // App shortcuts (command palette) must reach the window: xterm would consume them.
  term.attachCustomKeyEventHandler(
    (e) => !(isModKey(e) && !e.altKey && (e.key === 'k' || (e.shiftKey && (e.key === 'P' || e.key === 'B')))),
  )
  term.open(el)
  const offTheme = onTerminalThemeChange((t) => {
    if (!disposed) term.options.theme = t
  })
  let disposed = false
  const doFit = () => {
    if (disposed) return
    try {
      fit.fit()
      void deps.resize(term.cols, term.rows).catch(log)
    } catch {
      // element not laid out yet
    }
  }
  doFit()
  const ro = new ResizeObserver(doFit)
  ro.observe(el)
  // Scrollback first, then live output.
  void deps
    .readBuffer()
    .then((s) => !disposed && s && term.write(s))
    .catch(log)
  const offData = deps.onData((chunk) => !disposed && term.write(chunk))
  const input = term.onData((d) => void deps.write(d).catch(log))
  return () => {
    if (disposed) return
    disposed = true
    ro.disconnect()
    offTheme()
    input.dispose()
    offData()
    term.dispose()
  }
}
