/**
 * `editor` — a CodeMirror file editor pane (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `file`: one file per tile (./EditorTile.tsx); pane only
 *  - command `open` (`editor/open`): `{ path }` (absolute or project-relative) focuses the tile
 *    already showing that file or opens a new one; without args it asks for a path. Shell callers
 *    (file explorer "Open in Editor", terminal file links) run it through the command system.
 *
 * File IO goes through `ctx.fs` (`fs:read:project` / `fs:write:project`); nothing is imported
 * from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type JsonValue, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { EditorTile, promptAndOpen } from './EditorTile'
import { openFile, pathArg } from './model'
import './styles.css'

async function open(ctx: PluginContext, args?: JsonValue) {
  const path = pathArg(args)
  try {
    if (path) await openFile(ctx, path)
    else await promptAndOpen(ctx)
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not open the file', body: e instanceof Error ? e.message : String(e) })
  }
}

export default definePlugin({
  tiles: {
    // `.qf-editor` is the style scope of this plugin's Tailwind build.
    file: (props: TileProps) => (
      <div className="qf-editor h-full w-full">
        <EditorTile {...props} />
      </div>
    ),
  },
  commands: {
    open: (ctx, args) => open(ctx, args),
  },
})
