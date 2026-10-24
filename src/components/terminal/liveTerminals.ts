/**
 * One xterm per PTY, living as long as the PTY — not as long as a React mount.
 *
 * A terminal tile unmounts whenever it leaves the layout: switching projects or
 * workspaces (with "Keep terminals alive" the PTY keeps running), minimizing,
 * moving it to/from a global workspace. Creating a fresh xterm on every mount
 * lost the whole scrollback of a still-running PTY (only ConPTY's repaint of
 * the visible screen came back, so the terminal could not be scrolled up).
 *
 * Now `TerminalView` acquires the live xterm for its terminal id: the xterm's
 * host element is moved into the tile, and on unmount it is parked (detached,
 * still receiving PTY output). It is disposed when its PTY ends: killed, exited,
 * or replaced by a fresh spawn under the same id (that one starts from the
 * saved buffer, `pendingBufferContent`).
 *
 * Re-attaching a detached element resets the viewport's `scrollTop` to 0 while
 * xterm still believes it shows the bottom — wheel/scrollbar then cannot
 * scroll up. `resyncViewport` fixes that after every re-attach / re-show.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { terminalApi, requestWindowAttention, openExternal, ptyLifecycle } from '../../lib/tauri-api'
import { registerTerminal, unregisterTerminal } from '../../lib/terminalRegistry'
import { useTerminalStore, terminalActivityMap } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { closeIfLinkedIssueFinished } from '../../lib/issueTerminals'
import { shouldTriggerAttention } from '../../lib/attentionDetector'
import { getProviderInfo } from '../../agents/providers'
import { redactSecrets } from '../../lib/secretRedaction'
import { applyPtyPlatformOptions } from '../../lib/xtermPlatform'
import { getTerminalTheme, onTerminalThemeChange } from '../../lib/terminalTheme'
import { getCopyText } from '../../lib/terminalSelection'
import { isModKey } from '../../lib/platformKeys'

export interface LiveTerminal {
  readonly id: string
  readonly terminal: Terminal
  readonly fit: FitAddon
  /** Element the xterm was opened in; moved between tile containers. */
  readonly host: HTMLDivElement
  /** The mount currently showing it (null = parked). */
  owner: object | null
  /** The PTY ended (exit / kill): dispose once no tile shows it. */
  ended: boolean
  /** Last size sent to the PTY. */
  ptyCols: number
  ptyRows: number
  dispose(): void
}

const live = new Map<string, LiveTerminal>()

ptyLifecycle.add((e) => {
  const t = live.get(e.id)
  if (!t) return
  if (e.kind === 'spawned' && e.reattached) return
  // Killed, or a fresh PTY took over the id: this xterm belongs to a dead PTY.
  if (t.owner) t.ended = true
  else t.dispose()
})

/** Copy the terminal's selection to the clipboard; false when nothing is selected. */
export function copySelection(terminal: Terminal): boolean {
  const text = getCopyText(terminal, useAppSettingsStore.getState().terminal.joinWrappedLines)
  if (!text) return false
  navigator.clipboard.writeText(text).catch((err) => console.error('Failed to write to clipboard:', err))
  return true
}

function pasteInto(id: string): void {
  navigator.clipboard.readText().then((text) => {
    if (text) terminalApi.write(id, text)
  }).catch((err) => console.error('Failed to read clipboard:', err))
}

/**
 * Show the live xterm for `id` in `container` (creating it on first use).
 * `adopted`: an existing xterm (with its scrollback) was re-attached.
 */
export function acquireLiveTerminal(id: string, container: HTMLElement, owner: object): { live: LiveTerminal; adopted: boolean } {
  const existing = live.get(id)
  if (existing) {
    container.appendChild(existing.host)
    existing.owner = owner
    // A saved buffer is only for a fresh xterm; this one still has the real scrollback.
    if (useTerminalStore.getState().terminals.get(id)?.pendingBufferContent) {
      useTerminalStore.getState().updateTerminal(id, { pendingBufferContent: undefined })
    }
    return { live: existing, adopted: true }
  }
  const created = createLiveTerminal(id, container)
  created.owner = owner
  return { live: created, adopted: false }
}

/** The mount `owner` no longer shows the terminal: park it, or dispose it if its PTY ended. */
export function releaseLiveTerminal(t: LiveTerminal, owner: object): void {
  if (t.owner !== owner) return // another mount took it over
  t.owner = null
  t.host.remove()
  if (t.ended) t.dispose()
}

/** Whether an element is laid out with a real size (not display:none / collapsed / detached). */
function isLaidOut(el: HTMLElement): boolean {
  return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0
}

/**
 * Fit the xterm to its container and tell the PTY. Skipped while hidden: a fit
 * at 0×0 would shrink the terminal to the minimum size and make the PTY
 * (ConPTY) re-wrap its screen to 2 columns.
 */
