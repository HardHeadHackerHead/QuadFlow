import { useEffect, useState } from 'react'
import { useCheckpointStore } from '../model'
import type { Checkpoint, CheckpointDiffSummary } from '../types'

function timeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  if (diffMs < 0) return 'just now'
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function DiffPreview({ diff }: { diff: CheckpointDiffSummary }) {
  if (diff.filesChanged === 0) {
    return <div className="text-xs text-vibe-muted py-1">No differences from current HEAD</div>
  }

  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-3 text-xs">
        <span className="text-vibe-muted">{diff.filesChanged} file{diff.filesChanged !== 1 ? 's' : ''}</span>
        <span className="text-emerald-400">+{diff.additions}</span>
        <span className="text-red-400">-{diff.deletions}</span>
      </div>
      <div className="max-h-32 overflow-y-auto space-y-0.5">
        {diff.files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 text-xs font-mono">
            <span className="text-emerald-400 w-8 text-right">+{f.additions}</span>
            <span className="text-red-400 w-8 text-right">-{f.deletions}</span>
            <span className="text-vibe-muted truncate flex-1" title={f.path}>{f.path}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CheckpointCard({
  checkpoint,
  diffPreview,
  isActioning,
  onRestore,
  onDelete,
  onLoadDiff,
}: {
  checkpoint: Checkpoint
  diffPreview?: CheckpointDiffSummary
  isActioning: boolean
  onRestore: (id: string, createSafety: boolean) => void
  onDelete: (id: string) => void
  onLoadDiff: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [createSafety, setCreateSafety] = useState(true)

  const handleExpand = () => {
    if (!expanded && !diffPreview) {
      onLoadDiff(checkpoint.id)
    }
    setExpanded(!expanded)
  }

  return (
    <div className="p-3 bg-vibe-surface border border-vibe-border rounded-lg">
      {/* Card header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-vibe-text truncate" data-testid="checkpoint-name">{checkpoint.name}</span>
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-teal-500/15 text-teal-400 border border-teal-500/30 flex-shrink-0">
              {checkpoint.branch}
            </span>
            {checkpoint.hadUncommittedChanges && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 flex-shrink-0">
                auto-committed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-vibe-muted">
            <span className="font-mono">{checkpoint.commitSha.substring(0, 7)}</span>
            <span>{timeAgo(checkpoint.createdAt)}</span>
          </div>
          {checkpoint.description && (
            <p className="text-xs text-vibe-muted mt-1 line-clamp-2">{checkpoint.description}</p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={handleExpand}
            className="p-1.5 rounded text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg transition-colors"
            title="View diff"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            onClick={() => setConfirmRestore(true)}
            disabled={isActioning}
            className="p-1.5 rounded text-vibe-muted hover:text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
            title="Restore to this checkpoint"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4m-4 4l4 4" />
            </svg>
          </button>
          <button
            onClick={() => onDelete(checkpoint.id)}
            disabled={isActioning}
            className="p-1.5 rounded text-vibe-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            title="Delete checkpoint"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Diff preview (expandable) */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-vibe-border">
          {diffPreview ? (
            <DiffPreview diff={diffPreview} />
          ) : (
            <div className="flex items-center gap-2 text-xs text-vibe-muted py-1">
              <div className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              Loading diff...
            </div>
          )}
        </div>
      )}

      {/* Restore confirmation */}
      {confirmRestore && (
        <div className="mt-2 pt-2 border-t border-vibe-border">
          <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 space-y-2">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="text-xs text-amber-300">
                This will <strong>hard-reset</strong> your working tree to this checkpoint. All current changes will be overwritten.
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-vibe-muted cursor-pointer">
              <input
                type="checkbox"
                checked={createSafety}
                onChange={(e) => setCreateSafety(e.target.checked)}
                className="rounded border-vibe-border"
              />
              Create safety checkpoint first (recommended)
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setConfirmRestore(false)
                  onRestore(checkpoint.id, createSafety)
                }}
                disabled={isActioning}
                className="flex-1 px-3 py-1.5 text-xs rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
              >
                Restore
              </button>
              <button
                onClick={() => setConfirmRestore(false)}
                className="flex-1 px-3 py-1.5 text-xs rounded bg-vibe-bg border border-vibe-border text-vibe-muted hover:text-vibe-text transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface CheckpointsViewProps {
  activeDir?: string
}

export default function CheckpointsView({ activeDir }: CheckpointsViewProps) {
  const {
    checkpoints,
    isLoading,
    isActioning,
    error,
    diffPreviews,
    loadCheckpoints,
    createCheckpoint,
    restoreCheckpoint,
    deleteCheckpoint,
    loadDiffPreview,
    clearError,
  } = useCheckpointStore()

  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')

  useEffect(() => {
    loadCheckpoints(activeDir)
  }, [loadCheckpoints, activeDir])

  const handleCreate = async () => {
    if (!newName.trim()) return
    const result = await createCheckpoint(newName.trim(), newDesc.trim() || undefined, activeDir)
    if (result) {
      setNewName('')
      setNewDesc('')
    }
  }

  const handleRestore = async (id: string, createSafety: boolean) => {
    await restoreCheckpoint(id, createSafety, activeDir)
  }

  const handleDelete = async (id: string) => {
    await deleteCheckpoint(id, activeDir)
  }

  return (
    <div className="h-full flex flex-col bg-vibe-bg relative">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-vibe-border">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium text-vibe-text">Checkpoints</span>
          <span className="text-xs text-vibe-muted">({checkpoints.length})</span>
        </div>
        <button
          onClick={() => loadCheckpoints(activeDir)}
          disabled={isLoading}
          className="p-1.5 rounded text-vibe-muted hover:text-vibe-text hover:bg-vibe-surface transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <svg className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Scrollable checkpoint list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="flex-1 break-words overflow-y-auto max-h-20">{error}</span>
            <button onClick={clearError} className="flex-shrink-0 hover:text-red-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {checkpoints.length === 0 && !isLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-vibe-muted">
            <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium">No checkpoints yet</p>
            <p className="text-xs mt-1 opacity-70">Create one below to snapshot your project state</p>
          </div>
        )}

        {checkpoints.map((cp) => (
          <CheckpointCard
            key={cp.id}
            checkpoint={cp}
            diffPreview={diffPreviews[cp.id]}
            isActioning={isActioning}
            onRestore={handleRestore}
            onDelete={handleDelete}
            onLoadDiff={(id) => loadDiffPreview(id, activeDir)}
          />
        ))}
      </div>

      {/* Create form - pinned to bottom */}
      <div className="flex-shrink-0 p-4 pt-3 border-t border-vibe-border space-y-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleCreate()
            }
          }}
          placeholder="Checkpoint name (e.g. before-refactor)..."
          className="w-full px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text placeholder:text-vibe-muted/50 focus:outline-none focus:border-vibe-primary/50"
          disabled={isActioning}
        />
        <input
          type="text"
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleCreate()
            }
          }}
          placeholder="Description (optional)..."
          className="w-full px-4 py-2 text-sm rounded-lg bg-vibe-surface border border-vibe-border text-vibe-text placeholder:text-vibe-muted/50 focus:outline-none focus:border-vibe-primary/50"
          disabled={isActioning}
        />
        <button
          onClick={handleCreate}
          disabled={isActioning || !newName.trim()}
          className="w-full px-4 py-2 text-sm rounded-lg bg-teal-600 border border-teal-500/50 text-white hover:bg-teal-500 transition-colors disabled:opacity-40"
        >
          Create Checkpoint
        </button>
      </div>

      {/* Loading overlay */}
      {isActioning && (
        <div className="absolute inset-0 bg-vibe-bg/50 flex items-center justify-center z-10">
          <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )}
    </div>
  )
}
