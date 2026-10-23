/**
 * The Missions plugin's state, one model per plugin context (the pane and the
 * flyout tile share it). Everything goes through the public host API:
 *
 *  - `ctx.data.missions.*` — missions (with members, proposals and merge queue
 *    embedded), messages, activity, progress, templates, agent definitions;
 *  - `ctx.data.issues.*` — the open-issue picker;
 *  - `ctx.agents.launch` — members are agent sessions in their own worktree;
 *  - `ctx.shell.exec('git', …)` — worktrees and merges (`shell:exec:git`);
 *  - `ctx.terminals.*` — previews, nudges, stop.
 *
 * Mutations name the project explicitly (`{ projectRoot }` captured before the
 * call) and drop results that land after a project switch. Proposal decisions,
 * merge-queue status, activity notes and read markers are recorded in the
 * mission (API 1.4); `agents.prepareWorktree` writes each member's context and
 * file scope, `terminals.focus` shows a member's terminal.
 */
import { create } from 'zustand'
import type {
  AgentDefinition,
  AgentDefinitionInput_Deserialize,
  ChangeEvent,
  Disposable,
  Issue_Serialize,
  MissionActivityKind,
  MissionActivity_Serialize,
  MissionMemberPatch_Deserialize,
  MissionMember_Serialize,
  MissionMergeEntry_Serialize,
  MissionMergeStatus,
  MissionMessage_Serialize,
  MissionOrchestratorMode,
  MissionPatch_Deserialize,
  MissionProgress,
  MissionProposalStatus,
  MissionProposal_Serialize,
  MissionTemplateInput_Deserialize,
  MissionTemplate_Serialize,
  Mission_Serialize,
  PluginContext,
  ProviderInfo,
} from '@quadflow/plugin-api'
import { createCollection, type Collection } from '@quadflow/plugin-kit'
import {
  buildMemberPrompt,
  buildOrchestratorPrompt,
  coordinatorOverlay,
  isCoordinatorRole,
  nudgeText,
  rejectionNudge,
  reviewTask,
  scopeNote,
  taskFromIssue,
  workerOverlay,
  type AgentTask,
} from './prompts'

export type Mission = Mission_Serialize
export type Member = MissionMember_Serialize
export type Proposal = MissionProposal_Serialize
export type MergeEntry = MissionMergeEntry_Serialize
export type Message = MissionMessage_Serialize
export type Activity = MissionActivity_Serialize
export type Template = MissionTemplate_Serialize

export type MainTab = 'missions' | 'templates' | 'agents'
export type DetailTab = 'team' | 'issues' | 'messages' | 'activity' | 'proposals' | 'merge'

export const membersOf = (m: Mission | undefined): Member[] => m?.members ?? []
/** Newest proposal first. */
export const proposalsOf = (m: Mission | undefined): Proposal[] => [...(m?.proposals ?? [])].reverse()
export const mergeQueueOf = (m: Mission | undefined): MergeEntry[] => [...(m?.mergeQueue ?? [])].sort((a, b) => a.position - b.position)

// ---------------------------------------------------------------- capabilities

/** What this host serves (the agent framework may be missing in a build). */
export interface Capabilities {
  prepareWorktree: boolean
  git: boolean
}

function capabilities(ctx: PluginContext): Capabilities {
  return { prepareWorktree: ctx.api.has('agents.prepareWorktree'), git: ctx.api.has('shell.exec') }
}

// ---------------------------------------------------------------- stores

interface UiState {
  selectedId: string | null
  tab: MainTab
  detailTab: DetailTab
  /** Bumped by the "New Mission" command: the tile opens its dialog. */
  newMissionNonce: number
  /** Template preselected in that dialog. */
  newMissionTemplateId: string | null
  /** Members currently being spawned (button spinners). */
  busy: Record<string, boolean>
}

interface ExtraState {
  messages: Record<string, Message[]>
  activity: Record<string, Activity[]>
  progress: Record<string, MissionProgress>
  issues: Record<string, Issue_Serialize[]>
  openIssues: Issue_Serialize[]
  templates: Template[]
  agents: AgentDefinition[]
  providers: ProviderInfo[]
}

