/**
 * `code-quality` — code metrics of the active project (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `report`: the Code Quality tool, in a pane or a flyout (./CodeQualityTile.tsx)
 *  - command `rescan`: rescan the project (opens the tile)
 *  - command `insight`: ask the Chat endpoint for a short assessment of the last scan
 *
 * Files are read with `ctx.fs` (`fs:read:project`); the AI insight is a one-off question via
 * `ctx.data.chat` (`data:chat:write`). Nothing is imported from the shell.
 */
import { definePlugin, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { CodeQualityTile } from './CodeQualityTile'
import { codeQualityModel } from './model'
import './styles.css'

async function rescan(ctx: PluginContext) {
  await ctx.ui.openTile('report')
  await codeQualityModel(ctx).refresh()
}

async function insight(ctx: PluginContext) {
  const model = codeQualityModel(ctx)
  await ctx.ui.openTile('report')
  if (!model.store.getState().metrics) await model.scan()
  await model.requestLlmInsight()
  const err = model.store.getState().llmError
  if (err) ctx.notifications.toast({ kind: 'error', title: 'AI insight unavailable', body: err })
}

export default definePlugin({
  tiles: {
    // The `.qf-code-quality` wrapper is the style scope of this plugin's Tailwind build.
    report: (props: TileProps) => (
      <div className="qf-code-quality">
        <CodeQualityTile {...props} />
      </div>
    ),
  },
  commands: {
    rescan: (ctx) => rescan(ctx),
    insight: (ctx) => insight(ctx),
  },
})
