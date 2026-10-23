/**
 * `external-apps` — launch external programs, link/focus their windows, embed
 * a window into a tile (first-party, bundled, trusted; Windows).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `app` (pane only — a native child window cannot live in a flyout):
 *    ./ExternalAppTile.tsx;
 *  - toolbar item `link` → command `activate-link`: focus the linked window or
 *    launch/focus the linked program; an unlinked button opens the tile to
 *    choose its target;
 *  - commands `embed-window`, `detach-all`, `reset-links`;
 *  - settings `dropToEmbed` / `dropRequiresHotkey`: drag a window onto
 *    QuadFlow (holding Ctrl+Shift) to embed it in a new tile.
 *
 * Native work is in the Rust sidecar (sidecar/src); see ./model.ts.
 * Replaces the former App Launcher, Window Link and Embed Window tools.
 */
import { definePlugin, type JsonValue, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { openTileWithState } from '@quadflow/plugin-kit'
import { ExternalAppTile, type TileState } from './ExternalAppTile'
import { errorText, existingModel, exeName, externalAppsModel } from './model'
import './styles.css'

let activeCtx: PluginContext | null = null
let offDrop: (() => void) | null = null

function toolConfigIdOf(args?: JsonValue): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const id = (args as Record<string, JsonValue>).toolConfigId
  return typeof id === 'string' ? id : undefined
}

/** Open a new tile starting from `state` (`claimTileState` in the tile covers API 1.1 hosts). */
async function openTile(ctx: PluginContext, state: TileState) {
  await openTileWithState(ctx, 'app', state as unknown as JsonValue, { placement: 'split-active' })
}

/** Toolbar "App / Window Link" button. */
async function activateLink(ctx: PluginContext, args?: JsonValue) {
  const id = toolConfigIdOf(args)
  if (!id) return
  const model = externalAppsModel(ctx)
  const target = await model.getLink(id)
  if (!target) {
    await openTile(ctx, { setupFor: id })
    return
  }
  try {
    if (target.kind === 'window') {
      const r = await model.call<{ found: boolean; focused: boolean }>('windows.focusMatch', {
        processName: target.processName,
        windowTitle: target.windowTitle,
      })
      if (!r.found) {
        ctx.notifications.toast({
          kind: 'warning',
          title: `${target.processName} is not running`,
          body: 'Run “External Apps: Reset Toolbar Links” to link the button to another window.',
        })
      }
    } else {
      await model.launch(`link:${id}`, target)
    }
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: target.kind === 'app' ? `Could not launch ${exeName(target.path)}` : 'Could not focus the window', body: errorText(e) })
  }
}

async function syncDragMonitor(ctx: PluginContext) {
  const model = externalAppsModel(ctx)
  if (!model.nativeAvailable) return
  const on = ctx.settings.get<boolean>('dropToEmbed') === true
  try {
    if (on) {
      await model.call('drag.start', { requireHotkey: ctx.settings.get<boolean>('dropRequiresHotkey') !== false })
      offDrop ??= ctx.sidecar.onNotification('drop', (p) => {
        const hwnd = (p as { hwnd?: number } | null)?.hwnd
        if (typeof hwnd === 'number') void openTile(ctx, { embedHwnd: hwnd }).catch(() => {})
      })
    } else if (offDrop) {
      offDrop()
      offDrop = null
      await model.call('drag.stop')
    }
  } catch (e) {
    ctx.log.warn('drag-to-embed unavailable:', errorText(e))
  }
}

export default definePlugin({
  activate(ctx) {
    activeCtx = ctx
    // Only touches the sidecar when drag-to-embed is turned on.
    if (ctx.settings.get<boolean>('dropToEmbed') === true) void syncDragMonitor(ctx)
    ctx.settings.onDidChange((key) => {
      if (key === 'dropToEmbed' || key === 'dropRequiresHotkey') void syncDragMonitor(ctx)
    })
  },
  async deactivate() {
    // Reload / disable / app exit: give every embedded window back.
    const ctx = activeCtx
    activeCtx = null
    offDrop?.()
    offDrop = null
    const model = ctx ? existingModel(ctx) : undefined
    if (!model) return
    model.dispose()
    if (model.nativeAvailable && Object.keys(model.embeds.getState().byInstance).length > 0) {
      await model.call('embed.detachAll', {}, 5_000).catch(() => {})
    }
  },
  tiles: {
    // The `.qf-external-apps` wrapper is the style scope of this plugin's Tailwind build.
    app: (props: TileProps) => (
      <div className="qf-external-apps">
        <ExternalAppTile {...props} />
      </div>
    ),
  },
  commands: {
    'activate-link': (ctx, args) => activateLink(ctx, args),
    'embed-window': (ctx) => openTile(ctx, {}),
    'detach-all': async (ctx) => {
      const model = externalAppsModel(ctx)
      await model.call('embed.detachAll')
      await model.refreshEmbeds()
    },
    'reset-links': async (ctx) => {
      const keys = await ctx.storage.keys('link:')
      await Promise.all(keys.map((k) => ctx.storage.delete(k)))
      ctx.notifications.toast({ kind: 'success', title: `Cleared ${keys.length} toolbar link${keys.length === 1 ? '' : 's'}` })
    },
  },
})
