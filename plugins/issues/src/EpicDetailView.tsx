import { useState, useMemo, useRef } from 'react'
import { Markdown } from '@quadflow/ui'
import { EpicStatus, Issue, IssueStatus, priorityConfig, statusConfig } from './types'
import { reportError, useModel, useFormatRef } from './model'
import { Overlay } from './Overlay'

interface EpicDetailViewProps {
  epicId: string
  onBack: () => void
  onEditEpic: (id: string) => void
  onSelectIssue: (id: string) => void
  onCreateIssue: (epicId: string) => void
}

const epicStatusConfig: Record<EpicStatus, { label: string; color: string; bgColor: string }> = {
  open: { label: 'Open', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  done: { label: 'Done', color: 'text-green-400', bgColor: 'bg-green-500/20' },
}

const epicStatusOptions: EpicStatus[] = ['open', 'in_progress', 'done']

// Group display order for issues
const issueStatusGroups: { status: IssueStatus; label: string }[] = [
  { status: 'in_progress', label: 'In Progress' },
  { status: 'todo', label: 'To Do' },
  { status: 'backlog', label: 'Backlog' },
  { status: 'qa', label: 'QA' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'needs_human', label: 'Needs Human' },
  { status: 'done', label: 'Done' },
]

export default function EpicDetailView({
  epicId,
  onBack,
  onEditEpic,
  onSelectIssue,
  onCreateIssue,
}: EpicDetailViewProps) {
  const model = useModel()
  const issues = model.issues.use((s) => s.items)
  const currentEpic = model.epics.use((s) => s.items.find((e) => e.id === epicId) ?? null)
  const epicsLoading = model.epics.use((s) => s.loading)
  /** Mutations report failures as toasts. */
  const guard = (title: string, fn: () => Promise<unknown>) => fn().then(() => true, (e) => (reportError(model.ctx, title, e), false))
  const updateEpic = (id: string, u: Parameters<typeof model.updateEpic>[1]) => guard('Could not save the epic', () => model.updateEpic(id, u))

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showLinkModal, setShowLinkModal] = useState(false)
  const [linkSearch, setLinkSearch] = useState('')

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Issues linked to this epic
  const epicIssues = useMemo(() => {
    return issues.filter((i) => i.epicId === epicId)
  }, [issues, epicId])

  // Progress computation
  const progress = useMemo(() => {
    const total = epicIssues.length
    const done = epicIssues.filter((i) => i.status === 'done').length
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return { total, done, pct }
  }, [epicIssues])

  // Issues grouped by status
  const groupedIssues = useMemo(() => {
    const groups: { status: IssueStatus; label: string; items: Issue[] }[] = []
    for (const group of issueStatusGroups) {
      const items = epicIssues.filter((i) => i.status === group.status)
      if (items.length > 0) {
        groups.push({ ...group, items })
      }
    }
    return groups
  }, [epicIssues])

  // Blocking relationships among child issues
  const blockingPairs = useMemo(() => {
    const epicIssueIds = new Set(epicIssues.map((i) => i.id))
    const pairs: { blocker: Issue; blocked: Issue }[] = []
    for (const issue of epicIssues) {
      if (issue.blockedBy) {
        for (const blockerId of issue.blockedBy) {
          if (epicIssueIds.has(blockerId)) {
            const blocker = epicIssues.find((i) => i.id === blockerId)
            if (blocker) {
              pairs.push({ blocker, blocked: issue })
            }
          }
        }
      }
    }
    return pairs
  }, [epicIssues])

  // Unlinked issues for the link modal
  const unlinkedIssues = useMemo(() => {
    return issues.filter((i) => {
      if (i.epicId === epicId) return false
      if (!linkSearch) return true
      return i.title.toLowerCase().includes(linkSearch.toLowerCase())
    })
  }, [issues, epicId, linkSearch])

  const handleStatusChange = async (status: EpicStatus) => {
    await updateEpic(epicId, { status })
  }

  const handleDelete = async () => {
    const ok = await guard('Could not delete the epic', () => model.deleteEpic(epicId))
    setShowDeleteConfirm(false)
    if (ok) onBack()
  }

  const handleLinkIssue = async (issueId: string) => {
    await guard('Could not link the issue', () => model.updateIssue(issueId, { epicId }))
    setShowLinkModal(false)
    setLinkSearch('')
  }

  // Inline title editing handlers
  const startEditingTitle = () => {
    if (!currentEpic) return
    setEditTitle(currentEpic.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const saveTitle = async () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== currentEpic?.title) {
      await updateEpic(epicId, { title: trimmed })
    }
    setEditingTitle(false)
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatRef = useFormatRef()

  if (!currentEpic) {
    if (!epicsLoading) {
      return (
        <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-vibe-bg text-sm text-vibe-muted">
          <span>This epic no longer exists.</span>
          <button onClick={onBack} className="px-3 py-1.5 text-xs border border-vibe-border rounded hover:text-vibe-text">Back to epics</button>
        </div>
      )
    }
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted">
        <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const statusInfo = epicStatusConfig[currentEpic.status]
  const prioInfo = priorityConfig[currentEpic.priority] ?? { label: currentEpic.priority || '?', color: 'text-gray-400' }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              aria-label="Back to epic list"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-vibe-muted text-sm">Back to epics</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onEditEpic(epicId)}
              className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text border border-vibe-border rounded-lg hover:border-vibe-border-bright transition-colors"
              aria-label="Edit epic in form"
            >
              Edit
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="p-1.5 text-vibe-muted hover:text-red-400 transition-colors"
              aria-label="Delete epic"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Epic header */}
        <div className="p-4 border-b border-vibe-border">
          {/* Inline-editable title */}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className="w-full text-lg font-semibold bg-vibe-bg-lighter border border-indigo-500 rounded px-2 py-1 focus:outline-none"
            />
          ) : (
            <h1
              onClick={startEditingTitle}
              className={`text-lg font-semibold cursor-text hover:bg-vibe-bg-lighter/50 rounded px-2 py-1 -mx-2 -my-1 transition-colors ${currentEpic.status === 'done' ? 'text-vibe-muted line-through' : ''}`}
              title="Click to edit title"
            >
              {currentEpic.title}
            </h1>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-3 mt-2 text-sm">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusInfo.color} ${statusInfo.bgColor}`}>
              {statusInfo.label}
            </span>
            <span className="text-vibe-muted">·</span>
            <span className={`font-medium ${prioInfo.color}`}>{prioInfo.label} priority</span>
            <span className="text-vibe-muted">·</span>
            <span className="text-vibe-muted">{formatDate(currentEpic.createdAt)}</span>
          </div>

          {/* Labels */}
          {currentEpic.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {currentEpic.labels.map((label) => (
                <span
                  key={label}
                  className="px-2 py-0.5 rounded-full bg-white/10 text-vibe-muted text-xs"
                >
                  {label}
                </span>
              ))}
            </div>
          )}

          {/* Status selector */}
          <div className="mt-4">
            <label className="block text-xs text-vibe-muted mb-2">Change Status</label>
            <div className="flex flex-wrap gap-2">
              {epicStatusOptions.map((s) => {
                const info = epicStatusConfig[s]
                return (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    className={`
                      px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                      ${currentEpic.status === s
                        ? `border-current ${info.color} ${info.bgColor}`
                        : 'border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-border-bright'
                      }
                    `}
                    aria-label={`Set status to ${info.label}`}
                    aria-pressed={currentEpic.status === s}
                  >
                    {info.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Description */}
        <div className="p-4 border-b border-vibe-border">
          {currentEpic.description ? (
            <div className="prose prose-sm prose-invert max-w-none">
              <Markdown>{currentEpic.description}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-vibe-muted italic">No description</p>
          )}
        </div>

        {/* Progress section */}
        <div className="p-4 border-b border-vibe-border">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <span className="text-sm font-medium">Progress</span>
          </div>
          {progress.total > 0 ? (
            <>
              <div className="flex items-center justify-between text-xs text-vibe-muted mb-1.5">
                <span>{progress.done} of {progress.total} issues completed</span>
                <span className="font-medium">{progress.pct}%</span>
              </div>
              <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-300"
                  style={{ width: `${progress.pct}%` }}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-vibe-muted">No issues linked to this epic yet</p>
          )}
        </div>

        {/* Issues list grouped by status */}
        <div className="p-4 border-b border-vibe-border">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <span className="text-sm font-medium">Issues ({epicIssues.length})</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowLinkModal(true)}
                className="px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text border border-vibe-border rounded-lg hover:border-vibe-border-bright transition-colors"
              >
                Link Issue
              </button>
              <button
                onClick={() => onCreateIssue(epicId)}
                className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
              >
                Add Issue
              </button>
            </div>
          </div>

          {groupedIssues.length === 0 ? (
            <p className="text-sm text-vibe-muted text-center py-4">No issues linked to this epic</p>
          ) : (
            <div className="space-y-4">
              {groupedIssues.map((group) => (
                <div key={group.status}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`w-2 h-2 rounded-full ${(statusConfig[group.status] ?? { bgColor: 'bg-gray-500/20' }).bgColor}`} />
                    <span className={`text-xs font-medium ${(statusConfig[group.status] ?? { color: 'text-gray-400' }).color}`}>
                      {group.label}
                    </span>
                    <span className="text-xs text-vibe-muted">({group.items.length})</span>
                  </div>
                  <div className="space-y-1 ml-4">
                    {group.items.map((issue) => (
                      <button
                        key={issue.id}
                        onClick={() => onSelectIssue(issue.id)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vibe-bg-lighter transition-colors group"
                      >
                        {issue.displayNumber && (
                          <span className="text-[10px] font-mono text-vibe-muted flex-shrink-0">
                            {formatRef(issue.displayNumber)}
                          </span>
                        )}
                        <span className={`text-sm flex-1 truncate ${issue.status === 'done' ? 'text-vibe-muted line-through' : ''}`}>
                          {issue.title}
                        </span>
                        <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${(priorityConfig[issue.priority] ?? { color: 'text-gray-400' }).color}`}>
                          {(priorityConfig[issue.priority] ?? { label: '?' }).label}
                        </span>
                        <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${(statusConfig[issue.status] ?? { color: 'text-gray-400', bgColor: 'bg-gray-500/20' }).color} ${(statusConfig[issue.status] ?? { bgColor: 'bg-gray-500/20' }).bgColor}`}>
                          {(statusConfig[issue.status] ?? { label: '?' }).label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Blocking relationships */}
        {blockingPairs.length > 0 && (
          <div className="p-4 border-b border-vibe-border">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-sm font-medium">Blocking Relationships</span>
            </div>
            <div className="space-y-2">
              {blockingPairs.map((pair, i) => (
                <div key={i} className="flex items-center gap-2 text-xs rounded-lg border border-red-500/20 bg-red-500/5 p-2">
                  <button
                    onClick={() => onSelectIssue(pair.blocker.id)}
                    className="text-vibe-text hover:text-red-300 transition-colors truncate"
                  >
                    {pair.blocker.displayNumber && (
                      <span className="font-mono text-vibe-muted mr-1">{formatRef(pair.blocker.displayNumber)}</span>
                    )}
                    {pair.blocker.title}
                  </button>
                  <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                  <span className="text-red-400 text-[10px] flex-shrink-0">blocks</span>
                  <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                  <button
                    onClick={() => onSelectIssue(pair.blocked.id)}
                    className="text-vibe-text hover:text-red-300 transition-colors truncate"
                  >
                    {pair.blocked.displayNumber && (
                      <span className="font-mono text-vibe-muted mr-1">{formatRef(pair.blocked.displayNumber)}</span>
                    )}
                    {pair.blocked.title}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      <Overlay open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} id="epicdetailview-delete-confirm" size="sm">
          <div role="dialog" aria-labelledby="delete-epic-dialog-title">
            <h3 id="delete-epic-dialog-title" className="font-medium mb-2">Delete epic?</h3>
            <p className="text-sm text-vibe-muted mb-4">
              This will permanently delete this epic. Linked issues will be unlinked but not deleted.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 rounded-lg"
              >
                Delete
              </button>
            </div>
          </div>
      </Overlay>

      {/* Link existing issue modal */}
      <Overlay open={showLinkModal} onClose={() => setShowLinkModal(false)} id="epicdetailview-link-modal" size="md">
          <div role="dialog" aria-labelledby="link-issue-dialog-title">
            <h3 id="link-issue-dialog-title" className="font-medium mb-3">Link Existing Issue</h3>
            <input
              type="text"
              value={linkSearch}
              onChange={(e) => setLinkSearch(e.target.value)}
              placeholder="Search issues..."
              className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-indigo-500 mb-3"
              autoFocus
            />
            <div className="max-h-60 overflow-y-auto space-y-1">
              {unlinkedIssues.length === 0 ? (
                <p className="text-sm text-vibe-muted text-center py-4">No unlinked issues found</p>
              ) : (
                unlinkedIssues.slice(0, 30).map((issue) => (
                  <button
                    key={issue.id}
                    onClick={() => handleLinkIssue(issue.id)}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vibe-bg-lighter transition-colors text-sm"
                  >
                    {issue.displayNumber && (
                      <span className="text-[10px] font-mono text-vibe-muted flex-shrink-0">
                        {formatRef(issue.displayNumber)}
                      </span>
                    )}
                    <span className="truncate">{issue.title}</span>
                    <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] ${(statusConfig[issue.status] ?? { color: 'text-gray-400', bgColor: 'bg-gray-500/20' }).color} ${(statusConfig[issue.status] ?? { bgColor: 'bg-gray-500/20' }).bgColor}`}>
                      {(statusConfig[issue.status] ?? { label: '?' }).label}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="flex justify-end mt-3">
              <button
                onClick={() => { setShowLinkModal(false); setLinkSearch('') }}
                className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text"
              >
                Cancel
              </button>
            </div>
          </div>
      </Overlay>
    </div>
  )
}
