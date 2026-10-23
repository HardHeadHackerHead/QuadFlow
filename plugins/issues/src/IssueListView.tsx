import { useState, useCallback } from 'react'
import { DropdownMenu } from '@quadflow/ui'
import { launchAgent } from '@quadflow/plugin-kit'
import { Issue, IssueLabel, IssueFilters as IssueFiltersType, IssueStatus, IssuePriority, statusConfig, priorityConfig } from './types'
import { reportError, useModel } from './model'
import IssueCard from './IssueCard'
import IssueFilters from './IssueFilters'
import KanbanBoard from './KanbanBoard'

// AI Skills for issues management
const AI_SKILLS = [
  {
    id: 'summary',
    name: 'Issue Summary',
    description: 'Quick overview by status & priority',
    command: '/issue-summary',
    icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'text-blue-400',
  },
  {
    id: 'organize',
    name: 'Organize Issues',
    description: 'Categorize, label, and prioritize',
    command: '/organize-issues',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    color: 'text-teal-400',
  },
  {
    id: 'triage',
    name: 'Triage Issues',
    description: 'Prioritize and identify blockers',
    command: '/triage-issues',
    icon: 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
    color: 'text-orange-400',
  },
  {
    id: 'check',
    name: 'Check Progress',
    description: 'Find which issues are resolved',
    command: '/check-issue-progress',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    color: 'text-green-400',
  },
  {
    id: 'duplicates',
    name: 'Find Duplicates',
    description: 'Detect similar or duplicate issues',
    command: '/find-duplicate-issues',
    icon: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z',
    color: 'text-yellow-400',
  },
  {
    id: 'work',
    name: 'Work on Issue',
    description: 'Start implementing an issue',
    command: '/issue-to-prompt',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    color: 'text-purple-400',
  },
]

type ViewMode = 'list' | 'board'

interface IssueListViewProps {
  issues: Issue[]         // Filtered issues to display
  allIssues: Issue[]      // All issues for counts
  labels: IssueLabel[]
  filters: IssueFiltersType
  viewMode: ViewMode
  onViewModeChange: (mode: ViewMode) => void
  onFiltersChange: (filters: Partial<IssueFiltersType>) => void
  onIssueClick: (issue: Issue) => void
  onStatusChange: (id: string, status: IssueStatus) => void
  onNewIssue: () => void
  onOpenSettings: () => void
}

