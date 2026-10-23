/**
 * `scripts` — run project scripts (first-party, bundled, trusted). Replaces the
 * two former built-in Scripts views (pane `ScriptsToolView`, flyout
 * `ScriptLauncherToolView`) with one UI that works in both modes.
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `scripts`: the Scripts tool, in a pane or a (compact) flyout
 *  - commands `new-script`, `stop-all`, `run-script` ({ scriptId } | { groupId }), `open`
 *  - palette provider `scripts`: "run <script / group>" from the palette
 *  - agent context doc `scripts` (docs/agent.md): `quadflow docs scripts`
 *
 * Everything goes through the public host API (`ctx.data.scripts.*`,
 * `ctx.terminals.*`, `ctx.agents.launch`, `ctx.fs`); nothing is imported from
 * the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type JsonValue, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { ScriptsTile } from './ScriptsTile'
import { disposeAll, runsOnThisPlatform, scriptsModel } from './model'
import './styles.css'

/** Show the output panel: open the tile (as a flyout) unless one is visible. Does not wait for it. */
function reveal(ctx: PluginContext) {
  if (scriptsModel(ctx).ui.getState().visibleTiles > 0) return
  ctx.ui.openTile('scripts', { placement: 'flyout' }).catch((e) => ctx.log.warn('could not open the Scripts tile:', e))
}

async function runScript(ctx: PluginContext, args?: JsonValue) {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as { scriptId?: unknown; groupId?: unknown }
  const m = scriptsModel(ctx)
  try {
    if (typeof a.groupId === 'string') {
      const g = await ctx.data.scripts.groups.get(a.groupId)
      reveal(ctx)
      await m.runGroup(g)
      return
    }
    if (typeof a.scriptId !== 'string') throw new Error('run-script: pass { scriptId } or { groupId }')
    const s = await ctx.data.scripts.get(a.scriptId)
    reveal(ctx)
    await m.start({ type: 'saved', script: s })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not run the script', body: e instanceof Error ? e.message : String(e) })
  }
}

async function search(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const q = query.trim().toLowerCase()
  const [scripts, groups] = await Promise.all([ctx.data.scripts.list({ text: query }), ctx.data.scripts.groups.list()])
  const items: PaletteItem[] = scripts.items.filter(runsOnThisPlatform).map((s) => ({
    id: `script:${s.id}`,
    title: `Run ${s.name}`,
    subtitle: s.description || s.command,
    keywords: [s.name, s.command, ...(s.tags ?? [])],
    run: () => runScript(ctx, { scriptId: s.id }),
  }))
  for (const g of groups.items) {
    if (!g.name.toLowerCase().includes(q)) continue
    items.push({
      id: `group:${g.id}`,
      title: `Run group ${g.name}`,
      subtitle: `${g.mode}, ${(g.members ?? []).length} scripts`,
      keywords: [g.name],
      run: () => runScript(ctx, { groupId: g.id }),
    })
  }
  return items
}

export default definePlugin({
  tiles: {
    // The `.qf-scripts` wrapper is the style scope of this plugin's Tailwind build.
    scripts: (props: TileProps) => (
      <div className="qf-scripts h-full w-full">
        <ScriptsTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-script': async (ctx) => {
      const m = scriptsModel(ctx)
      reveal(ctx)
      m.ui.setState({ newScriptPending: true })
    },
    'stop-all': async (ctx) => {
      const n = await scriptsModel(ctx).stopAll()
      ctx.notifications.toast({ kind: 'info', title: n === 0 ? 'No script is running' : `Stopped ${n} script(s)` })
    },
    'run-script': (ctx, args) => runScript(ctx, args),
    open: (ctx) => reveal(ctx),
  },
  paletteProviders: { scripts: { search } },
  deactivate: () => disposeAll(),
})
