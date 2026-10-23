import { useCallback, useEffect, useMemo, useState } from 'react'
import { KanbanBoard as Board, Menu, type KanbanColumn, type MenuItem } from '@quadflow/ui'
import { Issue, IssueLabel, IssueStatus, IssuePriority, statusConfig, priorityConfig } from './types'
import { hasUnresolvedBlockers, isAgentStale, reportError, useFormatRef, useModel } from './model'
import LabelBadge from './LabelBadge'

const priorityRank: Record<IssuePriority, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const statusOrder: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'qa', 'done', 'blocked', 'needs_human']
/** Column dot colors (the old board's `text-*-400` → hex). */
const statusDot: Record<IssueStatus, string> = {
  backlog: '#9ca3af',
  todo: '#60a5fa',
  in_progress: '#facc15',
  qa: '#c084fc',
  done: '#4ade80',
  blocked: '#f87171',
  needs_human: '#fb923c',
}

function formatRelativeDate(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return new Date(timestamp).toLocaleDateString()
}

function UndoToast({ message, onUndo, onDismiss }: { message: string; onUndo: () => void; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl text-sm">
      <span className="text-vibe-text">{message}</span>
      <button onClick={onUndo} className="px-2 py-0.5 text-teal-400 hover:text-teal-300 font-medium text-xs border border-teal-500/30 rounded hover:bg-teal-500/10 transition-colors">
        Undo
      </button>
      <button onClick={onDismiss} aria-label="Dismiss" className="text-vibe-muted hover:text-vibe-text p-0.5">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

interface KanbanCardProps {
  issue: Issue
  labels: IssueLabel[]
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent, issue: Issue) => void
}

function KanbanCard({ issue, labels, onClick, onContextMenu }: KanbanCardProps) {
  const model = useModel()
  const formatRef = useFormatRef()
  const [copied, setCopied] = useState(false)
  const priorityInfo = priorityConfig[issue.priority] ?? { label: issue.priority || '?', color: 'text-gray-400' }
  const issueLabels = issue.labels.map((name) => labels.find((l) => l.name === name)).filter((l): l is IssueLabel => l !== undefined)
  const ref = formatRef(issue.displayNumber)

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, issue) } : undefined}
      data-issue-id={issue.id}
      className={`group bg-vibe-bg border border-vibe-border rounded-lg p-2.5 hover:border-vibe-border-bright transition-colors cursor-grab ${issue.status === 'done' ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-2 mb-1">
        <h4 className={`flex-1 text-sm font-medium leading-tight ${issue.status === 'done' ? 'line-through text-vibe-muted' : ''}`}>
          <span
            className="text-xs font-mono text-vibe-muted mr-1 hover:text-teal-400 cursor-pointer transition-colors"
            title="Click to copy"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              model.copy(ref)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied!' : ref}
          </span>
          {issue.title}
        </h4>
        <span className={`flex-shrink-0 text-xs ${priorityInfo.color}`}>{priorityInfo.label[0]}</span>
      </div>

      {issue.body && <p className="text-xs text-vibe-muted leading-snug mb-1.5 line-clamp-1">{issue.body}</p>}

      {issueLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {issueLabels.slice(0, 3).map((label) => (
            <LabelBadge key={label.id} name={label.name} color={label.color} size="sm" />
          ))}
          {issueLabels.length > 3 && <span className="text-xs text-vibe-muted">+{issueLabels.length - 3}</span>}
        </div>
      )}

      {issue.assignedAgentLabel && (() => {
        const stale = isAgentStale(issue)
        return (
          <div
            className={`flex items-center gap-1 mt-1.5 pt-1.5 border-t border-vibe-border/50 text-[10px] ${stale ? 'text-orange-400' : 'text-green-400'}`}
            title={`Assigned ${issue.assignedAt ? formatRelativeDate(issue.assignedAt) : ''}, last heartbeat ${issue.lastHeartbeat ? formatRelativeDate(issue.lastHeartbeat) : 'never'}${stale ? '\nAgent may be inactive' : ''}`}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span className="truncate">{issue.assignedAgentLabel}</span>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${stale ? 'bg-orange-400' : 'bg-green-400'}`} />
          </div>
        )
      })()}

      {/* Footer: timestamp + native drag handle for dropping onto a terminal */}
      <div className="flex items-center justify-between text-[10px] text-vibe-muted">
        <span>{formatRelativeDate(issue.updatedAt)}</span>
        <span
          draggable
          title="Drag onto a terminal to work on this issue"
          onPointerDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.stopPropagation()
            // Read by the shell's TerminalView (types `/issue-to-prompt <ref>`).
            e.dataTransfer.setData('application/quadflow-issue', JSON.stringify({ id: issue.id, title: issue.title, ref }))
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-purple-500/20 text-purple-400"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </span>
      </div>
    </div>
  )
}

interface KanbanBoardProps {
  issues: Issue[]
  labels: IssueLabel[]
  onStatusChange: (issueId: string, status: IssueStatus) => void
  onIssueClick: (issue: Issue) => void
}

/**
 * Status columns (`@quadflow/ui` `KanbanBoard`); dropping a card in another
 * column changes its status. Columns are ordered by priority, then number, so
 * only cross-column moves change data.
 */