const emptyExtra = (): Omit<ExtraState, 'agents' | 'providers'> => ({
  messages: {},
  activity: {},
  progress: {},
  issues: {},
  openIssues: [],
  templates: [],
})

export interface NewMissionInput {
  name: string
  templateId?: string | null
  orchestratorMode?: MissionOrchestratorMode | null
  issueRefs?: string[]
}

export interface MissionsModel {
  missions: Collection<Mission>
  ui: ReturnType<typeof createUi>
  extra: ReturnType<typeof createExtra>
  caps(): Capabilities
  retain(): Disposable
  root(): string

  select(id: string | null): void
  loadDetail(id: string): Promise<void>
  loadProgress(id: string): Promise<void>
  loadOpenIssues(): Promise<void>
  loadTemplates(): Promise<void>
  loadAgents(): Promise<void>

  createMission(i: NewMissionInput): Promise<Mission>
  updateMission(id: string, p: MissionPatch_Deserialize): Promise<void>
  deleteMission(id: string): Promise<void>
  addMember(missionId: string, agentDefinitionId: string, name?: string, model?: string): Promise<Member>
  updateMember(missionId: string, memberId: string, p: MissionMemberPatch_Deserialize): Promise<void>
  removeMember(missionId: string, memberId: string): Promise<void>
  assignIssues(missionId: string, refs: string[]): Promise<void>
  sendMessage(missionId: string, content: string, toMemberId?: string | null): Promise<void>

  spawnMember(missionId: string, memberId: string, task?: AgentTask): Promise<void>
  stopMember(missionId: string, memberId: string): Promise<void>
  nudge(missionId: string, memberId: string): Promise<void>
  focusTerminal(terminalId: string): void
  launchMission(missionId: string): Promise<void>
  stopAll(missionId: string): Promise<void>
  startCoordinator(missionId: string): Promise<void>
  approveProposal(missionId: string, proposalId: string): Promise<void>
  rejectProposal(missionId: string, proposalId: string): Promise<void>
  merge(missionId: string, entryId: string, target?: string): Promise<{ success: boolean; message: string }>
  spawnReviewer(missionId: string, entryId: string): Promise<void>
  cleanup(missionId: string): Promise<void>

  upsertTemplate(t: MissionTemplateInput_Deserialize): Promise<Template>
  deleteTemplate(id: string): Promise<void>
  upsertAgent(d: AgentDefinitionInput_Deserialize): Promise<AgentDefinition>
  deleteAgent(id: string): Promise<void>
}

