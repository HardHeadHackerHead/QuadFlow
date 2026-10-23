/**
 * @quadflow/plugin-api — the QuadFlow plugin host API (plugin-system.md §6).
 *
 * One import for both isolation modes (§8.3, §8.4): this module only exports
 * `definePlugin`, types, constants and the React glue for the context object.
 * All functionality is reached through the `ctx` passed to `activate()` and to
 * tile components; the host builds it (trusted: `src/plugins/hostApi/` in the
 * host document, shared through the import map; sandboxed: the RPC client of
 * PL-6). Privileged calls are permission-checked in Rust (§7.1, §11.3) and
 * reject with a {@link HostError} (`code: 'permission_denied'`, …).
 *
 * Feature-detect with `ctx.api.has('<group>.<method>')` (§6.8), e.g.
 * `ctx.api.has('agents.launch')`.
 */
import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react'
import type * as G from './generated/types'
import type { Isolation, JsonValue, TileMode } from './generated/types'

export { PLUGIN_API_VERSION } from './version'

/** Domain types generated from Rust by tauri-specta (data-layer.md §9). */
export type * from './generated/types'

// ---------------------------------------------------------------------------
// §6.1 Plugin module contract
// ---------------------------------------------------------------------------

export interface PluginModule {
  activate?(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
  /** key = tile contribution id */
  tiles?: Record<string, ComponentType<TileProps>>
  miniWidgets?: Record<string, ComponentType<MiniWidgetProps>>
  settingsPages?: Record<string, ComponentType<SettingsPageProps>>
  commands?: Record<string, (ctx: PluginContext, args?: JsonValue) => unknown | Promise<unknown>>
  paletteProviders?: Record<string, PaletteProvider>
  /** key = `contributes.titleGenerators[].id` (API 1.3). */
  titleGenerators?: Record<string, TitleGenerator>
  /** agent-providers.md §4.2 (typed by AP-1). */
  agentProvider?: AgentProviderImpl
}

/** Identity helper that types a plugin module (`export default definePlugin({...})`). */
export function definePlugin(m: PluginModule): PluginModule {
  return m
}

/** A tool config as {@link UiApi.getToolConfig} returns it (API 1.4). */
export interface ToolConfigInfo {
  id: string
  name: string
  /** The tile / toolbar-item id in this plugin's manifest. */
  contributionId: string
  settings: Record<string, JsonValue>
}

export interface TileProps {
  ctx: PluginContext
  instance: { id: string; title: string; state: JsonValue }
  config: { id: string; name: string; settings: JsonValue }
  mode: TileMode
  visible: boolean
  setTitle(title: string): void
  /** Persisted with the tile instance (debounced). */
  setState(state: JsonValue): void
  setAttention(needsAttention: boolean): void
  close(): void
}
export interface MiniWidgetProps {
  ctx: PluginContext
  config: TileProps['config']
}
export interface SettingsPageProps {
  ctx: PluginContext
}

export interface PaletteItem {
  id: string
  title: string
  subtitle?: string
  keywords?: string[]
  run(): void | Promise<void>
}
export interface PaletteProvider {
  search(query: string, ctx: PluginContext): Promise<PaletteItem[]>
}

/** What the shell asks a {@link TitleGenerator} for (API 1.3). */
export interface TitleRequest {
  /** Text to summarize: an agent's first prompt, or a long session summary. */
  text: string
  /** Word range of the title (the user's "Word limit" setting). */
  minWords: number
  maxWords: number
  /** Terminal the title is for, when there is one. */
  terminalId?: string
}
/**
 * `contributes.titleGenerators[]` (API 1.3): generates short terminal titles.
 * The shell asks title generators first (in plugin-id order), then the agent
 * provider's `sessionTitle` hook, then the chat-API fallback. Resolve `null`
 * to pass (e.g. no model downloaded); a rejection is logged and also passes.
 */
export interface TitleGenerator {
  generate(req: TitleRequest, ctx: PluginContext): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Agent-provider hooks (agent-providers.md §4.2). Declared in the manifest's
// `contributes.agentProvider.hooks`; the shell calls them through
// `src/agents/providerRegistry.ts`. Errors are logged and treated as "no data".
// ---------------------------------------------------------------------------

/** One rate-limit window of an account (e.g. "Current session", "Current week"). */
export interface AgentUsageWindow {
  id: string
  label: string
  /** 0–100. */
  usedPercent: number
  /** Epoch ms, when known. */
  resetsAt?: number
  /** Human text as reported by the agent CLI, e.g. "Resets 5pm (Europe/Berlin)". */
  resetsText?: string
}
export interface AgentUsageSnapshot {
  providerId: string
  /** Epoch ms. */
  fetchedAt: number
  plan?: string
  windows: AgentUsageWindow[]
}
export interface AgentContextUsage {
  usedTokens: number
  limitTokens: number | null
  estimated: boolean
}
export interface AgentWorktreeScope {
  /** Project-relative paths the agent may write (empty = unrestricted). */
  allowedPaths: string[]
  /** Paths the agent must never write. */
  readOnlyPaths: string[]
  /** Coordinators may not write files at all. */
  coordinator: boolean
}
/** §4.2 names. */
export type UsageSnapshot = AgentUsageSnapshot
export type ContextUsage = AgentContextUsage
export type WorktreeScope = AgentWorktreeScope

export interface AgentProviderImpl {
  /** Account usage / rate-limit windows. The host enforces a cooldown (≥ 60 s). */
  usage?(ctx: PluginContext): Promise<AgentUsageSnapshot | null>
  /** Context-window usage of a session (terminal header meter). */
  contextUsage?(ctx: PluginContext, s: { sessionId: string; sessionPath: string; model: string | null }): Promise<AgentContextUsage | null>
  /** Human title/summary for a session (history lists, terminal titles). */
  sessionTitle?(ctx: PluginContext, s: G.AgentSessionInfo): Promise<string | null>
  /** Prepare a git worktree before an agent is launched in it (Missions). */
  prepareWorktree?(ctx: PluginContext, w: { worktreePath: string; scope: AgentWorktreeScope; contextMarkdown: string }): Promise<void>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `CoreError.code` values (data-layer.md §3). */
export type HostErrorCode = G.ErrorCode

/** Every rejected host call rejects with this (`instanceof HostError`). */
export class HostError extends Error {
  readonly code: HostErrorCode
  readonly details?: JsonValue
  constructor(code: HostErrorCode, message: string, details?: JsonValue) {
    super(message)
    this.name = 'HostError'
    this.code = code
    this.details = details
  }
  /** The permission a `permission_denied` error names, if any. */
  get permission(): string | undefined {
    const d = this.details as { permission?: unknown } | undefined
    return typeof d?.permission === 'string' ? d.permission : undefined
  }
}

// ---------------------------------------------------------------------------
// §6.2 Context
// ---------------------------------------------------------------------------

export type Disposable = () => void

export interface Logger {
  debug(...a: unknown[]): void
  info(...a: unknown[]): void
  warn(...a: unknown[]): void
  error(...a: unknown[]): void
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  rootKey: string
  /** `null` until loaded, or when `.quadflow/config.json` cannot be read. */
  config: G.ProjectConfig_Serialize | null
}
export interface ProjectApi {
  current(): ProjectInfo | null
  list(): Promise<ProjectInfo[]>
  onDidChange(cb: (p: ProjectInfo | null) => void): Disposable
}
export interface WorkspaceInfo {
  id: string
  name: string
}
export interface WorkspaceApi {
  current(): WorkspaceInfo | null
  onDidChange(cb: (w: WorkspaceInfo | null) => void): Disposable
}

// ---------------------------------------------------------------------------
// §6.3 Data — every method takes an optional trailing `{ projectRoot }`
// (default: the active project; `project_not_found` if none).
// Permissions: `data:<domain>:read` / `data:<domain>:write`.
// ---------------------------------------------------------------------------

/** Trailing per-call options of project-scoped data methods. */
export interface DataCallOptions {
  projectRoot?: string
}
type P = DataCallOptions
type L<T> = G.ListResult<T>

export interface IdeasDataApi {
  list(q?: G.IdeaQuery_Deserialize, o?: P): Promise<L<G.Idea_Serialize>>
  get(id: string, o?: P): Promise<G.Idea_Serialize>
  stats(o?: P): Promise<G.IdeaStats>
  create(i: G.NewIdea_Deserialize, o?: P): Promise<G.Idea_Serialize>
  update(id: string, p: G.IdeaPatch_Deserialize, o?: P): Promise<G.Idea_Serialize>
  delete(id: string, o?: P): Promise<void>
  merge(ids: string[], keep: string, o?: P): Promise<G.Idea_Serialize>
  addTag(id: string, tag: string, o?: P): Promise<G.Idea_Serialize>
  removeTag(id: string, tag: string, o?: P): Promise<G.Idea_Serialize>
  /** Add `tag` to every idea in `ids` (one transaction; an unknown id writes nothing). API 1.1. */
  bulkTag(ids: string[], tag: string, o?: P): Promise<G.Idea_Serialize[]>
  addNote(id: string, body: string, o?: P): Promise<G.Idea_Serialize>
  deleteNote(id: string, noteId: string, o?: P): Promise<G.Idea_Serialize>
  addSuggestion(id: string, kind: G.SuggestionKind, text: string, o?: P): Promise<G.Idea_Serialize>
  resolveSuggestion(id: string, suggestionId: string, accept: boolean, o?: P): Promise<G.Idea_Serialize>
  deleteSuggestion(id: string, suggestionId: string, o?: P): Promise<G.Idea_Serialize>
  revert(id: string, o?: P): Promise<G.Idea_Serialize>
}

export interface IssuesDataApi {
  list(q?: G.IssueQuery_Deserialize, o?: P): Promise<L<G.Issue_Serialize>>
  /** `ref` = id, `CODE-n`, `n` or `#n`. */
  get(ref: string, o?: P): Promise<G.Issue_Serialize>
  create(i: G.NewIssue_Deserialize, o?: P): Promise<G.Issue_Serialize>
  update(ref: string, p: G.IssuePatch_Deserialize, o?: P): Promise<G.Issue_Serialize>
  setStatus(ref: string, s: G.IssueStatus, o?: P): Promise<G.Issue_Serialize>
  close(ref: string, o?: P): Promise<G.Issue_Serialize>
  reopen(ref: string, o?: P): Promise<G.Issue_Serialize>
  delete(ref: string, o?: P): Promise<void>
  addComment(ref: string, body: string, o?: P): Promise<G.Issue_Serialize>
  deleteComment(ref: string, commentId: string, o?: P): Promise<G.Issue_Serialize>
  toggleCriterion(ref: string, criterionId: string, checked?: boolean, o?: P): Promise<G.Issue_Serialize>
  claim(ref: string, claim: G.ClaimInput_Deserialize, o?: P): Promise<G.Issue_Serialize>
  heartbeat(ref: string, o?: P): Promise<G.Issue_Serialize>
  release(ref: string, o?: P): Promise<G.Issue_Serialize>
  /** `CODE-n` from the (current) project's code; synchronous, from the cached config. */
  displayRef(issue: Pick<G.Issue_Serialize, 'number'>, o?: P): string
  labels: {
    list(o?: P): Promise<G.Label_Serialize[]>
    upsert(l: G.Label_Deserialize, renameFrom?: string | null, o?: P): Promise<G.Label_Serialize[]>
    delete(name: string, o?: P): Promise<G.Label_Serialize[]>
  }
  epics: {
    list(o?: P): Promise<L<G.Epic_Serialize>>
    get(id: string, o?: P): Promise<G.Epic_Serialize>
    create(e: G.NewEpic_Deserialize, o?: P): Promise<G.Epic_Serialize>
    update(id: string, p: G.EpicPatch_Deserialize, o?: P): Promise<G.Epic_Serialize>
    delete(id: string, o?: P): Promise<void>
  }
}

export interface PlansDataApi {
  list(q?: G.PlanQuery_Deserialize, o?: P): Promise<L<G.Plan_Serialize>>
  get(id: string, o?: P): Promise<G.Plan_Serialize>
  create(i: G.NewPlan_Deserialize, o?: P): Promise<G.Plan_Serialize>
  update(id: string, p: G.PlanPatch_Deserialize, o?: P): Promise<G.Plan_Serialize>
  delete(id: string, o?: P): Promise<void>
  stepAdd(planId: string, s: G.NewPlanStep_Deserialize, o?: P): Promise<G.Plan_Serialize>
  stepUpdate(planId: string, stepId: string, p: G.PlanStepPatch_Deserialize, o?: P): Promise<G.Plan_Serialize>
  stepDelete(planId: string, stepId: string, o?: P): Promise<G.Plan_Serialize>
  stepsReorder(planId: string, ids: string[], o?: P): Promise<G.Plan_Serialize>
  commentAdd(planId: string, c: { body: string; kind: G.PlanCommentKind }, o?: P): Promise<G.Plan_Serialize>
  commentDelete(planId: string, commentId: string, o?: P): Promise<G.Plan_Serialize>
  /** Needs `data:plans:write` and `data:issues:write`. */
  promoteStep(planId: string, stepId: string, o?: P): Promise<G.PlanPromotion_Serialize>
  promoteAll(planId: string, o?: P): Promise<G.PlanPromotion_Serialize>
}

export interface DiscoveryDataApi {
  list(q?: G.DiscoveryQuery_Deserialize, o?: P): Promise<L<G.DiscoveryProject_Serialize>>
  get(id: string, o?: P): Promise<G.DiscoveryProject_Serialize>
  create(i: G.NewDiscoveryProject_Deserialize, o?: P): Promise<G.DiscoveryProject_Serialize>
  update(id: string, p: G.DiscoveryPatch_Deserialize, o?: P): Promise<G.DiscoveryProject_Serialize>
  delete(id: string, o?: P): Promise<void>
  itemAdd(id: string, i: G.NewDiscoveryItem_Deserialize, o?: P): Promise<G.DiscoveryProject_Serialize>
  itemUpdate(id: string, itemId: string, p: G.DiscoveryItemPatch_Deserialize, o?: P): Promise<G.DiscoveryProject_Serialize>
  itemDelete(id: string, itemId: string, o?: P): Promise<G.DiscoveryProject_Serialize>
  itemsReorder(id: string, itemIds: string[], o?: P): Promise<G.DiscoveryProject_Serialize>
  linked(id: string, o?: P): Promise<G.DiscoveryLinks_Serialize>
}

export interface ScriptsDataApi {
  list(q?: G.ScriptQuery_Deserialize, o?: P): Promise<L<G.Script_Serialize>>
  get(id: string, o?: P): Promise<G.Script_Serialize>
  create(i: G.ScriptInput_Deserialize, o?: P): Promise<G.Script_Serialize>
  update(id: string, p: G.ScriptPatch_Deserialize, o?: P): Promise<G.Script_Serialize>
  delete(id: string, o?: P): Promise<void>
  resolveCommand(id: string, opts?: G.ScriptResolveOptions_Deserialize, o?: P): Promise<G.ScriptResolvedCommand_Serialize>
  groups: {
    list(o?: P): Promise<L<G.ScriptGroup_Serialize>>
    get(id: string, o?: P): Promise<G.ScriptGroup_Serialize>
    create(g: G.ScriptGroupInput_Deserialize, o?: P): Promise<G.ScriptGroup_Serialize>
    update(id: string, p: G.ScriptGroupPatch_Deserialize, o?: P): Promise<G.ScriptGroup_Serialize>
    delete(id: string, o?: P): Promise<void>
    addMember(groupId: string, m: G.ScriptGroupMemberInput_Deserialize, o?: P): Promise<G.ScriptGroup_Serialize>
    removeMember(groupId: string, scriptId: string, o?: P): Promise<G.ScriptGroup_Serialize>
  }
  environments: {
    list(): Promise<G.TerminalEnvironment_Serialize[]>
    /** Needs `data:scripts:write` (stores detected environments). */
    detect(): Promise<G.TerminalEnvironment_Serialize[]>
  }
}

export interface ShipDataApi {
  configGet(o?: P): Promise<G.ShipConfig_Serialize | null>
  configSave(c: G.ShipConfig_Deserialize, o?: P): Promise<G.ShipConfig_Serialize>
  validate(o?: P): Promise<G.ShipValidation>
  status(o?: P): Promise<G.ShipStatus_Serialize>
  readiness(o?: P): Promise<G.ShipReadinessCheck_Serialize[]>
  /** Streams run events; resolves with the finished run. Answer `externalRequest` events with `externalComplete`. */
  run(opts: G.ShipRunOptions, onEvent: (e: G.ShipRunEvent_Serialize) => void, o?: P): Promise<G.ShipRun_Serialize>
  externalComplete(requestId: string, result: G.ShipExternalResult_Deserialize): Promise<void>
  abort(runId?: string | null, o?: P): Promise<G.ShipRun_Serialize>
  runs(o?: P): Promise<L<G.ShipRun_Serialize>>
  runGet(id: string, o?: P): Promise<G.ShipRun_Serialize>
  // ---- API 1.4: setup, diagnostics, recovery ----
  /** Built-in pipeline templates (`data:ship:read`). */
  templates(): Promise<G.ShipTemplateInfo_Serialize[]>
  /** Write a config from a template (`data:ship:write`; `force` overwrites an existing one). */
  init(options: G.ShipInitOptions_Deserialize, o?: P): Promise<G.ShipConfig_Serialize>
  /** Installed release tools and project facts that templates use. */
  detect(o?: P): Promise<G.ShipEnvDetection_Serialize>
  /** Config file / parse / version-file diagnostics. */
  diagnostics(o?: P): Promise<G.ShipDiagnostics_Serialize>
  /** Re-run one readiness check. */
  readinessOne(checkId: string, o?: P): Promise<G.ShipReadinessCheck_Serialize>
  /** Run the check's own fix command (`data:ship:write`); streams its output, resolves with the re-run check. */
  runFix(checkId: string, onLine: (l: G.ShipLineEvent) => void, o?: P): Promise<G.ShipReadinessCheck_Serialize>
  /** Delete the config (a backup is kept; `data:ship:write`). */
  configDelete(o?: P): Promise<G.ShipConfigDeleteResult_Serialize>
  /** Restore orphan `*.ship-bak` files of a crashed run (`data:ship:write`); returns the restored paths. */
  restoreBackups(o?: P): Promise<string[]>
}

export interface ChatDataApi {
  conversations(o?: { projectRootKey?: string | null }): Promise<G.ChatConversation[]>
  get(id: string): Promise<G.ChatConversation>
  create(i: G.ChatConversationCreate): Promise<G.ChatConversation>
  messages(id: string): Promise<G.ChatMessage[]>
  /** Streams `ChatStreamEvent`s; resolves with the final result. */
  send(id: string, content: string, onEvent: (e: G.ChatStreamEvent_Serialize) => void): Promise<G.ChatSendResult>
  rename(id: string, title: string): Promise<G.ChatConversation>
  delete(id: string): Promise<void>
  // ---- API 1.4 ----
  /**
   * Endpoint settings (namespace `chat`). `hasApiKey` is true when a key is stored — the Chat
   * plugin's secret `apiKey` (read first) or `chat.apiKey` from `quadflow chat key set`; the key
   * itself is never returned. Changes arrive as `settings` change events with `chat/<key>` ids.
   */
  settingsGet(): Promise<G.ChatSettings>
  /** `data:chat:write`. */
  settingsUpdate(patch: G.ChatSettingsPatch_Deserialize): Promise<G.ChatSettings>
  /** Models the configured endpoint offers (default timeout 5 s). */
  models(timeoutMs?: number | null): Promise<string[]>
  /**
   * One question to the configured endpoint; nothing is stored (`data:chat:write`, as it uses
   * the user's endpoint and key). Rejects with the host's error when the request fails.
   */
  ask(question: string, o?: { systemPrompt?: string | null; model?: string | null }): Promise<string>
}

export interface MissionsDataApi {
  list(q?: { status?: G.MissionStatus | null }, o?: P): Promise<L<G.Mission_Serialize>>
  get(id: string, o?: P): Promise<G.Mission_Serialize>
  create(i: G.NewMission_Deserialize, o?: P): Promise<G.Mission_Serialize>
  update(id: string, p: G.MissionPatch_Deserialize, o?: P): Promise<G.Mission_Serialize>
  delete(id: string, o?: P): Promise<void>
  progress(id: string, o?: P): Promise<G.MissionProgress>
  /** Needs `data:issues:read` too. */
  issues(id: string, o?: P): Promise<L<G.Issue_Serialize>>
  memberAdd(id: string, m: G.MissionMemberAddInput_Deserialize, o?: P): Promise<G.MissionMember_Serialize>
  memberUpdate(id: string, memberRef: string, p: G.MissionMemberPatch_Deserialize, o?: P): Promise<G.MissionMember_Serialize>
  memberRemove(id: string, memberRef: string, o?: P): Promise<void>
  messages(id: string, q?: G.MissionMessageQuery_Deserialize, o?: P): Promise<L<G.MissionMessage_Serialize>>
  send(id: string, m: G.NewMissionMessage_Deserialize, o?: P): Promise<G.MissionMessage_Serialize>
  activity(id: string, q?: { since?: string | null; limit?: number | null }, o?: P): Promise<L<G.MissionActivity_Serialize>>
  /** Needs `data:issues:write` too. */
  assignIssues(id: string, issueRefs: string[], o?: P): Promise<G.Issue_Serialize[]>
  claimNextIssue(id: string, memberRef: string, o?: P): Promise<G.Issue_Serialize | null>
  // ---- API 1.4 ----
  /** Record the human's decision on a coordinator proposal. */
  proposalSetStatus(id: string, proposalId: string, status: G.MissionProposalStatus, o?: P): Promise<G.MissionProposal_Serialize>
  /** Update a merge-queue entry (status, priority, skip reason). */
  mergeUpdate(id: string, entryId: string, patch: G.MissionMergeEntryPatch_Deserialize, o?: P): Promise<G.MissionMergeEntry_Serialize>
  /** Append to the mission's activity log. */
  logActivity(id: string, activity: G.NewMissionActivity_Deserialize, o?: P): Promise<G.MissionActivity_Serialize>
  /** Mark messages read for `reader` (`'human'` or a member id) up to `upTo` (default: the newest). */
  markRead(id: string, reader: string, upTo?: string | null, o?: P): Promise<G.MissionReads_Serialize>
  templates: {
    list(o?: P): Promise<L<G.MissionTemplate_Serialize>>
    upsert(t: G.MissionTemplateInput_Deserialize, o?: P): Promise<G.MissionTemplate_Serialize>
    delete(id: string, o?: P): Promise<void>
  }
  agentDefinitions: {
    list(): Promise<G.AgentDefinition[]>
    upsert(d: G.AgentDefinitionInput_Deserialize): Promise<G.AgentDefinition>
    delete(id: string): Promise<void>
  }
}

export interface DataApi {
  ideas: IdeasDataApi
  issues: IssuesDataApi
  plans: PlansDataApi
  discovery: DiscoveryDataApi
  scripts: ScriptsDataApi
  ship: ShipDataApi
  chat: ChatDataApi
  missions: MissionsDataApi
  projectConfig: {
    get(o?: P): Promise<G.ProjectConfig_Serialize>
    /** Needs `project:config:write`. */
    update(p: G.ProjectConfigPatch_Deserialize, o?: P): Promise<G.ProjectConfig_Serialize>
  }
  /** Change events of the given domains (each needs its `data:<domain>:read`). */
  onDidChange(filter: { domain: G.Domain | G.Domain[]; projectRoot?: string }, cb: (e: G.ChangeEvent) => void): Disposable
  /** Keep a non-active project's watcher alive (external edits produce events). */
  watchProject(projectRoot: string): Disposable
}

// ---------------------------------------------------------------------------
// §6.4 Terminals and agents
// ---------------------------------------------------------------------------

export interface SpawnTerminalOptions {
  /** Default: project root. */
  cwd?: string
  shell?: 'default' | 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'sh'
  /**
   * Absolute path of the shell executable (e.g. `scripts.resolveCommand().shellPath`,
   * Git Bash's `bash.exe`); overrides `shell` and the environment's shell. API 1.2.
   */
  shellPath?: string
  environmentId?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** Typed into the shell after start (user-authored content only). */
  initCommands?: string[]
  /** `'none'` = headless (default). */
  placement?: 'none' | 'tile' | 'split-active' | 'replace-empty'
  title?: string
}
export interface TerminalHandle {
  id: string
  pid: number | null
  cwd: string
}
export interface TerminalSummary {
  id: string
  title: string
  cwd: string
  ownerPluginId: string | null
  /** Not filled by the host yet (always `null`; use `agents.onSessionLinked`). */
  agent: G.AgentBinding | null
}
export interface TerminalsApi {
  /** `terminal:spawn` */
  spawn(o: SpawnTerminalOptions): Promise<TerminalHandle>
  /** Own terminals; all with `terminal:io`. */
  list(): Promise<TerminalSummary[]>
  /** Own, or `terminal:io`. */
  write(id: string, data: string): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  kill(id: string): Promise<void>
  onData(id: string, cb: (chunk: string) => void): Disposable
  onExit(id: string, cb: (e: { code: number | null }) => void): Disposable
  /** Scrollback snapshot (own terminals from spawn; others from the first read on). */
  readBuffer(id: string, maxBytes?: number): Promise<string>
  /** Make the terminal the active one in the layout (own, or `terminal:io`). API 1.4. */
  focus(id: string): Promise<void>
  /** Trusted only: mount an xterm view of the terminal into `el`. */
  attach(id: string, el: HTMLElement): Disposable
}

/**
 * agent-providers.md §5 (generated from AP-1's core types). `isDefault` (API 1.4): the provider
 * `"default"` resolves to (setting `agents.defaultProvider`, else the first installed one).
 */
export type ProviderInfo = G.AgentProviderInfo & { isDefault: boolean }
/** Options of {@link AgentsApi.oneShot}. */
export interface AgentOneShotOptions {
  prompt: string
  /** Absolute existing directory; default: the active project's root. */
  cwd?: string
  /** Default: the default provider when it has a one-shot mode, else the first provider that has one. */
  providerId?: string
}
/** Options of {@link AgentsApi.prepareWorktree}. */
export interface AgentPrepareWorktreeOptions {
  /** Absolute existing directory (the agent's git worktree). */
  worktreePath: string
  contextMarkdown: string
  scope: AgentWorktreeScope
}
export type DetectionResult = G.AgentDetection
export type ModelInfo = G.AgentModelInfo
/** `AgentLaunchOptions` + the project to launch for (default: the active project). */
export type LaunchAgentOptions = G.AgentLaunchOptions & {
  projectRoot?: string
  /**
   * With `issueRef`: close the agent's terminal once the issue reaches `qa` /
   * `done` and the agent has exited (shell-side; default: the user's setting
   * "auto-close issue terminals"). API 1.2.
   */
  closeOnIssueDone?: boolean
}
export interface AgentLaunchHandle extends TerminalHandle {
  /** A new PTY was created (the host places it in the layout). */
  createdTerminal: boolean
  binding: G.AgentBinding
}
/** Options of {@link AgentsApi.usage}. */
export interface AgentUsageRequest {
  /** Only this provider (default: every provider whose manifest declares the `usage` hook). */
  providerId?: string
  /** Reuse a snapshot younger than this (seconds; clamped to ≥ 60, the host minimum). */
  cooldownSeconds?: number
  /** Re-run the hook unless the last run is younger than the host minimum (60 s). */
  force?: boolean
}
export interface AgentsApi {
  /** `agents:read` */
  providers(): Promise<ProviderInfo[]>
  detect(providerId: string): Promise<DetectionResult>
  models(providerId: string): Promise<ModelInfo[]>
  /**
   * `agents:read` — account usage windows from the providers' `usage` hooks
   * (agent-providers.md §4.2), run by the host with its cooldown. One snapshot
   * per provider that reported data; providers without data are left out.
   */
  usage(o?: AgentUsageRequest): Promise<AgentUsageSnapshot[]>
  /**
   * `agents:launch`. A terminal the launch creates (`createdTerminal`) belongs
   * to the calling plugin like a `terminals.spawn` one (API 1.2): it may
   * `onData` / `onExit` / `readBuffer` / `write` / `kill` it without `terminal:io`.
   */
  launch(o: LaunchAgentOptions): Promise<AgentLaunchHandle>
  /**
   * `agents:launch` (API 1.4) — run a prompt non-interactively (the provider's one-shot mode,
   * prompt on stdin) and resolve with its output.
   */
  oneShot(o: AgentOneShotOptions): Promise<string>
  /**
   * `agents:read` (API 1.4) — where every active provider keeps its session transcripts:
   * `glob` is relative to `root`; `cwdSegments` leading segments below `root` encode the project.
   */
  sessionRoots(): Promise<{ providerId: string; root: string; glob: string; cwdSegments: number }[]>
  /**
   * `agents:launch` (API 1.4) — run the provider's `prepareWorktree` hook (context file + file
   * scope) for an agent about to be launched in `worktreePath`. `providerId` may be `"default"`.
   * Resolves `false` when the provider declares no such hook.
   */
  prepareWorktree(providerId: string, w: AgentPrepareWorktreeOptions): Promise<boolean>
  onSessionLinked(cb: (e: { terminalId: string; providerId: string; sessionId: string }) => void): Disposable
}

// ---------------------------------------------------------------------------
// §6.5 Events, storage, settings, secrets
// ---------------------------------------------------------------------------

export type HostTopic =
  | 'project.changed'
  | 'workspace.changed'
  | 'theme.changed'
  | 'settings.changed'
  | 'terminal.created'
  | 'terminal.exited'
  | 'agent.sessionLinked'
  | 'plugin.activated'
  | 'plugin.deactivated'

export interface EventsApi {
  on(topic: HostTopic, cb: (payload: JsonValue) => void): Disposable
  /** Published as `"<pluginId>:<topic>"`. */
  emit(topic: string, payload?: JsonValue): void
  onPlugin(pluginId: string, topic: string, cb: (payload: JsonValue) => void): Disposable
}

export type StorageScope = 'global' | 'project'
/** plugin_kv; no permission needed; 1 MiB per value, 50 MiB per plugin. */
export interface StorageApi {
  get<T = JsonValue>(key: string, scope?: StorageScope): Promise<T | undefined>
  set(key: string, value: JsonValue, scope?: StorageScope): Promise<void>
  delete(key: string, scope?: StorageScope): Promise<void>
  keys(prefix?: string, scope?: StorageScope): Promise<string[]>
}
/** Namespace `plugin:<id>`; schema = `contributes.settings` (validated in Rust). */
export interface SettingsApi {
  /** Synchronous: cached snapshot (defaults from the schema included). */
  get<T = JsonValue>(key: string): T | undefined
  getAll(): Record<string, JsonValue>
  set(key: string, value: JsonValue): Promise<void>
  onDidChange(cb: (key: string, value: JsonValue) => void): Disposable
}
/** Permission `secrets`; keychain entries `plugin:<id>:<name>`. */
export interface SecretsApi {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

// ---------------------------------------------------------------------------
// §6.6 Notifications, fs, shell, http, clipboard
// ---------------------------------------------------------------------------

export interface NotificationsApi {
  toast(t: { title: string; body?: string; kind?: 'info' | 'success' | 'warning' | 'error'; action?: { label: string; command: string } }): void
  /** `notifications` */
  system(n: { title: string; body?: string }): Promise<void>
  /** Tile glow / taskbar flash. */
  attention(instanceId: string, on: boolean): void
}

export type FsScope = 'project' | 'pluginData' | 'projectPluginData' | 'projectPluginLocal' | 'home' | 'absolute'
export interface FsEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  modifiedAt: number
}
export interface FsStat {
  kind: 'file' | 'dir'
  size: number
  modifiedAt: number
}
/**
 * Paths are relative to the scope root (default `'project'`); `..`, absolute
 * paths and symlink escapes are rejected in Rust. `'absolute'` needs
 * `fs:*:any` or a path picked with `ui.pickFile`. The project's `.quadflow/`
 * folder is not reachable through `'project'` (use `data.*`).
 */
export interface FsApi {
  readText(path: string, scope?: FsScope): Promise<string>
  readBytes(path: string, scope?: FsScope): Promise<Uint8Array>
  /** Atomic (data-layer.md §4.1); creates parent folders. */
  writeText(path: string, content: string, scope?: FsScope): Promise<void>
  writeBytes(path: string, content: Uint8Array, scope?: FsScope): Promise<void>
  list(path: string, scope?: FsScope): Promise<FsEntry[]>
  stat(path: string, scope?: FsScope): Promise<FsStat | null>
  remove(path: string, scope?: FsScope, o?: { recursive?: boolean }): Promise<void>
  mkdir(path: string, scope?: FsScope): Promise<void>
  watch(path: string, scope: FsScope, cb: (e: { paths: string[] }) => void): Disposable
}

export interface ExecOptions {
  /** Bare program name (resolved from PATH); needs `shell:exec:<program>`. */
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  stdin?: string
}
export type ShellSpawnEvent = { stream: 'stdout' | 'stderr'; data: string } | { exit: number | null }
export interface ShellApi {
  exec(o: ExecOptions): Promise<{ code: number | null; stdout: string; stderr: string }>
  spawn(o: ExecOptions, onEvent: (e: ShellSpawnEvent) => void): Promise<{ kill(): Promise<void> }>
  /** `shell:open-external` (http/https/mailto only). */
  openExternal(url: string): Promise<void>
  /** Read permission of the scope. */
  revealInFileManager(path: string, scope?: FsScope): Promise<void>
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  text(): string
  json<T = JsonValue>(): T
}
/** `network:<host>` / `network:*`; executed in Rust; 50 MiB cap; redirects are returned, not followed. */
export interface HttpApi {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  ): Promise<HttpResponse>
}
export interface ClipboardApi {
  /** `clipboard:read` */
  readText(): Promise<string>
  /** `clipboard:write` */
  writeText(t: string): Promise<void>
  writeImage(png: Uint8Array): Promise<void>
}

// ---------------------------------------------------------------------------
// §6.7 Sidecar, commands, UI, overlay, native
// ---------------------------------------------------------------------------

export interface SidecarStatus {
  state: 'stopped' | 'starting' | 'running' | 'restarting' | 'failed'
  restarts: number
  lastError?: string
  /** OS process id while running. */
  pid?: number
}
/**
 * The plugin's own sidecar process (plugin-system.md §10), declared in the
 * manifest's `sidecar`. `api.has('sidecar.request')` is true only for plugins
 * that declare one. Started on the first request/notify (or at startup for
 * `activation: "onStartup"`); restarted with backoff after a crash; `failed`
 * after 5 crashes in 5 minutes until `restart()`.
 */
export interface SidecarApi {
  /** Methods starting with `$/`, `host/`, `cli/`, `ui/` and the lifecycle methods are reserved. Default timeout 30 s. */
  request<T = JsonValue>(method: string, params?: JsonValue, opts?: { timeoutMs?: number }): Promise<T>
  notify(method: string, params?: JsonValue): void
  /** The sidecar's `ui/<method>` notifications. (Its `host/emit` goes to `ctx.events.onPlugin(<own id>, topic, …)`.) */
  onNotification(method: string, cb: (params: JsonValue) => void): Disposable
  status(): Promise<SidecarStatus>
  onStatus(cb: (s: SidecarStatus) => void): Disposable
  restart(): Promise<void>
  /** Last 200 lines of its stderr and `host/log` output. */
  logs(): Promise<string[]>
}
export interface CommandsApi {
  /** `id` must be declared in the manifest (`contributes.commands`). */
  register(id: string, handler: (args?: JsonValue) => unknown): Disposable
  /** `"<plugin>/<cmd>"` or `"core/<cmd>"`. */
  execute<T = unknown>(id: string, args?: JsonValue): Promise<T>
}

/** Resolved theme tokens (plugin-system.md §14.1; same shape as `@quadflow/ui` `ThemeSnapshot`). */
export interface ThemeSnapshot {
  mode: 'dark' | 'light'
  preference: 'dark' | 'light' | 'system'
  colors: Record<string, string>
  terminal: Record<string, string>
  scalars: Record<string, string>
}
export interface UiApi {
  /**
   * Resolves with the new tile instance id. `state` becomes the new tile's
   * `instance.state` (pane tiles; honoured since API 1.2 — `@quadflow/plugin-kit`
   * `openTileWithState` also covers older hosts).
   */
  openTile(
    contributionId: string,
    o?: { state?: JsonValue; placement?: 'split-active' | 'replace-empty' | 'flyout'; toolConfigId?: string },
  ): Promise<string>
  closeTile(instanceId: string): void
  focusTile(instanceId: string): void
  /**
   * One of this plugin's tiles was closed for good (not merely unmounted: hidden
   * flyouts, layout changes and workspace switches unmount tiles too). Release
   * what the tile owned — its PTY, child webview, … API 1.2; feature-detect with
   * `api.has('ui.onTileClosed')`.
   */
  onTileClosed(cb: (e: { instanceId: string; contributionId: string }) => void): Disposable
  /**
   * A tool config of one of this plugin's contributions (tile or toolbar item), e.g. the
   * `toolConfigId` a toolbar command receives; `null` for unknown ids or another plugin's. API 1.4.
   */
  getToolConfig(id: string): Promise<ToolConfigInfo | null>
  /**
   * Merge `settings` into that tool config's settings (the manifest `configSchema` fields; a key
   * set to `null` is removed) and resolve with the updated config. Own configs only. API 1.4.
   */
  updateToolConfigSettings(id: string, settings: Record<string, JsonValue>): Promise<ToolConfigInfo>
  confirm(o: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>
  prompt(o: { title: string; label?: string; initial?: string }): Promise<string | null>
  /** Open Settings at one of this plugin's `contributes.settingsPages` (API 1.4); unknown ids reject `not_found`. */
  openSettings(pageId: string): Promise<void>
  /** Picked paths join this plugin's fs `'absolute'` allowlist for the session. */
  pickFile(o?: { directory?: boolean; multiple?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<string[] | null>
  theme(): ThemeSnapshot
  onThemeChange(cb: (t: ThemeSnapshot) => void): Disposable
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}
export interface OverlayApi {
  isAnyOpen(): boolean
  /** CSS px, viewport coordinates. */
  onChange(cb: (s: { anyOpen: boolean; rects: Rect[] }) => void): Disposable
  /** The plugin's own overlays (menus/modals not built with `@quadflow/ui`). */
  register(id: string, open: boolean): void
}
export interface TileGeometry {
  css: Rect
  physical: Rect
  scaleFactor: number
  /** False while an overlay intersects the tile, it is minimized/hidden, or the workspace changed. */
  visible: boolean
}
export interface ChildWebview {
  id: string
  navigate(url: string): Promise<void>
  eval(js: string): Promise<void>
  close(): Promise<void>
}
/** {@link NativeApi.monitorOf} (API 1.4). Physical pixels; `scaleFactor` = DPR of that monitor. */
export interface MonitorInfo {
  name: string | null
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
}
/** `native:windows` / `native:webview` / `native:screen-capture`. */
export interface NativeApi {
  /** HWND (Windows) / NSWindow pointer (macOS), decimal string. */
  mainWindowHandle(): Promise<string>
  tileGeometry(instanceId: string): TileGeometry
  /** Fires on resize/move/visibility/overlay changes. Native views **must** hide on `visible: false`. */
  onTileGeometry(instanceId: string, cb: (g: TileGeometry) => void): Disposable
  /**
   * Trusted only. The host keeps the webview on the tile and hides it under overlays.
   * `anchor` (API 1.2): CSS selector of an element inside the tile that the webview
   * covers instead of the whole tile (e.g. the area below the plugin's own toolbar). It
   * is looked up in the tile on every update, so it survives remounts and follows the
   * element's size; while it is missing the webview is hidden. API 1.4: `anchor` may also be
   * the element itself (hidden while it is detached), and `userAgent` overrides the webview's
   * user agent (e.g. a mobile layout).
   */
  createChildWebview(o: { instanceId: string; url: string; anchor?: string | HTMLElement; userAgent?: string }): Promise<ChildWebview>
  /**
   * `native:webview` (API 1.4): a separate top-level window showing an http(s) `url` (e.g. a
   * pop-out player). The handle navigates / evals / closes it like a child webview.
   */
  openWindow(o: { url: string; title?: string; width?: number; height?: number; userAgent?: string }): Promise<ChildWebview>
  /**
   * `native:windows` (API 1.4): the monitor the tile is on (its center), in physical pixels —
   * e.g. to map screen positions onto an OBS canvas. `null` when the tile is not mounted.
   */
  monitorOf(instanceId: string): Promise<MonitorInfo | null>
  /** Absolute physical pixels → PNG. */
  captureRegion(r: Rect): Promise<Uint8Array>
  /** `native:windows`, Windows only (API 1.4): let process `pid` take the foreground (AllowSetForegroundWindow) — call it from a user action before the plugin's sidecar focuses that process's window. */
  allowSetForeground(pid: number): Promise<void>
}

export interface PluginContext {
  readonly plugin: { id: string; version: string; isolation: Isolation }
  /** `has('<group>.<method>')`: does this host implement it (in this isolation mode)? */
  readonly api: { version: string; has(method: string): boolean }
  readonly log: Logger
  readonly project: ProjectApi
  readonly workspace: WorkspaceApi
  readonly data: DataApi
  readonly terminals: TerminalsApi
  readonly agents: AgentsApi
  readonly events: EventsApi
  readonly storage: StorageApi
  readonly settings: SettingsApi
  readonly secrets: SecretsApi
  readonly notifications: NotificationsApi
  readonly fs: FsApi
  readonly shell: ShellApi
  readonly http: HttpApi
  readonly clipboard: ClipboardApi
  readonly sidecar: SidecarApi
  readonly commands: CommandsApi
  readonly ui: UiApi
  readonly overlay: OverlayApi
  readonly native: NativeApi
}

// ---------------------------------------------------------------------------
// React glue: the host provides the context of the plugin a component belongs
// to, so deep components need not drill `ctx` through props.
// ---------------------------------------------------------------------------

const PluginReactContext = createContext<PluginContext | null>(null)
PluginReactContext.displayName = 'QuadFlowPluginContext'

/** Host-side provider (TileHost and the sandbox runtime wrap every tile in it). */
export function PluginContextProvider(props: { value: PluginContext; children?: ReactNode }) {
  return createElement(PluginReactContext.Provider, { value: props.value }, props.children)
}

/**
 * The `PluginContext` of the plugin rendering this component. Throws when used
 * outside a QuadFlow tile (e.g. the module was bundled instead of shared).
 */
export function usePluginContext(): PluginContext {
  const ctx = useContext(PluginReactContext)
  if (!ctx) {
    throw new Error('usePluginContext() must be used inside a QuadFlow plugin tile')
  }
  return ctx
}
