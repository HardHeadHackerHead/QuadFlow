import { useEffect, useState, useRef } from 'react'
import { useGitStatusStore } from '../model'
import { useProjectRoot } from '../model'

function timeAgo(isoString: string | null): string {
  if (!isoString) return 'never'
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diffMs = now - then
  if (diffMs < 0) return 'just now'

  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function timeColor(isoString: string | null): string {
  if (!isoString) return 'text-vibe-muted'
  const diffMs = Date.now() - new Date(isoString).getTime()
  const hours = diffMs / 3600000
  if (hours < 1) return 'text-emerald-400'
  if (hours < 4) return 'text-yellow-400'
  return 'text-red-400'
}

interface StatusViewProps {
  activeDir?: string
}

export default function StatusView({ activeDir }: StatusViewProps) {
  const globalWorkingDirectory = useProjectRoot()
  const dir = activeDir || globalWorkingDirectory

  const status = useGitStatusStore(s => s.getStatus(dir))
  const autoGenerateMessage = useGitStatusStore(s => s.autoGenerateMessage)
  const { initRepo, refresh, stageAll, commit, push, commitAndPush, fetch, generateMessage, setAutoGenerateMessage, clearError } = useGitStatusStore()

  const {
    branch, staged, modified, untracked, ahead, behind,
    lastCommitTime, lastPushTime, hasRemote, hasUpstream, isGitRepo,
    isLoading, isActioning, isGenerating, error,
  } = status

  const [commitMsg, setCommitMsg] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [, setTick] = useState(0) // force re-render for time-ago updates

  // Initial load + 30s polling
  useEffect(() => {
    if (!dir) return
    refresh(dir)
    intervalRef.current = setInterval(() => {
      refresh(dir)
      setTick(t => t + 1)
    }, 30000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [refresh, dir])

  const resolveMessage = async (): Promise<string | null> => {
    if (autoGenerateMessage) {
      const generated = await generateMessage(dir)
      return generated
    }
    const msg = commitMsg.trim()
    return msg || null
  }

  const handleCommit = async () => {
    try {
      const msg = await resolveMessage()
      if (!msg) return
      await commit(dir, msg)
      setCommitMsg('')
    } catch {
      // Error is already set in the store by generateMessage
    }
  }

  const handleCommitAndPush = async () => {
    try {
      const msg = await resolveMessage()
      if (!msg) return
      await commitAndPush(dir, msg)
      setCommitMsg('')
    } catch {
      // Error is already set in the store by generateMessage
    }
  }

  if (!isGitRepo && !isLoading) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-vibe-muted">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01M3 12a9 9 0 1118 0 9 9 0 01-18 0z" />
          </svg>
          <p className="text-sm font-medium">Not a git repository</p>
          <p className="text-xs mt-1 opacity-70 mb-4">Initialize git to start tracking changes</p>
          <button
            onClick={() => initRepo(dir)}
            disabled={isActioning}
            className="px-4 py-2 text-sm rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors disabled:opacity-50"
          >
            {isActioning ? 'Initializing...' : 'Initialize Git'}
          </button>
          <p className="text-xs mt-2 opacity-50">Generates a .gitignore based on your project</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-vibe-bg relative">
      {/* Header with refresh */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-vibe-border">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          <span className="font-medium text-vibe-text" data-testid="git-branch">{branch || '(detached HEAD)'}</span>
        </div>
        <div className="flex items-center gap-2">
          {hasRemote && (
            <button
              onClick={() => fetch(dir)}
              disabled={isActioning}
              className="px-3 py-1.5 text-xs rounded bg-vibe-surface border border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-primary/50 transition-colors disabled:opacity-50"
              title="Fetch from remote"
            >
              Fetch
            </button>
          )}
          <button
            onClick={() => refresh(dir)}
            disabled={isLoading}
            className="p-1.5 rounded text-vibe-muted hover:text-vibe-text hover:bg-vibe-surface transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Time summary cards */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="p-3 bg-vibe-surface border border-vibe-border rounded-lg">
            <div className="text-xs text-vibe-muted mb-1">Last Commit</div>
            <div className={`text-sm font-medium ${timeColor(lastCommitTime)}`}>
              {timeAgo(lastCommitTime)}
            </div>
          </div>
          <div className="p-3 bg-vibe-surface border border-vibe-border rounded-lg">
            <div className="text-xs text-vibe-muted mb-1">Last Push</div>
            <div className={`text-sm font-medium ${hasRemote ? timeColor(lastPushTime) : 'text-vibe-muted'}`}>
              {hasRemote ? timeAgo(lastPushTime) : 'no remote'}
            </div>
          </div>
        </div>

        {/* Status counts */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          <StatusCard label="Staged" count={staged} color="text-emerald-400" bgColor="bg-emerald-500/10" />
          <StatusCard label="Modified" count={modified} color="text-yellow-400" bgColor="bg-yellow-500/10" />
          <StatusCard label="Untracked" count={untracked} color="text-blue-400" bgColor="bg-blue-500/10" />
        </div>

        {hasRemote && (
          hasUpstream ? (
            <div className="grid grid-cols-2 gap-2 mb-4">
              <StatusCard label="Ahead" count={ahead} color="text-teal-400" bgColor="bg-teal-500/10" />
              <StatusCard label="Behind" count={behind} color="text-orange-400" bgColor="bg-orange-500/10" />
            </div>
          ) : (
            <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-sm text-yellow-400 mb-4">
              No upstream branch set — push to set up tracking
            </div>
          )
        )}

        {/* Error display */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">
            <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="flex-1 break-words overflow-y-auto max-h-20">{error}</span>
            <button onClick={() => clearError(dir)} className="flex-shrink-0 hover:text-red-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Actions - pinned to bottom */}
      <div className="flex-shrink-0 p-4 pt-3 border-t border-vibe-border space-y-3">
        {/* Stage All */}
        {(modified > 0 || untracked > 0) && (
          <button
            onClick={() => stageAll(dir)}
            disabled={isActioning}
            className="w-full px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text hover:border-emerald-500/50 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
          >
            Stage All ({modified + untracked} file{modified + untracked !== 1 ? 's' : ''})
          </button>
        )}

        {/* Auto-generate checkbox */}
        <label className="flex items-center gap-2 cursor-pointer select-none group">
          <input
            type="checkbox"
            checked={autoGenerateMessage}
            onChange={(e) => setAutoGenerateMessage(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-vibe-border bg-vibe-surface text-teal-500 accent-teal-500 cursor-pointer"
          />
          <span className="text-xs text-vibe-muted group-hover:text-vibe-text transition-colors">
            Auto-generate commit message with an agent
          </span>
          {isGenerating && (
            <div className="animate-spin w-3 h-3 border border-teal-500 border-t-transparent rounded-full" />
          )}
        </label>

        {/* Commit input */}
        <input
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleCommit()
            }
          }}
          placeholder={autoGenerateMessage ? 'Message will be auto-generated...' : 'Commit message...'}
          className={`w-full px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text placeholder:text-vibe-muted/50 focus:outline-none focus:border-vibe-primary/50 ${autoGenerateMessage ? 'opacity-50' : ''}`}
          disabled={isActioning || isGenerating || autoGenerateMessage}
        />

        {/* Commit / Push / Commit & Push buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleCommit}
            disabled={isActioning || isGenerating || (!autoGenerateMessage && !commitMsg.trim()) || staged === 0}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text hover:border-teal-500/50 hover:bg-teal-500/10 transition-colors disabled:opacity-40"
            title={staged === 0 ? 'No staged changes to commit' : ''}
          >
            {isGenerating ? 'Generating...' : 'Commit'}
          </button>
          {hasRemote && (
            <>
              <button
                onClick={() => push(dir)}
                disabled={isActioning || (hasUpstream && ahead === 0)}
                className="flex-1 px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text hover:border-blue-500/50 hover:bg-blue-500/10 transition-colors disabled:opacity-40"
                title={!hasUpstream ? 'Push and set upstream' : ahead === 0 ? 'Nothing to push' : ''}
              >
                {!hasUpstream ? 'Push -u' : 'Push'}
              </button>
              <button
                onClick={handleCommitAndPush}
                disabled={isActioning || isGenerating || (!autoGenerateMessage && !commitMsg.trim()) || staged === 0}
                className="flex-1 px-4 py-2 text-sm rounded-lg bg-teal-600 border border-teal-500/50 text-white hover:bg-teal-500 transition-colors disabled:opacity-40"
                title={staged === 0 ? 'No staged changes' : ''}
              >
                {isGenerating ? 'Generating...' : 'Commit & Push'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Loading overlay */}
      {(isActioning || isGenerating) && (
        <div className="absolute inset-0 bg-vibe-bg/50 flex items-center justify-center z-10">
          <div className="text-center">
            <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full mx-auto" />
            {isGenerating && (
              <div className="text-xs text-vibe-muted mt-2">The agent is writing a commit message...</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatusCard({ label, count, color, bgColor }: { label: string; count: number; color: string; bgColor: string }) {
  return (
    <div className={`p-3 rounded-lg border border-vibe-border ${count > 0 ? bgColor : 'bg-vibe-surface'}`} data-testid={`git-status-${label.toLowerCase()}`}>
      <div className="text-xs text-vibe-muted mb-0.5">{label}</div>
      <div className={`text-lg font-semibold ${count > 0 ? color : 'text-vibe-muted/50'}`}>{count}</div>
    </div>
  )
}
