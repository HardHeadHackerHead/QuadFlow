/**
 * Session Recommendations (agent launch dialog)
 *
 * Past sessions related to the prompt being typed, with "Focus" for a session that is open in
 * a terminal and "Continue" otherwise. The search is done by the optional `semantic-search`
 * plugin through its `related-sessions` command; the dialog only mounts this component while
 * that plugin is installed and active (`useOptionalPlugin`), and any failure just shows nothing.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { runPluginCommand } from '../../plugins/commands'

/** `SessionHit` of the semantic-search plugin (the fields this view uses). */
interface RelatedSession {
  sessionId: string
  sessionPath: string
  providerId: string
  project: string
  score: number
  matchingChunks: number
  preview: string
}

interface SessionRecommendationsProps {
  providerId: string
  prompt: string
  onContinueSession: (sessionId: string, sessionPath: string, prompt: string) => void
  onFocusTerminal: (terminalId: string, prompt: string) => void
  minScore?: number
}

interface EnrichedSession extends RelatedSession {
  isOpen: boolean
  terminalId?: string
  terminalTitle?: string
}

const MIN_PROMPT = 10

function scoreBadge(score: number): string {
  if (score >= 0.7) return 'bg-green-500/20 text-green-400'
  if (score >= 0.5) return 'bg-yellow-500/20 text-yellow-400'
  if (score >= 0.3) return 'bg-orange-500/20 text-orange-400'
  return 'bg-vibe-muted/20 text-vibe-muted'
}

const tail = (p: string, n = 2) => p.split(/[/\\]/).slice(-n).join('/')
const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n)}...`)

export default function SessionRecommendations({
  providerId,
  prompt,
  onContinueSession,
  onFocusTerminal,
  minScore = 0.35,
}: SessionRecommendationsProps) {
  const [results, setResults] = useState<RelatedSession[]>([])
  const [isSearching, setIsSearching] = useState(false)

  // Debounced lookup through the plugin (never downloads a model; [] on any problem).
  useEffect(() => {
    const query = prompt.trim()
    if (query.length < MIN_PROMPT) {
      setResults([])
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      setIsSearching(true)
      try {
        const hits = await runPluginCommand('semantic-search', 'related-sessions', { query, providerId, limit: 5, minScore })
        if (!cancelled) setResults(Array.isArray(hits) ? (hits as RelatedSession[]) : [])
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setIsSearching(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [prompt, providerId, minScore])

  const terminals = useTerminalStore((state) => state.terminals)

  const enrichedSessions = useMemo((): EnrichedSession[] => {
    return results
      .filter((session) => session.providerId === providerId)
      .map((session) => {
        let isOpen = false
        let terminalId: string | undefined
        let terminalTitle: string | undefined
        terminals.forEach((terminal, id) => {
          const b = terminal.agent
          if (b && b.providerId === session.providerId && !!b.sessionId && b.sessionId === session.sessionId) {
            isOpen = true
            terminalId = id
            terminalTitle = terminal.title
          }
        })
        return { ...session, isOpen, terminalId, terminalTitle }
      })
  }, [providerId, results, terminals])

  if (prompt.trim().length < MIN_PROMPT) return null

  if (isSearching && enrichedSessions.length === 0) {
    return (
      <div className="mb-4">
        <div className="flex items-center gap-2 text-xs text-vibe-muted mb-2">
          <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
          Finding related sessions...
        </div>
      </div>
    )
  }

  if (enrichedSessions.length === 0) return null

  return (
    <div className="mb-4" data-testid="session-recommendations">
      <div className="flex items-center gap-2 mb-2">
        <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <span className="text-xs font-medium text-vibe-text">Related Sessions</span>
        <span className="text-xs text-vibe-muted">({enrichedSessions.length} found)</span>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto">
        {enrichedSessions.map((session) => (
          <SessionCard
            key={session.sessionPath}
            session={session}
            onContinue={() => onContinueSession(session.sessionId, session.sessionPath, prompt)}
            onFocus={() => session.terminalId && onFocusTerminal(session.terminalId, prompt)}
          />
        ))}
      </div>
    </div>
  )
}

interface SessionCardProps {
  session: EnrichedSession
  onContinue: () => void
  onFocus: () => void
}

function SessionCard({ session, onContinue, onFocus }: SessionCardProps) {
  return (
    <div className="p-2.5 bg-vibe-bg border border-vibe-border rounded-lg hover:border-vibe-muted transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {session.isOpen ? (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/20 text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Open
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-vibe-muted/20 text-vibe-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-vibe-muted" />
                Previous
              </span>
            )}
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${scoreBadge(session.score)}`}>{Math.round(session.score * 100)}% match</span>
            {session.matchingChunks > 1 && <span className="text-[10px] text-vibe-muted">{session.matchingChunks} chunks</span>}
          </div>

          {session.isOpen && session.terminalTitle && <div className="text-xs text-green-400 mb-1 truncate">{session.terminalTitle}</div>}

          <div className="text-[10px] text-vibe-muted mb-1 truncate" title={session.project}>
            {tail(session.project || session.sessionPath, 2)}
          </div>

          {session.preview && <p className="text-xs text-vibe-text/70 line-clamp-2">{clip(session.preview, 100)}</p>}
        </div>

        <div className="flex-shrink-0">
          {session.isOpen ? (
            <button
              onClick={onFocus}
              className="px-2.5 py-1.5 text-xs font-medium rounded bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors"
              title="Switch to this terminal"
            >
              Focus
            </button>
          ) : (
            <button
              onClick={onContinue}
              className="px-2.5 py-1.5 text-xs font-medium rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors"
              title="Continue this session"
            >
              Continue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
