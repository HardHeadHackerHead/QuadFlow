/**
 * `ship` — the project's release pipeline (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `ship`: status, readiness, cut a release, run history, live output (./ShipTile.tsx)
 *  - commands `dry-run` (preview the phase plan) and `configure` (setup-ship agent)
 *  - palette provider `ship-runs`: find runs by version / status / mode
 *  - agent context doc `ship` (docs/agent.md): `quadflow docs ship`
 *
 * Everything goes through the public host API (`ctx.data.ship.*`, `ctx.terminals`,
 * `ctx.agents`); nothing is imported from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { ShipTile, launchSetupShip } from './ShipTile'
import { shipModel } from './model'
import './styles.css'

async function openShip(ctx: PluginContext) {
  await ctx.ui.openTile('ship')
}

async function dryRun(ctx: PluginContext) {
  if (!ctx.project.current()) {
    ctx.notifications.toast({ kind: 'warning', title: 'Open a project first' })
    return
  }
  const config = await ctx.data.ship.configGet().catch(() => null)
  if (!config) {
    ctx.notifications.toast({ kind: 'warning', title: 'No ship pipeline', body: 'Configure one in the Ship tool first.', action: { label: 'Open Ship', command: 'ship/open' } })
    return
  }
  await openShip(ctx)
  const run = await shipModel(ctx).run(config.versionFiles.length > 0 ? 'patch' : 'deploy', { dryRun: true })
  if (run) ctx.notifications.toast({ kind: 'info', title: `Dry run: ${run.phases.length} phases`, body: `v${run.version}` })
}

async function searchRuns(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const q = query.trim().toLowerCase().replace(/^v/, '')
  const res = await ctx.data.ship.runs()
  return res.items
    .filter((r) => !r.dryRun && [r.version, r.status, r.mode].some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map((r) => ({
      id: r.id,
      title: `Ship run v${r.version}`,
      subtitle: `${r.status.replace('_', ' ')} · ${r.mode} · ${new Date(r.startedAt).toLocaleString()}`,
      keywords: ['ship', 'release', r.version, r.status, r.mode],
      run: async () => {
        shipModel(ctx).enterReplay(r)
        await openShip(ctx)
      },
    }))
}

export default definePlugin({
  tiles: {
    // The `.qf-ship` wrapper is the style scope of this plugin's Tailwind build.
    ship: (props: TileProps) => (
      <div className="qf-ship">
        <ShipTile {...props} />
      </div>
    ),
  },
  commands: {
    open: (ctx) => openShip(ctx),
    'dry-run': (ctx) => dryRun(ctx),
    configure: (ctx) => launchSetupShip(ctx),
  },
  paletteProviders: { 'ship-runs': { search: searchRuns } },
})
