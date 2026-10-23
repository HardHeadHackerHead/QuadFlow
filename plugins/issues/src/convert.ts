/**
 * Mapping between the core's issue entities (`@quadflow/plugin-api`
 * generated types) and the view models in `./types.ts`, plus the input
 * builders for create / update. Originally the shell's issue mapping
 * (MIG-issues); the GitHub link is read from `ext.github` (written by the
 * GitHub integration, displayed read-only here).
 */
import type { Epic_Serialize, IssuePatch_Deserialize, Issue_Serialize, Label_Serialize, NewIssue_Deserialize } from '@quadflow/plugin-api'
import type { AcceptanceCriterion, ActorType, Epic, EpicStatus, Issue, IssueComment, IssueLabel, IssuePriority, IssueStatus } from './types'

/** `CODE-n`. Mirrors core `issues::display_ref` (the CLI and terminal titles use the same format). */
export function formatIssueRef(code: string, number: number): string {
  return code ? `${code}-${number}` : `#${number}`
}

/** `ext.github` on an issue (written by the GitHub integration). */
interface GithubExt {
  repoId?: string
  id?: string
  number?: number
  url?: string
  syncStatus?: Issue['syncStatus']
}

export function toIssue(i: Issue_Serialize): Issue {
  const gh = (i.ext?.github ?? undefined) as GithubExt | undefined
  return {
    id: i.id,
    displayNumber: i.number,
    title: i.title,
    body: i.body ?? undefined,
    status: i.status,
    priority: i.priority,
    labels: i.labels ?? [],
    parentIssueId: i.parentId ?? undefined,
    epicId: i.epicId ?? undefined,
    userStory: i.userStory ?? undefined,
    acceptanceCriteria: (i.acceptanceCriteria ?? []).map((c) => ({ id: c.id, text: c.text, checked: c.checked ?? false })),
    blockedBy: i.blockedBy ?? [],
    dependsOn: i.dependsOn ?? [],
    sourceIdeaId: i.source?.ideaId ?? undefined,
    sourcePlanId: i.source?.planId ?? undefined,
    sourceStepId: i.source?.stepId ?? undefined,
    assignedTerminalId: i.assignment?.terminalId ?? undefined,
    assignedAgentLabel: i.assignment?.agentLabel ?? undefined,
    assignedAt: i.assignment?.assignedAt ?? undefined,
    lastHeartbeat: i.assignment?.lastHeartbeat ?? undefined,
    agentSessionId: i.assignment?.sessionId ?? undefined,
    assignedProviderId: i.assignment?.providerId ?? undefined,
    missionId: i.missionId ?? undefined,
    comments: (i.comments ?? []).map(
      (c): IssueComment => ({
        id: c.id,
        issueId: i.id,
        body: c.body,
        author: { type: c.createdBy.kind as ActorType, name: c.createdBy.name },
        createdAt: c.createdAt,
      }),
    ),
    statusHistory: (i.history ?? []).map((h) => ({
      status: h.to,
      from: h.from ?? undefined,
      at: h.at,
      by: h.by.name,
      byType: h.by.kind as ActorType,
    })),
    createdBy: i.createdBy.name,
    createdByType: i.createdBy.kind as ActorType,
    githubRepoId: gh?.repoId,
    githubId: gh?.id,
    githubNumber: gh?.number,
    githubUrl: gh?.url,
    syncStatus: gh?.syncStatus,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }
}

