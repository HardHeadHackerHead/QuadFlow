/**
 * Palette entity search from plugins (plugin-system.md §5.5): every active
 * plugin that declares `contributes.paletteProviders[]` is loaded on the first
 * entity query and its UI module's `paletteProviders[id].search(query, ctx)`
 * is called. Results are grouped under the provider's `title`.
 *
 * A slow or failing provider never blocks the palette: each one has a time
 * budget and errors are logged and dropped.
 */
import { createElement, type ReactNode } from 'react'
import type { PaletteItem } from '@quadflow/plugin-api'
import { loadPluginModule } from './loader'
import { ensurePluginRegistry, usePluginRegistry } from './registry'
import PluginIcon from './PluginIcon'

export interface PaletteProviderHit {
  pluginId: string
  providerId: string
  /** Group label (manifest `title`). */
  title: string
  icon: ReactNode
  item: PaletteItem
}

const PROVIDER_TIMEOUT_MS = 1500
const MAX_PER_PROVIDER = 10

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Query every declared palette provider; never rejects. */
export async function searchPaletteProviders(query: string): Promise<PaletteProviderHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  await ensurePluginRegistry()
  const providers = usePluginRegistry.getState().contributions?.paletteProviders ?? []
  const groups = await Promise.all(
    providers.map(async ({ pluginId, contribution }) => {
      try {
        const loaded = await loadPluginModule(pluginId)
        const provider = loaded.module.paletteProviders?.[contribution.id]
        if (!provider) return []
        const items = await withTimeout(provider.search(q, loaded.ctx), PROVIDER_TIMEOUT_MS)
        const icon = createElement(PluginIcon, { pluginId, size: 16 })
        return items.slice(0, MAX_PER_PROVIDER).map((item) => ({
          pluginId,
          providerId: contribution.id,
          title: contribution.title,
          icon,
          item,
        }))
      } catch (e) {
        console.warn(`[plugins] palette provider ${pluginId}/${contribution.id} failed:`, e)
        return []
      }
    }),
  )
  return groups.flat()
}
