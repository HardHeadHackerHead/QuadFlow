/**
 * Plugin commands (plugin-system.md §5.5): ids are `<pluginId>/<commandId>`;
 * a manifest command is implemented by the UI module's `commands[commandId]`
 * and runs with the plugin's context. Toolbar items, palette entries and
 * context menus all execute through here.
 */
import type { JsonValue } from '@quadflow/plugin-api'
import { ensurePluginRegistry } from './registry'
import { loadPluginModule } from './loader'

/** Split a command reference relative to `pluginId` (`cmd` or `<plugin>/<cmd>`). */
export function resolveCommandRef(pluginId: string, ref: string): { pluginId: string; commandId: string } {
  const slash = ref.indexOf('/')
  return slash < 0 ? { pluginId, commandId: ref } : { pluginId: ref.slice(0, slash), commandId: ref.slice(slash + 1) }
}

export async function runPluginCommand(pluginId: string, ref: string, args?: JsonValue): Promise<unknown> {
  await ensurePluginRegistry()
  const target = resolveCommandRef(pluginId, ref)
  const loaded = await loadPluginModule(target.pluginId)
  const fn = loaded.module.commands?.[target.commandId]
  if (!fn) throw new Error(`Plugin "${target.pluginId}" does not implement command "${target.commandId}"`)
  return fn(loaded.ctx, args)
}

/**
 * Open a file in the Editor plugin (`editor/open { path }`, plugins/editor): focuses the tile
 * already showing it or opens one. Used by the file explorer, terminal file links, …
 */
export function openFileInEditor(path: string): Promise<void> {
  return runPluginCommand('editor', 'open', { path }).then(
    () => undefined,
    (e) => console.error('[plugins] editor/open failed:', e),
  )
}

