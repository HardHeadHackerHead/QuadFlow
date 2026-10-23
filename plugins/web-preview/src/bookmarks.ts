/**
 * Per-project web bookmarks, stored in the plugin's own key-value storage
 * (`ctx.storage`, scope `project`, key `bookmarks`). One store per plugin
 * context, shared by the pane and the flyout tile; reloaded on project switch.
 */
import { create, type UseBoundStore, type StoreApi } from 'zustand'
import type { JsonValue, PluginContext } from '@quadflow/plugin-api'

export interface WebBookmark {
  id: string
  title: string
  url: string
  createdAt: number
}

interface BookmarksState {
  /** Root of the project the list belongs to (`null`: no project). */
  projectRoot: string | null
  bookmarks: WebBookmark[]
  loading: boolean
}

const KEY = 'bookmarks'

/** Best-effort default title from a URL: hostname plus non-root path. */
export function deriveTitle(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${path}`
  } catch {
    return url
  }
}

function parse(v: unknown): WebBookmark[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((b) => {
    if (!b || typeof b !== 'object') return []
    const o = b as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.url !== 'string') return []
    return [{ id: o.id, url: o.url, title: typeof o.title === 'string' && o.title ? o.title : o.url, createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0 }]
  })
}

export class BookmarksModel {
  readonly store: UseBoundStore<StoreApi<BookmarksState>>
  private loadSeq = 0

  constructor(private readonly ctx: PluginContext) {
    this.store = create<BookmarksState>()(() => ({ projectRoot: null, bookmarks: [], loading: false }))
    ctx.project.onDidChange(() => void this.load())
    void this.load()
  }

  /** React hook over the store. */
  use<T>(sel: (s: BookmarksState) => T): T {
    return this.store(sel)
  }

  async load(): Promise<void> {
    const root = this.ctx.project.current()?.root ?? null
    const seq = ++this.loadSeq
    if (!root) {
      this.store.setState({ projectRoot: null, bookmarks: [], loading: false })
      return
    }
    this.store.setState({ loading: true })
    try {
      const v = await this.ctx.storage.get(KEY, 'project')
      if (seq === this.loadSeq) this.store.setState({ projectRoot: root, bookmarks: parse(v), loading: false })
    } catch (e) {
      this.ctx.log.warn('loading bookmarks failed:', e)
      if (seq === this.loadSeq) this.store.setState({ projectRoot: root, bookmarks: [], loading: false })
    }
  }

  findByUrl(url: string): WebBookmark | undefined {
    return this.store.getState().bookmarks.find((b) => b.url === url)
  }

  private async save(bookmarks: WebBookmark[]): Promise<void> {
    const root = this.store.getState().projectRoot
    // A switch landed since the list was loaded: never write it into the other project.
    if (!root || root !== this.ctx.project.current()?.root) return
    this.store.setState({ bookmarks })
    await this.ctx.storage.set(KEY, bookmarks as unknown as JsonValue, 'project')
  }

  async add(url: string, title?: string): Promise<void> {
    if (this.findByUrl(url)) return
    const b: WebBookmark = { id: crypto.randomUUID(), title: (title ?? deriveTitle(url)).trim() || url, url, createdAt: Date.now() }
    await this.save([...this.store.getState().bookmarks, b])
  }

  async remove(id: string): Promise<void> {
    await this.save(this.store.getState().bookmarks.filter((b) => b.id !== id))
  }

  async rename(id: string, title: string): Promise<void> {
    const t = title.trim()
    if (!t) return
    await this.save(this.store.getState().bookmarks.map((b) => (b.id === id ? { ...b, title: t } : b)))
  }
}

const models = new WeakMap<PluginContext, BookmarksModel>()
export function bookmarksModel(ctx: PluginContext): BookmarksModel {
  let m = models.get(ctx)
  if (!m) models.set(ctx, (m = new BookmarksModel(ctx)))
  return m
}
