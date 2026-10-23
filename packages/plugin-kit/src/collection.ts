/**
 * A live, project-scoped list of one domain's entities, kept in sync through
 * the public host API only (`ctx.project`, `ctx.data.<domain>`,
 * `ctx.data.onDidChange`). The pattern every migrated tool copies
 * (docs/plugins/migrating-a-tool.md §4):
 *
 *  - one store per plugin context (pane and flyout tiles share it);
 *  - subscriptions are reference-counted by mounted tiles (`retain()`), so a
 *    closed tool costs nothing;
 *  - change events are filtered to the current project in Rust (`projectRoot`)
 *    and coalesced per animation frame: a few ids are re-fetched one by one,
 *    anything bigger reloads the list;
 *  - results that arrive after a project switch are dropped.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ChangeEvent, CorruptEntry, Disposable, Domain, PluginContext } from '@quadflow/plugin-api'

export interface CollectionState<T> {
  items: T[]
  /** Files the core could not read (never skipped silently). */
  corrupt: CorruptEntry[]
  /** Project the items belong to (`null`: no project open). */
  root: string | null
  loading: boolean
  error: string | null
  /** Bumped on every change event of `relatedDomains` (e.g. links to refetch). */
  relatedVersion: number
}

export interface CollectionSpec<T extends { id: string }> {
  domain: Domain
  /** Other domains whose changes bump `relatedVersion`. */
  relatedDomains?: Domain[]
  list(ctx: PluginContext, root: string): Promise<{ items: T[]; errors?: CorruptEntry[] }>
  get(ctx: PluginContext, id: string, root: string): Promise<T>
  /** Fill omitted (empty) lists etc. */
  normalize(raw: T): T
  /** Order of `items` (default: newest ULID first). */
  compare?(a: T, b: T): number
}

export interface Collection<T extends { id: string }> {
  use: UseBoundStore<StoreApi<CollectionState<T>>>
  /** Start syncing (first caller) — returns the matching release. */
  retain(): Disposable
  reload(silent?: boolean): Promise<void>
  /** The current project root; throws when no project is open. */
  root(): string
  /** Merge a mutation result if it still belongs to the current project. */
  apply(root: string, item: T): void
  remove(root: string, ids: string[]): void
  /** Replace every item (APIs that return the whole set, e.g. `issues.labels.upsert`). */
  replaceAll(root: string, items: T[]): void
}

const newestFirst = (a: { id: string }, b: { id: string }) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

export function createCollection<T extends { id: string }>(ctx: PluginContext, spec: CollectionSpec<T>): Collection<T> {
  const compare = spec.compare ?? newestFirst
  const use = create<CollectionState<T>>(() => ({
    items: [],
    corrupt: [],
    root: null,
    loading: false,
    error: null,
    relatedVersion: 0,
  }))
  const sorted = (items: T[]) => [...items].sort(compare)

  const current = () => ctx.project.current()?.root ?? null

  async function reload(silent = false) {
    const root = current()
    if (!root) {
      use.setState({ items: [], corrupt: [], root: null, loading: false, error: null })
      return
    }
    if (!silent) use.setState({ loading: true })
    try {
      const res = await spec.list(ctx, root)
      if (current() !== root) return // switched meanwhile
      use.setState({
        items: sorted(res.items.map(spec.normalize)),
        corrupt: res.errors ?? [],
        root,
        loading: false,
        error: null,
      })
    } catch (e) {
      ctx.log.error(`failed to load ${spec.domain}:`, e)
      if (current() === root) use.setState({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  function apply(root: string, item: T) {
    if (use.getState().root !== root) return
    const x = spec.normalize(item)
    use.setState((s) => ({ items: sorted([...s.items.filter((i) => i.id !== x.id), x]) }))
  }

  function remove(root: string, ids: string[]) {
    if (use.getState().root !== root) return
    const gone = new Set(ids)
    use.setState((s) => ({ items: s.items.filter((i) => !gone.has(i.id)) }))
  }

  function replaceAll(root: string, items: T[]) {
    if (use.getState().root !== root) return
    use.setState({ items: sorted(items.map(spec.normalize)) })
  }

  // ---- change events, coalesced per frame (data-layer.md §8.4) ----
  let pendingIds: Set<string> | null = null
  let pendingFull = false
  let scheduled = false
  async function flush() {
    scheduled = false
    const root = use.getState().root
    const ids = pendingIds
    const full = pendingFull
    pendingIds = null
    pendingFull = false
    if (!root) return
    if (full || !ids || ids.size > 20) return reload(true)
    for (const id of ids) {
      try {
        apply(root, await spec.get(ctx, id, root))
      } catch {
        return reload(true) // deleted or unreadable meanwhile
      }
    }
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => void flush())
  }
  function onEvent(e: ChangeEvent) {
    if (e.domain !== spec.domain) {
      use.setState((s) => ({ relatedVersion: s.relatedVersion + 1 }))
      return
    }
    const root = use.getState().root
    if (!root) return
    if (e.kind === 'deleted') return remove(root, e.ids)
    if (e.kind === 'invalidated' || e.ids.length === 0) pendingFull = true
    else {
      pendingIds ??= new Set()
      for (const id of e.ids) pendingIds.add(id)
    }
    schedule()
  }

  // ---- subscriptions, reference-counted ----
  let refs = 0
  let projectSubs: Disposable[] = []
  let projectOff: Disposable | null = null

  function subscribeProject() {
    for (const d of projectSubs) d()
    projectSubs = []
    const root = current()
    if (!root) return
    projectSubs.push(ctx.data.onDidChange({ domain: [spec.domain, ...(spec.relatedDomains ?? [])], projectRoot: root }, onEvent))
    // External edits (CLI, other processes) produce events only while the project is watched.
    projectSubs.push(ctx.data.watchProject(root))
  }

  function retain(): Disposable {
    if (refs++ === 0) {
      subscribeProject()
      projectOff = ctx.project.onDidChange(() => {
        subscribeProject()
        void reload()
      })
      void reload()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--refs > 0) return
      projectOff?.()
      projectOff = null
      for (const d of projectSubs) d()
      projectSubs = []
    }
  }

  return {
    use,
    retain,
    reload,
    root() {
      const r = current()
      if (!r) throw new Error('No project is open')
      return r
    },
    apply,
    remove,
    replaceAll,
  }
}
