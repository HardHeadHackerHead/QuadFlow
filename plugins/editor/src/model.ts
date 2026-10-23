/**
 * Which editor tiles are open (one tile per file) and how a new one learns
 * its file.
 *
 * `editor/open { path }` focuses the tile already showing that file, or opens
 * a new `file` tile with `state: { path, scope }` (`openTileWithState` from
 * the kit, which also covers hosts that drop `ui.openTile`'s `state`).
 */
import type { JsonValue, PluginContext } from '@quadflow/plugin-api'
import { claimTileState, openTileWithState } from '@quadflow/plugin-kit'
import { resolveTarget, targetKey, type EditorScope, type EditorTarget } from './paths'

const openTiles = new Map<string, string>() // instanceId -> targetKey

/** The tile's persisted state, if it names a file. */
export function targetFromState(state: JsonValue): EditorTarget | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const s = state as { path?: unknown; scope?: unknown }
  if (typeof s.path !== 'string' || !s.path) return null
  const scope: EditorScope = s.scope === 'absolute' ? 'absolute' : 'project'
  return { path: s.path, scope }
}

/** Called once by a tile on mount: its file (persisted state, else the request that opened it). */
export function claimTarget(ctx: PluginContext, state: JsonValue): EditorTarget | null {
  return targetFromState(claimTileState(ctx, 'file', state))
}

/** Register a mounted tile's file; returns the unregister function. */
export function trackTile(instanceId: string, target: EditorTarget): () => void {
  const key = targetKey(target)
  openTiles.set(instanceId, key)
  return () => {
    if (openTiles.get(instanceId) === key) openTiles.delete(instanceId)
  }
}

function findTile(target: EditorTarget): string | null {
  const key = targetKey(target)
  for (const [id, k] of openTiles) if (k === key) return id
  return null
}

/** Args of `editor/open`: `{ path }` (absolute or project-relative) or a bare path string. */
export function pathArg(args: JsonValue | undefined): string | null {
  if (typeof args === 'string') return args.trim() || null
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const p = (args as { path?: unknown; filePath?: unknown }).path ?? (args as { filePath?: unknown }).filePath
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return null
}

/** Focus the tile showing `path`, or open a new one. Resolves with its instance id. */
export async function openFile(ctx: PluginContext, path: string, scope?: EditorScope): Promise<string> {
  const target = scope ? { path, scope } : resolveTarget(path, ctx.project.current()?.root)
  const existing = findTile(target)
  if (existing) {
    ctx.ui.focusTile(existing)
    return existing
  }
  return openTileWithState(ctx, 'file', { path: target.path, scope: target.scope }, { placement: 'split-active' })
}
