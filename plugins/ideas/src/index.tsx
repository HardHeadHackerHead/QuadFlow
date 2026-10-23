/**
 * `ideas` — capture, tag and triage ideas (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `board`: the Ideas tool, in a pane or a flyout (./IdeasTile.tsx)
 *  - command `new-idea`: prompt for an idea and save it
 *  - palette provider `ideas`: palette entity search over the project's ideas
 *  - agent context doc `ideas` (docs/agent.md): `quadflow docs ideas`
 *
 * Everything goes through the public host API (`ctx.data.ideas.*`,
 * `ctx.data.issues.create`, `ctx.data.discovery.list`, `ctx.agents.*`);
 * nothing is imported from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { IdeasTile } from './IdeasTile'
import { ideasModel, normalizeIdea, preview } from './model'
import './styles.css'

async function newIdea(ctx: PluginContext) {
  const content = await ctx.ui.prompt({ title: 'New idea', label: "What's on your mind?" })
  if (!content?.trim()) return
  try {
    await ideasModel(ctx).create(content.trim())
    ctx.notifications.toast({ kind: 'success', title: 'Idea saved', action: { label: 'Open Ideas', command: 'ideas/open' } })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not save the idea', body: e instanceof Error ? e.message : String(e) })
  }
}

async function openIdeas(ctx: PluginContext, focusId?: string) {
  if (focusId) ideasModel(ctx).ui.setState({ focusId })
  await ctx.ui.openTile('board')
}

async function searchIdeas(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const res = await ctx.data.ideas.list({ text: query })
  return res.items.map(normalizeIdea).map((idea) => ({
    id: idea.id,
    title: preview(idea.content, 60),
    subtitle: idea.tags.length > 0 ? idea.tags.map((t) => `#${t}`).join(' ') : undefined,
    keywords: [...idea.tags, idea.content],
    run: () => openIdeas(ctx, idea.id),
  }))
}

export default definePlugin({
  tiles: {
    // The `.qf-ideas` wrapper is the style scope of this plugin's Tailwind build.
    board: (props: TileProps) => (
      <div className="qf-ideas">
        <IdeasTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-idea': (ctx) => newIdea(ctx),
    open: (ctx) => openIdeas(ctx),
  },
  paletteProviders: { ideas: { search: searchIdeas } },
})
