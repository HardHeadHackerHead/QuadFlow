import { useState } from 'react'
import { Issue, IssueLabel, priorityConfig, statusConfig } from './types'
import { useModel, useFormatRef } from './model'
import LabelBadge from './LabelBadge'

interface IssueCardProps {
  issue: Issue
  labels: IssueLabel[]
  onClick: () => void
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  assignedMember?: { name: string; role: string }
  childCount?: number
  parentTitle?: string
  isEpic?: boolean
}

// Resolve a blockedBy ref (UUID or display ID like "AG-32") to an issue
function resolveRef(ref: string, allIssues: Issue[]): Issue | undefined {
  const byId = allIssues.find(i => i.id === ref)
  if (byId) return byId
  const dashPos = ref.lastIndexOf('-')
  if (dashPos >= 0) {
    const num = parseInt(ref.slice(dashPos + 1), 10)
    if (!isNaN(num)) return allIssues.find(i => i.displayNumber === num)
  }
  const plainNum = parseInt(ref, 10)
  if (!isNaN(plainNum)) return allIssues.find(i => i.displayNumber === plainNum)
  return undefined
}

export default function IssueCard({ issue, labels, onClick, selectable, selected, onToggleSelect, assignedMember, childCount, parentTitle, isEpic }: IssueCardProps) {
  const model = useModel()
  const formatRef = useFormatRef()
  const [copiedId, setCopiedId] = useState(false)
  const allIssues = useModel().issues.use((s) => s.items)

  // Compute unresolved blocker count reactively (ignores done/qa blockers)
  const unresolvedBlockerCount = issue.blockedBy?.filter(ref => {
    const blocker = resolveRef(ref, allIssues)
    return !blocker || (blocker.status !== 'done' && blocker.status !== 'qa')
  }).length ?? 0
  const totalBlockerCount = issue.blockedBy?.length ?? 0

  const blocksCount = allIssues.filter(i => i.blockedBy?.some(ref => {
    if (ref === issue.id) return true
    const dashPos = ref.lastIndexOf('-')
    if (dashPos >= 0) {
      const num = parseInt(ref.slice(dashPos + 1), 10)
      if (!isNaN(num) && num === issue.displayNumber) return true
    }
    return false
  })).length
  const priorityInfo = priorityConfig[issue.priority] ?? { label: issue.priority || '?', color: 'text-gray-400' }
  const statusInfo = statusConfig[issue.status] ?? { label: issue.status || '?', color: 'text-gray-400', bgColor: 'bg-gray-500/20' }

  // Get label objects for this issue
  const issueLabels = issue.labels
    .map((name) => labels.find((l) => l.name === name))
    .filter((l): l is IssueLabel => l !== undefined)

  const formatDate = (timestamp: number) => {
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

  return (
    <div
      onClick={onClick}
      className={`group bg-vibe-bg-lighter border rounded-lg p-3 hover:border-vibe-border-bright transition-colors cursor-pointer ${
        selected ? 'border-teal-500/50 bg-teal-500/5' : 'border-vibe-border'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Selection checkbox */}
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => {
              e.stopPropagation()
              onToggleSelect?.()
            }}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 w-3.5 h-3.5 rounded border-vibe-border bg-vibe-bg text-teal-500 focus:ring-teal-500 focus:ring-offset-0 flex-shrink-0"
            aria-label={`Select issue: ${issue.title}`}
          />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className={`font-medium text-sm leading-tight ${issue.status === 'done' ? 'text-vibe-muted line-through' : ''}`}>
              {issue.displayNumber && (
                <span
                  className="text-xs font-mono text-vibe-muted mr-1.5 hover:text-teal-400 cursor-pointer transition-colors"
                  title="Click to copy"
                  onClick={(e) => {
                    e.stopPropagation()
                    model.copy(formatRef(issue.displayNumber))
                    setCopiedId(true)
                    setTimeout(() => setCopiedId(false), 1500)
                  }}
                >{copiedId ? 'Copied!' : formatRef(issue.displayNumber)}</span>
              )}
              {issue.title}
            </h3>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs px-1.5 py-0.5 rounded ${statusInfo.color} ${statusInfo.bgColor}`}>
                {statusInfo.label}
              </span>
              <span className={`text-xs font-medium ${priorityInfo.color}`}>
                {priorityInfo.label}
              </span>
            </div>
          </div>

          {/* Hierarchy & dependency badges */}
          {(isEpic || parentTitle || totalBlockerCount > 0 || (issue.acceptanceCriteria && issue.acceptanceCriteria.length > 0) || blocksCount > 0) && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {isEpic && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-medium">
                  Epic{childCount ? ` · ${childCount} sub-issues` : ''}
                </span>
              )}
              {parentTitle && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 truncate max-w-[200px]" title={`Child of: ${parentTitle}`}>
                  ↑ {parentTitle}
                </span>
              )}
              {totalBlockerCount > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  unresolvedBlockerCount > 0
                    ? 'bg-red-500/20 text-red-400'
                    : 'bg-green-500/20 text-green-400'
                }`}>
                  {unresolvedBlockerCount > 0
                    ? `${unresolvedBlockerCount} blocker${unresolvedBlockerCount > 1 ? 's' : ''}`
                    : `${totalBlockerCount} resolved`}
                </span>
              )}
              {blocksCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">
                  blocks {blocksCount}
                </span>
              )}
              {issue.acceptanceCriteria && issue.acceptanceCriteria.length > 0 && (() => {
                const total = issue.acceptanceCriteria.length
                const checked = issue.acceptanceCriteria.filter(c => typeof c === 'object' && c.checked).length
                return (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${checked === total ? 'bg-green-500/20 text-green-400' : 'bg-white/10 text-vibe-muted'}`}>
                    {checked}/{total} AC
                  </span>
                )
              })()}
            </div>
          )}

          {/* Labels */}
          {issueLabels.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {issueLabels.map((label) => (
                <LabelBadge key={label.id} name={label.name} color={label.color} />
              ))}
            </div>
          )}

          {/* Meta */}
          <div className="flex items-center gap-2 mt-2 text-xs text-vibe-muted">
            <span>{formatDate(issue.createdAt)}</span>
            {assignedMember && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 text-purple-400" title={`Assigned to ${assignedMember.name} (${assignedMember.role})`}>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {assignedMember.name}
                </span>
              </>
            )}
            {issue.syncStatus === 'synced' && issue.githubNumber && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 text-green-400">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  #{issue.githubNumber}
                </span>
              </>
            )}
            {issue.syncStatus === 'local' && (
              <>
                <span>·</span>
                <span className="text-vibe-muted">Local only</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
