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

export interface UsageMonitorSettings {
  cooldownSeconds: number
  /** 0 = off. */
  backgroundPollSeconds: number
  warningThreshold: number
  criticalThreshold: number
}

export const DEFAULT_SETTINGS: UsageMonitorSettings = {
  cooldownSeconds: 300,
  backgroundPollSeconds: 0,
  warningThreshold: 75,
  criticalThreshold: 90,
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
