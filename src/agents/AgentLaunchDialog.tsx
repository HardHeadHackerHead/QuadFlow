/**
 * "New agent session" dialog (agent-providers.md §11): provider, model,
 * approval mode and effort all come from the provider's manifest
 * (`agents_providers`, `agents_models`); the launch goes through
 * `agents_launch`. Mounted once by the toolbar; opened via `useAgentPromptStore`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentApprovalMode } from '../generated/bindings'
import { useAIModels } from '../hooks/useAIModels'
import { useAgentPromptStore } from '../stores/agentPromptStore'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useOverlayRegistration } from '../stores/overlayStore'
import { useTerminalStore } from '../stores/terminalStore'
import { terminalApi } from '../lib/tauri-api'
import SessionRecommendations from '../components/terminal/SessionRecommendations'
import { useOptionalPlugin } from '../plugins/optional'
import { runPluginCommand } from '../plugins/commands'
import {
  APPROVAL_MODE_INFO,
  providerColor,
  providerName,
  resolveDefaultProviderId,
  supportedApprovalMode,
  useAgentProviders,
  useAgentProvidersStore,
} from './providers'
import { launchAgent } from './launch'

export default function AgentLaunchDialog() {
  const { isOpen, providerId: initialProviderId, initialPrompt, closeModal, lastApprovalMode, lastEffort, remember } = useAgentPromptStore()
  useOverlayRegistration('agent-prompt-modal', isOpen)
  const providers = useAgentProviders()
  const detections = useAgentProvidersStore((s) => s.detections)
  const agentDefaults = useAppSettingsStore((s) => s.agentDefaults)
  const [providerId, setProviderId] = useState<string | null>(null)
  const provider = providers.find((p) => p.id === providerId)
  const { models, defaultModelId } = useAIModels(providerId)
  const [model, setModel] = useState<string>(defaultModelId)
  const [effort, setEffort] = useState<string | null>(null)
  const [approvalMode, setApprovalMode] = useState<AgentApprovalMode>('default')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Related past sessions + session search come from the optional semantic-search plugin.
  const semanticSearch = useOptionalPlugin('semantic-search')

  // Per-provider defaults: last pick this run > Settings → Agents > manifest default.
  const applyProviderDefaults = useCallback(
    (id: string | null) => {
      const p = providers.find((x) => x.id === id)
      setApprovalMode(supportedApprovalMode(p, (id && lastApprovalMode[id]) || (id && agentDefaults.defaultApprovalMode[id]) || 'default'))
      const e = (id && (lastEffort[id] || agentDefaults.defaultEffort[id])) || p?.efforts?.default || null
      setEffort(p?.efforts && e && p.efforts.values.includes(e) ? e : p?.efforts?.default ?? null)
    },
    [providers, lastApprovalMode, lastEffort, agentDefaults],
  )

  useEffect(() => {
    if (!isOpen) return
    setPrompt(initialPrompt)
    setError(null)
    void resolveDefaultProviderId(initialProviderId).then((id) => {
      setProviderId(id ?? null)
      applyProviderDefaults(id ?? null)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialProviderId, initialPrompt])

  useEffect(() => setModel(defaultModelId), [defaultModelId, providerId])

  useEffect(() => {
    if (isOpen) textareaRef.current?.focus()
  }, [isOpen, providerId])

  const switchProvider = (id: string) => {
    setProviderId(id)
    applyProviderDefaults(id)
  }

  const submit = async (withPrompt: boolean) => {
    if (!providerId || busy) return
    if (withPrompt && !prompt.trim()) return
    const finalPrompt = withPrompt ? prompt.trim() : ''
    remember(providerId, { approvalMode, effort })
    setBusy(true)
    setError(null)
    try {
      await launchAgent({ providerId, model, effort, approvalMode, prompt: finalPrompt || null })
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit(true)
    }
    if (e.key === 'Escape') closeModal()
  }

  const onContinueSession = useCallback(
    (sessionId: string, _path: string, text: string) => {
      if (!providerId) return
      closeModal()
      launchAgent({ providerId, resumeSessionId: sessionId, prompt: text || null, autoSubmit: false }).catch((e) =>
        console.error('[agents] resume failed:', e),
      )
    },
    [closeModal, providerId],
  )

  const onFocusTerminal = useCallback(
    (terminalId: string, text: string) => {
      closeModal()
      useTerminalStore.getState().setActiveTerminal(terminalId)
      if (text) setTimeout(() => void terminalApi.write(terminalId, `\x1b[200~${text.replace(/\x1b\[201~/g, '')}\x1b[201~`), 300)
    },
    [closeModal],
  )

  const color = providerColor(provider)
  const approvalModes = useMemo(() => provider?.approvalModes ?? ['default' as AgentApprovalMode], [provider])

  if (!isOpen) return null

  const pill = (active: boolean) =>
    `px-3 py-2 rounded text-sm font-medium transition-all border ${
      active ? 'text-white shadow-sm border-transparent' : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
    }`
  const activeStyle = (active: boolean) => (active ? { backgroundColor: color } : undefined)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid="agent-launch-dialog">
      <div className={`bg-vibe-surface border border-vibe-border rounded-lg flex overflow-hidden w-full max-w-lg`}>
        <div className="flex-1 p-4 max-h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full" style={{ backgroundColor: color }} />
              <h2 className="text-lg font-semibold text-vibe-text">New Agent Session</h2>
            </div>
            <div className="flex items-center gap-2">
              {semanticSearch && (
                <button
                  onClick={() => {
                    const query = prompt.trim()
                    closeModal()
                    void runPluginCommand('semantic-search', 'search', query ? { query } : undefined).catch((e) => console.error('[semantic-search] search failed:', e))
                  }}
                  className="p-1.5 rounded transition-colors text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50"
                  title="Search past sessions (Semantic Search)"
                  data-testid="agent-launch-semantic-search"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </button>
              )}
              <button onClick={closeModal} className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {providers.length === 0 ? (
            <p className="text-sm text-vibe-muted mb-4">
              No agent provider is enabled. Enable a provider plugin in Settings → Plugins.
            </p>
          ) : (
            <div className="flex flex-wrap mb-4 bg-vibe-bg rounded-lg p-1 border border-vibe-border gap-1" data-testid="agent-provider-picker">
              {providers.map((p) => {
                const installed = detections[p.id]?.installed ?? true
                const active = p.id === providerId
                return (
                  <button
                    key={p.id}
                    data-provider={p.id}
                    onClick={() => switchProvider(p.id)}
                    title={installed ? p.displayName : `${p.displayName} is not installed${p.installHint ? ` — ${p.installHint}` : ''}`}
                    className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${active ? 'text-white shadow-sm' : 'text-vibe-muted hover:text-vibe-text'} ${installed ? '' : 'opacity-50'}`}
                    style={active ? { backgroundColor: providerColor(p) } : undefined}
                  >
                    {p.displayName}
                  </button>
                )
              })}
            </div>
          )}

          {provider && detections[provider.id] && !detections[provider.id].installed && (
            <p className="text-xs text-amber-400 mb-3">
              {provider.displayName} was not found on this machine.{provider.installHint ? ` Install: ${provider.installHint}` : ''}
            </p>
          )}

          {semanticSearch && providerId && (
            <SessionRecommendations providerId={providerId} prompt={prompt} onContinueSession={onContinueSession} onFocusTerminal={onFocusTerminal} />
          )}

          {provider && (
            <>
              <div className="mb-4">
                <label className="block text-sm text-vibe-muted mb-2">Model</label>
                <div className="flex flex-wrap gap-2" data-testid="agent-model-picker">
                  {models.map((m) => (
                    <button key={m.id} data-model={m.id} onClick={() => setModel(m.id)} className={pill(model === m.id)} style={activeStyle(model === m.id)}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              {provider.efforts && (
                <div className="mb-4">
                  <label className="block text-sm text-vibe-muted mb-2">Effort</label>
                  <div className="flex gap-2" data-testid="agent-effort-picker">
                    {provider.efforts.values.map((v) => (
                      <button key={v} data-effort={v} onClick={() => setEffort(v)} className={`flex-1 capitalize ${pill(effort === v)}`} style={activeStyle(effort === v)}>
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {approvalModes.length > 1 && (
                <div className="mb-4">
                  <label className="block text-sm text-vibe-muted mb-2">Approval mode</label>
                  <div className="flex flex-col gap-1.5" data-testid="agent-approval-picker">
                    {approvalModes.map((m) => {
                      const active = approvalMode === m
                      const danger = m === 'bypass'
                      return (
                        <button
                          key={m}
                          data-approval={m}
                          onClick={() => setApprovalMode(m)}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left transition-all ${
                            active
                              ? danger ? 'bg-amber-500/10 border-amber-500/50 text-amber-400' : 'border-transparent text-vibe-text'
                              : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
                          }`}
                          style={active && !danger ? { backgroundColor: `${color}22`, borderColor: color } : undefined}
                        >
                          <div>
                            <span className="text-sm font-medium">{APPROVAL_MODE_INFO[m].label}</span>
                            <p className="text-xs opacity-70">{APPROVAL_MODE_INFO[m].description}</p>
                          </div>
                          <span className={`w-3 h-3 rounded-full border ${active ? 'border-transparent' : 'border-vibe-border'}`} style={active ? { backgroundColor: danger ? '#f59e0b' : color } : undefined} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="mb-4">
            <label className="block text-sm text-vibe-muted mb-2">What should {providerName(provider, providerId)} work on?</label>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe the task, feature, or question..."
              rows={4}
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder:text-vibe-muted focus:outline-none resize-none"
            />
            <p className="text-xs text-vibe-muted mt-1">Press Ctrl+Enter to start</p>
          </div>

          {error && <p className="text-xs text-red-400 mb-3 whitespace-pre-wrap">{error}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={closeModal} className="px-4 py-2 text-vibe-muted hover:text-vibe-text rounded transition-colors">Cancel</button>
            <button
              onClick={() => void submit(false)}
              disabled={!provider || busy}
              data-testid="agent-launch-interactive"
              className="px-4 py-2 border border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30 rounded transition-colors disabled:opacity-50"
              title="Launch the CLI without sending an initial prompt"
            >
              Open Interactive
            </button>
            <button
              onClick={() => void submit(true)}
              disabled={!provider || busy || !prompt.trim()}
              data-testid="agent-launch-start"
              className="px-4 py-2 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              style={{ backgroundColor: color }}
            >
              Start {providerName(provider, providerId)}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