function createUi() {
  return create<UiState>(() => ({ selectedId: null, tab: 'missions', detailTab: 'team', newMissionNonce: 0, newMissionTemplateId: null, busy: {} }))
}
function createExtra() {
  return create<ExtraState>(() => ({ ...emptyExtra(), agents: [], providers: [] }))
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent'

const models = new WeakMap<PluginContext, MissionsModel>()

export function missionsModel(ctx: PluginContext): MissionsModel {
  const existing = models.get(ctx)
  if (existing) return existing

  const d = ctx.data.missions
  const missions = createCollection<Mission>(ctx, {
    domain: 'missions',
    list: async (c, root) => {
      const r = await c.data.missions.list({}, { projectRoot: root })
      return { items: r.items, errors: r.errors }
    },
    get: (c, id, root) => c.data.missions.get(id, { projectRoot: root }),
    normalize: (m) => m,
  })
  const ui = createUi()
  const extra = createExtra()

  const current = () => ctx.project.current()?.root ?? null
  const root = () => missions.root()
  const stillOn = (r: string) => current() === r
  const find = (id: string) => missions.use.getState().items.find((m) => m.id === id)
  const memberOf = (missionId: string, memberId: string) => membersOf(find(missionId)).find((x) => x.id === memberId)

  const setIn = <K extends 'messages' | 'activity' | 'progress' | 'issues'>(key: K, id: string, v: ExtraState[K][string]) =>
    extra.setState((s) => ({ [key]: { ...s[key], [id]: v } }) as unknown as Pick<ExtraState, K>)

  async function refresh(r: string, id: string) {
    try {
      missions.apply(r, await d.get(id, { projectRoot: r }))
    } catch (e) {
      ctx.log.warn('mission refresh failed:', e)
    }
  }

  async function note(r: string, missionId: string, detail: string, memberId?: string, kind: MissionActivityKind = 'note') {
    try {
      await d.logActivity(missionId, { kind, memberId: memberId ?? null, detail }, { projectRoot: r })
    } catch (e) {
      ctx.log.warn('could not log mission activity:', e)
    }
  }

  async function git(cwd: string, args: string[]) {
    return ctx.shell.exec({ program: 'git', args, cwd, timeoutMs: 120_000 })
  }

  async function writeTerminal(terminalId: string, text: string) {
    try {
      await ctx.terminals.write(terminalId, text)
    } catch {
      // closed, or the agent is mid-inference
    }
  }

  // ---------------------------------------------------------------- loads

  async function loadMessages(r: string, id: string) {
    const res = await d.messages(id, { limit: 200 }, { projectRoot: r })
    if (!stillOn(r)) return
    setIn('messages', id, res.items)
    if (res.items.length > 0) d.markRead(id, 'human', null, { projectRoot: r }).catch(() => {})
  }
  async function loadActivity(r: string, id: string) {
    const res = await d.activity(id, { limit: 100 }, { projectRoot: r })
    if (!stillOn(r)) return
    // Newest first.
    setIn('activity', id, [...res.items].reverse())
  }
  async function loadProgress(r: string, id: string) {
    const p = await d.progress(id, { projectRoot: r })
    if (stillOn(r)) setIn('progress', id, p)
  }
  async function loadIssues(r: string, id: string) {
    const res = await d.issues(id, { projectRoot: r })
    if (stillOn(r)) setIn('issues', id, [...res.items].sort((a, b) => a.number - b.number))
  }
  async function loadTemplates() {
    const r = current()
    if (!r) return
    const res = await d.templates.list({ projectRoot: r })
    if (stillOn(r)) extra.setState({ templates: res.items })
  }
  async function loadAgents() {
    extra.setState({ agents: await d.agentDefinitions.list() })
  }
  async function loadProviders() {
    try {
      extra.setState({ providers: await ctx.agents.providers() })
    } catch (e) {
      ctx.log.warn('agent providers unavailable:', e)
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch((e) => ctx.log.warn('missions refresh failed:', e))

  async function loadDetail(id: string) {
    const r = current()
    if (!r) return
    await Promise.all([loadMessages(r, id), loadActivity(r, id), loadProgress(r, id), loadIssues(r, id)].map(quiet))
  }

  // ---------------------------------------------------------------- live updates

  let refs = 0
  let subs: Disposable[] = []
  let projectOff: Disposable | null = null
  let releaseMissions: Disposable | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  let progressOff: Disposable | null = null
  let agentsOff: Disposable | null = null
  let boundRoot: string | null = null

  function subscribe() {
    for (const s of subs) s()
    subs = []
    const r = current()
    if (r !== boundRoot) {
      // Another project: nothing of the previous one may survive.
      boundRoot = r
      extra.setState(emptyExtra())
      ui.setState({ selectedId: null })
    }
    if (!r) return
    const sel = ui.getState().selectedId
    if (sel) void loadDetail(sel)
    void quiet(loadTemplates())
    const selected = () => ui.getState().selectedId
    const perMission = (e: ChangeEvent, fn: (id: string) => Promise<void>) => {
      const ids = e.ids.length > 0 ? e.ids : [selected()].filter((x): x is string => !!x)
      for (const id of ids) void quiet(fn(id))
    }
    subs.push(
      ctx.data.onDidChange({ domain: 'mission_messages', projectRoot: r }, (e) =>
        perMission(e, (id) => (extra.getState().messages[id] || id === selected() ? loadMessages(r, id) : Promise.resolve())),
      ),
      ctx.data.onDidChange({ domain: 'mission_activity', projectRoot: r }, (e) =>
        perMission(e, (id) => (extra.getState().activity[id] || id === selected() ? loadActivity(r, id) : Promise.resolve())),
      ),
      ctx.data.onDidChange({ domain: 'issues', projectRoot: r }, () => {
        for (const m of missions.use.getState().items) void quiet(loadProgress(r, m.id))
        const s = selected()
        if (s) void quiet(loadIssues(r, s))
        if (extra.getState().openIssues.length > 0) void quiet(loadOpenIssues())
      }),
      ctx.data.onDidChange({ domain: 'mission_templates', projectRoot: r }, () => void quiet(loadTemplates())),
    )
  }

  async function loadOpenIssues() {
    const r = current()
    if (!r) return
    const res = await ctx.data.issues.list({ includeDone: false }, { projectRoot: r })
    if (stillOn(r)) extra.setState({ openIssues: [...res.items].sort((a, b) => a.number - b.number) })
  }

  /** Progress of every listed mission, whenever the list changes. */
  function trackProgress(): Disposable {
    let last = ''
    return missions.use.subscribe((s) => {
      const key = s.items.map((m) => `${m.id}:${m.updatedAt}`).join(',')
      if (key === last || !s.root) return
      last = key
      for (const m of s.items) void quiet(loadProgress(s.root, m.id))
      const sel = ui.getState().selectedId
      if (sel && !s.items.some((m) => m.id === sel)) ui.setState({ selectedId: null })
    })
  }

  function retain(): Disposable {
    if (refs++ === 0) {
      releaseMissions = missions.retain()
      progressOff = trackProgress()
      subscribe()
      projectOff = ctx.project.onDidChange(() => subscribe())
      // App-wide (not project-scoped).
      agentsOff = ctx.data.onDidChange({ domain: 'agent_definitions' }, () => void quiet(loadAgents()))
      void quiet(loadAgents())
      void loadProviders()
      watchdog = setInterval(() => void tick(), 60_000)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--refs > 0) return
      releaseMissions?.()
      progressOff?.()
      projectOff?.()
      agentsOff?.()
      for (const s of subs) s()
      subs = []
      if (watchdog) clearInterval(watchdog)
      watchdog = null
    }
  }

  // ---------------------------------------------------------------- watchdog

  const STALL_MS = 5 * 60_000
  const DEAD_MS = 15 * 60_000
  const nudged = new Set<string>()

  async function tick() {
    const r = current()
    if (!r) return
    for (const mission of missions.use.getState().items) {
      if (mission.status !== 'active') continue
      try {
        for (const member of membersOf(mission)) {
          if (member.status !== 'working' && member.status !== 'idle') continue
          if (!member.lastHeartbeat) continue
          const elapsed = Date.now() - member.lastHeartbeat
          const minutes = Math.round(elapsed / 60_000)
          if (elapsed > DEAD_MS) {
            await d.memberUpdate(mission.id, member.id, { status: 'error', error: `No heartbeat for ${minutes} min — presumed dead` }, { projectRoot: r })
            nudged.delete(member.id)
          } else if (elapsed > STALL_MS && !nudged.has(member.id)) {
            nudged.add(member.id)
            if (member.terminalId) await writeTerminal(member.terminalId, nudgeText(mission.id, r, member.id, minutes))
            await note(r, mission.id, `${member.name} appears stalled (${minutes} min idle) — watchdog nudge sent`, member.id)
          }
        }
        // Auto-complete: every issue of the mission is done.
        const p = await d.progress(mission.id, { projectRoot: r })
        if (p.total > 0 && (p.byStatus.done ?? 0) === p.total) {
          missions.apply(r, await d.update(mission.id, { status: 'completed' }, { projectRoot: r }))
        }
      } catch (e) {
        ctx.log.warn('watchdog tick failed:', e)
      }
    }
  }

  // ---------------------------------------------------------------- agents

  /** A provider id the host can launch (`default` is resolved by the host). */
  function providerFor(member: Member): string {
    return member.providerId || 'default'
  }

  async function createWorktree(r: string, mission: Mission, member: Member): Promise<{ path: string; branch: string | null }> {
    const name = safeName(member.name)
    const branch = `agent/${mission.id.slice(0, 8)}/${name}`
    const path = `${r.replace(/\\/g, '/')}/.worktrees/mission-${mission.id.slice(0, 8)}/${name}`
    if (!capabilities(ctx).git) return { path: r, branch: null }
    try {
      const inside = await git(r, ['rev-parse', '--is-inside-work-tree'])
      if (inside.code !== 0) return { path: r, branch: null }
      const exists = (await git(r, ['rev-parse', '--verify', `refs/heads/${branch}`])).code === 0
      const add = await git(r, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path])
      if (add.code !== 0) {
        // Already checked out there (respawn) — reuse it.
        const list = await git(r, ['worktree', 'list', '--porcelain'])
        if (list.stdout.replace(/\\/g, '/').includes(`worktree ${path}`)) return { path, branch }
        throw new Error(add.stderr.trim() || `git worktree add exited with ${add.code}`)
      }
      return { path, branch }
    } catch (e) {
      ctx.log.warn(`worktree for ${member.name} failed, working in the project dir:`, e)
      return { path: r, branch: null }
    }
  }

  async function spawnMember(missionId: string, memberId: string, task?: AgentTask) {
    const r = root()
    const o = { projectRoot: r }
    ui.setState((s) => ({ busy: { ...s.busy, [memberId]: true } }))
    try {
      let mission = find(missionId) ?? (await d.get(missionId, o))
      let member = membersOf(mission).find((m) => m.id === memberId)
      if (!member) throw new Error(`Member ${memberId} is not in mission ${missionId}`)
      await d.memberUpdate(missionId, memberId, { status: 'spawning', error: null }, o)
      try {
        // 1. Own git worktree + branch (falls back to the project dir outside git).
        const wt = await createWorktree(r, mission, member)
        member = await d.memberUpdate(missionId, memberId, { worktreePath: wt.path, branchName: wt.branch }, o)
        mission = await d.get(missionId, o)
        const all = membersOf(mission)
        const coordinator = isCoordinatorRole(member.role)

        // 2. Context + file scope through the provider's prepareWorktree hook.
        const allowed = coordinator ? [] : task?.allowedFiles ?? []
        let scoped = false
        if (capabilities(ctx).prepareWorktree) {
          try {
            scoped = await ctx.agents.prepareWorktree(providerFor(member), {
              worktreePath: wt.path,
              contextMarkdown: coordinator ? coordinatorOverlay(member, mission, r, all) : workerOverlay(member, mission, r, wt.path, task),
              scope: { allowedPaths: allowed, readOnlyPaths: [], coordinator },
            })
          } catch (e) {
            ctx.log.warn('prepareWorktree failed:', e)
          }
        }

        // 3. Launch the agent in the worktree (the host builds the command line).
        let prompt = coordinator
          ? buildOrchestratorPrompt(mission, r, all, extra.getState().issues[missionId] ?? (await d.issues(missionId, o)).items, member)
          : buildMemberPrompt(member, mission, r, task)
        if (!scoped && !coordinator) prompt += scopeNote(missionId, r, member.id, allowed)
        const h = await ctx.agents.launch({
          providerId: providerFor(member),
          projectRoot: r,
          cwd: wt.path,
          model: member.model || null,
          prompt,
          autoSubmit: true,
          role: member.role,
          missionId,
          memberId: member.id,
          title: `${member.name} [${member.role}]`,
          placement: 'new-tile',
        })
        await d.memberUpdate(
          missionId,
          memberId,
          { terminalId: h.id, status: 'working', ...(task && !task.id.startsWith('review-') ? { assignedIssueId: task.id } : {}) },
          o,
        )
        await note(r, missionId, `Spawned ${member.name} (${member.role}) in ${wt.path}, terminal ${h.id}`, member.id)
      } catch (e) {
        // `error` logs an error activity in the core.
        await d.memberUpdate(missionId, memberId, { status: 'error', error: `Failed to spawn: ${errorText(e)}` }, o).catch(() => {})
        throw e
      }
    } finally {
      ui.setState((s) => {
        const busy = { ...s.busy }
        delete busy[memberId]
        return { busy }
      })
      await refresh(r, missionId)
    }
  }

  async function stopMember(missionId: string, memberId: string) {
    const r = root()
    const member = memberOf(missionId, memberId)
    if (member?.terminalId) {
      try {
        await ctx.terminals.kill(member.terminalId)
      } catch {
        // already closed
      }
    }
    // `stopped` logs member_left in the core.
    await d.memberUpdate(missionId, memberId, { status: 'stopped' }, { projectRoot: r })
    await refresh(r, missionId)
  }

  async function issueTask(r: string, ref: string, allowedFiles?: string[]): Promise<AgentTask | undefined> {
    try {
      return taskFromIssue(await ctx.data.issues.get(ref, { projectRoot: r }), allowedFiles)
    } catch (e) {
      ctx.log.warn('proposed issue not found:', e)
      return undefined
    }
  }

  async function defs(): Promise<AgentDefinition[]> {
    if (extra.getState().agents.length === 0) await loadAgents()
    return extra.getState().agents
  }

  async function setProposal(r: string, missionId: string, proposalId: string, status: MissionProposalStatus) {
    await d.proposalSetStatus(missionId, proposalId, status, { projectRoot: r })
  }

  // ---------------------------------------------------------------- the model

  const m: MissionsModel = {
    missions,
    ui,
    extra,
    caps: () => capabilities(ctx),
    retain,
    root,

    select(id) {
      boundRoot ??= current()
      ui.setState({ selectedId: id })
      if (id) void loadDetail(id)
    },
    loadDetail,
    loadProgress: async (id) => {
      const r = current()
      if (r) await loadProgress(r, id)
    },
    loadOpenIssues,
    loadTemplates,
    loadAgents,

    async createMission(i) {
      const r = root()
      const mission = await d.create(
        { name: i.name, templateId: i.templateId ?? null, orchestratorMode: i.orchestratorMode ?? null, issueRefs: i.issueRefs ?? [] },
        { projectRoot: r },
      )
      missions.apply(r, mission)
      void quiet(loadProgress(r, mission.id))
      return mission
    },
    async updateMission(id, p) {
      const r = root()
      missions.apply(r, await d.update(id, p, { projectRoot: r }))
    },
    async deleteMission(id) {
      const r = root()
      await d.delete(id, { projectRoot: r })
      missions.remove(r, [id])
      if (ui.getState().selectedId === id) ui.setState({ selectedId: null })
    },
    async addMember(missionId, agentDefinitionId, name, model) {
      const r = root()
      const member = await d.memberAdd(missionId, { agentDefinitionId, name: name || null, model: model || null }, { projectRoot: r })
      await refresh(r, missionId)
      return member
    },
    async updateMember(missionId, memberId, p) {
      const r = root()
      await d.memberUpdate(missionId, memberId, p, { projectRoot: r })
      await refresh(r, missionId)
    },
    async removeMember(missionId, memberId) {
      const r = root()
      await d.memberRemove(missionId, memberId, { projectRoot: r })
      await refresh(r, missionId)
    },
    async assignIssues(missionId, refs) {
      if (refs.length === 0) return
      const r = root()
      await d.assignIssues(missionId, refs, { projectRoot: r })
      await Promise.all([loadIssues(r, missionId), loadProgress(r, missionId), loadOpenIssues()].map(quiet))
    },
    async sendMessage(missionId, content, toMemberId) {
      const r = root()
      await d.send(missionId, { content, toMemberId: toMemberId || null, kind: toMemberId ? 'assignment' : 'chat' }, { projectRoot: r })
      await quiet(loadMessages(r, missionId))
    },

    spawnMember,
    stopMember,
    async nudge(missionId, memberId) {
      const member = memberOf(missionId, memberId)
      if (member?.terminalId) await ctx.terminals.write(member.terminalId, nudgeText(missionId, root(), memberId))
    },
    focusTerminal(terminalId) {
      void ctx.terminals.focus(terminalId).catch((e) => ctx.log.warn('focus failed:', e))
    },
    async launchMission(missionId) {
      await m.updateMission(missionId, { status: 'active' })
      for (const member of membersOf(find(missionId))) {
        if (member.status === 'pending') await spawnMember(missionId, member.id).catch((e) => ctx.log.warn('spawn failed:', e))
      }
    },
    async stopAll(missionId) {
      for (const member of membersOf(find(missionId))) {
        if (member.status === 'working' || member.status === 'idle' || member.status === 'spawning') await stopMember(missionId, member.id)
      }
    },
    async startCoordinator(missionId) {
      const r = root()
      const all = await defs()
      const def = all.find((x) => x.role === 'scrum_master') ?? all.find((x) => x.role === 'tech_lead') ?? all[0]
      if (!def) throw new Error('No agent definitions available. Create one first.')
      let coordinator = membersOf(find(missionId)).find((x) => isCoordinatorRole(x.role))
      if (!coordinator) coordinator = await d.memberAdd(missionId, { agentDefinitionId: def.id, name: 'Coordinator', model: def.model }, { projectRoot: r })
      missions.apply(r, await d.update(missionId, { orchestratorMemberId: coordinator.id, status: 'active' }, { projectRoot: r }))
      await quiet(loadIssues(r, missionId))
      if (coordinator.status === 'pending' || coordinator.status === 'stopped' || coordinator.status === 'error') {
        await spawnMember(missionId, coordinator.id)
      }
    },
    async approveProposal(missionId, proposalId) {
      const r = root()
      const proposal = proposalsOf(find(missionId)).find((p) => p.id === proposalId) ?? proposalsOf(await d.get(missionId, { projectRoot: r })).find((p) => p.id === proposalId)
      if (!proposal) throw new Error('Proposal not found')
      await setProposal(r, missionId, proposalId, 'approved')
      missions.apply(r, await d.update(missionId, { status: 'active' }, { projectRoot: r }))
      const all = await defs()
      for (const agent of proposal.agents ?? []) {
        const def =
          (agent.agentDefinitionId && all.find((x) => x.id === agent.agentDefinitionId)) ||
          all.find((x) => x.role === agent.role) ||
          all.find((x) => x.role === 'fullstack')
        if (!def) continue
        const member = await d.memberAdd(missionId, { agentDefinitionId: def.id, name: agent.name, model: agent.model ?? null }, { projectRoot: r })
        const first = agent.issueIds?.[0]
        const task = first ? await issueTask(r, first, agent.allowedFiles ?? []) : undefined
        await refresh(r, missionId)
        await spawnMember(missionId, member.id, task).catch((e) => ctx.log.warn('spawn failed:', e))
      }
      await refresh(r, missionId)
    },
    async rejectProposal(missionId, proposalId) {
      const r = root()
      await setProposal(r, missionId, proposalId, 'rejected')
      const coordinator = membersOf(find(missionId)).find((x) => isCoordinatorRole(x.role))
      if (coordinator?.terminalId) await writeTerminal(coordinator.terminalId, rejectionNudge(missionId, r, coordinator.id))
      await refresh(r, missionId)
    },
    async merge(missionId, entryId, target = 'main') {
      const r = root()
      const o = { projectRoot: r }
      const entry = mergeQueueOf(find(missionId)).find((e) => e.id === entryId)
      if (!entry) return { success: false, message: 'Merge queue entry not found' }
      const record = async (status: MissionMergeStatus) => {
        await d.mergeUpdate(missionId, entryId, { status }, o).catch((e) => ctx.log.warn('merge-update failed:', e))
      }
      if (!capabilities(ctx).git) return { success: false, message: 'Running git is not available to this plugin' }
      await record('merging')
      let result: { success: boolean; message: string }
      try {
        const co = await git(r, ['checkout', target])
        if (co.code !== 0) throw new Error(`Failed to checkout '${target}': ${co.stderr.trim()}`)
        const mg = await git(r, ['merge', '--no-ff', '-m', `Merge agent branch '${entry.branchName}'`, entry.branchName])
        if (mg.code === 0) {
          result = { success: true, message: `Merged '${entry.branchName}' into '${target}'` }
        } else {
          const conflict = /conflict/i.test(mg.stderr + mg.stdout)
          if (conflict) await git(r, ['merge', '--abort'])
          result = { success: false, message: conflict ? `Merge conflict between '${entry.branchName}' and '${target}'. Merge aborted.` : `Merge failed: ${mg.stderr.trim()}` }
        }
      } catch (e) {
        result = { success: false, message: errorText(e) }
      }
      await record(result.success ? 'merged' : 'failed')
      await refresh(r, missionId)
      return result
    },
    async spawnReviewer(missionId, entryId) {
      const r = root()
      const entry = mergeQueueOf(find(missionId)).find((e) => e.id === entryId)
      if (!entry) throw new Error('Merge queue entry not found')
      const all = await defs()
      const qa = all.find((x) => x.role === 'qa') ?? all.find((x) => x.role === 'fullstack')
      if (!qa) throw new Error('No QA agent definition found')
      const reviewer = await d.memberAdd(missionId, { agentDefinitionId: qa.id, name: `Reviewer (${entry.branchName})` }, { projectRoot: r })
      await refresh(r, missionId)
      let ref: string | null = null
      if (entry.issueId) {
        try {
          ref = String((await ctx.data.issues.get(entry.issueId, { projectRoot: r })).number)
        } catch {
          ref = null
        }
      }
      await spawnMember(missionId, reviewer.id, reviewTask(missionId, r, reviewer.id, entry.branchName, ref))
    },
    async cleanup(missionId) {
      const r = root()
      await m.stopAll(missionId)
      const mission = await d.get(missionId, { projectRoot: r })
      let removed = 0
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
      if (capabilities(ctx).git) {
        for (const member of membersOf(mission)) {
          if (!member.worktreePath || norm(member.worktreePath) === norm(r)) continue
          const rm = await git(r, ['worktree', 'remove', '--force', norm(member.worktreePath)]).catch(() => null)
          if (rm?.code === 0) removed++
        }
        await git(r, ['worktree', 'prune']).catch(() => null)
      }
      if (mission.status !== 'completed' && mission.status !== 'cancelled') {
        missions.apply(r, await d.update(missionId, { status: 'completed' }, { projectRoot: r }))
      }
      await note(r, missionId, `Mission cleanup complete — ${removed} worktrees removed`)
      await refresh(r, missionId)
    },

    async upsertTemplate(t) {
      const r = root()
      const saved = await d.templates.upsert(t, { projectRoot: r })
      await quiet(loadTemplates())
      return saved
    },
    async deleteTemplate(id) {
      const r = root()
      await d.templates.delete(id, { projectRoot: r })
      await quiet(loadTemplates())
    },
    async upsertAgent(def) {
      const saved = await d.agentDefinitions.upsert(def)
      await quiet(loadAgents())
      return saved
    },
    async deleteAgent(id) {
      await d.agentDefinitions.delete(id)
      await quiet(loadAgents())
    },
  }
  models.set(ctx, m)
  return m
}

/** Run a UI action; failures become an error toast instead of a silent console error. */
export async function attempt<T>(ctx: PluginContext, title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    ctx.log.error(title, e)
    ctx.notifications.toast({ kind: 'error', title, body: errorText(e) })
    return undefined
  }
}
