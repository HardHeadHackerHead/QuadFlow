/**
 * `discord-bot` — mirror terminals into Discord threads (first-party,
 * experimental / on hold, not bundled: `quadflow.bundle: "none"`).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `bot`: connection, settings and mirrored terminals (./DiscordBotTile.tsx)
 *  - commands `start`, `stop`, `toggle-share` ({ terminalId, title })
 *  - context menu `share-terminal` (location `terminal`, the terminal's ⋯ menu)
 *  - Node sidecar (sidecar/index.mjs → bin/sidecar.mjs) running discord.js
 *
 * Everything goes through the public host API: `ctx.terminals.onData/write`
 * (`terminal:io`), `ctx.secrets` (bot token), `ctx.settings`, `ctx.sidecar`.
 */
import { definePlugin, type JsonValue, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { DiscordBotTile } from './DiscordBotTile'
import { discordModel } from './model'
import './styles.css'

let activeCtx: PluginContext | null = null

function shareArgs(args?: JsonValue): { terminalId: string; title: string } | null {
  const o = (args ?? {}) as Record<string, unknown>
  return typeof o.terminalId === 'string' ? { terminalId: o.terminalId, title: typeof o.title === 'string' ? o.title : 'Terminal' } : null
}

async function toggleShare(ctx: PluginContext, args?: JsonValue) {
  const a = shareArgs(args)
  if (!a) return
  const model = discordModel(ctx)
  const sharing = !model.isMirrored(a.terminalId)
  try {
    await model.toggle(a.terminalId, a.title)
    ctx.notifications.toast({ kind: 'success', title: sharing ? 'Sharing terminal to Discord' : 'Stopped sharing on Discord' })
  } catch (e) {
    ctx.notifications.toast({
      kind: 'error',
      title: 'Discord share failed',
      body: e instanceof Error ? e.message : String(e),
      action: { label: 'Open Discord Bot', command: 'discord-bot/open' },
    })
  }
}

export default definePlugin({
  activate(ctx) {
    activeCtx = ctx
  },
  deactivate() {
    if (activeCtx) discordModel(activeCtx).dispose()
    activeCtx = null
  },
  tiles: {
    // The `.qf-discord-bot` wrapper is the style scope of this plugin's Tailwind build.
    bot: (props: TileProps) => (
      <div className="qf-discord-bot">
        <DiscordBotTile {...props} />
      </div>
    ),
  },
  commands: {
    start: async (ctx) => {
      await discordModel(ctx).start()
      await ctx.ui.openTile('bot').catch(() => undefined)
    },
    stop: (ctx) => discordModel(ctx).stop(),
    open: (ctx) => ctx.ui.openTile('bot'),
    'toggle-share': (ctx, args) => toggleShare(ctx, args),
  },
})
