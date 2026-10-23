import { useState, useEffect } from 'react'
import { commands, type AgentBinding } from '../generated/bindings'
import { call } from '../lib/core'
import { providerContextUsage } from '../agents/providerRegistry'
import { useProviderInfo } from '../agents/providers'
import { useModelContextWindow } from './useAIModels'

export interface UseContextUsageReturn {
  /** `false` when the provider has no `contextUsage` hook or no session is bound. */
  available: boolean
  estimatedTokens: number
  contextWindow: number
  percentage: number
  isLoading: boolean
  error: string | null
}

/**
 * Context-window usage of a terminal's agent session, from the provider's
 * `contextUsage` hook (agent-providers.md §4.2). The session file path comes
 * from the core's generic session scanner (`agents_sessions_list`).
 */
export function useContextUsage(binding: AgentBinding | null | undefined, workingDirectory: string | undefined, pollIntervalMs = 20000): UseContextUsageReturn {
  const provider = useProviderInfo(binding?.providerId)
  const hasHook = !!provider?.hooks.includes('contextUsage')
  const providerId = binding?.providerId
  const sessionId = binding?.sessionId ?? undefined
  const model = binding?.model ?? null
  const [usedTokens, setUsedTokens] = useState(0)
  const [limit, setLimit] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelWindow = useModelContextWindow(model, providerId)

  useEffect(() => {
    if (!hasHook || !providerId || !sessionId || !workingDirectory) return
    let cancelled = false
    let sessionPath: string | null = null
    const fetchUsage = async () => {
      try {
        setIsLoading(true)
        if (!sessionPath) {
          const sessions = await call(commands.agentsSessionsList(providerId, workingDirectory))
          sessionPath = sessions.find((s) => s.id === sessionId)?.path ?? null
        }
        if (!sessionPath) return
        const usage = await providerContextUsage(providerId, { sessionId, sessionPath, model })
        if (cancelled || !usage) return
        setUsedTokens(usage.usedTokens)
        setLimit(usage.limitTokens)
        setError(null)
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void fetchUsage()
    const t = setInterval(fetchUsage, pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [hasHook, providerId, sessionId, workingDirectory, model, pollIntervalMs])

  const contextWindow = limit ?? modelWindow ?? 200_000
  return {
    available: hasHook && !!sessionId,
    estimatedTokens: usedTokens,
    contextWindow,
    percentage: contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
    isLoading,
    error,
  }
}