export function toEpic(e: Epic_Serialize): Epic {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? undefined,
    status: e.status,
    priority: e.priority,
    labels: e.labels ?? [],
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

export function toLabel(l: Label_Serialize): IssueLabel {
  return { id: l.name, name: l.name, color: l.color, description: l.description ?? undefined }
}

// ------------------------------------------------------------------- inputs

export interface NewIssueInput {
  body?: string
  status?: IssueStatus
  priority?: IssuePriority
  labels?: string[]
  parentIssueId?: string
  epicId?: string
  blockedBy?: string[]
  dependsOn?: string[]
  userStory?: string
  acceptanceCriteria?: (AcceptanceCriterion | { id?: string; text: string; checked?: boolean })[]
}

/** Fields of `Issue` the tool edits. A present key with `undefined` / `''` clears it. */
export type IssueUpdates = Partial<
  Pick<
    Issue,
    | 'title'
    | 'body'
    | 'status'
    | 'priority'
    | 'labels'
    | 'parentIssueId'
    | 'epicId'
    | 'blockedBy'
    | 'dependsOn'
    | 'userStory'
    | 'acceptanceCriteria'
  >
>

export type EpicUpdates = Partial<Pick<Epic, 'title' | 'description' | 'status' | 'priority' | 'labels'>>
export interface NewEpicInput {
  description?: string
  status?: EpicStatus
  priority?: IssuePriority
  labels?: string[]
}

function isUlid(s: string | undefined): s is string {
  return !!s && /^[0-9a-hjkmnp-tv-z]{26}$/i.test(s)
}

function criteria(list: NewIssueInput['acceptanceCriteria']) {
  return (list ?? []).map((c) => ({
    // The forms mint temporary ids; only real ULIDs are kept.
    id: isUlid(c.id) ? c.id : null,
    text: c.text,
    checked: c.checked ?? false,
  }))
}

export function toNewIssue(title: string, o: NewIssueInput = {}): NewIssue_Deserialize {
  return {
    title,
    body: o.body || null,
    status: o.status ?? null,
    priority: o.priority ?? null,
    labels: o.labels ?? [],
    epicId: o.epicId || null,
    parentId: o.parentIssueId || null,
    blockedBy: (o.blockedBy ?? []).filter(isUlid),
    dependsOn: (o.dependsOn ?? []).filter(isUlid),
    userStory: o.userStory || null,
    acceptanceCriteria: criteria(o.acceptanceCriteria),
  }
}

export function toPatch(u: IssueUpdates): IssuePatch_Deserialize {
  const p: IssuePatch_Deserialize = {}
  const has = (k: keyof IssueUpdates) => Object.prototype.hasOwnProperty.call(u, k)
  if (u.title !== undefined) p.title = u.title
  if (has('body')) p.body = u.body || null
  if (u.status !== undefined) p.status = u.status
  if (u.priority !== undefined) p.priority = u.priority
  if (has('labels')) p.labels = u.labels ?? []
  if (has('epicId')) p.epicId = u.epicId || null
  if (has('parentIssueId')) p.parentId = u.parentIssueId || null
  if (has('blockedBy')) p.blockedBy = (u.blockedBy ?? []).filter(isUlid)
  if (has('dependsOn')) p.dependsOn = (u.dependsOn ?? []).filter(isUlid)
  if (has('userStory')) p.userStory = u.userStory || null
  if (has('acceptanceCriteria')) p.acceptanceCriteria = criteria(u.acceptanceCriteria)
  return p
}

export function toEpicPatch(u: EpicUpdates) {
  const has = (k: keyof EpicUpdates) => Object.prototype.hasOwnProperty.call(u, k)
  return {
    ...(u.title !== undefined ? { title: u.title } : {}),
    ...(has('description') ? { description: u.description || null } : {}),
    ...(u.status !== undefined ? { status: u.status } : {}),
    ...(u.priority !== undefined ? { priority: u.priority } : {}),
    ...(has('labels') ? { labels: u.labels ?? [] } : {}),
  }
}

/** Find an issue by id, `CODE-n`, `#n` or `n` among loaded issues. */
export function findIssueByRef(issues: Issue[], ref: string): Issue | undefined {
  const r = ref.trim()
  const byId = issues.find((i) => i.id === r)
  if (byId) return byId
  const m = /(?:^|-|#)(\d+)$/.exec(r)
  if (!m) return undefined
  const n = parseInt(m[1], 10)
  return issues.find((i) => i.displayNumber === n)
}
