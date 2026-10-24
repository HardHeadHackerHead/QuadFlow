/**
 * Live plugin changes (plugin-system.md §12.4): install, update, rollback, uninstall and
 * enable/disable take effect without restarting QuadFlow — from Settings → Plugins and from
 * `quadflow plugins …` in another process alike.
 *
 * - Every `DataChanged { domain: "plugins" }` (the app DB change log; CLI writes arrive through
 *   the cross-process cursor) refreshes the shell registry. `plugins_list` also refreshes the
 *   `qfplugin://` asset index and lets the host restart / stop sidecars whose plugin changed
 *   (`src-tauri/src/plugin_host/live.rs`).
 * - The registry diffs the plugin list (`diffPlugins`) and bumps the generation of each changed
 *   plugin: its tiles, mini widgets and settings pages remount on a fresh module (new `v=`
 *   cache-buster), tile instances keep their saved `state`, commands / palette providers /
 *   agent-provider hooks load the new module on their next call. This module handles the rest:
 *   a plugin that was running (loaded, or `onStartup`) is re-activated right away; a removed or
 *   inactive one is unloaded (its tiles show the "unavailable" placeholder).
 * - A toast says what happened ("Updated Hello to 1.2.0"). When the new code fails to load, a
 *   sticky toast offers "Restart QuadFlow" instead of leaving a half-loaded plugin behind.
 */
import { toast } from '@quadflow/ui'
import { relaunch } from '@tauri-apps/plugin-process'
import { commands } from '../generated/bindings'
import { onDataChanged } from '../lib/core'
import { isPluginLoaded, loadPluginModule, unloadPlugin, deactivateAllPlugins } from './loader'
import { onPluginChanges, usePluginRegistry, type PluginChange } from './registry'

let installed = false
let timer: ReturnType<typeof setTimeout> | null = null

/** What the user is told after a successful live change (`null` = nothing to say). */
export function liveChangeMessage(c: PluginChange): string | null {
  // Dev folders ("Load unpacked…", rebuilds) have their own toasts (Settings, devReload.ts).
  if (c.after?.origin === 'dev' || c.before?.origin === 'dev') return null
  const name = c.after?.name ?? c.before?.name ?? c.id
  const version = c.after?.version ? ` ${c.after.version}` : ''
  switch (c.kind) {
    case 'installed':
      return `Installed ${name}${version}`
    case 'uninstalled':
      return `Uninstalled ${name}`
    case 'updated':
      return `Updated ${name} to${version}`
    case 'rolledBack':
      return `Rolled back ${name} to${version}`
    default:
      return null // enable/disable/reload: the user sees the switch or the tile itself
  }
}

/** Restart the app the way the updater does (save, release native resources, stop sidecars). */
export async function restartQuadFlow(): Promise<void> {
  try {
    const { flushSave } = await import('../lib/workspaceSave')
    await Promise.race([flushSave(), new Promise((r) => setTimeout(r, 3000))])
  } catch (e) {
    console.warn('[plugins] saving before restart failed:', e)
  }
  await deactivateAllPlugins()
  await commands.pluginSidecarsStopAll().catch(() => {})
  await relaunch()
}

async function applyChange(c: PluginChange): Promise<void> {
  const active = c.after?.status.kind === 'active'
  if (!active) {
    // Uninstalled / disabled / needs consent: deactivate, drop its context and stylesheet.
    // Its tiles render MissingPluginTile; its tool configs drop out with the next config sync.
    await unloadPlugin(c.id)
    return
  }
  const onStartup = c.after?.manifest?.activation?.includes('onStartup') ?? false
  // Re-activate what was running; anything else loads the new module on first use.
  if (isPluginLoaded(c.id) || onStartup) await loadPluginModule(c.id)
}

function handleChanges(changes: PluginChange[]): void {
  for (const c of changes) {
    applyChange(c).then(
      () => {
        const message = liveChangeMessage(c)
        if (message) toast({ kind: 'success', message, duration: 3000 })
        console.info(`[plugins] live ${c.kind}: ${c.id}`, c.before?.version ?? '-', '→', c.after?.version ?? '-')
      },
      (e) => {
        console.error(`[plugins] live ${c.kind} of ${c.id} failed:`, e)
        // A broken dev build is fixed by the next rebuild (its tiles show the error), not a restart.
        if (c.after?.origin === 'dev') return
        const name = c.after?.name ?? c.before?.name ?? c.id
        toast({
          kind: 'error',
          title: `${name} could not be reloaded`,
          message: `${e instanceof Error ? e.message : String(e)} Restart QuadFlow to finish the change.`,
          duration: 0,
          action: { label: 'Restart QuadFlow', onClick: () => void restartQuadFlow() },
        })
      },
    )
  }
}

function applyQuietly(changes: PluginChange[]): void {
  for (const c of changes) applyChange(c).catch((e) => console.error(`[plugins] live ${c.kind} of ${c.id} failed:`, e))
}

/**
 * Follow registry changes from any process (idempotent). The main window shows the toasts;
 * floating windows (`notify: false`) only reload their own plugin tiles.
 */
export function installLiveReload({ notify = true }: { notify?: boolean } = {}): void {
  if (installed) return
  installed = true
  onPluginChanges(notify ? handleChanges : applyQuietly)
  onDataChanged({ domain: 'plugins' }, (e) => {
    // Source rows (`source:<id>`) do not change any plugin.
    if (e.ids.length && e.ids.every((id) => id.startsWith('source:'))) return
    // Coalesce bursts (one install writes several rows; GUI actions refresh on their own too).
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void usePluginRegistry.getState().load()
    }, 200)
  })
}
