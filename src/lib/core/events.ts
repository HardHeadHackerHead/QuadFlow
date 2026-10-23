/** Typed change-event subscription (data-layer.md §8.4). */
import { events, type ChangeEvent, type Domain } from '../../generated/bindings'

export interface DataChangedFilter {
  domain: Domain | Domain[]
  /** Only events for this project (`ChangeScope.project.rootKey`). */
  projectRootKey?: string
}

function matches(filter: DataChangedFilter, e: ChangeEvent): boolean {
  const domains = Array.isArray(filter.domain) ? filter.domain : [filter.domain]
  if (!domains.includes(e.domain)) return false
  if (filter.projectRootKey !== undefined) {
    return e.scope.type === 'project' && e.scope.rootKey === filter.projectRootKey
  }
  return true
}

/**
 * Subscribe to `DataChanged`. Returns a synchronous unsubscribe; calling it
 * before `listen()` resolves still detaches the listener once it arrives
 * (disposed-flag pattern), so effects that unmount early do not leak.
 */
export function onDataChanged(
  filter: DataChangedFilter,
  handler: (e: ChangeEvent) => void,
): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  events.dataChanged
    .listen((ev) => {
      if (!disposed && matches(filter, ev.payload)) handler(ev.payload)
    })
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch((err) => console.error('[core] onDataChanged listen failed:', err))

  return () => {
    if (disposed) return
    disposed = true
    unlisten?.()
    unlisten = null
  }
}
