/**
 * Shell-side agent provider registry (agent-providers.md §2, §4.2, §8.1).
 *
 * Providers come from the core (`agents_providers`: active plugins'
 * `contributes.agentProvider`, plus interim shell specs until AP-4). The
 * procedural parts live in the provider's plugin: this module loads the
 * plugin's UI module and calls its `agentProvider` hooks with the plugin's own
 * context (trusted: direct call; a sidecar answers `agentProvider/<hook>` when
 * the UI module does not implement it, §4.3). Hook errors are logged and
 * treated as "no data".
 *
 * The `usage` hook is rate-limited here (≥ 60 s per provider, §4.2): callers
 * get the cached snapshot inside the cooldown, and concurrent calls share one
 * request.
 */
import type {
  AgentContextUsage,
  AgentProviderImpl,
  AgentUsageSnapshot,
  AgentWorktreeScope,
  JsonValue,
  PluginContext,
} from '@quadflow/plugin-api'
import { commands, type AgentHook, type AgentProviderInfo, type AgentSessionInfo } from '../generated/bindings'
import { call, CoreCallError } from '../lib/core'
import { listAgentProviders } from '../lib/core/agents'
import { getSettings } from '../lib/appData'
import { loadPluginModule } from '../plugins/loader'
import { ensurePluginRegistry, usePluginRegistry } from '../plugins/registry'

/** Minimum time between two `usage` hook runs of one provider. */
export const MIN_USAGE_COOLDOWN_MS = 60_000

export function listProviders(): Promise<AgentProviderInfo[]> {
  return listAgentProviders()
}

export async function getProvider(providerId: string): Promise<AgentProviderInfo | undefined> {
  return (await listProviders()).find((p) => p.id === providerId)
}

/** Providers that declare `hook` in their manifest. */
export async function providersWithHook(hook: AgentHook): Promise<AgentProviderInfo[]> {
  return (await listProviders()).filter((p) => p.hooks.includes(hook))
}

type HookArgs = {
  usage: []
  contextUsage: [{ sessionId: string; sessionPath: string; model: string | null }]
  sessionTitle: [AgentSessionInfo]
  prepareWorktree: [{ worktreePath: string; scope: AgentWorktreeScope; contextMarkdown: string }]
}
type HookResult = {
  usage: AgentUsageSnapshot | null
  contextUsage: AgentContextUsage | null
  sessionTitle: string | null
  prepareWorktree: void
}

/**
 * Run `hook` of `provider` in its plugin. Resolves `undefined` when the
 * provider does not declare the hook, its plugin is not active, or the hook
 * failed (logged).
 */
async function callHook<H extends AgentHook>(
  provider: AgentProviderInfo,
  hook: H,
  ...args: HookArgs[H]
): Promise<HookResult[H] | undefined> {
  if (!provider.hooks.includes(hook)) return undefined
  try {
    await ensurePluginRegistry()
    if (usePluginRegistry.getState().getPlugin(provider.pluginId)?.status.kind !== 'active') return undefined
    const loaded = await loadPluginModule(provider.pluginId)
    const impl = loaded.module.agentProvider as AgentProviderImpl | undefined
    const fn = impl?.[hook] as ((ctx: PluginContext, ...a: HookArgs[H]) => Promise<HookResult[H]>) | undefined
    if (fn) return await fn.call(impl, loaded.ctx, ...args)
    if (loaded.ctx.api.has('sidecar.request')) {
      const params = (args[0] ?? {}) as JsonValue
      const p = hook === 'sessionTitle' ? ({ session: params } as JsonValue) : params
      // `agentProvider/*` is reserved for the host (plugin UIs cannot send it), so the shell
      // goes through its own command rather than `ctx.sidecar.request`.
      return (await call(commands.pluginSidecarAgentHook(provider.pluginId, hook, p))) as HookResult[H]
    }
    console.warn(`[agents] ${provider.pluginId} declares hook "${hook}" but implements it nowhere`)
  } catch (e) {
    console.warn(`[agents] ${provider.id}.${hook} failed:`, e)
  }
  return undefined
}

// ---- usage (cooldown + dedupe) ----

const usageState = new Map<string, { at: number; snapshot: AgentUsageSnapshot | null; inflight?: Promise<AgentUsageSnapshot | null> }>()

export interface UsageRequest {
  /** Cooldown in seconds (clamped to ≥ 60). */
  cooldownSeconds?: number
  /** Ignore a cached snapshot that is older than the minimum cooldown (60 s). */
  force?: boolean
}

/** The provider's account usage; cached for the cooldown, `null` when unknown. */
export async function providerUsage(providerId: string, req: UsageRequest = {}): Promise<AgentUsageSnapshot | null> {
  const cooldown = Math.max(MIN_USAGE_COOLDOWN_MS, (req.cooldownSeconds ?? 0) * 1000)
  const wait = req.force ? MIN_USAGE_COOLDOWN_MS : cooldown
  const st = usageState.get(providerId)
  if (st?.inflight) return st.inflight
  if (st && Date.now() - st.at < wait) return st.snapshot
  const inflight = (async () => {
    const provider = await getProvider(providerId)
    const snap = provider ? ((await callHook(provider, 'usage')) ?? null) : null
    usageState.set(providerId, { at: Date.now(), snapshot: snap })
    return snap
  })()
  usageState.set(providerId, { at: st?.at ?? 0, snapshot: st?.snapshot ?? null, inflight })
  try {
    return await inflight
  } catch {
    usageState.set(providerId, { at: Date.now(), snapshot: st?.snapshot ?? null })
    return st?.snapshot ?? null
  }
}

// ---- other hooks ----

export async function providerContextUsage(
  providerId: string,
  s: { sessionId: string; sessionPath: string; model: string | null },
): Promise<AgentContextUsage | null> {
  const p = await getProvider(providerId)
  return p ? ((await callHook(p, 'contextUsage', s)) ?? null) : null
}

export async function providerSessionTitle(session: AgentSessionInfo): Promise<string | null> {
  const p = await getProvider(session.providerId)
  return p ? ((await callHook(p, 'sessionTitle', session)) ?? null) : null
}

/** Prepare a worktree for an agent of `providerId`; resolves `false` when the provider has no hook. */
export async function providerPrepareWorktree(
  providerId: string,
  w: { worktreePath: string; scope: AgentWorktreeScope; contextMarkdown: string },
): Promise<boolean> {
  const p = await getProvider(providerId)
  if (!p?.hooks.includes('prepareWorktree')) return false
  await callHook(p, 'prepareWorktree', w)
  return true
}

// ---- project scaffold (§7.3) ----

/**
 * Project open: apply every active provider's project scaffold
 * (`agents_scaffold`; missing files only, JSON-merged settings) unless the
 * setting `agents.scaffold.<providerId>` is `false`.
 */
export async function scaffoldProjectProviders(projectRoot: string): Promise<void> {
  const [providers, settings] = await Promise.all([
    listProviders(),
    getSettings('agents').catch(() => ({}) as Record<string, unknown>),
  ])
  for (const p of providers) {
    if (settings[`scaffold.${p.id}`] === false) continue
    try {
      await call(commands.agentsScaffold(projectRoot, p.id))
    } catch (e) {
      if (e instanceof CoreCallError && e.error.code === 'unsupported') continue // provider without a scaffold
      console.error(`[agents] scaffold ${p.id} failed:`, e)
    }
  }
}
