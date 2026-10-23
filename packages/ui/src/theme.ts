import { useSyncExternalStore } from 'react'

/** User preference (setting `appearance.mode`). */
export type ThemeMode = 'dark' | 'light' | 'system'
/** Theme actually in effect. */
export type ResolvedTheme = 'dark' | 'light'

/** Every `--qf-*` color token (RGB triplets in CSS). */
export const COLOR_TOKENS = [
  'bg', 'bg-elevated', 'surface', 'border', 'border-strong',
  'primary', 'primary-hover', 'secondary', 'on-primary',
  'text', 'text-muted', 'success', 'warning', 'error',
  'scrim', 'scrollbar-track', 'scrollbar-thumb', 'scrollbar-thumb-hover',
  'attention-glow', 'idle-glow',
] as const

export const TERMINAL_TOKENS = [
  'bg', 'fg', 'cursor', 'cursor-accent', 'selection', 'selection-fg',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const

export const SCALAR_TOKENS = ['radius-panel', 'gap-panel', 'ui-scale', 'font-mono', 'font-sans'] as const

export type ColorToken = (typeof COLOR_TOKENS)[number]
export type TerminalToken = (typeof TERMINAL_TOKENS)[number]

/** Resolved theme values (`ui.theme()` in the plugin API, §6.7 / §14.1). */
export interface ThemeSnapshot {
  /** Theme in effect. */
  mode: ResolvedTheme
  /** User preference that produced it. */
  preference: ThemeMode
  /** Color tokens as `#rrggbb`, keyed by token name without the `--qf-` prefix. */
  colors: Record<ColorToken, string>
  /** Terminal palette as `#rrggbb`, keyed by `term-*` suffix. */
  terminal: Record<TerminalToken, string>
  /** Non-color tokens verbatim (`radius-panel`, `font-mono`, …). */
  scalars: Record<(typeof SCALAR_TOKENS)[number], string>
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/** `#7c3aed` / `#73e` → `"124 58 237"`. Returns null for anything else. */
export function hexToTriplet(hex: string): string | null {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** `"124 58 237"` → `#7c3aed`. Unparseable input is returned unchanged. */
export function tripletToHex(triplet: string): string {
  const parts = triplet.trim().split(/[\s,]+/).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((p) => !Number.isFinite(p))) return triplet.trim()
  return '#' + parts.slice(0, 3).map((p) => Math.round(p).toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Theme application (host side)
// ---------------------------------------------------------------------------

export interface ApplyThemeOptions {
  mode: ThemeMode
  /**
   * Accent override for `--qf-primary` / `--qf-primary-hover` (hex). Pass null
   * to use each theme's own primary (the default purple is tuned per theme).
   */
  accent?: { primary: string; hover: string } | null
  /** Extra variables to set, e.g. `{ 'radius-panel': '8px', 'attention-glow': '#f97316' }`.
   *  Hex values are converted to triplets. Keys are without the `--qf-` prefix. */
  vars?: Record<string, string>
  /** Element to theme; defaults to `document.documentElement`. */
  root?: HTMLElement
}

let currentPreference: ThemeMode = 'dark'
let mediaQuery: MediaQueryList | null = null
let snapshot: ThemeSnapshot | null = null
const listeners = new Set<(t: ThemeSnapshot) => void>()

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  return mode === 'system' ? systemTheme() : mode
}

function onSystemChange() {
  if (currentPreference !== 'system') return
  document.documentElement.dataset.theme = systemTheme()
  emit()
}

function emit() {
  snapshot = null
  const s = getThemeSnapshot()
  listeners.forEach((l) => l(s))
}

/**
 * Apply the theme to the document: sets `data-theme`, accent and appearance
 * variables, keeps `system` in sync with `prefers-color-scheme`, and notifies
 * `onThemeChange` subscribers. Idempotent; call whenever appearance settings change.
 */
export function applyTheme({ mode, accent, vars, root }: ApplyThemeOptions) {
  if (typeof document === 'undefined') return
  const el = root ?? document.documentElement
  currentPreference = mode
  el.dataset.theme = resolveThemeMode(mode)
  el.dataset.themePreference = mode

  if (accent) {
    const p = hexToTriplet(accent.primary)
    const h = hexToTriplet(accent.hover)
    if (p) el.style.setProperty('--qf-primary', p)
    if (h) el.style.setProperty('--qf-primary-hover', h)
  } else {
    el.style.removeProperty('--qf-primary')
    el.style.removeProperty('--qf-primary-hover')
  }

  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      el.style.setProperty(`--qf-${k}`, hexToTriplet(v) ?? v)
    }
  }

  if (typeof window !== 'undefined' && window.matchMedia && !mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: light)')
    mediaQuery.addEventListener('change', onSystemChange)
  }
  emit()
}

/** Resolved tokens of `root` (default: the document root). */
export function getThemeSnapshot(root?: HTMLElement): ThemeSnapshot {
  if (!root && snapshot) return snapshot
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : null)
  const cs = el && typeof getComputedStyle !== 'undefined' ? getComputedStyle(el) : null
  const read = (name: string) => cs?.getPropertyValue(`--qf-${name}`).trim() ?? ''
  const colors = {} as Record<ColorToken, string>
  for (const t of COLOR_TOKENS) colors[t] = tripletToHex(read(t))
  const terminal = {} as Record<TerminalToken, string>
  for (const t of TERMINAL_TOKENS) terminal[t] = tripletToHex(read(`term-${t}`))
  const scalars = {} as ThemeSnapshot['scalars']
  for (const t of SCALAR_TOKENS) scalars[t] = read(t)
  const attr = el?.closest<HTMLElement>('[data-theme]')?.dataset.theme
  const s: ThemeSnapshot = {
    mode: attr === 'light' ? 'light' : 'dark',
    preference: root ? ((attr as ResolvedTheme) ?? 'dark') : currentPreference,
    colors,
    terminal,
    scalars,
  }
  if (!root) snapshot = s
  return s
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(cb: (t: ThemeSnapshot) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const subscribe = (cb: () => void) => onThemeChange(cb)

/** React hook: the current theme snapshot, re-rendering on change. */
export function useTheme(): ThemeSnapshot {
  return useSyncExternalStore(subscribe, () => getThemeSnapshot(), () => getThemeSnapshot())
}
