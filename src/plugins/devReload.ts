/**
 * Plugin dev mode, shell side (plugin-system.md §15.3).
 *
 * The Rust dev watcher (`src-tauri/src/plugin_host/dev.rs`) emits `plugin-dev-changed` when a
 * `dev` plugin's build output changes (`npm run dev` of the plugin). This reloads the plugin:
 * the registry is refreshed (manifest changes → new contributions) and its generation bumped,
 * so the loader deactivates the old module and re-imports the entry with a cache-buster, and
 * every `TileHost` of the plugin remounts. Tile instances keep their persisted `state` (what
 * the tile passed to `setState`), so a tile that restores itself from `instance.state` comes
 * back where it was. The sidecar restart happens in Rust.
 */
import { listen } from '@tauri-apps/api/event'
import { toast } from '@quadflow/ui'
import { usePluginRegistry } from './registry'

/** Payload of `plugin-dev-changed` (Rust `PluginDevChange`). */
export interface PluginDevChange {
  pluginId: string
  manifest: boolean
  ui: boolean
  sidecar: boolean
  paths: string[]
}

export const DEV_CHANGED_EVENT = 'plugin-dev-changed'

let installed = false
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** Reload a dev plugin now (also the "Reload" button in Settings → Plugins). */
export async function reloadDevPlugin(pluginId: string, why?: PluginDevChange): Promise<void> {
  const reg = usePluginRegistry.getState()
  await reg.reload(pluginId)
  const name = reg.getPlugin(pluginId)?.name ?? pluginId
  const what = why ? [why.manifest && 'manifest', why.ui && 'UI', why.sidecar && 'sidecar'].filter(Boolean).join(' + ') : ''
  console.info(`[plugins] dev reload ${pluginId}${what ? ` (${what})` : ''}`, why?.paths ?? [])
  toast({ kind: 'info', message: `Reloaded ${name}${what ? ` (${what})` : ''}`, duration: 2000 })
}

/** Listen for dev rebuilds (main window; idempotent). */
export function installDevReload(): void {
  if (installed) return
  installed = true
  void listen<PluginDevChange>(DEV_CHANGED_EVENT, (ev) => {
    const change = ev.payload
    // Coalesce bursts (a UI and a sidecar rebuild landing close together).
    clearTimeout(pending.get(change.pluginId))
    pending.set(
      change.pluginId,
      setTimeout(() => {
        pending.delete(change.pluginId)
        reloadDevPlugin(change.pluginId, change).catch((e) => console.error(`[plugins] dev reload of ${change.pluginId} failed:`, e))
      }, 150),
    )
  })
}
