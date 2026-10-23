/**
 * `missions` — multi-agent missions (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `control`: the one Missions UI, in a pane or a flyout (./MissionsTile.tsx)
 *  - command `new-mission`: open the tile with the New Mission dialog
 *  - command `new-from-template`: `{ templateId, name? }` creates the mission
 *    right away; without args the tile opens on its Templates tab
 *  - palette provider `missions`: the project's missions, and "New mission
 *    from template …" for every template
 *  - agent context doc `missions` (docs/agent.md): `quadflow docs missions`
 *
 * Everything goes through the public host API (`ctx.data.missions.*`,
 * `ctx.data.issues.*`, `ctx.agents.*`, `ctx.terminals.*`, `ctx.shell.exec`
 * for git); nothing is imported from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type JsonValue, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { MissionsTile } from './MissionsTile'
import { attempt, missionsModel } from './model'
import './styles.css'

async function openMissions(ctx: PluginContext, focusId?: string) {
  const model = missionsModel(ctx)
  if (focusId) {
    model.select(focusId)
    model.ui.setState({ tab: 'missions' })
  }
  await ctx.ui.openTile('control')
}

async function newMission(ctx: PluginContext, templateId: string | null = null) {
  missionsModel(ctx).ui.setState((s) => ({ tab: 'missions', newMissionNonce: s.newMissionNonce + 1, newMissionTemplateId: templateId }))
  await ctx.ui.openTile('control')
}

async function newFromTemplate(ctx: PluginContext, args?: JsonValue) {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as { templateId?: unknown; name?: unknown }
  const templateId = typeof a.templateId === 'string' ? a.templateId : null
  if (!templateId) {
    missionsModel(ctx).ui.setState({ tab: 'templates' })
    await ctx.ui.openTile('control')
    return
  }
  const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null
  if (!name) return newMission(ctx, templateId)
  const mission = await attempt(ctx, 'Could not create the mission', () => missionsModel(ctx).createMission({ name, templateId }))
  if (mission) await openMissions(ctx, mission.id)
  return mission?.id
}

async function search(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const q = query.trim().toLowerCase()
  const [missions, templates] = await Promise.all([ctx.data.missions.list(), ctx.data.missions.templates.list()])
  const hit = (...s: (string | null | undefined)[]) => s.some((x) => x?.toLowerCase().includes(q))
  const items: PaletteItem[] = missions.items
    .filter((m) => hit(m.name, m.status))
    .map((m) => ({
      id: `mission:${m.id}`,
      title: m.name,
      subtitle: `Mission · ${m.status} · ${(m.members ?? []).length} agents`,
      keywords: ['mission', m.status],
      run: () => openMissions(ctx, m.id),
    }))
  for (const t of templates.items.filter((t) => hit(t.name, t.description, t.category, 'template'))) {
    items.push({
      id: `template:${t.id}`,
      title: `New mission from template: ${t.name}`,
      subtitle: t.description ?? t.category,
      keywords: ['template', 'mission', t.category],
      run: () => newMission(ctx, t.id),
    })
  }
  return items
}

export default definePlugin({
  tiles: {
    // The `.qf-missions` wrapper is the style scope of this plugin's Tailwind build.
    control: (props: TileProps) => (
      <div className="qf-missions">
        <MissionsTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-mission': (ctx) => newMission(ctx),
    'new-from-template': (ctx, args) => newFromTemplate(ctx, args),
    open: (ctx) => openMissions(ctx),
  },
  paletteProviders: { missions: { search } },
})
