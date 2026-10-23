/**
 * `qfplugin://` URLs (plugin-system.md §8.2): `http://qfplugin.localhost/<id>/<path>`
 * on Windows, `qfplugin://localhost/<id>/<path>` on macOS/Linux.
 *
 * The base comes from Tauri's `convertFileSrc` (which knows the platform's
 * custom-scheme form), but the path is appended segment by segment rather than
 * as one encoded component, so relative imports between a plugin's own chunks
 * (`./chunk-abc.js`) resolve inside the plugin.
 */
import { convertFileSrc } from '@tauri-apps/api/core'

let base: string | null = null

export function pluginAssetBase(): string {
  if (base === null) {
    try {
      base = convertFileSrc('', 'qfplugin').replace(/\/+$/, '')
    } catch {
      // Outside Tauri (unit tests / plain browser): mirror Tauri's convention.
      base = navigator.userAgent.includes('Windows') ? 'http://qfplugin.localhost' : 'qfplugin://localhost'
    }
  }
  return base
}

/** URL of `relPath` (manifest-relative, `/`-separated) inside plugin `pluginId`. */
export function pluginUrl(pluginId: string, relPath: string): string {
  const rel = relPath
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join('/')
  return `${pluginAssetBase()}/${encodeURIComponent(pluginId)}/${rel}`
}
