/**
 * `youtube-live` — YouTube Live chat overlay for streamers (first-party, optional:
 * not bundled, installed from the official source or loaded from the repo).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `overlay`: the streamer-facing overlay (ideas, slot machine, leaderboard,
 *    polls, alerts) — ./LiveTile.tsx, ported from the shell's YouTubeLiveToolView
 *  - tile `settings`: every admin control (credentials, features, pay table, OAuth,
 *    polls, AI voice) — ./SettingsTile.tsx, formerly a separate window. Keep it off
 *    stream: it shows (masked) credentials.
 *  - commands `open`, `open-settings`, and `test-*` demo events (simulated chat idea,
 *    slot pull, alert, subscriber — no stream or network needed)
 *
 * All YouTube / OpenAI traffic and the chat poller live in the Rust sidecar
 * (sidecar/), which talks to the network only through the host's `http.fetch` and
 * keeps credentials in `ctx.secrets`. The UI talks to it through ./bridge.ts.
 */
import { useEffect } from 'react'
import { definePlugin, type Disposable, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { bindContext } from './bridge'
import { youtubeLiveApi } from './api'
import LiveTile from './LiveTile'
import SettingsTile from './SettingsTile'
import './styles.css'

let watching: Disposable[] = []

/** Tag new chat ideas with the active project (the sidecar has no project names). */
function trackProject(ctx: PluginContext) {
  const push = () => {
    const p = ctx.project.current()
    youtubeLiveApi.setActiveProject(p?.id ?? null, p?.name ?? null).catch(() => {})
  }
  push()
  watching.push(ctx.project.onDidChange(push))
  // OAuth: when the host cannot open the browser for the sidecar, it asks us to.
  void youtubeLiveApi
    .onOpenUrl(({ url }) => {
      ctx.shell.openExternal(url).catch((e) => ctx.notifications.toast({ kind: 'error', title: 'Could not open the browser', body: String(e) }))
    })
    .then((off) => watching.push(off))
}

async function simulate(ctx: PluginContext, run: () => Promise<unknown>) {
  bindContext(ctx)
  try {
    await run()
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'YouTube Live', body: String(e) })
  }
}

function useBound(ctx: PluginContext) {
  bindContext(ctx)
  useEffect(() => {
    if (watching.length === 0) trackProject(ctx)
  }, [ctx])
}

function Overlay({ ctx }: TileProps) {
  useBound(ctx)
  return (
    <div className="qf-youtube-live">
      <LiveTile />
    </div>
  )
}

function Settings({ ctx }: TileProps) {
  useBound(ctx)
  return (
    <div className="qf-youtube-live">
      <SettingsTile />
    </div>
  )
}

export default definePlugin({
  activate(ctx) {
    bindContext(ctx)
  },
  deactivate() {
    watching.forEach((d) => d())
    watching = []
  },
  tiles: { overlay: Overlay, settings: Settings },
  commands: {
    open: async (ctx) => {
      bindContext(ctx)
      await ctx.ui.openTile('overlay')
    },
    'open-settings': async (ctx) => {
      bindContext(ctx)
      await ctx.ui.openTile('settings', { placement: 'flyout' })
    },
    // Demo events (no stream, no network): try the overlay before going live.
    'test-idea': (ctx) => simulate(ctx, () => youtubeLiveApi.testIdea()),
    'test-slot-pull': (ctx) => simulate(ctx, () => youtubeLiveApi.testSlotPull()),
    'test-alert': (ctx) => simulate(ctx, () => youtubeLiveApi.testAlert()),
    'test-subscriber': (ctx) => simulate(ctx, () => youtubeLiveApi.testSubscriber()),
  },
})
