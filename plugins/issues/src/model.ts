/**
 * The Issues plugin's state: live collections of the current project's
 * issues, epics and labels (`@quadflow/plugin-kit` `createCollection`), the
 * project code (`CODE-n` refs), UI state shared by the pane and the flyout
 * tile, and every mutation — all through `ctx.data.issues.*` with an
 * explicit `projectRoot`, so a reply that lands after a project switch never
 * touches the new project's lists.
 */
import { createContext, useCallback, useContext } from 'react'
import { create } from 'zustand'
import type { Disposable, JsonValue, PluginContext } from '@quadflow/plugin-api'
import { createCollection, launchAgent, type Collection } from '@quadflow/plugin-kit'
import {
  findIssueByRef,
  formatIssueRef,
  toEpic,
  toEpicPatch,
  toIssue,
  toLabel,
  toNewIssue,
  toPatch,
  type EpicUpdates,
  type IssueUpdates,
  type NewEpicInput,
  type NewIssueInput,
} from './convert'
import { defaultIssueFilters, type Epic, type Issue, type IssueFilters, type IssueLabel, type IssuePriority, type IssueStatus } from './types'

const STALE_THRESHOLD_MS = 5 * 60 * 1000

/** An agent assignment without a heartbeat for 5+ minutes. */
export function isAgentStale(issue: Issue): boolean {
  if (!issue.assignedTerminalId || !issue.lastHeartbeat) return false
  return Date.now() - issue.lastHeartbeat > STALE_THRESHOLD_MS
}

/** Statuses a blocker may be in without blocking anymore. */
const resolved = (s: IssueStatus) => s === 'done' || s === 'qa'

export function hasUnresolvedBlockers(issue: Issue, all: Issue[]): boolean {
  if (!issue.blockedBy || issue.blockedBy.length === 0) return false
  return issue.blockedBy.some((ref) => {
    const blocker = findIssueByRef(all, ref)
    return !blocker || !resolved(blocker.status)
  })
}

/** The list view's filters applied to `issues` (search also matches `CODE-n`). */
export function filterIssues(issues: Issue[], filters: IssueFilters, formatRef: (n: number) => string): Issue[] {
  return issues.filter((issue) => {
    if (!filters.showCompleted && issue.status === 'done') return false
    if (filters.status !== 'all' && issue.status !== filters.status) return false
    if (filters.priority !== 'all' && issue.priority !== filters.priority) return false
    if (filters.epicId && issue.epicId !== filters.epicId) return false
    if (filters.hideBlocked && hasUnresolvedBlockers(issue, issues)) return false
    if (filters.labels.length > 0 && !filters.labels.some((l) => issue.labels.includes(l))) return false
    if (filters.search) {
      const q = filters.search.toLowerCase()
      const hit =
        issue.title.toLowerCase().includes(q) ||
        issue.body?.toLowerCase().includes(q) ||
        formatRef(issue.displayNumber).toLowerCase().includes(q)
      if (!hit) return false
    }
    return true
  })
}

interface UiState {
  filters: IssueFilters
  /** An issue to show (palette, "open issue by ref"); the tile consumes and clears it. */
  focusId: string | null
  /** Bumped by the `new-issue` command: the tile opens the create form. */
  composeNonce: number
  /** Re-render tick for stale-agent indicators. */
  tick: number
  /** "Auto-close terminal when done" for agents started on an issue (remembered, plugin kv). */
  autoClose: boolean
}

export interface IssuesModel {
  ctx: PluginContext
  issues: Collection<Issue>
  epics: Collection<Epic>
  labels: Collection<IssueLabel>
  /** The project's issue code (`CODE` of `CODE-n`). */
  meta: ReturnType<typeof createMeta>
  ui: ReturnType<typeof createUi>
  /** Start syncing everything (tiles call it in an effect). */
  retain(): Disposable
  formatRef(n: number): string
  /** Copy to the clipboard (`clipboard:write`). */
  copy(text: string): void
  loadCode(): Promise<void>
  setProjectCode(code: string): Promise<void>
  setFilters(f: Partial<IssueFilters>): void
  setAutoClose(on: boolean): void
  clearFilters(): void

