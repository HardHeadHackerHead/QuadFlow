import { useEffect, useMemo } from 'react'
import type { AgentModelInfo } from '../generated/bindings'
import type { AIModelOption } from '../types'
import { useAgentModelsStore } from '../lib/core/agents'
import { useAgentProviders, SYSTEM_DEFAULT_MODEL_ID } from '../agents/providers'

const EMPTY: AgentModelInfo[] = []
/** Shown until the core answers (the core list always starts with it). */
const FALLBACK: AIModelOption[] = [{ id: SYSTEM_DEFAULT_MODEL_ID, label: 'Default', shortLabel: 'Def', isDefault: true }]

export function toModelOption(m: AgentModelInfo): AIModelOption {
  const o: AIModelOption = { id: m.id, label: m.label }
  if (m.shortLabel) o.shortLabel = m.shortLabel
  if (m.contextWindow) o.contextWindow = m.contextWindow
  if (m.isDefault) o.isDefault = true
  return o
}

/** The core's model list for a provider (`system-default` ++ catalog ++ custom), loaded on demand. */
export function useAgentModels(providerId: string | null | undefined): AgentModelInfo[] {
  const list = useAgentModelsStore((s) => (providerId ? s.models[providerId] : undefined))
  useEffect(() => {
    if (providerId && !list) {
      useAgentModelsStore.getState().load(providerId).catch((e) => console.error('[models] load failed:', e))
    }
  }, [providerId, list])
  return list ?? EMPTY
}

/** Model options and the resolved default for a provider (from the core, agent-providers.md §6.4). */
export function useAIModels(providerId: string | null | undefined): { models: AIModelOption[]; defaultModelId: string } {
  const list = useAgentModels(providerId)
  return useMemo(() => {
    if (list.length === 0) return { models: FALLBACK, defaultModelId: SYSTEM_DEFAULT_MODEL_ID }
    return {
      models: list.map(toModelOption),
      defaultModelId: list.find((m) => m.isDefault)?.id ?? SYSTEM_DEFAULT_MODEL_ID,
    }
  }, [list])
}

/** Models of one provider, or of every provider when `providerId` is unknown. */
function useModelsFor(providerId: string | null | undefined): AgentModelInfo[] {
  const providers = useAgentProviders()
  const all = useAgentModelsStore((s) => s.models)
  useEffect(() => {
    const ids = providerId ? [providerId] : providers.map((p) => p.id)
    for (const id of ids) if (!all[id]) useAgentModelsStore.getState().load(id).catch(() => undefined)
  }, [providerId, providers, all])
  return useMemo(
    () => (providerId ? all[providerId] ?? EMPTY : Object.values(all).flat()),
    [providerId, all],
  )
}

/** Synchronous lookup across the loaded lists (for non-React callers). */
export function findLoadedModel(modelId: string, providerId?: string | null): AgentModelInfo | undefined {
  const all = useAgentModelsStore.getState().models
  const lists = providerId ? [all[providerId] ?? []] : Object.values(all)
  for (const l of lists) {
    const hit = l.find((m) => m.id === modelId)
    if (hit) return hit
  }
  return undefined
}

/** Display label for a model id (falls back to the id). */
export function useModelLabel(modelId: string | null | undefined, providerId?: string | null): string | null {
  const all = useModelsFor(providerId)
  return useMemo(() => {
    if (!modelId) return null
    return all.find((m) => m.id === modelId)?.label ?? modelId
  }, [modelId, all])
}

/** Abbreviated label for a model id, falling back to the full label. */
export function useModelShortLabel(modelId: string | null | undefined, providerId?: string | null): string | null {
  const all = useModelsFor(providerId)
  return useMemo(() => {
    if (!modelId) return null
    const m = all.find((x) => x.id === modelId)
    return m?.shortLabel ?? m?.label ?? modelId
  }, [modelId, all])
}

/** Context window of a model, `null` when unknown. */
export function useModelContextWindow(modelId: string | null | undefined, providerId?: string | null): number | null {
  const all = useModelsFor(providerId)
  return useMemo(() => (modelId ? all.find((m) => m.id === modelId)?.contextWindow ?? null : null), [modelId, all])
}
