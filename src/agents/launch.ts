/**
 * Every agent launch in the shell goes through here (agent-providers.md §8.2):
 * the core builds and quotes the command line from the provider's manifest
 * (`agents_launch` / `agents_relaunch`), spawns or reuses the PTY and delivers
 * the prompt; this module only fills in user defaults, places the terminal in
 * the layout and stores the returned `AgentBinding` on it.
 */
import {
  commands,
  type AgentApprovalMode,
  type AgentBinding,
  type AgentLaunchOptions,
  type AgentLaunchResult,
  type AgentRelaunchOptions,
} from '../generated/bindings'
import { call } from '../lib/core'
import { useAgentModelsStore } from '../lib/core/agents'
import { useTerminalStore } from '../stores/terminalStore'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useTitleSettingsStore } from '../stores/titleSettingsStore'
import { generateTitle } from '../lib/titles'
import type { TerminalState } from '../types'
import { ensureProviders, getProviderInfo, resolveDefaultProviderId, supportedApprovalMode, SYSTEM_DEFAULT_MODEL_ID } from './providers'

export { SYSTEM_DEFAULT_MODEL_ID }

export interface ShellAgentLaunch extends Omit<AgentLaunchOptions, 'providerId'> {
  /** Provider id; omitted / `"default"` = the user's default provider. */
  providerId?: string | null
  /** Project the agent works for (default: the active project). */
  projectRoot?: string
  /** Shell-only terminal metadata (title, linked issue, team, …). */
  terminal?: Partial<TerminalState>
  /** `false` = do not put a newly created terminal into the layout. */
  place?: boolean
}

function newTerminalId(): string {
  return `term:${crypto.randomUUID()}`
}

/** The user's default model of a provider (`agents.defaultModel.<id>` / catalog default). */
export async function defaultModelId(providerId: string): Promise<string> {
  const list = await useAgentModelsStore.getState().load(providerId).catch(() => [])
  return list.find((m) => m.isDefault)?.id ?? SYSTEM_DEFAULT_MODEL_ID
}

/** Settings → Agents defaults for a provider. */
export function providerDefaults(providerId: string): { effort: string | null; approvalMode: AgentApprovalMode } {
  const s = useAppSettingsStore.getState().agentDefaults
  const p = getProviderInfo(providerId)
  const effort = s.defaultEffort[providerId] ?? null
  return {
    effort: effort && p?.efforts?.values.includes(effort) ? effort : null,
    approvalMode: supportedApprovalMode(p, s.defaultApprovalMode[providerId] ?? 'default'),
  }
}

function defaultEnvironmentId(): string | null {
  const env = useAppSettingsStore.getState().environments
  const id = env.defaultEnvironmentId
  return id && env.terminalEnvironments.some((e) => e.id === id) ? id : null
}

function activeProjectRoot(): string {
  return useTerminalStore.getState().globalWorkingDirectory
}

/** Store a binding on a terminal (and mark it live so no resume overlay shows). */
export function applyBinding(terminalId: string, binding: AgentBinding, extra?: Partial<TerminalState>): void {
  useTerminalStore.getState().updateTerminal(terminalId, { agent: binding, hasAutoResumed: true, hasExited: false, ...extra })
}

/** Show a terminal created by the core (agent launch) in the layout with its binding. */
export function placeAgentTerminal(r: { terminalId: string; binding: AgentBinding; cwd?: string }, extra?: Partial<TerminalState>): void {
  const store = useTerminalStore.getState()
  if (!store.terminals.has(r.terminalId)) {
    store.addTerminal({ id: r.terminalId, cwd: r.cwd || extra?.workingDirectory || activeProjectRoot() })
  }
  applyBinding(r.terminalId, r.binding, extra)
}

/**
 * Launch an agent. Unset model / effort / approval mode fall back to the
 * user's per-provider defaults. Resolves `null` (after logging) when no
 * provider is available.
 */