export default function KanbanBoard({ issues, labels, onStatusChange, onIssueClick }: KanbanBoardProps) {
  const model = useModel()
  const formatRef = useFormatRef()
  const autoClose = model.ui((s) => s.autoClose)
  const [isLaunchingAll, setIsLaunchingAll] = useState(false)
  const [launchProgress, setLaunchProgress] = useState({ current: 0, total: 0 })
  const [undoAction, setUndoAction] = useState<{ message: string; issueId: string; previousStatus: IssueStatus } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ issue: Issue; x: number; y: number } | null>(null)

  const columns: KanbanColumn[] = useMemo(
    () => statusOrder.map((s) => ({ id: s, title: statusConfig[s]?.label ?? s, color: statusDot[s] })),
    [],
  )
  const sorted = useMemo(
    () => [...issues].sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.displayNumber - b.displayNumber),
    [issues],
  )

  const handleDismissUndo = useCallback(() => setUndoAction(null), [])
  const handleUndo = useCallback(() => {
    if (undoAction) {
      onStatusChange(undoAction.issueId, undoAction.previousStatus)
      setUndoAction(null)
    }
  }, [undoAction, onStatusChange])

  const handleMove = (issueId: string, toColumn: string) => {
    const issue = issues.find((i) => i.id === issueId)
    const target = toColumn as IssueStatus
    if (!issue || issue.status === target) return
    setUndoAction({ message: `Moved to ${statusConfig[target]?.label ?? target}`, issueId, previousStatus: issue.status })
    onStatusChange(issueId, target)
  }

  // Startable: todo, no unresolved blockers, not assigned to an agent.
  const startableIssues = issues.filter((i) => i.status === 'todo' && !i.assignedTerminalId && !hasUnresolvedBlockers(i, issues))

  const handleStartAllUnblocked = async () => {
    if (startableIssues.length === 0) return
    setIsLaunchingAll(true)
    setLaunchProgress({ current: 0, total: startableIssues.length })
    for (let i = 0; i < startableIssues.length; i++) {
      setLaunchProgress({ current: i + 1, total: startableIssues.length })
      await model.workOn(startableIssues[i], { autoClose })
      // Small delay between launches to avoid overwhelming the system
      if (i < startableIssues.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    setIsLaunchingAll(false)
    setLaunchProgress({ current: 0, total: 0 })
  }

  const menuItems = (issue: Issue): MenuItem[] => [
    ...(!issue.assignedTerminalId
      ? ([
          { id: 'work', label: 'Work on Issue', onSelect: () => void model.workOn(issue, { autoClose }) },
          { id: 'auto-close', label: 'Auto-close terminal when done', checked: autoClose, onSelect: () => model.setAutoClose(!autoClose) },
          { type: 'separator' },
        ] as MenuItem[])
      : []),
    { type: 'label', label: 'Priority' },
    ...(['low', 'medium', 'high', 'critical'] as IssuePriority[]).map(
      (p): MenuItem => ({
        id: `priority-${p}`,
        label: <span className={priorityConfig[p].color}>{priorityConfig[p].label}</span>,
        checked: issue.priority === p,
        onSelect: () => void model.updateIssue(issue.id, { priority: p }).catch((e) => reportError(model.ctx, 'Could not set the priority', e)),
      }),
    ),
    { type: 'separator' },
    { id: 'copy', label: 'Copy ID', onSelect: () => model.copy(formatRef(issue.displayNumber)) },
    { id: 'open', label: 'Open Details', onSelect: () => onIssueClick(issue) },
  ]

  return (
    <div className="relative h-full flex flex-col">
      {startableIssues.length > 0 && (
        <div className="flex items-center gap-3 mb-3 px-1">
          <button
            onClick={handleStartAllUnblocked}
            disabled={isLaunchingAll}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-600/50 text-white rounded-lg transition-colors text-sm font-medium"
          >
            {isLaunchingAll ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Launching {launchProgress.current}/{launchProgress.total}...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Start All Unblocked ({startableIssues.length})
              </>
            )}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-vibe-muted cursor-pointer">
            <input
              type="checkbox"
              checked={autoClose}
              onChange={(e) => model.setAutoClose(e.target.checked)}
              className="rounded border-vibe-border w-3.5 h-3.5"
            />
            Auto-close on complete
          </label>
        </div>
      )}

      <div className="flex-1 min-h-0" data-issues-board>
        <Board
          columns={columns}
          items={sorted}
          getId={(i) => i.id}
          getColumn={(i) => i.status}
          onMove={handleMove}
          emptyText="No issues"
          columnClassName="w-64"
          renderCard={(issue) => (
            <KanbanCard
              issue={issue}
              labels={labels}
              onClick={() => onIssueClick(issue)}
              onContextMenu={(e, i) => setContextMenu({ issue: i, x: e.clientX, y: e.clientY })}
            />
          )}
        />
      </div>

      {undoAction && <UndoToast message={undoAction.message} onUndo={handleUndo} onDismiss={handleDismissUndo} />}

      <Menu
        items={contextMenu ? menuItems(contextMenu.issue) : []}
        open={!!contextMenu}
        onClose={() => setContextMenu(null)}
        anchor={contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null}
        placement="bottom-start"
        overlayId="issues-card-menu"
      />
    </div>
  )
}
