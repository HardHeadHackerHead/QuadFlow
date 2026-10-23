/**
 * PTYs of the plugin's tiles (instance id -> terminal id), so a tile that is
 * closed for good can kill its program. Tiles only *detach* on unmount: a
 * hidden flyout or a remounted pane keeps its program running.
 *
 * `ui.onTileClosed` (host API 1.2) tells us about closes; on older hosts the
 * PTY lives until the app exits.
 */
import type { Disposable, PluginContext } from '@quadflow/plugin-api'

const terminals = new Map<string, string>()

export function rememberTerminal(instanceId: string, terminalId: string): void {
  terminals.set(instanceId, terminalId)
}

export function forgetTerminal(instanceId: string): void {
  terminals.delete(instanceId)
}

/** Kill a tile's PTY when the tile is closed (called from `activate`). */
export function killOnClose(ctx: PluginContext): Disposable {
  if (!ctx.api.has('ui.onTileClosed')) return () => {}
  return ctx.ui.onTileClosed(({ instanceId }) => {
    const id = terminals.get(instanceId)
    if (!id) return
    terminals.delete(instanceId)
    void ctx.terminals.kill(id).catch(() => {})
  })
}
