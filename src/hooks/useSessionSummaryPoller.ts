import { useEffect } from 'react'
import { commands, type AgentSessionInfo } from '../generated/bindings'
import { call } from '../lib/core'
import { providerSessionTitle } from '../agents/providerRegistry'
import { getProviderInfo } from '../agents/providers'
import { useTerminalStore } from '../stores/terminalStore'
import { useTitleSettingsStore } from '../stores/titleSettingsStore'
import { generateTitle } from '../lib/titles'

/**
 * Periodically asks each agent terminal's provider for its session's title
 * (`sessionTitle` hook, agent-providers.md §4.2) and uses it as the terminal
 * title (long summaries are shortened by the title generator when enabled).
 */
export function useSessionSummaryPoller() {
  const pollIntervalSeconds = useTitleSettingsStore((s) => s.settings.summaryPollIntervalSeconds)

  useEffect(() => {
    const pollIntervalMs = Math.max(15, Math.min(300, pollIntervalSeconds)) * 1000

    const poll = async () => {
      const terminalStore = useTerminalStore.getState()
      const titleStore = useTitleSettingsStore.getState()
      const terminals = Array.from(terminalStore.terminals.values()).filter(
        (t) =>
          t.agent?.sessionId &&
          t.status === 'active' &&
          t.titleSource !== 'manual' &&
          getProviderInfo(t.agent.providerId)?.hooks.includes('sessionTitle'),
      )
      if (terminals.length === 0) return

      // One session listing per (provider, cwd).
      const listings = new Map<string, Promise<AgentSessionInfo[]>>()
      for (const t of terminals) {
        const b = t.agent!
        const key = `${b.providerId}\u0000${t.workingDirectory}`
        if (!listings.has(key)) {
          listings.set(key, call(commands.agentsSessionsList(b.providerId, t.workingDirectory)).catch(() => []))
        }
        const session = (await listings.get(key)!).find((s) => s.id === b.sessionId)
        if (!session) continue
        const summary = (await providerSessionTitle(session))?.trim()
        if (!summary || summary === t.lastKnownSummary) continue

        let title = summary.length <= 50 ? summary : summary.slice(0, 47) + '...'
        if (summary.length > 50 && titleStore.settings.enabled) {
          // Shorten the summary: title-generator plugins, then the chat API (src/lib/titles.ts).
          const short = await generateTitle(summary, { terminalId: t.id, session: false, fallback: false }).catch((err) => {
            console.error('useSessionSummaryPoller: Title generation failed, using truncation:', err)
            return null
          })
          if (short) title = short.title
        }
        const current = useTerminalStore.getState().terminals.get(t.id)
        if (!current || current.titleSource === 'manual') continue
        terminalStore.updateTerminal(t.id, { title, titleSource: 'auto', lastKnownSummary: summary })
      }
    }

    const interval = setInterval(() => void poll(), pollIntervalMs)
    const initialTimeout = setTimeout(() => void poll(), 2000)
    return () => {
      clearInterval(interval)
      clearTimeout(initialTimeout)
    }
  }, [pollIntervalSeconds])
}
