import type { ITheme } from '@xterm/xterm'
import { getThemeSnapshot, onThemeChange, type ThemeSnapshot } from '@quadflow/ui'

/**
 * Fallback color theme for the main agent/shell terminals (TerminalView).
 * Identical to the dark `--qf-term-*` tokens in packages/ui/src/tokens.css;
 * used only when the tokens cannot be read (no DOM / CSS not loaded yet).
 */
export const DEFAULT_TERMINAL_THEME: ITheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
}

/** xterm ITheme key -> `--qf-term-*` token suffix. */
const TOKEN_MAP: Partial<Record<keyof ITheme, keyof ThemeSnapshot['terminal']>> = {
  background: 'bg',
  foreground: 'fg',
  cursor: 'cursor',
  cursorAccent: 'cursor-accent',
  selectionBackground: 'selection',
  selectionForeground: 'selection-fg',
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  brightBlack: 'bright-black',
  brightRed: 'bright-red',
  brightGreen: 'bright-green',
  brightYellow: 'bright-yellow',
  brightBlue: 'bright-blue',
  brightMagenta: 'bright-magenta',
  brightCyan: 'bright-cyan',
  brightWhite: 'bright-white',
}

/** Build an xterm theme from a theme snapshot's terminal tokens. */
export function terminalThemeFromSnapshot(snapshot: ThemeSnapshot): ITheme {
  const theme: ITheme = { ...DEFAULT_TERMINAL_THEME }
  for (const [key, token] of Object.entries(TOKEN_MAP)) {
    const v = snapshot.terminal[token]
    if (v && v.startsWith('#')) (theme as Record<string, string>)[key] = v
  }
  return theme
}

/** Current terminal theme, derived from the active @quadflow/ui theme tokens. */
export function getTerminalTheme(): ITheme {
  if (typeof document === 'undefined') return DEFAULT_TERMINAL_THEME
  return terminalThemeFromSnapshot(getThemeSnapshot())
}

/** Subscribe to terminal theme changes (light/dark switch, …). */
export function onTerminalThemeChange(cb: (theme: ITheme) => void): () => void {
  return onThemeChange((s) => cb(terminalThemeFromSnapshot(s)))
}
