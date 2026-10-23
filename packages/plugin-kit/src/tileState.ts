/**
 * Open a tile with an initial state, reliably.
 *
 * `ctx.ui.openTile(id, { state })` is meant to hand `state` to the new tile as
 * `props.instance.state`. Hosts up to API 1.1 drop it, so the state also goes
 * into a per-contribution queue: a tile that mounts without state claims the
 * oldest queued one (and should persist it with `setState`). On hosts that do
 * pass it through, the tile finds it in `instance.state` and the queued copy is
 * discarded.
 *
 *   await openTileWithState(ctx, 'file', { path })                    // command
 *   const [s] = useState(() => claimTileState(ctx, 'file', instance.state)) // tile
 */
import type { JsonValue, PluginContext, UiApi } from '@quadflow/plugin-api'

type OpenOptions = Omit<NonNullable<Parameters<UiApi['openTile']>[1]>, 'state'>

const queues = new Map<string, JsonValue[]>()
const keyOf = (ctx: PluginContext, contributionId: string) => `${ctx.plugin.id}/${contributionId}`
const same = (a: JsonValue, b: JsonValue) => JSON.stringify(a) === JSON.stringify(b)

/** True for `null`, `{}` and `[]` (a tile that has not stored anything yet). */
export function isEmptyTileState(state: JsonValue | undefined): boolean {
  if (state === null || state === undefined) return true
  if (Array.isArray(state)) return state.length === 0
  return typeof state === 'object' && Object.keys(state).length === 0
}

/** `ctx.ui.openTile` with `state`, plus the queue fallback. Resolves with the instance id. */
export async function openTileWithState(
  ctx: PluginContext,
  contributionId: string,
  state: JsonValue,
  o?: OpenOptions,
): Promise<string> {
  const key = keyOf(ctx, contributionId)
  const q = queues.get(key) ?? []
  queues.set(key, q)
  q.push(state)
  try {
    return await ctx.ui.openTile(contributionId, { ...o, state })
  } catch (e) {
    const i = q.indexOf(state)
    if (i >= 0) q.splice(i, 1)
    throw e
  }
}

/**
 * The state a tile should start from: its own `instanceState` if it has one
 * (dropping the matching queued copy), else the oldest queued state, else `null`.
 * Call once per mount (e.g. in a `useState` initializer).
 */
export function claimTileState(ctx: PluginContext, contributionId: string, instanceState: JsonValue | undefined): JsonValue {
  const q = queues.get(keyOf(ctx, contributionId)) ?? []
  if (!isEmptyTileState(instanceState)) {
    const i = q.findIndex((s) => same(s, instanceState as JsonValue))
    if (i >= 0) q.splice(i, 1)
    return instanceState as JsonValue
  }
  return q.shift() ?? null
}
