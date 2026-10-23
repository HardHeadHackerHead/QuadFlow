/**
 * `web-preview` — preview a web page (typically a local dev server) in a tile
 * (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `preview` (./WebPreviewTile.tsx), pane or flyout: address bar, zoom, mobile view,
 *    per-project bookmarks (`ctx.storage`), screenshot to clipboard, open in browser
 *  - command `open-url` (`web-preview/open-url { url, linkedScriptTabId? }`): navigate the open
 *    preview tile, or open one; without args it asks for a URL. The Scripts tool runs it for
 *    "server" scripts with a preview URL.
 *
 * The page is a child webview (`ctx.native.createChildWebview`, `native:webview`) the host keeps
 * on the tile and hides under overlays; it is closed with the tile (`ui.onTileClosed`).
 */
import { definePlugin, type Disposable, type JsonValue, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { openTileWithState } from '@quadflow/plugin-kit'
import { WebPreviewTile } from './WebPreviewTile'
import { anyMounted, closeAllWebviews, closeOnTileClosed, normalizeUrl } from './webviews'
import './styles.css'

let offClose: Disposable | null = null

function urlArgs(args?: JsonValue): { url: string | null; linkedScriptTabId?: string } {
  if (typeof args === 'string') return { url: args }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, JsonValue>
    return {
      url: typeof o.url === 'string' ? o.url : null,
      linkedScriptTabId: typeof o.linkedScriptTabId === 'string' ? o.linkedScriptTabId : undefined,
    }
  }
  return { url: null }
}

async function openUrl(ctx: PluginContext, args?: JsonValue) {
  let { url, linkedScriptTabId } = urlArgs(args)
  if (!url) url = await ctx.ui.prompt({ title: 'Open in Web Preview', label: 'URL', initial: 'http://localhost:3000' })
  const target = url ? normalizeUrl(url) : ''
  if (!target) return
  const open = anyMounted()
  if (open && !linkedScriptTabId) {
    const [instanceId, navigate] = open
    navigate(target)
    ctx.ui.focusTile(instanceId)
    return
  }
  try {
    const state: Record<string, JsonValue> = { url: target }
    if (linkedScriptTabId) state.linkedScriptTabId = linkedScriptTabId
    await openTileWithState(ctx, 'preview', state, { placement: 'split-active' })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not open Web Preview', body: e instanceof Error ? e.message : String(e) })
  }
}

export default definePlugin({
  activate(ctx) {
    offClose?.()
    offClose = closeOnTileClosed(ctx)
  },
  async deactivate() {
    offClose?.()
    offClose = null
    // A reload re-creates the webviews from the tiles' saved URLs.
    await closeAllWebviews()
  },
  tiles: {
    // `.qf-web-preview` is the style scope of this plugin's Tailwind build.
    preview: (props: TileProps) => (
      <div className="qf-web-preview h-full w-full">
        <WebPreviewTile {...props} />
      </div>
    ),
  },
  commands: {
    'open-url': (ctx, args) => openUrl(ctx, args),
  },
})
