/**
 * `semantic-search` — optional first-party plugin (not bundled; install it from the
 * official plugin source or load plugins/semantic-search unpacked).
 *
 * A native sidecar (sidecar/, Rust + Candle) discovers agent session transcripts,
 * embeds them with a local sentence-transformer and answers searches; its index and
 * models live in the plugin data folder. This UI module contributes:
 *  - tile `search` (pane / flyout): search, results, index status, settings panel
 *  - settings page `semantic-search`: the same settings panel
 *  - commands `search` (prompt → tile), `index`, `reindex`, and `related-sessions`
 *    (`{ query, providerId?, limit?, minScore? }` → `SessionHit[]`; used by the shell's
 *    agent launch dialog, never downloads a model)
 *  - palette provider `sessions`: type `semantic search: <query>` (or `ss: <query>`)
 *
 * Session folders come from the host (`agents.sessionRoots`, every active provider's
 * session dir) plus folders added in the settings. Nothing is imported from the shell.
 */
import { definePlugin, type JsonValue, type PaletteItem, type PluginContext, type SettingsPageProps, type TileProps } from '@quadflow/plugin-api'
import { openTileWithState } from '@quadflow/plugin-kit'
import { useEffect } from 'react'
import { formatScore, paletteQuery, projectLabel, truncate } from './format'
import { errorText, semanticModel, type SessionHit } from './model'
import { SearchTile } from './SearchTile'
import { SettingsPanel } from './SettingsPanel'
import { readSettings } from './settings'
import './styles.css'

async function openSearch(ctx: PluginContext, query?: string) {
  const model = semanticModel(ctx)
  if (query) model.setPendingQuery(query)
  if (model.visibleTiles > 0) return
  try {
    await openTileWithState(ctx, 'search', query ? { query } : {})
  } catch (e) {
    ctx.log.warn('openTile failed', errorText(e))
  }
}

async function startIndex(ctx: PluginContext, full: boolean) {
  try {
    const started = await semanticModel(ctx).index(full)
    ctx.notifications.toast({
      kind: started ? 'info' : 'warning',
      title: started ? (full ? 'Rebuilding the semantic index' : 'Indexing agent sessions') : 'Indexing is already running',
      action: { label: 'Show', command: 'semantic-search/search' },
    })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not start indexing', body: errorText(e) })
  }
}

async function searchPalette(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  const q = paletteQuery(query)
  if (!q || q.length < 2) return []
  const open: PaletteItem = {
    id: `open:${q}`,
    title: `Semantic search: “${truncate(q, 60)}”`,
    subtitle: 'Open in the Semantic Search tile',
    keywords: [query],
    run: () => openSearch(ctx, q),
  }
  let hits: SessionHit[] = []
  try {
    hits = await semanticModel(ctx).search<SessionHit>(q, { mode: 'sessions', limit: 6 })
  } catch {
    /* model not downloaded / sidecar unavailable: just offer the tile */
  }
  return [
    open,
    ...hits.map((h) => ({
      id: h.sessionPath,
      title: truncate(h.preview.replace(/\s+/g, ' '), 90),
      subtitle: `${formatScore(h.score)} · ${projectLabel(h.project) || h.providerId}`,
      keywords: [query],
      run: () => openSearch(ctx, q),
    })),
  ]
}

function Tile(props: TileProps) {
  const model = semanticModel(props.ctx)
  useEffect(() => (props.visible ? model.trackVisible() : undefined), [props.visible, model])
  // The `.qf-semantic-search` wrapper is the style scope of this plugin's Tailwind build.
  return (
    <div className="qf-semantic-search">
      <SearchTile {...props} />
    </div>
  )
}

function SettingsPage({ ctx }: SettingsPageProps) {
  return (
    <div className="qf-semantic-search">
      <SettingsPanel ctx={ctx} />
    </div>
  )
}

export default definePlugin({
  activate(ctx) {
    // Automatic indexing runs in the sidecar: start it at startup when the user asked for it.
    if (readSettings(ctx).indexMode !== 'manual' && ctx.api.has('sidecar.request')) {
      void semanticModel(ctx).refresh()
    }
  },
  tiles: { search: Tile },
  settingsPages: { 'semantic-search': SettingsPage },
  commands: {
    search: async (ctx, args) => {
      const given = args && typeof args === 'object' && !Array.isArray(args) ? (args as { query?: unknown }).query : undefined
      const q = typeof given === 'string' ? given : await ctx.ui.prompt({ title: 'Semantic search', label: 'Search past agent sessions' })
      if (q === null) return
      await openSearch(ctx, q?.trim() || undefined)
    },
    index: (ctx) => startIndex(ctx, false),
    reindex: (ctx) => startIndex(ctx, true),
    'related-sessions': async (ctx, args): Promise<JsonValue> => {
      const a = (args ?? {}) as { query?: string; providerId?: string | null; limit?: number; minScore?: number }
      const q = (a.query ?? '').trim()
      if (q.length < 3 || !ctx.api.has('sidecar.request')) return []
      try {
        const hits = await semanticModel(ctx).search<SessionHit>(q, { mode: 'sessions', limit: a.limit ?? 5, minScore: a.minScore, providerId: a.providerId ?? null })
        return hits as unknown as JsonValue
      } catch {
        return []
      }
    },
  },
  paletteProviders: { sessions: { search: searchPalette } },
})