  createIssue(title: string, o?: NewIssueInput): Promise<Issue>
  updateIssue(id: string, u: IssueUpdates): Promise<Issue>
  setStatus(id: string, s: IssueStatus): Promise<void>
  deleteIssue(id: string): Promise<void>
  toggleCriteria(id: string, criterionIds: string[], checked: boolean): Promise<void>
  bulkSetStatus(ids: string[], s: IssueStatus): Promise<void>
  bulkSetPriority(ids: string[], p: IssuePriority): Promise<void>
  bulkDelete(ids: string[]): Promise<void>
  addComment(id: string, body: string): Promise<void>
  deleteComment(id: string, commentId: string): Promise<void>
  release(id: string): Promise<void>

  createLabel(name: string, color: string): Promise<IssueLabel>
  updateLabel(name: string, u: { name?: string; color?: string }): Promise<void>
  deleteLabel(name: string): Promise<void>

  createEpic(title: string, o?: NewEpicInput): Promise<Epic>
  updateEpic(id: string, u: EpicUpdates): Promise<void>
  deleteEpic(id: string): Promise<void>

  /** Start an agent on the issue (`/issue-to-prompt CODE-n`; the core claims it for the new terminal). */
  workOn(issue: Issue, o?: { autoClose?: boolean; providerId?: string }): Promise<void>
  /** Resume the assigned agent's session (re-claims the issue for the new terminal). */
  resume(issue: Issue): Promise<void>
}

function createMeta() {
  return create<{ code: string }>(() => ({ code: '' }))
}
function createUi() {
  return create<UiState>(() => ({ filters: { ...defaultIssueFilters }, focusId: null, composeNonce: 0, tick: 0, autoClose: true }))
}

const FILTERS_KEY = 'filters'
const AUTO_CLOSE_KEY = 'autoCloseTerminals'
const models = new WeakMap<PluginContext, IssuesModel>()

/** Toast an error instead of failing silently. */
export function reportError(ctx: PluginContext, title: string, e: unknown) {
  ctx.log.error(title, e)
  ctx.notifications.toast({ kind: 'error', title, body: e instanceof Error ? e.message : String(e) })
}

