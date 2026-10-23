/**
 * `discovery` — the "Projects" tool: structured project discovery (goals,
 * success criteria, research, requirements, questions, references, decisions,
 * notes) and the ideas / plans linked to each discovery project.
 * First-party, bundled, trusted.
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `projects` (pane and flyout, ./ProjectsTile.tsx)
 *  - command `new-project`: prompt for a title and create a discovery project
 *  - palette provider `discovery`
 *  - agent context doc `discovery` (docs/agent.md): `quadflow docs discovery`
 *
 * Public host API only (`ctx.data.discovery.*`, `ctx.data.ideas.*`,
 * `ctx.agents.*`). See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { ProjectsTile } from './ProjectsTile'
import { discoveryModel } from './model'
import './styles.css'

async function openProjects(ctx: PluginContext, focusId?: string) {
  if (focusId) discoveryModel(ctx).ui.setState({ focusId })
  await ctx.ui.openTile('projects')
}

async function newProject(ctx: PluginContext) {
  const title = await ctx.ui.prompt({ title: 'New discovery project', label: 'Title' })
  if (!title?.trim()) return
  try {
    const p = await discoveryModel(ctx).create(title.trim())
    await openProjects(ctx, p.id)
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not create the project', body: e instanceof Error ? e.message : String(e) })
  }
}

async function searchProjects(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const q = query.toLowerCase()
  const res = await ctx.data.discovery.list({})
  return res.items
    .filter((p) => p.title.toLowerCase().includes(q) || (p.overview ?? '').toLowerCase().includes(q))
    .map((p) => ({
      id: p.id,
      title: p.title,
      subtitle: `${p.status.replace('_', ' ')} · ${(p.items ?? []).length} items`,
      keywords: [p.status, p.overview ?? ''],
      run: () => openProjects(ctx, p.id),
    }))
}

export default definePlugin({
  tiles: {
    // The `.qf-discovery` wrapper is the style scope of this plugin's Tailwind build.
    projects: (props: TileProps) => (
      <div className="qf-discovery">
        <ProjectsTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-project': (ctx) => newProject(ctx),
  },
  paletteProviders: { discovery: { search: searchProjects } },
})
