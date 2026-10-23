/**
 * `claude-code` — the Claude Code agent provider (agent-providers.md §9).
 *
 * Launch, resume, models, approval modes, sessions, context file and the
 * `.claude/` scaffold are declarative (`contributes.agentProvider` in the
 * manifest, interpreted by the core). This module adds the procedural parts:
 *  - provider hooks: `usage`, `contextUsage`, `sessionTitle`, `prepareWorktree` (./hooks.ts)
 *  - tile `config`: CLAUDE.md, settings env, skills, sessions + rewind, permissions
 *  - settings page `permissions`
 *  - command `rewind`: opens the rewind view (args `{ terminalId?, sessionId?, cwd? }`)
 */
import { definePlugin, type JsonValue, type PluginContext } from '@quadflow/plugin-api'
import { ConfigTile } from './ConfigTile'
import { agentProvider } from './hooks'
import { PermissionsPage } from './PermissionsPage'
import { useRewindTarget, type RewindTarget } from './RewindView'
import './claude.css'

function rewindTarget(args: JsonValue | undefined): RewindTarget {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, JsonValue>) : {}
  const str = (v: JsonValue | undefined) => (typeof v === 'string' && v ? v : undefined)
  return { terminalId: str(a.terminalId), sessionId: str(a.sessionId), cwd: str(a.cwd) }
}

async function rewind(ctx: PluginContext, args?: JsonValue) {
  useRewindTarget.getState().set(rewindTarget(args))
  return ctx.ui.openTile('config', { placement: 'flyout' })
}

export default definePlugin({
  activate(ctx) {
    ctx.log.debug('activated', { project: ctx.project.current()?.name ?? null })
  },
  tiles: { config: ConfigTile },
  settingsPages: { permissions: PermissionsPage },
  commands: { rewind },
  agentProvider,
})
