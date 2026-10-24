/**
 * Pure Usage Monitor logic (no host calls, type-only imports), so `test/`
 * runs it under plain node: settings normalisation, per-provider rows,
 * thresholds and the "crossed critical" edge.
 */
import type { AgentUsageSnapshot, AgentUsageWindow } from '@quadflow/plugin-api'

/** The host never re-runs a `usage` hook more often than this. */
export const MIN_COOLDOWN_SECONDS = 60
/** Background refresh runs an agent CLI each time: no faster than every 5 min. */
export const MIN_POLL_SECONDS = 300

/** How the toolbar mini widget draws each window. */
export type MiniStyle = 'percent' | 'bars' | 'countdown' | 'highest'
export const MINI_STYLES: { value: MiniStyle; label: string; description: string }[] = [
  { value: 'percent', label: 'Percent', description: 'Every window as "5h 11%"' },
  { value: 'bars', label: 'Bars', description: 'A small bar per window, with its percent' },
  { value: 'countdown', label: 'Percent + reset', description: 'Percent with the time until the window resets' },
  { value: 'highest', label: 'Highest only', description: 'One number: the highest window over all providers' },
]

export interface UsageMonitorSettings {
  cooldownSeconds: number
  /** 0 = off. */
  backgroundPollSeconds: number
  warningThreshold: number
  criticalThreshold: number
  miniStyle: MiniStyle
  /**
   * Hidden from the mini widget: `"<providerId>"` hides a provider,
   * `"<providerId>/<windowId>"` one window. A hide list (not a show list), so
   * windows a provider starts reporting later appear by default.
   */
  miniHidden: string[]
}

export const DEFAULT_SETTINGS: UsageMonitorSettings = {
  cooldownSeconds: 300,
  backgroundPollSeconds: 0,
  warningThreshold: 75,
  criticalThreshold: 90,
  miniStyle: 'percent',
  miniHidden: [],
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}

/** Settings from `ctx.settings.getAll()`, clamped to what the host enforces anyway. */
export function normalizeSettings(raw: Record<string, unknown> | null | undefined): UsageMonitorSettings {
  const r = raw ?? {}
  const cooldownSeconds = Math.max(MIN_COOLDOWN_SECONDS, int(r.cooldownSeconds, DEFAULT_SETTINGS.cooldownSeconds))
  const poll = Math.max(0, int(r.backgroundPollSeconds, DEFAULT_SETTINGS.backgroundPollSeconds))
  const clampPct = (v: unknown, d: number) => Math.min(100, Math.max(1, int(v, d)))
  return {
    cooldownSeconds,
    backgroundPollSeconds: poll === 0 ? 0 : Math.max(MIN_POLL_SECONDS, poll),
    warningThreshold: clampPct(r.warningThreshold, DEFAULT_SETTINGS.warningThreshold),
    criticalThreshold: clampPct(r.criticalThreshold, DEFAULT_SETTINGS.criticalThreshold),
    miniStyle: MINI_STYLES.some((m) => m.value === r.miniStyle) ? (r.miniStyle as MiniStyle) : DEFAULT_SETTINGS.miniStyle,
    miniHidden: Array.isArray(r.miniHidden) ? [...new Set(r.miniHidden.filter((v): v is string => typeof v === 'string' && v !== ''))] : [],
  }
}

/** A provider that declares the `usage` hook. */
export interface UsageProvider {
  id: string
  name: string
  color: string | null
}

export type ProviderUsageStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error'

export interface ProviderUsage {
  provider: UsageProvider
  status: ProviderUsageStatus
  snapshot: AgentUsageSnapshot | null
  error: string | null
  /** Epoch ms of the last finished check (data or not). */
  checkedAt: number | null
}

/** Rows for display: every provider with the hook, in provider order, data or not. */
export function providerRows(
  providers: UsageProvider[],
  state: Record<string, Omit<ProviderUsage, 'provider'> | undefined>,
): ProviderUsage[] {
  return providers.map((provider) => {
    const s = state[provider.id]
    return s ? { provider, ...s } : { provider, status: 'idle', snapshot: null, error: null, checkedAt: null }
  })
}

/** Highest `usedPercent` over all windows; `null` without any window. */
export function maxPercent(snapshots: Iterable<AgentUsageSnapshot | null | undefined>): number | null {
  let max: number | null = null
  for (const s of snapshots) for (const w of s?.windows ?? []) max = Math.max(max ?? 0, w.usedPercent)
  return max
}

export type UsageLevel = 'ok' | 'elevated' | 'warning' | 'critical'

export function levelOf(pct: number, s: Pick<UsageMonitorSettings, 'warningThreshold' | 'criticalThreshold'>): UsageLevel {
  if (pct >= s.criticalThreshold) return 'critical'
  if (pct >= s.warningThreshold) return 'warning'
  if (pct >= 50) return 'elevated'
  return 'ok'
}