export function fitLiveTerminal(t: LiveTerminal): boolean {
  if (!isLaidOut(t.host)) return false
  const dims = t.fit.proposeDimensions()
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return false
  const changed = dims.cols !== t.terminal.cols || dims.rows !== t.terminal.rows
  if (changed) t.fit.fit()
  if (dims.cols !== t.ptyCols || dims.rows !== t.ptyRows) {
    t.ptyCols = dims.cols
    t.ptyRows = dims.rows
    terminalApi.resize(t.id, dims.cols, dims.rows).catch(() => {})
  }
  if (changed) t.terminal.scrollToBottom()
  return true
}

/**
 * Re-sync xterm's viewport (scroll area height + scrollTop) with the buffer
 * after the element was re-attached or re-shown, and repaint. Uses a scroll
 * round trip: xterm re-syncs its scroll area on every scroll.
 */
export function resyncViewport(terminal: Terminal): void {
  try {
    const buf = terminal.buffer.active
    if (buf.baseY > 0) {
      const step = buf.viewportY > 0 ? -1 : 1
      terminal.scrollLines(step)
      terminal.scrollLines(-step)
    }
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    // disposed
  }
}

function createLiveTerminal(id: string, container: HTMLElement): LiveTerminal {
  const settings = useAppSettingsStore.getState().terminal
  const terminal = new Terminal({
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    lineHeight: settings.lineHeight,
    scrollback: settings.scrollbackLines,
    allowProposedApi: true,
    smoothScrollDuration: 0,
    // windowsPty is applied below from the real OS build (never hardcoded).
    theme: getTerminalTheme(),
  })
  applyPtyPlatformOptions(terminal)

  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(new WebLinksAddon((_event, url) => { openExternal(url) }))

  const host = document.createElement('div')
  host.className = 'h-full w-full'
  container.appendChild(host)
  terminal.open(host)

  if (settings.useWebGL) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      terminal.loadAddon(webgl)
    } catch {
      console.log('WebGL not available, using canvas renderer')
    }
  }

  let disposed = false
  const cleanups: (() => void)[] = []
  const t: LiveTerminal = {
    id,
    terminal,
    fit,
    host,
    owner: null,
    ended: false,
    ptyCols: 0,
    ptyRows: 0,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const c of cleanups) {
        try { c() } catch { /* ignore */ }
      }
      if (live.get(id) === t) live.delete(id)
      unregisterTerminal(id)
      terminal.dispose()
      host.remove()
    },
  }
  live.set(id, t)
  registerTerminal(id, terminal)

  // Copy on select (setting read per selection, so toggling it applies to open terminals).
  const selectionSub = terminal.onSelectionChange(() => {
    if (useAppSettingsStore.getState().terminal.copyOnSelect && terminal.hasSelection()) copySelection(terminal)
  })
  cleanups.push(() => selectionSub.dispose())

  terminal.onBell(() => {
    const s = useAppSettingsStore.getState().terminal
    if (s.bellStyle === 'none') return
    if (s.bellStyle === 'visual' || s.bellStyle === 'both') {
      const el = host.parentElement
      if (el) {
        el.style.backgroundColor = '#3f3f5a'
        setTimeout(() => { el.style.backgroundColor = '' }, 100)
      }
    }
    if (s.bellStyle === 'sound' || s.bellStyle === 'both') {
      const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()
      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.frequency.value = 800
      gainNode.gain.value = 0.1
      oscillator.start()
      setTimeout(() => {
        oscillator.stop()
        audioContext.close()
      }, 100)
    }
  })

  // Restore the saved buffer of a fresh PTY. It is plain text joined with LF:
  // xterm needs CR LF to start each line at column 0. Then scroll it all into
  // the scrollback: the new ConPTY paints its first screen from the top-left
  // of the viewport and would overwrite the last screenful of restored lines.
  const state = useTerminalStore.getState().terminals.get(id)
  if (state?.pendingBufferContent) {
    const content = useAppSettingsStore.getState().terminal.streamerMode
      ? redactSecrets(state.pendingBufferContent)
      : state.pendingBufferContent
    if (isLaidOut(host)) {
      try { fit.fit() } catch { /* not measurable yet */ }
    }
    terminal.write(content.replace(/\r?\n/g, '\r\n') + '\r\n'.repeat(terminal.rows + 1))
    useTerminalStore.getState().updateTerminal(id, { pendingBufferContent: undefined })
  }

  // Input -> PTY. Shift+Enter sends LF; skip the CR xterm still emits after it.
  let skipNextEnter = false
  terminal.onData((data) => {
    if (skipNextEnter && (data === '\r' || data === '\n' || data === '\r\n')) {
      skipNextEnter = false
      return
    }
    terminalApi.write(id, data)
  })

  // PTY -> xterm (also while parked, so nothing is lost while the tile is not shown).
  let attentionTimeout: number | null = null
  let recentOutput = ''
  cleanups.push(() => { if (attentionTimeout) clearTimeout(attentionTimeout) })
  const listen = (p: Promise<() => void>) => {
    p.then((unlisten) => {
      if (disposed) unlisten()
      else cleanups.push(unlisten)
    }).catch(() => {})
  }
  listen(terminalApi.onData(id, (data) => {
    if (disposed) return
    terminal.write(useAppSettingsStore.getState().terminal.streamerMode ? redactSecrets(data) : data)

    // Activity for idle detection (module-level map, no Zustand re-render).
    terminalActivityMap.set(id, Date.now())
    const current = useTerminalStore.getState().terminals.get(id)
    if (current?.isIdle) useTerminalStore.getState().setTerminalIdle(id, false)

    // Attention detection for agent terminals (generic + provider patterns).
    if (current?.agent) {
      recentOutput = (recentOutput + data).slice(-2000)
      if (attentionTimeout) clearTimeout(attentionTimeout)
      // Wait for the agent's TUI to finish rendering.
      attentionTimeout = window.setTimeout(() => {
        const store = useTerminalStore.getState()
        const term = store.terminals.get(id)
        const isActive = store.activeTerminalId === id
        const isMinimized = store.minimizedTerminals.includes(id)
        const patterns = getProviderInfo(term?.agent?.providerId)?.attentionPatterns ?? []
        const needsAttention = shouldTriggerAttention(recentOutput, patterns)
        const windowHasFocus = document.hasFocus()
        if (term && needsAttention && (!isActive || !windowHasFocus)) {
          store.setTerminalAttention(id, true)
          if ((isMinimized || !windowHasFocus) && useAppSettingsStore.getState().terminal.flashTaskbarOnAttention) {
            requestWindowAttention().catch(console.error)
          }
        }
        recentOutput = ''
      }, 800)
    }
  }))

  // Exit. Stale exits of a previous spawn under this id are filtered by generation in terminalApi.
  listen(terminalApi.onExit(id, () => {
    if (disposed) return
    t.ended = true
    const inStore = useTerminalStore.getState().terminals.has(id)
    // Parked and no longer part of the workspace (e.g. its project was switched away): nothing will show it again.
    if (!t.owner && !inStore) {
      t.dispose()
      return
    }
    terminal.write('\r\n\x1b[31m[Terminal closed]\x1b[0m\r\n')
    // Mark PTY as exited for auto-close tracking (also while minimized).
    useTerminalStore.getState().updateTerminal(id, { hasExited: true })
    // Reverse case: PTY exits after the linked issue already moved to qa/done.
    void closeIfLinkedIssueFinished(id)
  }))

  // Light/dark palette.
  cleanups.push(onTerminalThemeChange((theme) => { terminal.options.theme = theme }))

  // Live settings.
  cleanups.push(useAppSettingsStore.subscribe((s) => {
    const n = s.terminal
    terminal.options.fontSize = n.fontSize
    terminal.options.fontFamily = n.fontFamily
    terminal.options.lineHeight = n.lineHeight
    terminal.options.cursorStyle = n.cursorStyle
    terminal.options.cursorBlink = n.cursorBlink
    // scrollback can't be changed after creation. Refit after a font change.
    requestAnimationFrame(() => { if (!disposed) fitLiveTerminal(t) })
  }))

  terminal.attachCustomKeyEventHandler((event) => {
    // Shift+Enter: newline instead of submit.
    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'keydown') {
        skipNextEnter = true
        terminalApi.write(id, '\n')
      }
      return false
    }
    // Ctrl+V / Ctrl+Shift+V: paste (preventDefault: no second browser paste).
    if (event.ctrlKey && (event.key === 'v' || (event.shiftKey && event.key === 'V')) && event.type === 'keydown') {
      event.preventDefault()
      pasteInto(id)
      return false
    }
    // Ctrl+C / Ctrl+Shift+C with a selection: copy. Ctrl+C without one stays SIGINT.
    if (event.ctrlKey && (event.key === 'c' || (event.shiftKey && event.key === 'C')) && event.type === 'keydown') {
      if (copySelection(terminal)) return false
    }
    // Global app shortcuts must reach the window.
    if (isModKey(event) && (event.key === 'w' || event.key === 'k' || event.key === 'b' || (event.shiftKey && (event.key === 'P' || event.key === 'B')))) {
      return false
    }
    return true
  })

  return t
}

/** Right-click in a terminal: copy the selection (and clear it), else paste. */
export function handleTerminalContextMenu(t: LiveTerminal, e: { preventDefault(): void }): void {
  if (!useAppSettingsStore.getState().terminal.rightClickPaste) return
  e.preventDefault()
  if (copySelection(t.terminal)) {
    t.terminal.clearSelection()
    return
  }
  pasteInto(t.id)
}
