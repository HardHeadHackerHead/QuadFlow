/**
 * Plugin state shared by every Usage Monitor tile and the mini widget (module
 * state = plugin state; trusted plugins share the host's zustand).
 *
 * Data comes only from the plugin API: `ctx.agents.providers()` names the
 * providers whose manifest declares the `usage` hook, `ctx.agents.usage()`
 * runs one provider's hook through the host (which enforces the ≥ 60 s
 * cooldown and caches the snapshot). Providers are refreshed one after the
 * other — each hook may start an agent CLI.
 */
import { create } from 'zustand'
import type { Disposable, PluginContext } from '@quadflow/plugin-api'
import {
  DEFAULT_SETTINGS,
  maxPercent,
  newlyCritical,
  normalizeSettings,
  type ProviderUsage,
  type UsageMonitorSettings,
  type UsageProvider,
} from './model'

type UsageEntry = Omit<ProviderUsage, 'provider'>

interface UsageState {
  /** `null` until the provider list was read once. */
  providers: UsageProvider[] | null
  providersError: string | null
  usage: Record<string, UsageEntry | undefined>
  refreshing: boolean
  settings: UsageMonitorSettings
}

export const useUsageStore = create<UsageState>(() => ({
  providers: null,
  providersError: null,
  usage: {},
  refreshing: false,
  settings: DEFAULT_SETTINGS,
}))

let ctxRef: PluginContext | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let settingsSub: Disposable | null = null
let inflight: Promise<void> | null = null
/** Instance ids of mounted tiles (they glow at the warning threshold). */
const tiles = new Set<string>()

function message(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)
}

function restartPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  const secs = useUsageStore.getState().settings.backgroundPollSeconds
  if (secs > 0) pollTimer = setInterval(() => void refresh(), secs * 1000)
}

/** First call wins: keeps the plugin's context, follows settings, starts the background poll. */
export function bind(ctx: PluginContext): void {
  if (ctxRef) return
  ctxRef = ctx
  useUsageStore.setState({ settings: normalizeSettings(ctx.settings.getAll()) })
  settingsSub = ctx.settings.onDidChange(() => {
    useUsageStore.setState({ settings: normalizeSettings(ctx.settings.getAll()) })
    restartPoll()
    updateAttention()
  })
  restartPoll()
}

export function unbind(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  settingsSub?.()
  settingsSub = null
  ctxRef = null
}

function updateAttention() {
  const ctx = ctxRef
  if (!ctx) return
  const { usage, settings } = useUsageStore.getState()
  const max = maxPercent(Object.values(usage).map((u) => u?.snapshot))
  const on = max !== null && max >= settings.warningThreshold
  for (const id of tiles) ctx.notifications.attention(id, on)
}

/** A tile mounted (`instanceId`); returns the unregister function. */
export function registerTile(instanceId: string): () => void {
  tiles.add(instanceId)
  updateAttention()
  return () => {
    tiles.delete(instanceId)
  }
}

async function loadProviders(ctx: PluginContext): Promise<UsageProvider[]> {
  try {
    const providers = (await ctx.agents.providers())
      .filter((p) => p.hooks.includes('usage'))
      .map((p) => ({ id: p.id, name: p.shortName ?? p.displayName, color: p.color }))
    useUsageStore.setState({ providers, providersError: null })
    return providers
  } catch (e) {
    ctx.log.warn('agent providers unavailable:', e)
    useUsageStore.setState({ providers: useUsageStore.getState().providers ?? [], providersError: message(e) })
    return []
  }
}

function setEntry(providerId: string, patch: Partial<UsageEntry>) {
  useUsageStore.setState((s) => {
    const prev: UsageEntry = s.usage[providerId] ?? { status: 'idle', snapshot: null, error: null, checkedAt: null }
    return { usage: { ...s.usage, [providerId]: { ...prev, ...patch } } }
  })
}

async function refreshProvider(ctx: PluginContext, p: UsageProvider, force: boolean) {
  const { settings, usage } = useUsageStore.getState()
  const prev = usage[p.id]?.snapshot ?? null
  setEntry(p.id, { status: 'loading', error: null })
  try {
    const [snapshot = null] = await ctx.agents.usage({ providerId: p.id, cooldownSeconds: settings.cooldownSeconds, force })
    setEntry(p.id, {
      status: snapshot && snapshot.windows.length > 0 ? 'ok' : 'empty',
      snapshot,
      checkedAt: Date.now(),
    })
    const crossed = newlyCritical(prev, snapshot, settings.criticalThreshold)
    if (crossed.length > 0) {
      ctx.notifications.toast({
        kind: 'warning',
        title: `${p.name} usage is high`,
        body: crossed.map((w) => `${w.label}: ${Math.round(w.usedPercent)}% used`).join('\n'),
      })
    }
  } catch (e) {
    ctx.log.warn(`usage of ${p.id} failed:`, e)
    setEntry(p.id, { status: 'error', error: message(e), checkedAt: Date.now() })
  }
}

/**
 * Re-read every provider (or just `providerId`). Inside the cooldown the host
 * answers from its cache, so calling this often is cheap; `force` re-runs the
 * hooks unless they ran in the last 60 s.
 */
export function refresh(o: { force?: boolean; providerId?: string } = {}): Promise<void> {
  const ctx = ctxRef
  if (!ctx) return Promise.resolve()
  if (inflight) return inflight
  inflight = (async () => {
    useUsageStore.setState({ refreshing: true })
    try {
      const providers = await loadProviders(ctx)
      for (const p of providers) {
        if (o.providerId && p.id !== o.providerId) continue
        await refreshProvider(ctx, p, !!o.force)
      }
    } finally {
      useUsageStore.setState({ refreshing: false })
      inflight = null
      updateAttention()
    }
  })()
  return inflight
}