export function issuesModel(ctx: PluginContext): IssuesModel {
  let m = models.get(ctx)
  if (m) return m
  const d = ctx.data.issues
  const issues = createCollection<Issue>(ctx, {
    domain: 'issues',
    // Project code changes re-render refs (`relatedVersion` → `loadCode`).
    relatedDomains: ['project_config'],
    list: async (c, root) => {
      const r = await c.data.issues.list({ includeDone: true }, { projectRoot: root })
      return { items: r.items.map(toIssue), errors: r.errors }
    },
    get: async (c, id, root) => toIssue(await c.data.issues.get(id, { projectRoot: root })),
    normalize: (i) => i,
  })
  const epics = createCollection<Epic>(ctx, {
    domain: 'epics',
    list: async (c, root) => {
      const r = await c.data.issues.epics.list({ projectRoot: root })
      return { items: r.items.map(toEpic), errors: r.errors }
    },
    get: async (c, id, root) => toEpic(await c.data.issues.epics.get(id, { projectRoot: root })),
    normalize: (e) => e,
    compare: (a, b) => b.createdAt - a.createdAt,
  })
  const labels = createCollection<IssueLabel>(ctx, {
    domain: 'labels',
    list: async (c, root) => ({ items: (await c.data.issues.labels.list({ projectRoot: root })).map(toLabel) }),
    get: async (c, name, root) => {
      const l = (await c.data.issues.labels.list({ projectRoot: root })).find((x) => x.name === name)
      if (!l) throw new Error(`label ${name} not found`)
      return toLabel(l)
    },
    normalize: (l) => l,
    compare: (a, b) => a.name.localeCompare(b.name),
  })
  const meta = createMeta()
  const ui = createUi()

  const reloadIssues = () => void issues.reload(true)

  let refs = 0
  let subs: Disposable[] = []
  function retain(): Disposable {
    if (refs++ === 0) {
      subs = [issues.retain(), epics.retain(), labels.retain()]
      // Filters are a per-project convenience (plugin kv, project scope).
      const loadFilters = async () => {
        try {
          const saved = await ctx.storage.get<IssueFilters>(FILTERS_KEY, 'project')
          ui.setState({ filters: saved && typeof saved.showCompleted === 'boolean' ? { ...defaultIssueFilters, ...saved } : { ...defaultIssueFilters } })
        } catch {
          ui.setState({ filters: { ...defaultIssueFilters } })
        }
      }
      void loadFilters()
      ctx.storage
        .get<boolean>(AUTO_CLOSE_KEY)
        .then((v) => typeof v === 'boolean' && ui.setState({ autoClose: v }))
        .catch(() => {})
      subs.push(ctx.project.onDidChange(() => void loadFilters()))
      const timer = setInterval(() => {
        if (issues.use.getState().items.some((i) => i.assignedTerminalId)) ui.setState((s) => ({ tick: s.tick + 1 }))
      }, 60_000)
      subs.push(() => clearInterval(timer))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--refs > 0) return
      for (const s of subs) s()
      subs = []
    }
  }

  const replaceIssue = (root: string, raw: Parameters<typeof toIssue>[0]) => issues.apply(root, toIssue(raw))

  m = {
    ctx,
    issues,
    epics,
    labels,
    meta,
    ui,
    retain,
    formatRef: (n) => formatIssueRef(meta.getState().code, n),
    copy: (text) => void ctx.clipboard.writeText(text).catch((e) => reportError(ctx, 'Could not copy', e)),
    async loadCode() {
      const root = ctx.project.current()?.root
      if (!root) return
      try {
        const cfg = await ctx.data.projectConfig.get({ projectRoot: root })
        if (ctx.project.current()?.root === root) meta.setState({ code: cfg.code })
      } catch (e) {
        ctx.log.error('failed to load the project code:', e)
      }
    },
    async setProjectCode(code) {
      const trimmed = code.trim().toUpperCase()
      if (!trimmed) return
      const projectRoot = issues.root()
      const cfg = await ctx.data.projectConfig.update({ code: trimmed }, { projectRoot })
      if (ctx.project.current()?.root === projectRoot) meta.setState({ code: cfg.code })
    },
    setFilters(f) {
      const filters = { ...ui.getState().filters, ...f }
      ui.setState({ filters })
      ctx.storage.set(FILTERS_KEY, filters as unknown as JsonValue, 'project').catch(() => {})
    },
    setAutoClose(on) {
      ui.setState({ autoClose: on })
      ctx.storage.set(AUTO_CLOSE_KEY, on).catch(() => {})
    },
    clearFilters() {
      const filters = { ...defaultIssueFilters }
      ui.setState({ filters })
      ctx.storage.set(FILTERS_KEY, filters as unknown as JsonValue, 'project').catch(() => {})
    },

    async createIssue(title, o) {
      const projectRoot = issues.root()
      const issue = toIssue(await d.create(toNewIssue(title, o), { projectRoot }))
      issues.apply(projectRoot, issue)
      return issue
    },
    async updateIssue(id, u) {
      const projectRoot = issues.root()
      const issue = toIssue(await d.update(id, toPatch(u), { projectRoot }))
      issues.apply(projectRoot, issue)
      // A close may have unblocked other issues (their events arrive too; this is immediate).
      if (u.status === 'done') reloadIssues()
      return issue
    },
    async setStatus(id, s) {
      const projectRoot = issues.root()
      replaceIssue(projectRoot, await d.setStatus(id, s, { projectRoot }))
      if (s === 'done') reloadIssues()
    },
    async deleteIssue(id) {
      const projectRoot = issues.root()
      await d.delete(id, { projectRoot })
      issues.remove(projectRoot, [id])
      reloadIssues() // references in other issues were unlinked
    },
    async toggleCriteria(id, criterionIds, checked) {
      const projectRoot = issues.root()
      for (const cid of criterionIds) replaceIssue(projectRoot, await d.toggleCriterion(id, cid, checked, { projectRoot }))
    },
    async bulkSetStatus(ids, s) {
      const projectRoot = issues.root()
      for (const id of ids) replaceIssue(projectRoot, await d.setStatus(id, s, { projectRoot }))
      if (s === 'done') reloadIssues()
    },
    async bulkSetPriority(ids, priority) {
      const projectRoot = issues.root()
      for (const id of ids) replaceIssue(projectRoot, await d.update(id, { priority }, { projectRoot }))
    },
    async bulkDelete(ids) {
      const projectRoot = issues.root()
      for (const id of ids) await d.delete(id, { projectRoot })
      issues.remove(projectRoot, ids)
      reloadIssues()
    },
    async addComment(id, body) {
      const projectRoot = issues.root()
      replaceIssue(projectRoot, await d.addComment(id, body, { projectRoot }))
    },
    async deleteComment(id, commentId) {
      const projectRoot = issues.root()
      replaceIssue(projectRoot, await d.deleteComment(id, commentId, { projectRoot }))
    },
    async release(id) {
      const projectRoot = issues.root()
      replaceIssue(projectRoot, await d.release(id, { projectRoot }))
    },

    async createLabel(name, color) {
      const projectRoot = labels.root()
      const all = (await d.labels.upsert({ name, color, description: null }, null, { projectRoot })).map(toLabel)
      labels.replaceAll(projectRoot, all)
      return all.find((l) => l.name === name.trim()) ?? { id: name, name, color }
    },
    async updateLabel(name, u) {
      const projectRoot = labels.root()
      const existing = labels.use.getState().items.find((l) => l.name === name)
      const newName = u.name?.trim() || name
      const all = await d.labels.upsert(
        { name: newName, color: u.color ?? existing?.color ?? '#3b82f6', description: existing?.description ?? null },
        newName !== name ? name : null,
        { projectRoot },
      )
      labels.replaceAll(projectRoot, all.map(toLabel))
      if (newName !== name) reloadIssues()
    },
    async deleteLabel(name) {
      const projectRoot = labels.root()
      labels.replaceAll(projectRoot, (await d.labels.delete(name, { projectRoot })).map(toLabel))
      reloadIssues()
    },

    async createEpic(title, o = {}) {
      const projectRoot = epics.root()
      const epic = toEpic(
        await d.epics.create(
          { title, description: o.description || null, status: o.status ?? null, priority: o.priority ?? null, labels: o.labels ?? [] },
          { projectRoot },
        ),
      )
      epics.apply(projectRoot, epic)
      return epic
    },
    async updateEpic(id, u) {
      const projectRoot = epics.root()
      epics.apply(projectRoot, toEpic(await d.epics.update(id, toEpicPatch(u), { projectRoot })))
    },
    async deleteEpic(id) {
      const projectRoot = epics.root()
      await d.epics.delete(id, { projectRoot })
      epics.remove(projectRoot, [id])
      reloadIssues() // issues of the epic were unlinked
    },

    async workOn(issue, o = {}) {
      const ref = m!.formatRef(issue.displayNumber)
      await launchAgent(ctx, `/issue-to-prompt ${ref}`, {
        providerId: o.providerId,
        preferred: 'claude-code',
        autoSubmit: true,
        launch: { issueRef: ref, title: issue.title, closeOnIssueDone: o.autoClose ?? ui.getState().autoClose },
      })
    },
    async resume(issue) {
      if (!issue.agentSessionId) return
      const ref = m!.formatRef(issue.displayNumber)
      // The stale assignment is released first; the launch claims the issue for the new terminal.
      // `agentSessionId` is agent-writable: the core validates and quotes it.
      await m!.release(issue.id)
      await launchAgent(ctx, '', {
        providerId: issue.assignedProviderId,
        preferred: 'claude-code',
        launch: { resumeSessionId: issue.agentSessionId, issueRef: ref, title: `Resume: ${issue.title}` },
      })
    },
  }
  models.set(ctx, m)
  return m
}

/** The model of the tile being rendered (provided by `IssuesTile`). */
export const ModelContext = createContext<IssuesModel | null>(null)

export function useModel(): IssuesModel {
  const m = useContext(ModelContext)
  if (!m) throw new Error('useModel() outside the Issues tile')
  return m
}

/** Reactive `CODE-n` formatter. */
export function useFormatRef(): (n: number) => string {
  const code = useModel().meta((s) => s.code)
  return useCallback((n: number) => formatIssueRef(code, n), [code])
}