/** Windows that newly reached the critical threshold (were below it, or unknown, before). */
export function newlyCritical(
  prev: AgentUsageSnapshot | null | undefined,
  next: AgentUsageSnapshot | null | undefined,
  criticalThreshold: number,
): AgentUsageWindow[] {
  const before = new Map((prev?.windows ?? []).map((w) => [w.id, w.usedPercent]))
  return (next?.windows ?? []).filter((w) => w.usedPercent >= criticalThreshold && (before.get(w.id) ?? -1) < criticalThreshold)
}

/** "Resets …" line for a window: the CLI's own text, else a relative time from `resetsAt`. */
export function resetLabel(w: AgentUsageWindow, now = Date.now()): string | null {
  if (w.resetsText) return w.resetsText
  if (w.resetsAt === undefined) return null
  const mins = Math.round((w.resetsAt - now) / 60_000)
  if (mins <= 0) return 'Resets now'
  if (mins < 60) return `Resets in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `Resets in ${h}h ${mins % 60}m`
  return `Resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

export function timeAgo(ms: number | null, now = Date.now()): string {
  if (!ms) return 'never'
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Mini widget
// ---------------------------------------------------------------------------

/** Key of a window in `miniHidden`. */
export const windowKey = (providerId: string, windowId: string) => `${providerId}/${windowId}`

export function isHidden(hidden: readonly string[], providerId: string, windowId?: string): boolean {
  return hidden.includes(providerId) || (windowId !== undefined && hidden.includes(windowKey(providerId, windowId)))
}

/** `hidden` with `key` switched on or off. */
export function toggleHidden(hidden: readonly string[], key: string, hide: boolean): string[] {
  const rest = hidden.filter((k) => k !== key)
  return hide ? [...rest, key] : rest
}

/**
 * A short label for the toolbar: `5h` (session), `Wk` (weekly, all models),
 * the model name of a model-specific weekly window (`Opus`), else the label
 * itself when short or its first word.
 */
export function shortLabel(w: Pick<AgentUsageWindow, 'id' | 'label'>): string {
  const l = w.label.trim()
  if (w.id === 'session' || /\bsession\b/i.test(l) || /^5\s*h(ours?)?$/i.test(l)) return '5h'
  const model = /week\w*\s*\(([^)]+)\)/i.exec(l)
  if (model) {
    const m = model[1].replace(/\s+only$/i, '').trim()
    if (/^all( models)?$/i.test(m)) return 'Wk'
    const word = m.split(/\s+/)[0]
    return word.length > 8 ? word.slice(0, 7) + '…' : word
  }
  if (w.id === 'week' || /^(current )?week(ly)?$/i.test(l)) return 'Wk'
  if (l.length <= 6) return l
  const first = l.split(/\s+/)[0]
  return first.length > 8 ? first.slice(0, 7) + '…' : first
}

/** Compact time until `resetsAt`: `45m`, `2h10m`, `3d4h`; `null` when unknown. */
export function countdown(resetsAt: number | undefined, now = Date.now()): string | null {
  if (resetsAt === undefined) return null
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return mins % 60 === 0 ? `${h}h` : `${h}h${mins % 60}m`
  const d = Math.floor(h / 24)
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`
}

export interface MiniWindow {
  key: string
  short: string
  window: AgentUsageWindow
  level: UsageLevel
}
export interface MiniGroup {
  provider: UsageProvider
  windows: MiniWindow[]
}

/** What the mini widget shows: visible providers with data, each with its visible windows. */
export function miniGroups(rows: ProviderUsage[], settings: UsageMonitorSettings): MiniGroup[] {
  const out: MiniGroup[] = []
  for (const r of rows) {
    if (isHidden(settings.miniHidden, r.provider.id)) continue
    const windows = (r.snapshot?.windows ?? [])
      .filter((w) => !isHidden(settings.miniHidden, r.provider.id, w.id))
      .map((w) => ({ key: windowKey(r.provider.id, w.id), short: shortLabel(w), window: w, level: levelOf(w.usedPercent, settings) }))
    if (windows.length > 0) out.push({ provider: r.provider, windows })
  }
  return out
}

/** Highest `usedPercent` over the windows the mini widget shows; `null` without any. */
export function visibleMax(groups: MiniGroup[]): number | null {
  let max: number | null = null
  for (const g of groups) for (const w of g.windows) max = Math.max(max ?? 0, w.window.usedPercent)
  return max
}

/** The mini widget's tooltip: every provider and window (hidden ones too), with resets. */
export function miniTooltip(rows: ProviderUsage[], now = Date.now()): string {
  if (rows.length === 0) return 'Usage Monitor: no data yet. Open the Usage Monitor to check.'
  return rows
    .map((r) => {
      const ws = r.snapshot?.windows ?? []
      const head = `${r.provider.name}${r.snapshot?.plan ? ` (${r.snapshot.plan})` : ''}`
      if (ws.length === 0) return `${head}: no data`
      return [head, ...ws.map((w) => {
        const reset = resetLabel(w, now)
        return `  ${w.label}: ${Math.round(w.usedPercent)}% used${reset ? ` · ${reset}` : ''}`
      })].join('\n')
    })
    .join('\n')
}
