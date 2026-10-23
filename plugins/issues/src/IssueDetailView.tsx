import { useState, useRef } from 'react'
import { Markdown, MarkdownEditor } from '@quadflow/ui'
import { Issue, IssueLabel, IssueComment, IssueStatus, StatusHistoryEntry, CommentAuthor, priorityConfig, statusConfig } from './types'
import { Overlay } from './Overlay'
import { reportError, useModel, useFormatRef, isAgentStale } from './model'
import { findIssueByRef } from './convert'
import LabelBadge from './LabelBadge'
import DependencyGraph, { GraphNode } from './DependencyGraph'

interface IssueDetailViewProps {
  issue: Issue
  labels: IssueLabel[]
  comments: IssueComment[]
  isLoadingComments: boolean
  onBack: () => void
  onEdit: () => void
  onSetStatus: (status: IssueStatus) => void
  onDelete: () => void
  onAddComment: (body: string) => Promise<void>
  onDeleteComment: (id: string) => Promise<void>
  onUpdateIssue?: (updates: Partial<Pick<Issue, 'title' | 'body'>>) => Promise<void>
  onNavigateToIssue?: (issueId: string) => void
}

// Actor type icon helper
function ActorIcon({ type }: { type: string }) {
  if (type === 'human') {
    return (
      <svg className="w-3.5 h-3.5 text-blue-400 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    )
  }
  if (type === 'system') {
    return (
      <svg className="w-3.5 h-3.5 text-gray-400 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    )
  }
  // agent / team_agent
  return (
    <svg className="w-3.5 h-3.5 text-teal-400 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}

// Collapsible status history timeline
function StatusHistorySection({ history }: { history: StatusHistoryEntry[] }) {
  const [expanded, setExpanded] = useState(false)

  const formatRelative = (ts: number) => {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Date(ts).toLocaleDateString()
  }

  return (
    <div className="px-4 pb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-vibe-muted hover:text-vibe-text transition-colors w-full py-1"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium uppercase tracking-wide">Status History</span>
        <span className="text-vibe-muted">({history.length} transitions)</span>
      </button>
      {expanded && (
        <div className="mt-2 ml-1 border-l border-vibe-border pl-3 space-y-2">
          {[...history].reverse().map((entry, i) => {
            const statusInfo = statusConfig[entry.status as IssueStatus] || { label: entry.status, color: 'text-gray-400', bgColor: 'bg-gray-500/20' }
            return (
              <div key={i} className="flex items-start gap-2 text-xs">
                <div className="flex-shrink-0 mt-0.5">
                  <span className={`px-1.5 py-0.5 rounded ${statusInfo.color} ${statusInfo.bgColor} font-medium`}>
                    {statusInfo.label}
                  </span>
                </div>
                <div className="flex-1 text-vibe-muted">
                  {entry.from && (
                    <span>from <span className="text-vibe-text">{entry.from}</span> </span>
                  )}
                  <span>by </span>
                  <ActorIcon type={entry.byType} />{' '}
                  <span className="text-vibe-text">{entry.by}</span>
                  <span className="ml-2 opacity-60">{formatRelative(entry.at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function IssueDetailView({
  issue,
  labels,
  comments,
  isLoadingComments,
  onBack,
  onEdit,
  onSetStatus,
  onDelete,
  onAddComment,
  onDeleteComment,
  onUpdateIssue,
  onNavigateToIssue,
}: IssueDetailViewProps) {
  const [newComment, setNewComment] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isStartingWork, setIsStartingWork] = useState(false)
  const model = useModel()
  const formatRef = useFormatRef()
  const autoCloseChecked = model.ui((s) => s.autoClose)
  const [isResuming, setIsResuming] = useState(false)
  const [isReleasing, setIsReleasing] = useState(false)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)

  // Inline editing state
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [editTitle, setEditTitle] = useState(issue.title)
  const [editBody, setEditBody] = useState(issue.body || '')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const allIssues = model.issues.use((s) => s.items)

  // Compute hierarchy info
  const parentIssue = issue.parentIssueId ? allIssues.find(i => i.id === issue.parentIssueId) : undefined
  const childIssues = allIssues.filter(i => i.parentIssueId === issue.id)
  const findIssueByIdOrDisplay = (ref: string) => findIssueByRef(allIssues, ref)
  const blockerIssues = issue.blockedBy?.map(ref => findIssueByIdOrDisplay(ref)).filter(Boolean) as Issue[] || []
  const dependentIssues = allIssues.filter(i => i.blockedBy?.some(ref => {
    if (ref === issue.id) return true
    const resolved = findIssueByIdOrDisplay(ref)
    return resolved?.id === issue.id
  }))

  // Dependency graph state
  const [showDepGraph, setShowDepGraph] = useState(false)
  const hasDependencies = blockerIssues.length > 0 || dependentIssues.length > 0

  // Build graph nodes for the dependency graph (current issue + 1-level deep blockers/dependents)
  const depGraphNodes: GraphNode[] = (() => {
    if (!hasDependencies) return []
    const issueToNode = (i: Issue): GraphNode => ({
      id: i.id,
      label: i.title,
      sublabel: i.displayNumber ? formatRef(i.displayNumber) : undefined,
      status: i.status,
      statusColor: statusConfig[i.status]?.bgColor || 'bg-gray-500',
      dependsOn: i.blockedBy || [],
    })
    const seen = new Set<string>()
    const result: GraphNode[] = []
    const addIssue = (i: Issue) => {
      if (seen.has(i.id)) return
      seen.add(i.id)
      result.push(issueToNode(i))
    }
    addIssue(issue)
    blockerIssues.forEach(addIssue)
    dependentIssues.forEach(addIssue)
    return result
  })()

  const handleWorkOnIssue = async () => {
    setIsStartingWork(true)
    try {
      await model.workOn(issue, { autoClose: autoCloseChecked })
    } finally {
      setIsStartingWork(false)
    }
  }

  const stale = isAgentStale(issue)

  const handleResumeAgent = async () => {
    setIsResuming(true)
    try {
      await model.resume(issue)
    } catch (e) {
      reportError(model.ctx, 'Could not resume the agent', e)
    } finally {
      setIsResuming(false)
    }
  }

  const handleReleaseAgent = async () => {
    setIsReleasing(true)
    try {
      await model.release(issue.id)
    } catch (e) {
      reportError(model.ctx, 'Could not release the issue', e)
    } finally {
      setIsReleasing(false)
    }
  }

  const priorityInfo = priorityConfig[issue.priority] ?? { label: issue.priority || '?', color: 'text-gray-400' }
  const statusInfo = statusConfig[issue.status] ?? { label: issue.status || '?', color: 'text-gray-400', bgColor: 'bg-gray-500/20' }
  const [showNeedsHumanModal, setShowNeedsHumanModal] = useState(false)
  const [needsHumanNote, setNeedsHumanNote] = useState('')
  const toggleAcceptanceCriteria = (id: string, ids: string[], checked: boolean) =>
    model.toggleCriteria(id, ids, checked).catch((e) => reportError(model.ctx, 'Could not update the criterion', e))

  const statusOptions: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'qa', 'done', 'blocked', 'needs_human']
  const issueLabels = issue.labels
    .map((name) => labels.find((l) => l.name === name))
    .filter((l): l is IssueLabel => l !== undefined)

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatRelativeDate = (timestamp: number) => {
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

  const handleSubmitComment = async () => {
    if (!newComment.trim()) return

    setIsSubmitting(true)
    try {
      await onAddComment(newComment.trim())
      setNewComment('')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmitComment()
    }
  }

  const handleDelete = async () => {
    onDelete()
    setShowDeleteConfirm(false)
  }

  // Inline editing handlers
  const startEditingTitle = () => {
    if (!onUpdateIssue) return
    setEditTitle(issue.title)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const saveTitle = async () => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== issue.title && onUpdateIssue) {
      await onUpdateIssue({ title: trimmed })
    }
    setEditingTitle(false)
  }

  const startEditingBody = () => {
    if (!onUpdateIssue) return
    setEditBody(issue.body || '')
    setEditingBody(true)
  }

  const saveBody = async () => {
    const trimmed = editBody.trim()
    if (onUpdateIssue && trimmed !== (issue.body || '')) {
      await onUpdateIssue({ body: trimmed || undefined })
    }
    setEditingBody(false)
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              aria-label="Back to issue list"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-vibe-muted text-sm">Back to list</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onEdit}
              className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text border border-vibe-border rounded-lg hover:border-vibe-border-bright transition-colors"
              aria-label="Edit issue in form"
            >
              Edit
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="p-1.5 text-vibe-muted hover:text-red-400 transition-colors"
              aria-label="Delete issue"
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
        {/* Issue header */}
        <div className="p-4 border-b border-vibe-border">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              {/* Display ID */}
              {issue.displayNumber && (
                <span
                  className="text-xs font-mono text-vibe-muted mb-1 inline-block hover:text-teal-400 cursor-pointer transition-colors"
                  title="Click to copy"
                  onClick={(e) => {
                    e.stopPropagation()
                    model.copy(formatRef(issue.displayNumber))
                    const el = e.currentTarget
                    const original = el.textContent
                    el.textContent = 'Copied!'
                    setTimeout(() => { el.textContent = original }, 1500)
                  }}
                >{formatRef(issue.displayNumber)}</span>
              )}
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
                  className="w-full text-lg font-semibold bg-vibe-bg-lighter border border-teal-500 rounded px-2 py-1 focus:outline-none"
                />
              ) : (
                <h1
                  onClick={onUpdateIssue ? startEditingTitle : undefined}
                  className={`text-lg font-semibold ${issue.status === 'done' ? 'text-vibe-muted line-through' : ''} ${onUpdateIssue ? 'cursor-text hover:bg-vibe-bg-lighter/50 rounded px-2 py-1 -mx-2 -my-1 transition-colors' : ''}`}
                  title={onUpdateIssue ? 'Click to edit title' : undefined}
                >
                  {issue.title}
                </h1>
              )}

              {/* Meta row */}
              <div className="flex items-center gap-3 mt-2 text-sm">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusInfo.color} ${statusInfo.bgColor}`}>
                  {statusInfo.label}
                </span>
                <span className="text-vibe-muted">·</span>
                <span className={`font-medium ${priorityInfo.color}`}>
                  {priorityInfo.label} priority
                </span>
                <span className="text-vibe-muted">·</span>
                <span className="text-vibe-muted">
                  {formatDate(issue.createdAt)}
                  {issue.createdBy && (
                    <span className="ml-1">
                      by <span className="text-vibe-text">{issue.createdBy}</span>
                    </span>
                  )}
                </span>
                {issue.statusHistory.length > 1 && (
                  <>
                    <span className="text-vibe-muted">·</span>
                    <span className="text-vibe-muted text-xs">
                      Last changed by{' '}
                      <span className="text-vibe-text">
                        {issue.statusHistory[issue.statusHistory.length - 1].byType === 'system' ? '⚙ system' : issue.statusHistory[issue.statusHistory.length - 1].by}
                      </span>
                    </span>
                  </>
                )}
                {issue.syncStatus === 'synced' && issue.githubUrl && (
                  <>
                    <span className="text-vibe-muted">·</span>
                    <a
                      href={issue.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-green-400 hover:underline"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                      </svg>
                      #{issue.githubNumber}
                    </a>
                  </>
                )}
              </div>

              {/* Labels */}
              {issueLabels.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {issueLabels.map((label) => (
                    <LabelBadge key={label.id} name={label.name} color={label.color} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Status selector */}
          <div className="mt-4">
            <label className="block text-xs text-vibe-muted mb-2">Change Status</label>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map((s) => {
                const info = statusConfig[s]
                return (
                  <button
                    key={s}
                    onClick={() => {
                      if (s === 'needs_human' && issue.status !== 'needs_human') {
                        setShowNeedsHumanModal(true)
                      } else {
                        onSetStatus(s)
                      }
                    }}
                    className={`
                      px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors
                      ${issue.status === s
                        ? `border-current ${info.color} ${info.bgColor}`
                        : 'border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-border-bright'
                      }
                    `}
                    aria-label={`Set status to ${info.label}`}
                    aria-pressed={issue.status === s}
                  >
                    {info.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Hierarchy & Dependencies */}
          {(parentIssue || childIssues.length > 0 || blockerIssues.length > 0 || dependentIssues.length > 0) && (
            <div className="mt-4 space-y-3">
              {/* Parent epic */}
              {parentIssue && (
                <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
                  <div className="text-xs text-indigo-400 font-medium mb-1">Parent Epic</div>
                  <button
                    onClick={() => onBack()}
                    className="text-sm text-vibe-text hover:text-indigo-300 transition-colors"
                  >
                    {parentIssue.displayNumber && <span className="text-xs font-mono text-vibe-muted mr-1">{formatRef(parentIssue.displayNumber)}</span>}
                    {parentIssue.title}
                  </button>
                </div>
              )}

              {/* Child issues (this is an epic) */}
              {childIssues.length > 0 && (
                <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3">
                  <div className="text-xs text-indigo-400 font-medium mb-2">Sub-Issues ({childIssues.length})</div>
                  <div className="space-y-1">
                    {childIssues.map(child => (
                      <button
                        key={child.id}
                        onClick={() => onNavigateToIssue?.(child.id)}
                        className="flex items-center gap-2 text-sm w-full text-left hover:bg-vibe-bg-lighter/50 rounded px-1 -mx-1 py-0.5 transition-colors"
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig[child.status]?.bgColor || 'bg-gray-500/20'}`} />
                        <span className="text-xs font-mono text-vibe-muted">{formatRef(child.displayNumber)}</span>
                        <span className={`truncate ${child.status === 'done' ? 'text-vibe-muted line-through' : ''}`}>{child.title}</span>
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 text-xs text-vibe-muted">
                    {childIssues.filter(c => c.status === 'done').length}/{childIssues.length} completed
                  </div>
                </div>
              )}

              {/* Blockers */}
              {blockerIssues.length > 0 && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                  <div className="text-xs text-red-400 font-medium mb-2">Blocked By</div>
                  <div className="space-y-1">
                    {blockerIssues.map(blocker => (
                      <button
                        key={blocker.id}
                        onClick={() => onNavigateToIssue?.(blocker.id)}
                        className="flex items-center gap-2 text-sm w-full text-left hover:bg-vibe-bg-lighter/50 rounded px-1 -mx-1 py-0.5 transition-colors"
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${blocker.status === 'done' || blocker.status === 'qa' ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-xs font-mono text-vibe-muted">{formatRef(blocker.displayNumber)}</span>
                        <span className={`truncate ${blocker.status === 'done' || blocker.status === 'qa' ? 'text-vibe-muted line-through' : ''}`}>{blocker.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Issues this blocks */}
              {dependentIssues.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <div className="text-xs text-amber-400 font-medium mb-2">Blocks ({dependentIssues.length} issue{dependentIssues.length > 1 ? 's' : ''})</div>
                  <div className="space-y-1">
                    {dependentIssues.map(dep => (
                      <button
                        key={dep.id}
                        onClick={() => onNavigateToIssue?.(dep.id)}
                        className="flex items-center gap-2 text-sm w-full text-left hover:bg-vibe-bg-lighter/50 rounded px-1 -mx-1 py-0.5 transition-colors"
                      >
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig[dep.status]?.bgColor || 'bg-gray-500/20'}`} />
                        <span className="text-xs font-mono text-vibe-muted">{formatRef(dep.displayNumber)}</span>
                        <span className="truncate">{dep.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dependency Graph (collapsible) */}
              {hasDependencies && (
                <div className="rounded-lg border border-vibe-border bg-vibe-bg-lighter">
                  <button
                    onClick={() => setShowDepGraph(!showDepGraph)}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-vibe-muted hover:text-vibe-text transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Dependency Graph
                    </span>
                    <svg className={`w-3.5 h-3.5 transition-transform ${showDepGraph ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showDepGraph && (
                    <div className="px-3 pb-3">
                      <DependencyGraph nodes={depGraphNodes} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Agent Assignment section */}
          {issue.assignedTerminalId && (
            <div className="mt-4">
              <div className={`rounded-lg border p-3 ${stale ? 'border-orange-500/30 bg-orange-500/5' : 'border-green-500/30 bg-green-500/5'}`}>
                <div className="flex items-center gap-2 mb-2">
                  <svg className={`w-4 h-4 ${stale ? 'text-orange-400' : 'text-green-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <span className="text-sm font-medium">Agent Assignment</span>
                  <span className={`ml-auto px-2 py-0.5 rounded text-xs font-medium ${stale ? 'text-orange-400 bg-orange-500/20' : 'text-green-400 bg-green-500/20'}`}>
                    {stale ? 'Stale' : 'Active'}
                  </span>
                </div>
                <div className="space-y-1 text-xs text-vibe-muted">
                  <div className="flex justify-between">
                    <span>Agent</span>
                    <span className="text-vibe-text">{issue.assignedAgentLabel}</span>
                  </div>
                  {issue.assignedAt && (
                    <div className="flex justify-between">
                      <span>Assigned</span>
                      <span>{formatRelativeDate(issue.assignedAt)}</span>
                    </div>
                  )}
                  {issue.lastHeartbeat && (
                    <div className="flex justify-between">
                      <span>Last heartbeat</span>
                      <span>{formatRelativeDate(issue.lastHeartbeat)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>Terminal</span>
                    <span className="font-mono text-[10px]">{issue.assignedTerminalId.slice(0, 8)}...</span>
                  </div>
                </div>
                {stale && (
                  <p className="text-xs text-orange-400 mt-2">
                    Agent may have disconnected (no heartbeat for 5+ minutes)
                  </p>
                )}
                <div className="flex gap-2 mt-3">
                  {stale && issue.agentSessionId && (
                    <button
                      onClick={handleResumeAgent}
                      disabled={isResuming}
                      className="flex-1 px-3 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-600/50 rounded-lg transition-colors text-sm font-medium flex items-center justify-center gap-1.5"
                    >
                      {isResuming ? (
                        <>
                          <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          Resuming...
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Resume Agent
                        </>
                      )}
                    </button>
                  )}
                  <button
                    onClick={handleReleaseAgent}
                    disabled={isReleasing}
                    className={`${stale && issue.agentSessionId ? '' : 'flex-1'} px-3 py-2 border border-vibe-border hover:border-vibe-border-bright rounded-lg transition-colors text-sm text-vibe-muted hover:text-vibe-text flex items-center justify-center gap-1.5`}
                  >
                    {isReleasing ? 'Releasing...' : 'Release'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Work on Issue button */}
          {issue.status !== 'done' && !issue.assignedTerminalId && (
            <div className="mt-4">
              <button
                onClick={handleWorkOnIssue}
                disabled={isStartingWork}
                className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-600/50 rounded-lg transition-colors font-medium text-sm flex items-center justify-center gap-2"
                aria-label="Start working on this issue with an agent"
              >
                {isStartingWork ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Starting agent...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Work on this Issue
                  </>
                )}
              </button>
              <label className="flex items-center justify-center gap-2 mt-2 text-xs text-vibe-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoCloseChecked}
                  onChange={(e) => model.setAutoClose(e.target.checked)}
                  className="rounded border-vibe-border text-vibe-primary focus:ring-vibe-primary w-3.5 h-3.5"
                />
                Auto-close terminal when done
              </label>
            </div>
          )}
        </div>

        {/* User Story */}
        {issue.userStory && (
          <div className="px-4 pt-4 border-b border-vibe-border pb-4">
            <div className="flex items-center gap-1.5 mb-2">
              <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className="text-xs font-medium text-blue-400 uppercase tracking-wide">User Story</span>
            </div>
            <p className="text-sm text-vibe-text leading-relaxed italic border-l-2 border-blue-500/40 pl-3">
              {issue.userStory}
            </p>
          </div>
        )}

        {/* Acceptance Criteria */}
        {issue.acceptanceCriteria && issue.acceptanceCriteria.length > 0 && (() => {
          const checkedCount = issue.acceptanceCriteria.filter(c => typeof c === 'object' && c.checked).length
          const totalCount = issue.acceptanceCriteria.length
          return (
            <div className="px-4 pt-4 border-b border-vibe-border pb-4">
              <div className="flex items-center gap-1.5 mb-2">
                <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs font-medium text-green-400 uppercase tracking-wide">Acceptance Criteria</span>
                <span className="text-xs text-vibe-muted ml-auto">{checkedCount}/{totalCount} complete</span>
              </div>
              {/* Progress bar */}
              {totalCount > 0 && (
                <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-green-500 rounded-full transition-all duration-300"
                    style={{ width: `${Math.round((checkedCount / totalCount) * 100)}%` }}
                  />
                </div>
              )}
              <ul className="space-y-1.5">
                {issue.acceptanceCriteria.map((criterion) => {
                  const isObj = typeof criterion === 'object' && criterion !== null
                  const text = isObj ? criterion.text : String(criterion)
                  const checked = isObj ? criterion.checked : false
                  const id = isObj ? criterion.id : undefined
                  return (
                    <li key={id || text} className="flex items-start gap-2 text-sm group">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          if (id) {
                            toggleAcceptanceCriteria(issue.id, [id], !checked)
                          }
                        }}
                        className="mt-0.5 w-4 h-4 rounded border-vibe-border bg-vibe-bg text-green-500 focus:ring-green-500 focus:ring-offset-0 flex-shrink-0 cursor-pointer"
                      />
                      <span className={checked ? 'line-through text-vibe-muted' : ''}>{text}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })()}

        {/* Body - inline editable with Markdown rendering */}
        <div className="p-4 border-b border-vibe-border">
          {editingBody ? (
            <div
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void saveBody() }
                if (e.key === 'Escape') { e.stopPropagation(); setEditingBody(false) }
              }}
            >
              <MarkdownEditor value={editBody} onChange={setEditBody} rows={10} placeholder="Add a description (Markdown supported)..." />
              <div className="flex items-center justify-end gap-2 mt-2">
                <span className="text-xs text-vibe-muted mr-auto">Ctrl+Enter to save · Esc to cancel</span>
                <button onClick={() => setEditingBody(false)} className="px-3 py-1 text-xs text-vibe-muted hover:text-vibe-text">Cancel</button>
                <button onClick={() => void saveBody()} className="px-3 py-1 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded">Save</button>
              </div>
            </div>
          ) : issue.body ? (
            <div
              onClick={onUpdateIssue ? startEditingBody : undefined}
              className={`max-w-none ${onUpdateIssue ? 'cursor-text hover:bg-vibe-bg-lighter/50 rounded px-3 py-2 -mx-3 -my-2 transition-colors' : ''}`}
              title={onUpdateIssue ? 'Click to edit description' : undefined}
            >
              <Markdown>{issue.body}</Markdown>
            </div>
          ) : onUpdateIssue ? (
            <button
              onClick={startEditingBody}
              className="w-full text-left text-sm text-vibe-muted hover:text-vibe-text py-2 px-3 rounded hover:bg-vibe-bg-lighter/50 transition-colors"
            >
              Click to add a description...
            </button>
          ) : null}
        </div>

        {/* Status History section */}
        {issue.statusHistory && issue.statusHistory.length > 1 && (
          <StatusHistorySection history={issue.statusHistory} />
        )}

        {/* Comments section */}
        <div className="p-4">
          <h2 className="text-sm font-medium text-vibe-muted mb-3">
            Comments ({comments.length})
          </h2>

          {isLoadingComments ? (
            <div className="flex justify-center py-4">
              <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-sm text-vibe-muted text-center py-4">No comments yet</p>
          ) : (
            <div className="space-y-3">
              {comments.map((comment) => (
                <div
                  key={comment.id}
                  className="group bg-vibe-bg-lighter border border-vibe-border rounded-lg p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="max-w-none flex-1">
                      <Markdown>{comment.body}</Markdown>
                    </div>
                    <button
                      onClick={() => onDeleteComment(comment.id)}
                      className="flex-shrink-0 p-1 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                      aria-label="Delete comment"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-2 text-xs text-vibe-muted">
                    {/* Author attribution */}
                    {(() => {
                      const author: CommentAuthor = comment.author
                      const iconColor = author.type === 'human' ? 'text-blue-400' : author.type === 'plugin' ? 'text-teal-400' : 'text-purple-400'
                      return (
                        <span className={`flex items-center gap-1 ${iconColor}`}>
                          {author.type === 'human' ? (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                          ) : author.type === 'plugin' ? (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                          )}
                          {author.name}
                        </span>
                      )
                    })()}
                    <span>·</span>
                    <span>{formatRelativeDate(comment.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add comment */}
          <div className="mt-4">
            <textarea
              ref={commentInputRef}
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a comment (Markdown supported)..."
              rows={3}
              aria-label="New comment"
              className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted resize-none focus:outline-none focus:border-teal-500"
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-vibe-muted">Ctrl+Enter to submit</span>
              <button
                onClick={handleSubmitComment}
                disabled={!newComment.trim() || isSubmitting}
                className="px-4 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors"
              >
                {isSubmitting ? 'Adding...' : 'Add Comment'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Needs Human note modal */}
      <Overlay open={showNeedsHumanModal} onClose={() => setShowNeedsHumanModal(false)} id="issuedetailview-needs-human-modal" size="sm">
          <div role="dialog" aria-labelledby="needs-human-dialog-title">
            <h3 id="needs-human-dialog-title" className="font-medium mb-2 text-orange-400">Needs Human Intervention</h3>
            <p className="text-sm text-vibe-muted mb-3">
              Please describe why this issue needs human attention:
            </p>
            <textarea
              value={needsHumanNote}
              onChange={(e) => setNeedsHumanNote(e.target.value)}
              placeholder="Explain what's needed..."
              rows={3}
              className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted resize-none focus:outline-none focus:border-orange-500"
              autoFocus
            />
            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => { setShowNeedsHumanModal(false); setNeedsHumanNote('') }}
                className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (needsHumanNote.trim()) {
                    onSetStatus('needs_human')
                    await onAddComment(`**Needs Human Intervention:** ${needsHumanNote.trim()}`)
                    setShowNeedsHumanModal(false)
                    setNeedsHumanNote('')
                  }
                }}
                disabled={!needsHumanNote.trim()}
                className="px-3 py-1.5 text-sm bg-orange-600 hover:bg-orange-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg"
              >
                Set Status
              </button>
            </div>
          </div>
      </Overlay>

      {/* Delete confirmation modal */}
      <Overlay open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} id="issuedetailview-delete-confirm" size="sm">
          <div role="dialog" aria-labelledby="delete-dialog-title">
            <h3 id="delete-dialog-title" className="font-medium mb-2">Delete issue?</h3>
            <p className="text-sm text-vibe-muted mb-4">
              This will permanently delete this issue and all its comments. This action cannot be undone.
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
    </div>
  )
}
