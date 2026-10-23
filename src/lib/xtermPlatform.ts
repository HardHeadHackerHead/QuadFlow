import type { Terminal, IWindowsPty } from '@xterm/xterm'
import { osApi } from './tauri-api'
import type { OsInfo } from '../types'

/**
 * xterm.js platform options for PTY-backed terminals.
 *
 * `windowsPty` must describe the *real* ConPTY: with a build < 21376 xterm
 * turns on legacy wrapping heuristics that break `isWrapped` tracking, so
 * copying wrapped output inserts a hard newline at every wrap. On non-Windows
 * platforms `windowsPty` must stay unset.
 */
export function windowsPtyFor(info: OsInfo | null): IWindowsPty | undefined {
  if (!info || info.platform !== 'windows' || !info.buildNumber) return undefined
  return { backend: 'conpty', buildNumber: info.buildNumber }
}

/**
 * Apply the platform's PTY options to a freshly created xterm Terminal.
 * Uses the cached OS info when it has loaded (preloaded at startup), otherwise
 * applies it as soon as it arrives — xterm re-evaluates `windowsPty` on change.
 */
export function applyPtyPlatformOptions(terminal: Terminal): void {
  const cached = osApi.getCachedInfo()
  if (cached) {
    const windowsPty = windowsPtyFor(cached)
    if (windowsPty) terminal.options.windowsPty = windowsPty
    return
  }
  osApi
    .getInfo()
    .then((info) => {
      const windowsPty = windowsPtyFor(info)
      if (windowsPty) {
        try {
          terminal.options.windowsPty = windowsPty
        } catch {
          // Terminal was disposed before OS info arrived.
        }
      }
    })
    .catch(() => {})
}
