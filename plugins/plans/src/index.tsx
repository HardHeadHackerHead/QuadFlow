/**
 * `plans` — implementation plans (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `board`: the Plans tool, in a pane or a flyout (./PlansTile.tsx)
 *  - command `new-plan`: open the New Plan wizard (or prompt for a title)
 *  - palette provider `plans`: palette entity search over the project's plans
 *  - agent context doc `plans` (docs/agent.md): `quadflow docs plans`
 *
 * Everything goes through the public host API (`ctx.data.plans.*`,
 * `ctx.data.issues.*` for promotion and coordination, `ctx.data.ideas.list`,
 * `ctx.data.discovery.list`, `ctx.agents.*` for the skill buttons); nothing
 * is imported from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { PlansTile } from './PlansTile'
import { plansModel, toPlan } from './model'
import './styles.css'

const STATUS_LABEL: Record<string, string> = {
  spec_draft: 'Spec draft',
  spec_review: 'Spec review',
  decomposing: 'Decomposing',
  review_steps: 'Review steps',
  promoting: 'Promoting',
  executing: 'Executing',
  completed: 'Completed',
}

async function openPlans(ctx: PluginContext, focusId?: string) {
  if (focusId) plansModel(ctx).ui.setState({ focusId })
  await ctx.ui.openTile('board')
}

/** Open the tile with the New Plan wizard (title, project type, starting point). */
async function newPlan(ctx: PluginContext) {
  if (!ctx.project.current()) {
    ctx.notifications.toast({ kind: 'warning', title: 'Open a project first' })
    return
  }
  plansModel(ctx).ui.setState((s) => ({ composeNonce: s.composeNonce + 1 }))
  await ctx.ui.openTile('board')
}

async function searchPlans(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  if (!ctx.project.current()) return []
  const res = await ctx.data.plans.list({ text: query })
  return res.items.map(toPlan).map((plan) => {
    const done = plan.steps.filter((s) => s.status === 'completed').length
    return {
      id: plan.id,
      title: plan.title,
      subtitle: `${STATUS_LABEL[plan.status] ?? plan.status}${plan.steps.length ? ` · ${done}/${plan.steps.length} steps` : ''}`,
      keywords: [plan.status, plan.title, ...(plan.description ? [plan.description] : [])],
      run: () => openPlans(ctx, plan.id),
    }
  })
}

export default definePlugin({
  tiles: {
    // The `.qf-plans` wrapper is the style scope of this plugin's Tailwind build.
    board: (props: TileProps) => (
      <div className="qf-plans">
        <PlansTile {...props} />
      </div>
    ),
  },
  commands: {
    'new-plan': (ctx) => newPlan(ctx),
    open: (ctx) => openPlans(ctx),
  },
  paletteProviders: { plans: { search: searchPlans } },
})
