/**
 * UI module of the built-in `core` plugin (plugins/core/quadflow-plugin.json):
 * the shell's own contributions — the Terminal and AI Agent toolbar items
 * (commands `core/new-terminal`, `core/launch-agent`) and the session History
 * flyout — expressed as plugin contributions so the shell has one registry
 * (plugin-system.md §5). Internal: the trusted loader imports it from the host
 * bundle (src/plugins/loader.ts `INTERNAL_MODULES`) because it drives the
 * shell's stores directly.
 */
import { definePlugin, type TileProps } from '@quadflow/plugin-api'
import type { TerminalState, ToolConfig } from '../../types'
import { ChatHistoryPanel } from '../../components/layout/ChatHistoryDropdown'
import { useTerminalStore } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useAgentPromptStore } from '../../stores/agentPromptStore'
import { useToolStore } from '../../stores/toolStore'
import { createTerminalFromToolConfig } from '../../lib/tauri-api'
import { replaceEmptyTile } from '../../lib/layoutUtils'

/** Arguments the shell passes to a toolbar item's command (plugins/tools.tsx). */
interface ToolCommandArgs {
  toolConfigId?: string
  targetLeafId?: string | null
}

function commandArgs(args: unknown): ToolCommandArgs {
  return args && typeof args === 'object' ? (args as ToolCommandArgs) : {}
}

function toolConfigOf(args: unknown): ToolConfig | undefined {
  const id = commandArgs(args).toolConfigId
  return id ? useToolStore.getState().toolConfigs.get(id) : undefined
}

function ChatHistory(props: TileProps) {
  return (
    <div className="h-full overflow-auto [&>*]:!w-full [&>*]:!max-w-none [&>*]:!shadow-none [&>*]:!border-0">
      <ChatHistoryPanel onClose={() => props.close()} />
    </div>
  )
}

async function newTerminal(args: unknown) {
  const config = toolConfigOf(args)
  if (!config) return
  const { targetLeafId } = commandArgs(args)
  const term = useTerminalStore.getState()
  const { environments } = useAppSettingsStore.getState()
  const info = await createTerminalFromToolConfig(
    config,
    term.globalWorkingDirectory,
    environments.terminalEnvironments,
    environments.defaultEnvironmentId,
  )
  if (!targetLeafId) {
    term.addTerminal(info)
    return
  }
  // Fill the empty tile the user picked instead of splitting the active pane.
  const now = Date.now()
  const terminals = new Map(term.terminals)
  const created: TerminalState = {
    id: info.id,
    title: `Terminal ${terminals.size + 1}`,
    titleSource: 'default',
    originalPrompt: null,
    summary: null,
    workingDirectory: info.cwd,
    gridPosition: terminals.size,
    status: 'active',
    createdAt: now,
    pid: info.pid,
    isLoading: false,
    lastActivityAt: now,
  }
  terminals.set(info.id, created)
  useTerminalStore.setState({
    terminals,
    layoutTree: replaceEmptyTile(term.layoutTree, targetLeafId, info.id),
    activeTerminalId: info.id,
  })
}

function launchAgent(args: unknown) {
  const config = toolConfigOf(args)
  const provider = config?.settings?.provider
  useAgentPromptStore.getState().openModal(typeof provider === 'string' && provider ? provider : null)
}

export default definePlugin({
  tiles: {
    'chat-history': ChatHistory,
  },
  commands: {
    'new-terminal': (_ctx, args) => newTerminal(args),
    'launch-agent': (_ctx, args) => launchAgent(args),
  },
})
