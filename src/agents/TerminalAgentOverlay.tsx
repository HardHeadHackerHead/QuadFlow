/**
 * Resume / relaunch overlay over a restored agent terminal (agent-providers.md
 * §8.4, §8.5). Shown once per fresh PTY (`hasAutoResumed` unset) for terminals
 * with an `AgentBinding`: "Resume" when the bound session still exists
 * (`agents_session_exists`), else "Relaunch" (a new session with the same
 * provider / model / effort / approval mode). Both go through `agents_launch`.
 */
import { useEffect, useState } from 'react'
import { commands } from '../generated/bindings'
import { call } from '../lib/core'
import { getTerminal } from '../lib/terminalRegistry'
import { useTerminalStore } from '../stores/terminalStore'
import { AGENT_ROLE_CONFIG, type TerminalState } from '../types'
import { restartAgentInTerminal } from './launch'
import { APPROVAL_MODE_INFO, providerColor, providerName, useProviderInfo } from './providers'

export default function TerminalAgentOverlay({ terminal }: { terminal: TerminalState }) {
  const b = terminal.agent
  const provider = useProviderInfo(b?.providerId)
  const [sessionExists, setSessionExists] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = !!b && !terminal.hasAutoResumed

  useEffect(() => {
    let cancelled = false
    setSessionExists(null)
    if (!visible || !b?.sessionId || !provider?.canResume) return
    call(commands.agentsSessionExists(b.providerId, terminal.workingDirectory, b.sessionId))
      .then((exists) => !cancelled && setSessionExists(exists))
      // On error assume it exists so we don't wrongly force a relaunch.
      .catch(() => !cancelled && setSessionExists(true))
    return () => {
      cancelled = true
    }
  }, [visible, b?.providerId, b?.sessionId, provider?.canResume, terminal.workingDirectory])

  if (!visible || !b) return null

  const update = useTerminalStore.getState().updateTerminal
  const focus = () => requestAnimationFrame(() => getTerminal(terminal.id)?.focus())
  const run = (o: { resume: boolean; approvalMode?: 'default' }) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setError(null)
    update(terminal.id, { hasAutoResumed: true })
    restartAgentInTerminal(terminal.id, o)
      .then(focus)
      .catch((err) => {
        update(terminal.id, { hasAutoResumed: undefined })
        setError(err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err))
      })
  }
  const startFresh = (e: React.MouseEvent) => {
    e.stopPropagation()
    update(terminal.id, { hasAutoResumed: true, agent: null })
    focus()
  }

  const resumable = !!b.sessionId && !!provider?.canResume && sessionExists !== false
  const mode = b.approvalMode ?? 'default'
  const elevated = mode === 'bypass' || mode === 'auto'
  const color = providerColor(provider)
  const name = providerName(provider, b.providerId)
  const roleConfig = terminal.role ? AGENT_ROLE_CONFIG[terminal.role] : null
  const roleLabel = terminal.role === 'custom' ? terminal.customRoleLabel : roleConfig?.label
  const summaryText = terminal.lastKnownSummary || terminal.summary || terminal.originalPrompt
  const primary = elevated ? 'bg-gradient-to-r from-amber-500 to-red-500' : 'bg-gradient-to-r from-vibe-primary to-vibe-secondary'

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm rounded-b-lg z-10" data-testid="agent-overlay">
      <div className="bg-vibe-surface border border-vibe-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-2xl">
        <div className="flex items-center justify-center gap-2 mb-3 flex-wrap">
          <span className="px-2 py-0.5 rounded-full text-xs font-medium text-white" style={{ backgroundColor: color }}>
            {name}
          </span>
          {roleLabel && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium text-white bg-gradient-to-r ${roleConfig?.color || 'from-gray-500 to-gray-600'}`}>
              {roleLabel}
            </span>
          )}
          {mode !== 'default' && (
            <span className={`px-2 py-0.5 rounded-full text-xs font-bold text-white ${elevated ? 'bg-gradient-to-r from-amber-500 to-red-500' : 'bg-blue-500'}`}>
              {APPROVAL_MODE_INFO[mode].label}
            </span>
          )}
        </div>

        <h3 className="text-sm font-semibold text-vibe-text text-center mb-1">{terminal.title}</h3>
        <p className="text-xs text-vibe-muted text-center mb-4 line-clamp-3 leading-relaxed">
          {!provider
            ? `The ${b.providerId} provider plugin is not enabled.`
            : summaryText || (resumable ? '' : 'This agent session was never started, so there is nothing to resume.')}
        </p>
        {error && <p className="text-xs text-red-400 text-center mb-3">{error}</p>}

        <div className="flex flex-col gap-2">
          {provider && resumable && (
            <>
              <button onClick={run({ resume: true })} data-testid="agent-overlay-resume" className={`w-full px-4 py-2 rounded-md text-sm font-medium text-white hover:brightness-110 transition-all ${primary}`}>
                {elevated ? `Resume (${APPROVAL_MODE_INFO[mode].label})` : 'Resume Session'}
              </button>
              {elevated && provider.approvalModes.includes('default') && (
                <button onClick={run({ resume: true, approvalMode: 'default' })} className="w-full px-4 py-2 rounded-md text-sm font-medium text-white bg-gradient-to-r from-vibe-primary to-vibe-secondary hover:brightness-110 transition-all">
                  Resume in Default mode
                </button>
              )}
            </>
          )}
          {provider && !resumable && (
            <button onClick={run({ resume: false })} data-testid="agent-overlay-relaunch" className={`w-full px-4 py-2 rounded-md text-sm font-medium text-white hover:brightness-110 transition-all ${primary}`}>
              {`Relaunch ${name}`}
            </button>
          )}
          <button
            onClick={startFresh}
            className="w-full px-3 py-1.5 rounded-md text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg-lighter transition-colors"
          >
            Start Fresh
          </button>
        </div>
      </div>
    </div>
  )
}
