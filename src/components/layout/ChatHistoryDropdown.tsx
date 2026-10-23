import { useState, useRef, useEffect, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { useOptionalPlugin } from '../../plugins/optional'
import { runPluginCommand } from '../../plugins/commands'
import { commands } from '../../generated/bindings'
import { call } from '../../lib/core'
import { launchAgent } from '../../agents/launch'
import { ensureProviders, providerColor, providerShortName, useAgentProviders } from '../../agents/providers'

interface ChatSession {
  id: string
  providerId: string
  modifiedAt: number
  isOpen: boolean
  terminalId?: string // If open, which terminal has this session
  title?: string // Derived from terminal if open
}

// Format date for display
function formatDate(timestamp: number) {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

// Truncate session ID for display
function truncateId(id: string) {
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-4)}`
}

// Reusable panel component for chat history content
export function ChatHistoryPanel({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const providers = useAgentProviders()
  const semanticSearch = useOptionalPlugin('semantic-search')
  const {
    terminals,
    globalWorkingDirectory,
    setActiveTerminal,
  } = useTerminalStore()

  // Which sessions are open in a terminal (provider + session id).
  const getOpenSessionIds = useCallback(() => {
    const openSessions = new Map<string, { terminalId: string; title?: string }>()
    terminals.forEach((terminal, terminalId) => {
      const b = terminal.agent
      if (b?.sessionId) openSessions.set(`${b.providerId}\u0000${b.sessionId}`, { terminalId, title: terminal.title })
    })
    return openSessions
  }, [terminals])

  // Sessions of every provider for the project dir (core session scanner).
  const fetchSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const list = await ensureProviders()
      const perProvider = await Promise.all(
        list.map((p) => call(commands.agentsSessionsList(p.id, globalWorkingDirectory)).catch(() => [])),
      )
      const openSessions = getOpenSessionIds()
      const combined: ChatSession[] = perProvider
        .flat()
        .map((s) => {
          const open = openSessions.get(`${s.providerId}\u0000${s.id}`)
          return { id: s.id, providerId: s.providerId, modifiedAt: s.modifiedAt, isOpen: !!open, terminalId: open?.terminalId, title: open?.title ?? s.title ?? undefined }
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt)
      setSessions(combined)
    } catch (error) {
      console.error('Failed to fetch chat sessions:', error)
    }
    setIsLoading(false)
  }, [globalWorkingDirectory, getOpenSessionIds])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleSessionClick = async (session: ChatSession) => {
    if (session.isOpen && session.terminalId) {
      setActiveTerminal(session.terminalId)
      onClose()
      return
    }
    try {
      await launchAgent({
        providerId: session.providerId,
        resumeSessionId: session.id,
        terminal: { originalPrompt: `[Resumed session ${session.id}]` },
      })
      onClose()
    } catch (error) {
      console.error('Failed to open session:', error)
    }
  }

  const openCount = sessions.filter(s => s.isOpen).length

  return (
    <div className="w-72 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-vibe-border flex items-center justify-between">
        <span className="text-sm font-medium text-vibe-text">Chat History</span>
        <button
          onClick={fetchSessions}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
          title="Refresh"
        >
          <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Sessions List */}
      <div className="max-h-80 overflow-y-auto">
        {isLoading && sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-vibe-muted text-sm">
            <div className="w-5 h-5 border-2 border-vibe-muted border-t-transparent rounded-full animate-spin mx-auto mb-2" />
            Loading sessions...
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-vibe-muted text-sm">
            No chat sessions found for this directory.
          </div>
        ) : (
          <div className="py-1">
            {sessions.map((session) => (
              <button
                key={`${session.providerId}-${session.id}`}
                onClick={() => handleSessionClick(session)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  session.isOpen
                    ? 'bg-vibe-primary/10 hover:bg-vibe-primary/20'
                    : 'hover:bg-vibe-border/50'
                }`}
              >
                {/* Provider Badge */}
                {(() => {
                  const p = providers.find((x) => x.id === session.providerId)
                  const color = providerColor(p)
                  return (
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 text-xs font-bold" style={{ backgroundColor: `${color}33`, color }}>
                      {providerShortName(p, session.providerId).slice(0, 2)}
                    </div>
                  )
                })()}

                {/* Session Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase" style={{ color: providerColor(providers.find((x) => x.id === session.providerId)) }}>
                      {providerShortName(providers.find((x) => x.id === session.providerId), session.providerId)}
                    </span>
                    {session.isOpen && (
                      <span className="flex items-center gap-1 text-xs text-vibe-primary">
                        <span className="w-1.5 h-1.5 bg-vibe-primary rounded-full animate-pulse" />
                        Open
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-vibe-text truncate">
                    {session.title || truncateId(session.id)}
                  </div>
                  <div className="text-xs text-vibe-muted">
                    {formatDate(session.modifiedAt)}
                  </div>
                </div>

                {/* Action indicator */}
                <div className="flex-shrink-0 text-vibe-muted">
                  {session.isOpen ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer with session counts */}
      {sessions.length > 0 && (
        <div className="px-3 py-2 border-t border-vibe-border text-xs text-vibe-muted flex items-center justify-between">
          <span>
            {providers
              .map((p) => [p, sessions.filter((s) => s.providerId === p.id).length] as const)
              .filter(([, n]) => n > 0)
              .map(([p, n]) => `${n} ${providerShortName(p)}`)
              .join(', ')}
          </span>
          <span>
            {openCount} open
          </span>
        </div>
      )}

      {/* Semantic search over past sessions: offered when the optional plugin is installed. */}
      {semanticSearch && (
        <div className="border-t border-vibe-border">
          <button
            onClick={() => {
              void runPluginCommand('semantic-search', 'search').catch((e) => console.error('[semantic-search] search failed:', e))
              onClose()
            }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            Search past sessions…
          </button>
        </div>
      )}
    </div>
  )
}

// Hook to get the count of open sessions (for badges)
export function useOpenSessionCount() {
  const terminals = useTerminalStore((s) => s.terminals)
  let count = 0
  terminals.forEach((terminal) => {
    if (terminal.agent?.sessionId) count++
  })
  return count
}

export default function ChatHistoryDropdown() {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Register overlay so native webviews (YouTube Shorts) hide when this dropdown is open
  useOverlayRegistration('chat-history-dropdown', isOpen)

  const openCount = useOpenSessionCount()

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Dropdown Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1 bg-vibe-surface border border-vibe-border text-vibe-text rounded hover:bg-vibe-border/50 transition-colors text-sm"
        title="Chat History"
      >
        {/* Chat history icon */}
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span className="hidden xl:inline">History</span>
        {openCount > 0 && (
          <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 text-xs bg-vibe-primary text-white rounded-full">
            {openCount}
          </span>
        )}
        <svg
          className={`w-3 h-3 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-full right-0 mt-1 z-50">
          <ChatHistoryPanel onClose={() => setIsOpen(false)} />
        </div>
      )}
    </div>
  )
}
