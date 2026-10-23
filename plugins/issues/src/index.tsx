/**
 * `issues` — track bugs and tasks (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `board`: the Issues tool (list, kanban, detail, forms, epics,
 *    labels, dependency graph), in a pane or a flyout (./IssuesTile.tsx)
 *  - command `new-issue`: prompt for a title, create the issue, show it
 *  - command `open-issue`: prompt for a ref (`CODE-n`, `n`, id) and show it
 *  - palette provider `issues`: issue search by ref and title
 *  - agent context doc `issues` (docs/agent.md): `quadflow docs issues`
 *
 * Everything goes through the public host API (`ctx.data.issues.*`,
 * `ctx.data.projectConfig`, `ctx.agents.*`); nothing is imported from the
 * shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { IssuesTile } from './IssuesTile'
import { formatIssueRef, toIssue } from './convert'
import { issuesModel, reportError } from './model'
import { statusConfig } from './types'
import './styles.css'

async function openIssues(ctx: PluginContext, focusId?: string) {
  if (focusId) issuesModel(ctx).ui.setState({ focusId })
  await ctx.ui.openTile('board')
}

async function newIssue(ctx: PluginContext) {
  const title = await ctx.ui.prompt({ title: 'New issue', label: 'Title' })
  if (!title?.trim()) return
  try {
    const m = issuesModel(ctx)
    const issue = toIssue(await ctx.data.issues.create({ title: title.trim() }))
    const root = ctx.project.current()?.root
    if (root) m.issues.apply(root, issue)
    ctx.notifications.toast({
      kind: 'success',
      title: `Created ${ctx.data.issues.displayRef({ number: issue.displayNumber })}`,
      body: issue.title,
      action: { label: 'Open Issues', command: 'issues/open' },
    })
  } catch (e) {
    reportError(ctx, 'Could not create the issue', e)
  }
}

async function openIssueByRef(ctx: PluginContext, args?: unknown) {
  const given = typeof args === 'string' ? args : (args as { ref?: string } | undefined)?.ref
  const ref = given ?? (await ctx.ui.prompt({ title: 'Open issue', label: 'Issue ref (e.g. ABC-12 or 12)' }))
  if (!ref?.trim()) return
  try {
    const issue = await ctx.data.issues.get(ref.trim())
    await openIssues(ctx, issue.id)
  } catch (e) {
    reportError(ctx, `No issue ${ref.trim()}`, e)
  }
}

async function searchIssues(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  const project = ctx.project.current()
  if (!project) return []
  const code = project.config?.code ?? ''
  // The core's text query matches title, body and the display ref (`ABC-12`).
  const res = await ctx.data.issues.list({ text: query.trim(), includeDone: true, limit: 10 })
  const hits = res.items
  return hits.slice(0, 10).map((raw) => {
    const issue = toIssue(raw)
    const ref = formatIssueRef(code, issue.displayNumber)
    return {
      id: issue.id,
      title: `${ref} ${issue.title}`,
      subtitle: `${statusConfig[issue.status]?.label ?? issue.status} | ${issue.priority}`,
      keywords: [ref, issue.status, issue.priority, ...issue.labels, issue.title],
      run: () => openIssues(ctx, issue.id),
    }
  })
}

export default definePlugin({
  tiles: {
    // The `.qf-issues` wrapper is the style scope of this plugin's Tailwind build.
    board: (props: TileProps) => (
      <div className="qf-issues">
        <IssuesTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-issue': (ctx) => newIssue(ctx),
    'open-issue': (ctx, args) => openIssueByRef(ctx, args),
    open: (ctx) => openIssues(ctx),
  },
  paletteProviders: { issues: { search: searchIssues } },
})
