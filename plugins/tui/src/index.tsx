/**
 * `tui` — run any terminal (TUI) program in a tile (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `run` (./TuiTile.tsx), pane or flyout; per tool config `configSchema`: executable,
 *    arguments, working directory, init commands. Users add one tool config per program.
 *  - command `run-command`: "Run Program in Tile…" — prompts for a command line and opens an
 *    ad-hoc tile running it.
 *
 * PTYs come from `ctx.terminals.spawn` (`terminal:spawn`) and are shown with
 * `ctx.terminals.attach`; nothing is imported from the shell.
 */
import { definePlugin, type Disposable, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { openTileWithState } from '@quadflow/plugin-kit'
import { parseCommandLine } from './command'
import { killOnClose } from './model'
import { TuiTile } from './TuiTile'
import './styles.css'

let offClose: Disposable | null = null

async function runCommand(ctx: PluginContext) {
  const line = await ctx.ui.prompt({ title: 'Run program in a tile', label: 'Command line (e.g. lazygit, htop, node -i)' })
  const parsed = line ? parseCommandLine(line) : null
  if (!parsed) return
  try {
    await openTileWithState(ctx, 'run', { program: { ...parsed, workingDirectory: '', initCommands: [] } }, { placement: 'split-active' })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not open the tile', body: e instanceof Error ? e.message : String(e) })
  }
}

export default definePlugin({
  activate(ctx) {
    offClose?.()
    offClose = killOnClose(ctx)
  },
  deactivate() {
    offClose?.()
    offClose = null
  },
  tiles: {
    // `.qf-tui` is the style scope of this plugin's Tailwind build.
    run: (props: TileProps) => (
      <div className="qf-tui h-full w-full">
        <TuiTile {...props} />
      </div>
    ),
  },
  commands: {
    'run-command': (ctx) => runCommand(ctx),
  },
})
