/**
 * Semantic search tile (pane + flyout): query box, session / excerpt results, index status
 * bar, and the settings panel behind the gear button. Ported from the shell's
 * SearchSidebar / SessionPreview / InlineIndexStatus / SemanticSettingsModal.
 */
import type { JsonValue, ProviderInfo, TileProps } from '@quadflow/plugin-api'
import { claimTileState } from '@quadflow/plugin-kit'
import { Badge, Button, EmptyState, Icon, IconButton, ProgressBar, SearchInput, Select, Spinner, Tabs } from '@quadflow/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { contextBlock, formatAge, formatScore, progressPercent, progressText, projectLabel, scoreTone, tailPath, truncate } from './format'
import { errorText, isModelMissing, semanticModel, type ChunkHit, type SessionHit } from './model'
import { SettingsPanel } from './SettingsPanel'

type Mode = 'sessions' | 'chunks'

interface TileState {
  query?: string
  mode?: Mode
  providerId?: string
}

const MIN_QUERY = 3

export function SearchTile({ ctx, mode: tileMode, instance, setState, visible }: TileProps) {
  const model = semanticModel(ctx)
  useEffect(() => model.retain(), [model])
  const initial = useMemo(() => (claimTileState(ctx, 'search', instance.state) ?? {}) as TileState, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [query, setQuery] = useState(initial.query ?? '')
  const [mode, setMode] = useState<Mode>(initial.mode ?? 'sessions')
  const [providerId, setProviderId] = useState(initial.providerId ?? '')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [results, setResults] = useState<{ sessions: SessionHit[]; chunks: ChunkHit[] }>({ sessions: [], chunks: [] })
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<{ text: string; modelMissing: boolean } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const status = model.store((s) => s.status)
  const sidecarError = model.store((s) => s.error)
  const indexedVersion = model.store((s) => s.indexedVersion)
  const pendingQuery = model.store((s) => s.pendingQuery)
  const seq = useRef(0)
  const compact = tileMode === 'flyout'

  // A query handed over by the palette / the search command.
  useEffect(() => {
    if (pendingQuery != null && visible) {
      setQuery(pendingQuery)
      model.setPendingQuery(null)
    }
  }, [pendingQuery, visible, model])

  // Persist the query with the tile (the host's `setState` identity changes between renders).
  const setStateRef = useRef(setState)
  setStateRef.current = setState
  useEffect(() => {
    setStateRef.current({ query, mode, providerId } as unknown as JsonValue)
  }, [query, mode, providerId])

  useEffect(() => {
    if (!ctx.api.has('agents.providers')) return
    ctx.agents.providers().then(setProviders, () => setProviders([]))
  }, [ctx])

  // Debounced search; re-run after an index job finished.
  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_QUERY) {
      setResults({ sessions: [], chunks: [] })
      setSearchError(null)
      return
    }
    const my = ++seq.current
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const o = { mode, limit: 25, providerId: providerId || null }
        const hits = await model.search<SessionHit | ChunkHit>(q, o)
        if (my !== seq.current) return
        setResults(mode === 'sessions' ? { sessions: hits as SessionHit[], chunks: [] } : { sessions: [], chunks: hits as ChunkHit[] })
        setSearchError(null)
        setSelected(new Set())
      } catch (e) {
        if (my === seq.current) setSearchError({ text: errorText(e), modelMissing: isModelMissing(e) })
      } finally {
        if (my === seq.current) setSearching(false)
      }
    }, 350)
    return () => clearTimeout(t)
  }, [query, mode, providerId, indexedVersion, model])

  const providerName = (id: string) => providers.find((p) => p.id === id)?.shortName ?? providers.find((p) => p.id === id)?.displayName ?? (id || 'unknown')

  const resume = async (hit: SessionHit) => {
    try {
      await ctx.agents.launch({ providerId: hit.providerId, resumeSessionId: hit.sessionId, placement: 'split-active' })
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Could not resume the session', body: errorText(e) })
    }
  }

  const sendToAgent = async (text: string) => {
    const p = providers.find((x) => x.id === providerId) ?? providers[0]
    if (!p) {
      ctx.notifications.toast({ kind: 'warning', title: 'No agent provider is installed' })
      return
    }
    try {
      await ctx.agents.launch({ providerId: p.id, prompt: text, autoSubmit: false, placement: 'split-active' })
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Could not start the agent', body: errorText(e) })
    }
  }

  const copy = async (text: string) => {
    try {
      await ctx.clipboard.writeText(text)
      ctx.notifications.toast({ kind: 'success', title: 'Copied' })
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Could not copy', body: errorText(e) })
    }
  }

  const chunkKey = (c: ChunkHit) => `${c.sessionPath}#${c.chunkIndex}`
  const selectedChunks = results.chunks.filter((c) => selected.has(chunkKey(c)))
  const canResume = (id: string) => providers.find((p) => p.id === id)?.canResume ?? false
  const stats = status?.stats
  const running = status?.state === 'running'
  const progress = running ? status?.progress : null
  const nothingIndexed = !!stats && stats.indexed === 0 && !running

  const providerOptions = [{ value: '', label: 'All agents' }, ...providers.map((p) => ({ value: p.id, label: p.displayName }))]

  return (
    <div className="flex h-full min-h-0 flex-col bg-vibe-bg text-vibe-text" data-testid="semantic-tile" data-mode={tileMode}>
      {/* Header: query + filters */}
      <div className={`flex flex-col gap-2 border-b border-vibe-border ${compact ? 'p-2' : 'p-3'}`}>
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            value={query}
            onChange={setQuery}
            placeholder="Search past agent sessions by meaning…"
            autoFocus
            data-testid="semantic-query"
          />
          <IconButton label="Semantic search settings" active={showSettings} onClick={() => setShowSettings((v) => !v)} data-testid="semantic-settings-toggle">
            <Icon name="settings" />
          </IconButton>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            size="sm"
            variant="pills"
            value={mode}
            onChange={(v) => setMode(v)}
            items={[
              { value: 'sessions', label: 'Sessions' },
              { value: 'chunks', label: 'Excerpts' },
            ]}
          />
          <div className="flex-1" />
          {providers.length > 1 && (
            <Select size="sm" aria-label="Agent" className="w-40" value={providerId} onChange={setProviderId} options={providerOptions} />
          )}
        </div>
      </div>

      {/* Index status bar */}
      <div className={`flex flex-col gap-1 border-b border-vibe-border text-xs ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`} data-testid="semantic-status">
        <div className="flex items-center gap-2">
          {running ? <Spinner size="sm" /> : <span className={`h-2 w-2 rounded-full ${stats?.pending ? 'bg-amber-400' : stats?.indexed ? 'bg-green-500' : 'bg-vibe-muted'}`} />}
          <span className="flex-1 truncate text-vibe-muted">
            {sidecarError
              ? 'Semantic search is unavailable'
              : !status
                ? 'Starting…'
                : running && progress
                  ? progressText(progress)
                  : `${stats?.indexed ?? 0} sessions indexed${stats?.pending ? ` · ${stats.pending} pending` : ''} · ${status.model.name}${status.lastRunAt ? ` · ${formatAge(status.lastRunAt)}` : ''}`}
          </span>
          {running ? (
            <Button size="xs" variant="ghost" onClick={() => void model.stop().catch((e) => ctx.notifications.toast({ kind: 'error', title: 'Could not stop', body: errorText(e) }))}>
              Stop
            </Button>
          ) : (
            <Button
              size="xs"
              variant={nothingIndexed || stats?.pending ? 'primary' : 'ghost'}
              disabled={!status}
              onClick={() => void model.index(false).catch((e) => ctx.notifications.toast({ kind: 'error', title: 'Could not start indexing', body: errorText(e) }))}
              data-testid="semantic-index"
            >
              Index
            </Button>
          )}
        </div>
        {progress && <ProgressBar value={progressPercent(progress)} />}
        {status?.lastError && !running && <span className="text-red-400">Last run failed: {status.lastError}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showSettings ? (
          <SettingsPanel ctx={ctx} />
        ) : sidecarError ? (
          <EmptyState
            icon={<Icon name="warning" />}
            title="The semantic search sidecar is not running"
            description={
              <span className="whitespace-pre-wrap">
                {sidecarError}
                {'\n\n'}Built from source? Build the sidecar with `npm run build:sidecar` in plugins/semantic-search.
              </span>
            }
            action={
              <Button size="sm" onClick={() => void ctx.sidecar.restart().then(() => model.refresh())}>
                Restart
              </Button>
            }
          />
        ) : query.trim().length < MIN_QUERY ? (
          <EmptyState
            icon={<Icon name="search" />}
            title={nothingIndexed ? 'Nothing indexed yet' : 'Search your agent sessions'}
            description={
              nothingIndexed
                ? 'Index your agent sessions once (the embedding model is downloaded on first use); then search them by meaning.'
                : `Type at least ${MIN_QUERY} characters — e.g. "how did we fix the websocket reconnect".`
            }
            action={
              nothingIndexed ? (
                <Button size="sm" variant="primary" onClick={() => void model.index(false)}>
                  Index sessions
                </Button>
              ) : undefined
            }
          />
        ) : searchError ? (
          <EmptyState
            icon={<Icon name="warning" />}
            title={searchError.modelMissing ? 'The embedding model is not downloaded yet' : 'Search failed'}
            description={searchError.modelMissing ? 'Index your sessions (downloads the model) or download it in the settings.' : searchError.text}
            action={
              searchError.modelMissing ? (
                <Button size="sm" variant="primary" onClick={() => void model.index(false)}>
                  Download model and index
                </Button>
              ) : undefined
            }
          />
        ) : searching && results.sessions.length === 0 && results.chunks.length === 0 ? (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (mode === 'sessions' ? results.sessions.length : results.chunks.length) === 0 ? (
          <EmptyState icon={<Icon name="search" />} title="No matching sessions" description={nothingIndexed ? 'Nothing is indexed yet.' : 'Try other words, or index recent sessions.'} />
        ) : (
          <div className={`flex flex-col gap-2 ${compact ? 'p-2' : 'p-3'}`} data-testid="semantic-results">
            {mode === 'sessions'
              ? results.sessions.map((h) => (
                  <div key={h.sessionPath} className="rounded-md border border-vibe-border bg-vibe-surface p-2.5" data-testid="semantic-hit">
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <Badge tone={scoreTone(h.score)}>{formatScore(h.score)}</Badge>
                      <span className="truncate font-medium" title={h.project}>
                        {projectLabel(h.project) || tailPath(h.sessionPath)}
                      </span>
                      <Badge>{providerName(h.providerId)}</Badge>
                      <span className="ml-auto shrink-0 text-vibe-muted">{formatAge(h.lastModified)}</span>
                    </div>
                    <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-vibe-text/90">{h.preview}</p>
                    <div className="mt-1.5 flex items-center gap-1 text-[11px] text-vibe-muted">
                      <span>
                        {h.matchingChunks}/{h.totalChunks} matching chunks{h.taskType ? ` · ${h.taskType}` : ''}
                      </span>
                      <div className="flex-1" />
                      {canResume(h.providerId) && (
                        <Button size="xs" variant="ghost" leftIcon={<Icon name="play" />} onClick={() => void resume(h)}>
                          Resume
                        </Button>
                      )}
                      <IconButton label="Copy excerpt" onClick={() => void copy(h.preview)}>
                        <Icon name="copy" />
                      </IconButton>
                    </div>
                  </div>
                ))
              : results.chunks.map((c) => {
                  const k = chunkKey(c)
                  const on = selected.has(k)
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(k)) next.delete(k)
                          else next.add(k)
                          return next
                        })
                      }
                      className={`rounded-md border p-2.5 text-left ${on ? 'border-vibe-primary bg-vibe-primary/10' : 'border-vibe-border bg-vibe-surface hover:border-vibe-primary/50'}`}
                      data-testid="semantic-hit"
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <Badge tone={scoreTone(c.score)}>{formatScore(c.score)}</Badge>
                        <span className="truncate font-medium">{projectLabel(c.project) || tailPath(c.sessionPath)}</span>
                        {c.role && <Badge tone={c.role === 'user' ? 'primary' : 'secondary'}>{c.role}</Badge>}
                        {c.turn != null && <span className="text-vibe-muted">turn {c.turn}</span>}
                      </div>
                      <p className="line-clamp-6 whitespace-pre-wrap break-words text-xs">{truncate(c.content, 900)}</p>
                    </button>
                  )
                })}
          </div>
        )}
      </div>

      {!showSettings && mode === 'chunks' && selectedChunks.length > 0 && (
        <div className="flex gap-2 border-t border-vibe-border p-2">
          <Button size="sm" variant="primary" className="flex-1" onClick={() => void sendToAgent(contextBlock(selectedChunks))}>
            Start an agent with {selectedChunks.length} excerpt{selectedChunks.length > 1 ? 's' : ''}
          </Button>
          <Button size="sm" onClick={() => void copy(contextBlock(selectedChunks))}>
            Copy
          </Button>
        </div>
      )}
    </div>
  )
}