export async function launchAgent(o: ShellAgentLaunch = {}): Promise<AgentLaunchResult | null> {
  await ensureProviders()
  const providerId = await resolveDefaultProviderId(o.providerId)
  if (!providerId) {
    console.error('[agents] no agent provider plugin is enabled')
    return null
  }
  const defaults = providerDefaults(providerId)
  const projectRoot = o.projectRoot || activeProjectRoot()
  const { terminal: extra, place, ...rest } = o
  delete rest.projectRoot
  const options: AgentLaunchOptions = {
    ...rest,
    providerId,
    model: o.model !== undefined ? o.model : await defaultModelId(providerId),
    effort: o.effort !== undefined ? o.effort : defaults.effort,
    approvalMode: supportedApprovalMode(getProviderInfo(providerId), o.approvalMode ?? defaults.approvalMode),
    autoSubmit: o.autoSubmit ?? useAppSettingsStore.getState().aiAgent.autoSubmitPrompt,
    environmentId: o.environmentId !== undefined ? o.environmentId : defaultEnvironmentId(),
    terminalId: o.terminalId || newTerminalId(),
    cwd: o.cwd || projectRoot,
  }
  const r = await call(commands.agentsLaunch(projectRoot, options))
  const meta: Partial<TerminalState> = {
    originalPrompt: o.prompt?.trim() ? o.prompt : '[Interactive session]',
    ...extra,
  }
  if (r.createdTerminal && place !== false) placeAgentTerminal({ ...r, cwd: options.cwd ?? projectRoot }, meta)
  else if (useTerminalStore.getState().terminals.has(r.terminalId)) applyBinding(r.terminalId, r.binding, r.createdTerminal ? meta : undefined)
  if (o.prompt?.trim() && extra?.titleSource !== 'manual') void maybeGenerateTitle(r.terminalId, o.prompt)
  return r
}

/**
 * Start the default agent with a (slash) command as its first prompt — the
 * tool views' "run skill" buttons. Resolves when the terminal exists.
 */
export function runAgentCommand(command: string, terminal?: Partial<TerminalState>): Promise<AgentLaunchResult | null> {
  return launchAgent({ prompt: command, autoSubmit: true, terminal: { originalPrompt: command, ...terminal } })
}

/** Exit the agent in a terminal and launch it again (approval mode / model switch, resume). */
export async function relaunchAgent(terminalId: string, o: AgentRelaunchOptions): Promise<AgentBinding | null> {
  const t = useTerminalStore.getState().terminals.get(terminalId)
  if (!t?.agent) return null
  const binding = await call(commands.agentsRelaunch(activeProjectRoot(), terminalId, t.agent, o))
  applyBinding(terminalId, binding)
  return binding
}

/**
 * Start the agent of a restored terminal again in its (fresh) shell:
 * `resume` = continue the bound session, else a new session with the same
 * provider, model, effort and approval mode.
 */
export async function restartAgentInTerminal(
  terminalId: string,
  o: { resume: boolean; approvalMode?: AgentApprovalMode },
): Promise<AgentBinding | null> {
  const t = useTerminalStore.getState().terminals.get(terminalId)
  const b = t?.agent
  if (!t || !b) return null
  const r = await launchAgent({
    providerId: b.providerId,
    terminalId,
    placement: 'terminal',
    cwd: t.workingDirectory || undefined,
    model: b.model ?? SYSTEM_DEFAULT_MODEL_ID,
    effort: b.effort ?? null,
    approvalMode: o.approvalMode ?? b.approvalMode ?? 'default',
    resumeSessionId: o.resume ? b.sessionId ?? null : null,
    role: b.role ?? null,
    roleLabel: b.roleLabel ?? null,
    missionId: b.missionId ?? null,
    memberId: b.memberId ?? null,
    syncEnabled: b.syncEnabled ?? true,
    environmentId: null,
  })
  if (r && b.issueId) applyBinding(terminalId, { ...r.binding, issueId: b.issueId })
  return r?.binding ?? null
}

/** Non-interactive run of a provider with the prompt on stdin (commit messages, titles). */
export async function oneShot(prompt: string, o: { providerId?: string | null; cwd?: string } = {}): Promise<string> {
  await ensureProviders()
  const preferred = await resolveDefaultProviderId(o.providerId)
  const p = getProviderInfo(preferred)
  const id = p?.hasOneShot ? p.id : (await ensureProviders()).find((x) => x.hasOneShot)?.id
  if (!id) throw new Error('No enabled agent provider supports non-interactive runs')
  return call(commands.agentsOneShot(id, o.cwd || activeProjectRoot(), prompt))
}

/**
 * Title from the first prompt (src/lib/titles.ts). With no generator the
 * terminal keeps showing the prompt; the session-summary poller picks up the
 * provider's session title later.
 */
async function maybeGenerateTitle(terminalId: string, prompt: string): Promise<void> {
  if (!useTitleSettingsStore.getState().settings.enabled || !prompt.trim()) return
  try {
    const result = await generateTitle(prompt, { terminalId, session: false, fallback: false })
    if (!result) return
    const t = useTerminalStore.getState().terminals.get(terminalId)
    if (!t || t.titleSource === 'manual') return
    useTerminalStore.getState().updateTerminal(terminalId, { title: result.title, titleSource: 'auto' })
  } catch (err) {
    console.error('Failed to auto-generate title:', err)
  }
}
