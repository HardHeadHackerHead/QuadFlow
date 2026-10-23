/**
 * Launching an agent with a prompt through `ctx.agents` (no shell stores, no
 * raw terminal writes): the provider plugin decides how the prompt is
 * delivered; the shell places the new terminal.
 */
import type { AgentApprovalMode, AgentLaunchHandle, LaunchAgentOptions, PluginContext, ProviderInfo } from '@quadflow/plugin-api'

let cached: Promise<ProviderInfo[]> | null = null

/** Installed agent providers (cached for the session; failures are not cached). */
export function agentProviders(ctx: PluginContext): Promise<ProviderInfo[]> {
  if (!cached) {
    cached = ctx.agents.providers().catch((e) => {
      cached = null
      throw e
    })
  }
  return cached
}

/**
 * The least restrictive approval mode short of "bypass" that the provider
 * offers (`auto`, else `accept-edits`, else `default`) — for unattended work
 * such as fixing a failed build, where a prompt per edited file would stall.
 */
export function unattendedApprovalMode(p: Pick<ProviderInfo, 'approvalModes'> | null | undefined): AgentApprovalMode {
  for (const m of ['auto', 'accept-edits'] as AgentApprovalMode[]) if (p?.approvalModes.includes(m)) return m
  return 'default'
}

export interface LaunchOptions {
  /** Provider id; default: `preferred` if registered, else the user's default provider, else the first one. */
  providerId?: string
  preferred?: string
  /** Submit the prompt right away (slash commands) or leave it for editing. */
  autoSubmit?: boolean
  /** `'unattended'` = {@link unattendedApprovalMode} of the chosen provider. */
  approvalMode?: AgentApprovalMode | 'unattended'
  title?: string
  cwd?: string
  placement?: LaunchAgentOptions['placement']
  /** Further launch options (`issueRef`, `resumeSessionId`, `closeOnIssueDone`, …). */
  launch?: Omit<LaunchAgentOptions, 'providerId' | 'prompt' | 'autoSubmit'>
}

/** Pick the provider for `o` (`null` when none is installed). */
export async function pickProvider(ctx: PluginContext, o: Pick<LaunchOptions, 'providerId' | 'preferred'> = {}): Promise<ProviderInfo | null> {
  const list = await agentProviders(ctx)
  if (o.providerId) return list.find((p) => p.id === o.providerId) ?? null
  // `isDefault` (API 1.4): the user's default provider (setting, else the first installed one).
  return list.find((p) => p.id === o.preferred) ?? list.find((p) => p.isDefault) ?? list[0] ?? null
}

/**
 * Launch an agent; failures become an error toast. Resolves with the handle
 * (its terminal belongs to this plugin when `createdTerminal`, API 1.2), or
 * `null` when nothing was launched.
 */
export async function launchAgent(ctx: PluginContext, prompt: string, o: LaunchOptions = {}): Promise<AgentLaunchHandle | null> {
  try {
    const provider = await pickProvider(ctx, o)
    if (!provider) {
      ctx.notifications.toast({ kind: 'warning', title: 'No agent provider', body: 'Enable an agent provider plugin (Claude Code, Codex) first.' })
      return null
    }
    const approvalMode = o.approvalMode === 'unattended' ? unattendedApprovalMode(provider) : o.approvalMode
    return await ctx.agents.launch({
      ...o.launch,
      providerId: provider.id,
      prompt,
      autoSubmit: o.autoSubmit ?? false,
      placement: o.placement ?? 'split-active',
      ...(approvalMode ? { approvalMode } : {}),
      ...(o.title ? { title: o.title } : {}),
      ...(o.cwd ? { cwd: o.cwd } : {}),
    })
  } catch (e) {
    ctx.log.error('agent launch failed:', e)
    ctx.notifications.toast({ kind: 'error', title: 'Could not launch the agent', body: e instanceof Error ? e.message : String(e) })
    return null
  }
}
