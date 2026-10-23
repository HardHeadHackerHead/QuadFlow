/**
 * Agent providers as the shell sees them (agent-providers.md §5, §11): the
 * `agents_providers` list (active plugins' `contributes.agentProvider`) plus
 * detection results. Every provider-specific label, color, approval mode and
 * effort the UI shows comes from here — the shell has no built-in providers.
 */
import { create } from 'zustand'
import { useEffect } from 'react'
import { commands, type AgentApprovalMode, type AgentDetection, type AgentProviderInfo } from '../generated/bindings'
import { call } from '../lib/core'
import { usePluginRegistry } from '../plugins/registry'

/** Alias accepted by core launch paths: the user's default provider. */
export const DEFAULT_PROVIDER_ALIAS = 'default'

/** Model id meaning "no model flag: the CLI's own default". */
export const SYSTEM_DEFAULT_MODEL_ID = 'system-default'

interface AgentProvidersState {
  providers: AgentProviderInfo[]
  detections: Record<string, AgentDetection>
  loaded: boolean
  /** Load providers (+ detection). Concurrent calls share one request. */
  load(refreshDetection?: boolean): Promise<AgentProviderInfo[]>
}

let inflight: Promise<AgentProviderInfo[]> | null = null

export const useAgentProvidersStore = create<AgentProvidersState>((set, get) => ({
  providers: [],
  detections: {},
  loaded: false,
  load(refreshDetection = false) {
    if (inflight && !refreshDetection) return inflight
    inflight = (async () => {
      try {
        const providers = await call(commands.agentsProviders())
        set({ providers, loaded: true })
        const dets = await call(commands.agentsDetectAll(refreshDetection)).catch(() => [] as AgentDetection[])
        set({ detections: Object.fromEntries(dets.map((d) => [d.providerId, d])) })
        return providers
      } catch (e) {
        console.error('[agents] failed to load providers:', e)
        set({ loaded: true })
        return get().providers
      } finally {
        inflight = null
      }
    })()
    return inflight
  },
}))

let watching = false
/** Reload providers whenever the plugin registry changes (enable/disable/install). */
function watchRegistry(): void {
  if (watching) return
  watching = true
  usePluginRegistry.subscribe((s, prev) => {
    if (s.plugins !== prev.plugins) void useAgentProvidersStore.getState().load()
  })
}

/** Providers, loaded on first use. */
export function useAgentProviders(): AgentProviderInfo[] {
  const { providers, loaded } = useAgentProvidersStore()
  useEffect(() => {
    watchRegistry()
    if (!loaded) void useAgentProvidersStore.getState().load()
  }, [loaded])
  return providers
}

export async function ensureProviders(): Promise<AgentProviderInfo[]> {
  watchRegistry()
  const s = useAgentProvidersStore.getState()
  return s.loaded ? s.providers : s.load()
}

export function getProviderInfo(providerId: string | null | undefined): AgentProviderInfo | undefined {
  if (!providerId) return undefined
  return useAgentProvidersStore.getState().providers.find((p) => p.id === providerId)
}

export function useProviderInfo(providerId: string | null | undefined): AgentProviderInfo | undefined {
  const providers = useAgentProviders()
  return providerId ? providers.find((p) => p.id === providerId) : undefined
}

/** Display name of a provider (its id until providers are loaded / when uninstalled). */
export function providerName(p: AgentProviderInfo | undefined, fallbackId?: string | null): string {
  return p?.displayName ?? fallbackId ?? 'Agent'
}

export function providerShortName(p: AgentProviderInfo | undefined, fallbackId?: string | null): string {
  return p?.shortName ?? p?.displayName ?? fallbackId ?? 'Agent'
}

/** The provider's manifest color (`#rrggbb`), else a neutral accent. */
export function providerColor(p: AgentProviderInfo | undefined): string {
  return p?.color ?? '#8b5cf6'
}

export function isInstalled(providerId: string): boolean {
  return useAgentProvidersStore.getState().detections[providerId]?.installed ?? true
}

/**
 * The provider used when a caller doesn't pick one: setting
 * `agents.defaultProvider` if it is active, else the first installed provider,
 * else the first provider. `undefined` when no provider plugin is active.
 */
export async function resolveDefaultProviderId(preferred?: string | null): Promise<string | undefined> {
  const providers = await ensureProviders()
  if (preferred && preferred !== DEFAULT_PROVIDER_ALIAS && providers.some((p) => p.id === preferred)) return preferred
  const { useAppSettingsStore } = await import('../stores/appSettingsStore')
  const configured = useAppSettingsStore.getState().aiAgent.defaultProvider
  if (configured && providers.some((p) => p.id === configured)) return configured
  const dets = useAgentProvidersStore.getState().detections
  return (providers.find((p) => dets[p.id]?.installed) ?? providers[0])?.id
}

// ---- approval modes ----

export const APPROVAL_MODE_INFO: Record<AgentApprovalMode, { label: string; description: string }> = {
  default: { label: 'Default', description: 'The agent asks before acting, as its CLI is configured' },
  plan: { label: 'Plan', description: 'Read-only analysis — the agent plans before making changes' },
  'accept-edits': { label: 'Accept edits', description: 'File edits are accepted without asking' },
  auto: { label: 'Auto', description: 'Approval requests are reviewed automatically inside the sandbox' },
  bypass: { label: 'Bypass', description: 'No permission checks and no sandbox — the agent acts without asking' },
}

/** `wanted` if the provider supports it, else `default`. */
export function supportedApprovalMode(p: AgentProviderInfo | undefined, wanted: AgentApprovalMode | null | undefined): AgentApprovalMode {
  if (wanted && p?.approvalModes.includes(wanted)) return wanted
  return 'default'
}

/**
 * The provider's least-restrictive non-bypass mode for unattended work
 * (`auto`, else `accept-edits`, else `default`). Shell-launched helpers
 * (auto-fix, plan executors) use this instead of a bypass flag.
 */
export function unattendedApprovalMode(p: AgentProviderInfo | undefined): AgentApprovalMode {
  for (const m of ['auto', 'accept-edits'] as AgentApprovalMode[]) if (p?.approvalModes.includes(m)) return m
  return 'default'
}
