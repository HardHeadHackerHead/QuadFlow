/**
 * Issue view models of the Issues plugin (copied from the shell's
 * issue types when the tool became a plugin, MIG-issues).
 *
 * The source of truth is the Rust core (`Issue_Serialize`, `Epic_Serialize`,
 * `Label_Serialize` from `@quadflow/plugin-api`); `./convert.ts` maps those to
 * the flatter shapes below. There is no `state` field: an issue is closed iff
 * `status === 'done'`.
 */
import type { IssueStatus as CoreIssueStatus, Priority, EpicStatus as CoreEpicStatus } from '@quadflow/plugin-api'

export type IssuePriority = Priority

export type IssueStatus = CoreIssueStatus

export type EpicStatus = CoreEpicStatus

// Acceptance criterion with check state
export interface AcceptanceCriterion {
  id: string
  text: string
  checked: boolean
}

// Actor kinds recorded in the audit trail (core `ActorKind`)
export type ActorType = 'human' | 'agent' | 'plugin' | 'system'

// Status history entry for audit trail
export interface StatusHistoryEntry {
  status: IssueStatus
  from?: IssueStatus
  at: number
  by: string
  byType: ActorType
}

// Comment author (from the core `Actor`)
export interface CommentAuthor {
  type: ActorType
  name: string
}

// Standalone Epic entity
export interface Epic {
  id: string
  title: string
  description?: string
  status: EpicStatus
  priority: IssuePriority
  labels: string[]
  createdAt: number
  updatedAt: number
}

export interface Issue {
  id: string
  /** Display number; render with the store's `formatRef(number)` (`CODE-n`). */
  displayNumber: number
  title: string
  body?: string
  status: IssueStatus
  priority: IssuePriority
  labels: string[]

  // Hierarchy: parent issue makes this a sub-issue
  parentIssueId?: string
  epicId?: string

  userStory?: string
  acceptanceCriteria?: AcceptanceCriterion[]

  blockedBy?: string[]
  dependsOn?: string[]

  // Provenance (core `source`)
  sourceIdeaId?: string
  sourcePlanId?: string
  sourceStepId?: string

  // Agent assignment (core `assignment`)
  assignedTerminalId?: string
  assignedAgentLabel?: string
  assignedAt?: number
  lastHeartbeat?: number
  agentSessionId?: string
  assignedProviderId?: string

  missionId?: string

  comments: IssueComment[]
  statusHistory: StatusHistoryEntry[]
  createdBy: string
  createdByType: ActorType

  // GitHub link, kept by the GitHub integration under `ext.github` (MIG-github)
  githubRepoId?: string
  githubId?: string
  githubNumber?: number
  githubUrl?: string
  syncStatus?: 'local' | 'synced' | 'pending' | 'conflict'

  createdAt: number
  updatedAt: number
}

/** A label of the project catalog. Labels are keyed by name (`id === name`). */
export interface IssueLabel {
  id: string
  name: string
  color: string // #rrggbb
  description?: string
}

export interface IssueComment {
  id: string
  issueId: string
  body: string
  githubId?: string
  author: CommentAuthor
  createdAt: number
}

// Filter state for issue list
export interface IssueFilters {
  showCompleted: boolean
  hideBlocked: boolean
  status: IssueStatus | 'all'
  priority: IssuePriority | 'all'
  labels: string[]
  search: string
  epicId?: string // Filter by epic
}

// Default filter state
export const defaultIssueFilters: IssueFilters = {
  showCompleted: false,
  hideBlocked: false,
  status: 'all',
  priority: 'all',
  labels: [],
  search: '',
}

// Priority display config
export const priorityConfig: Record<IssuePriority, { label: string; color: string }> = {
  low: { label: 'Low', color: 'text-gray-400' },
  medium: { label: 'Medium', color: 'text-blue-400' },
  high: { label: 'High', color: 'text-orange-400' },
  critical: { label: 'Critical', color: 'text-red-400' },
}

// Status display config
export const statusConfig: Record<IssueStatus, { label: string; color: string; bgColor: string }> = {
  backlog: { label: 'Backlog', color: 'text-gray-400', bgColor: 'bg-gray-500/20' },
  todo: { label: 'To Do', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  qa: { label: 'QA', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  done: { label: 'Done', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  blocked: { label: 'Blocked', color: 'text-red-400', bgColor: 'bg-red-500/20' },
  needs_human: { label: 'Needs Human', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
}

// Default label colors
export const defaultLabelColors = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#ec4899', // pink
]