export default function IssueListView({
  issues,
  allIssues,
  labels,
  filters,
  viewMode,
  onViewModeChange,
  onFiltersChange,
  onIssueClick,
  onStatusChange,
  onNewIssue,
  onOpenSettings,
}: IssueListViewProps) {
  const activeCount = allIssues.filter((i) => i.status !== 'done').length
  const inProgressCount = allIssues.filter((i) => i.status === 'in_progress').length
  const doneCount = allIssues.filter((i) => i.status === 'done').length

  // Team member assignment tracking removed - native teams handle assignments
  const assignedMembers: Record<string, { name: string; role: string }> = {}

  // Compute hierarchy data from allIssues
  const issueMap = new Map(allIssues.map(i => [i.id, i]))
  const childCounts = new Map<string, number>()
  const epicIds = new Set<string>()
  for (const issue of allIssues) {
    if (issue.parentIssueId) {
      childCounts.set(issue.parentIssueId, (childCounts.get(issue.parentIssueId) || 0) + 1)
      epicIds.add(issue.parentIssueId)
    }
  }

  const model = useModel()
  const [runningSkill, setRunningSkill] = useState<string | null>(null)

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === issues.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(issues.map((i) => i.id)))
    }
  }, [issues, selectedIds.size])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const bulk = async (title: string, fn: (ids: string[]) => Promise<void>) => {
    try {
      await fn(Array.from(selectedIds))
    } catch (e) {
      reportError(model.ctx, title, e)
    }
    clearSelection()
  }
  const handleBulkStatus = (status: IssueStatus) => bulk('Could not change the status', (ids) => model.bulkSetStatus(ids, status))
  const handleBulkPriority = (priority: IssuePriority) => bulk('Could not change the priority', (ids) => model.bulkSetPriority(ids, priority))
  const handleBulkDelete = () => bulk('Could not delete the issues', (ids) => model.bulkDelete(ids))

  // AI skill: a new agent session (Claude Code preferred) runs the slash command.
  const handleRunAiSkill = async (skill: typeof AI_SKILLS[0]) => {
    setRunningSkill(skill.id)
    try {
      await launchAgent(model.ctx, skill.command, { preferred: 'claude-code', autoSubmit: true, launch: { title: skill.name } })
    } finally {
      setRunningSkill(null)
    }
  }

  const isSelecting = selectedIds.size > 0

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <span className="font-medium">Issues</span>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-blue-400">{activeCount} active</span>
              <span className="text-vibe-muted">·</span>
              <span className="text-yellow-400">{inProgressCount} in progress</span>
              {filters.showCompleted && (
                <>
                  <span className="text-vibe-muted">·</span>
                  <span className="text-green-400">{doneCount} done</span>
                </>
              )}
            </div>
          </div>
          {/* View mode toggle */}
          <div className="flex items-center gap-1 bg-vibe-bg rounded-lg p-0.5">
            <button
              onClick={() => onViewModeChange('list')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                viewMode === 'list'
                  ? 'bg-vibe-bg-lighter text-vibe-text'
                  : 'text-vibe-muted hover:text-vibe-text'
              }`}
              title="List view"
              aria-label="Switch to list view"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
            <button
              onClick={() => onViewModeChange('board')}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                viewMode === 'board'
                  ? 'bg-vibe-bg-lighter text-vibe-text'
                  : 'text-vibe-muted hover:text-vibe-text'
              }`}
              title="Board view"
              aria-label="Switch to board view"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {/* AI Actions */}
            {allIssues.length > 0 && (
              <DropdownMenu
                overlayId="issues-ai-menu"
                placement="bottom-end"
                disabled={runningSkill !== null}
                items={[
                  { type: 'label', label: 'AI Agent Actions (opens a new agent terminal)' },
                  ...AI_SKILLS.map((skill) => ({
                    id: skill.id,
                    label: skill.name,
                    description: skill.description,
                    icon: (
                      <svg className={`w-4 h-4 ${skill.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={skill.icon} />
                      </svg>
                    ),
                    onSelect: () => void handleRunAiSkill(skill),
                  })),
                ]}
                trigger={
                  <button
                    className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
                      runningSkill ? 'bg-purple-600/20 text-purple-400' : 'bg-purple-600/10 text-purple-400 hover:bg-purple-600/20'
                    }`}
                    title="AI Actions"
                    aria-label="AI Actions menu"
                  >
                    {runningSkill ? (
                      <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    )}
                    <span>AI</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                }
              />
            )}
            <button
              onClick={onOpenSettings}
              className="p-1.5 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Settings"
              aria-label="Open settings"
            >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            </button>
          </div>
        </div>

        {/* Filters */}
        <IssueFilters
          filters={filters}
          labels={labels}
          onFiltersChange={onFiltersChange}
        />
      </div>

      {/* Bulk action bar */}
      {isSelecting && viewMode === 'list' && (
        <div className="flex-shrink-0 border-b border-teal-500/30 bg-teal-500/5 px-3 py-2 flex items-center gap-3">
          <span className="text-xs text-teal-400 font-medium">{selectedIds.size} selected</span>

          <DropdownMenu
            overlayId="issues-bulk-status"
            items={(['backlog', 'todo', 'in_progress', 'qa', 'done', 'blocked'] as IssueStatus[]).map((st) => ({
              id: st,
              label: statusConfig[st].label,
              onSelect: () => void handleBulkStatus(st),
            }))}
            trigger={<button className="text-xs px-2 py-1 border border-vibe-border rounded hover:bg-vibe-bg-lighter transition-colors">Set Status</button>}
          />
          <DropdownMenu
            overlayId="issues-bulk-priority"
            items={(['low', 'medium', 'high', 'critical'] as IssuePriority[]).map((pr) => ({
              id: pr,
              label: priorityConfig[pr].label,
              onSelect: () => void handleBulkPriority(pr),
            }))}
            trigger={<button className="text-xs px-2 py-1 border border-vibe-border rounded hover:bg-vibe-bg-lighter transition-colors">Set Priority</button>}
          />

          <button
            onClick={handleBulkDelete}
            className="text-xs px-2 py-1 text-red-400 border border-red-500/30 rounded hover:bg-red-500/10 transition-colors"
          >
            Delete
          </button>

          <div className="flex-1" />
          <button
            onClick={clearSelection}
            className="text-xs text-vibe-muted hover:text-vibe-text"
          >
            Clear
          </button>
        </div>
      )}

      {/* Done issues hidden indicator */}
      {!filters.showCompleted && doneCount > 0 && viewMode === 'list' && (
        <button
          onClick={() => onFiltersChange({ showCompleted: true })}
          className="flex-shrink-0 px-3 py-1.5 text-xs text-vibe-muted hover:text-green-400 bg-vibe-bg-lighter/50 border-b border-vibe-border flex items-center justify-center gap-1.5 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
          </svg>
          {doneCount} completed issue{doneCount !== 1 ? 's' : ''} hidden
        </button>
      )}

      {/* Issue list or board */}
      {viewMode === 'board' ? (
        <div className="flex-1 min-h-0 overflow-hidden p-3">
          <KanbanBoard issues={issues} labels={labels} onStatusChange={onStatusChange} onIssueClick={onIssueClick} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {issues.length === 0 ? (
            <div className="text-center text-vibe-muted py-12">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p>No issues found</p>
              <p className="text-sm mt-1">
                {filters.priority !== 'all' || filters.labels.length > 0 || filters.search
                  ? 'Try adjusting your filters'
                  : 'Create your first issue to get started'}
              </p>
            </div>
          ) : (
            <>
              {/* Select all row */}
              {issues.length > 1 && (
                <div className="flex items-center gap-2 px-1">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === issues.length}
                    onChange={toggleSelectAll}
                    className="w-3.5 h-3.5 rounded border-vibe-border bg-vibe-bg text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
                    aria-label="Select all issues"
                  />
                  <span className="text-xs text-vibe-muted">Select all</span>
                </div>
              )}
              {[...issues].sort((a, b) => (a.displayNumber ?? Infinity) - (b.displayNumber ?? Infinity)).map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  labels={labels}
                  onClick={() => onIssueClick(issue)}
                  selectable
                  selected={selectedIds.has(issue.id)}
                  onToggleSelect={() => toggleSelection(issue.id)}
                  assignedMember={assignedMembers[issue.id]}
                  isEpic={epicIds.has(issue.id)}
                  childCount={childCounts.get(issue.id)}
                  parentTitle={issue.parentIssueId ? issueMap.get(issue.parentIssueId)?.title : undefined}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* New issue button */}
      <div className="flex-shrink-0 border-t border-vibe-border p-3">
        <button
          onClick={onNewIssue}
          className="w-full px-4 py-2 bg-teal-600 hover:bg-teal-500 rounded-lg transition-colors font-medium text-sm flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Issue
        </button>
      </div>
    </div>
  )
}
