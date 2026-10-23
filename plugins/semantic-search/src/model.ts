/**
 * The plugin's state, one per plugin context (pane, flyout and settings page share it):
 * the sidecar's status / progress (pushed as `ui/*` notifications, polled while a view is
 * open) and thin wrappers over its requests. Search results live in the views.
 */
import type { JsonValue, PluginContext, SidecarStatus } from '@quadflow/plugin-api'
import { create, type StoreApi, type UseBoundStore } from 'zustand'

export interface SemanticProgress {
  phase: string
  current: number
  total: number
  sessionPath?: string | null
  fileName?: string | null
  chunk: number
  chunks: number
  downloadedBytes?: number | null
  totalBytes?: number | null
  elapsedMs: number
}

export interface SemanticIndexStats {
  sessions: number
  indexed: number
  pending: number
  errors: number
  chunks: number
  otherModelChunks: number
  lastIndexedAt: number | null
  dbBytes: number
}

export interface SemanticStatus {
  state: 'idle' | 'running'
  progress: SemanticProgress | null
  lastError: string | null
  lastRunAt: number | null
  lastRunIndexed: number
  lastRunFailed: number
  stats: SemanticIndexStats | null
  model: { id: string; name: string; downloaded: boolean; loaded: boolean; device: string | null }
  indexMode: string
  /** Host has `agents.sessionRoots` (null = not asked yet). */
  providerSessionRoots: boolean | null
  dataDir: string
  gpu: { cudaCompiled: boolean; metalCompiled: boolean }
}

export interface SemanticModelInfo {
  id: string
  name: string
  repo: string | null
  dimensions: number
  sizeBytes: number
  quality: number
  description: string
  minSimilarity: number
  downloaded: boolean
  path: string | null
  diskBytes: number
}

export interface SemanticRoot {
  providerId: string
  root: string
  glob: string | null
  origin: 'provider' | 'setting' | string
  exists: boolean
}

export interface SessionHit {
  sessionId: string
  sessionPath: string
  providerId: string
  project: string
  lastModified: number
  score: number
  bestSimilarity: number
  avgSimilarity: number
  matchingChunks: number
  totalChunks: number
  preview: string
  previewRole: string | null
  taskType: string | null
}

export interface ChunkHit {
  sessionId: string
  sessionPath: string
  providerId: string
  project: string
  chunkIndex: number
  content: string
  role: string | null
  turn: number | null
  score: number
}

export interface SessionChunk {
  chunkIndex: number
  content: string
  role: string | null
  turn: number | null
  modelId: string
  dimensions: number
}

export interface SearchOptions {
  mode?: 'sessions' | 'chunks'
  limit?: number
  minScore?: number
  providerId?: string | null
  project?: string | null
  currentFiles?: string[]
}

export interface DownloadState {
  modelId: string
  file?: string
  downloadedBytes?: number
  totalBytes?: number | null
  done?: boolean
  error?: string
}

interface ModelState {
  status: SemanticStatus | null
  /** Why the sidecar could not be reached (missing binary, crash, …). */
  error: string | null
  sidecar: SidecarStatus['state'] | 'unknown'
  download: DownloadState | null
  /** Bumped after each finished index job (views re-run their search). */
  indexedVersion: number
  /** A query handed over by the palette / a command for the next visible tile. */
  pendingQuery: string | null
}

export class SemanticModel {
  readonly store: UseBoundStore<StoreApi<ModelState>>
  private retains = 0
  private disposers: (() => void)[] = []
  private poll: ReturnType<typeof setInterval> | null = null

  constructor(readonly ctx: PluginContext) {
    this.store = create<ModelState>(() => ({
      status: null,
      error: null,
      sidecar: 'unknown',
      download: null,
      indexedVersion: 0,
      pendingQuery: null,
    }))
  }

  /** Number of mounted, visible search tiles (commands open a tile only when there is none). */
  visibleTiles = 0

  trackVisible(): () => void {
    this.visibleTiles++
    return () => {
      this.visibleTiles--
    }
  }

  get available(): boolean {
    return this.ctx.api.has('sidecar.request')
  }

  request<T = JsonValue>(method: string, params?: JsonValue, timeoutMs = 30_000): Promise<T> {
    if (!this.available) return Promise.reject(new Error('This QuadFlow version does not run plugin sidecars.'))
    return this.ctx.sidecar.request<T>(method, params, { timeoutMs })
  }

  /** Subscribe to sidecar notifications and poll the status while a view is open. */
  retain(): () => void {
    if (this.retains++ === 0) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.retains === 0) this.stopListening()
    }
  }

  private start() {
    if (!this.available) {
      this.store.setState({ error: 'This QuadFlow version does not run plugin sidecars.' })
      return
    }
    const sc = this.ctx.sidecar
    const d = [
      sc.onNotification('status', (s) => this.store.setState({ status: s as unknown as SemanticStatus, error: null })),
      sc.onNotification('progress', (p) =>
        this.store.setState((st) => (st.status ? { status: { ...st.status, state: 'running', progress: p as unknown as SemanticProgress } } : {})),
      ),
      sc.onNotification('indexed', () => this.store.setState((st) => ({ indexedVersion: st.indexedVersion + 1 }))),
      sc.onNotification('download', (p) => {
        const dl = p as unknown as DownloadState
        this.store.setState({ download: dl.done && !dl.error ? null : dl })
        if (dl.done) {
          if (dl.error) this.ctx.notifications.toast({ kind: 'error', title: 'Model download failed', body: dl.error })
          void this.refresh()
        }
      }),
      sc.onStatus((s) => this.store.setState({ sidecar: s.state, ...(s.state === 'failed' ? { error: s.lastError ?? 'The semantic search sidecar failed.' } : {}) })),
    ]
    this.disposers = d
    void this.refresh()
    this.poll = setInterval(() => void this.refresh(), 5000)
  }

  private stopListening() {
    for (const d of this.disposers) d()
    this.disposers = []
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  async refresh(): Promise<SemanticStatus | null> {
    try {
      const status = await this.request<SemanticStatus>('status')
      this.store.setState({ status, error: null })
      return status
    } catch (e) {
      this.store.setState({ error: errorText(e) })
      return null
    }
  }

  async index(full = false): Promise<boolean> {
    const r = await this.request<{ started: boolean }>('index', { full })
    void this.refresh()
    return r.started
  }

  async stop(): Promise<void> {
    await this.request('stop')
    void this.refresh()
  }

  search<T = SessionHit>(query: string, o: SearchOptions = {}): Promise<T[]> {
    // Loading a model can take a while the first time.
    return this.request<T[]>('search', { query, ...o } as unknown as JsonValue, 120_000)
  }

  /** Settings changed in the UI: make the sidecar re-read them now. */
  async settingsChanged(): Promise<void> {
    try {
      const status = await this.request<SemanticStatus>('reloadSettings')
      this.store.setState({ status, error: null })
    } catch (e) {
      this.store.setState({ error: errorText(e) })
    }
  }

  setPendingQuery(q: string | null) {
    this.store.setState({ pendingQuery: q })
  }
}

const models = new WeakMap<PluginContext, SemanticModel>()

export function semanticModel(ctx: PluginContext): SemanticModel {
  let m = models.get(ctx)
  if (!m) {
    m = new SemanticModel(ctx)
    models.set(ctx, m)
  }
  return m
}

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

/** The sidecar said the configured model is not downloaded yet. */
export function isModelMissing(e: unknown): boolean {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : ''
  return code === 'model_missing' || /model_missing|not downloaded/i.test(errorText(e))
}
