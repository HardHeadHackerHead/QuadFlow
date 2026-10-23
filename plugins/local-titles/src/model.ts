/**
 * Local Titles model (one per plugin context): the sidecar's model list,
 * download progress and the title generator. Replaces the shell's
 * `titleSettingsStore` local-model half and `src-tauri/src/title/{models,inference}.rs`.
 *
 * Settings (`contributes.settings`): `modelId`, `deviceMode` (auto | gpu | cpu),
 * `gpuLayers` (0 = all), `maxTokens`, `temperature`. The word limit comes from
 * the shell's request (Settings → Integrations → Auto Titles).
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Disposable, JsonValue, PluginContext, TitleRequest } from '@quadflow/plugin-api'

export interface ModelStatus {
  id: string
  name: string
  sizeBytes: number
  qualityRating: number
  tier: string
  downloaded: boolean
  downloading: boolean
  path: string | null
}

export interface SidecarInfo {
  backend: string
  gpu: string | null
  modelsDir: string
}

export interface DownloadProgress {
  downloadedBytes: number
  totalBytes: number
}

export interface LocalTitlesState {
  info: SidecarInfo | null
  models: ModelStatus[]
  progress: Record<string, DownloadProgress>
  loading: boolean
  error: string | null
  sidecarState: string
}

export interface LocalTitleSettings {
  modelId: string
  deviceMode: string
  gpuLayers: number
  maxTokens: number
  temperature: number
}

export const DEFAULT_MODEL_ID = 'tinyllama-1.1b-chat-q4k'
/** First use loads the model (seconds for the 7–8B ones); later calls are fast. */
const GENERATE_TIMEOUT_MS = 25_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function readSettings(ctx: PluginContext): LocalTitleSettings {
  const s = ctx.settings
  const num = (k: string, d: number) => (typeof s.get(k) === 'number' ? (s.get(k) as number) : d)
  return {
    modelId: typeof s.get('modelId') === 'string' && s.get('modelId') ? (s.get('modelId') as string) : DEFAULT_MODEL_ID,
    deviceMode: typeof s.get('deviceMode') === 'string' ? (s.get('deviceMode') as string) : 'auto',
    gpuLayers: num('gpuLayers', 0),
    maxTokens: num('maxTokens', 12),
    temperature: num('temperature', 0.2),
  }
}

export class LocalTitlesModel {
  readonly store: UseBoundStore<StoreApi<LocalTitlesState>>
  private subs: Disposable[] = []

  constructor(private readonly ctx: PluginContext) {
    this.store = create<LocalTitlesState>(() => ({ info: null, models: [], progress: {}, loading: false, error: null, sidecarState: 'stopped' }))
  }

  /** Sidecar notifications while a settings page is open (reference-counted by the caller). */
  retain(): Disposable {
    const { ctx } = this
    const subs = [
      ctx.sidecar.onStatus((s) => this.store.setState({ sidecarState: s.state })),
      ctx.sidecar.onNotification('downloadProgress', (p) => {
        const o = (p ?? {}) as Record<string, unknown>
        const id = String(o.modelId ?? '')
        if (!id) return
        this.store.setState((s) => ({
          progress: { ...s.progress, [id]: { downloadedBytes: Number(o.downloadedBytes) || 0, totalBytes: Number(o.totalBytes) || 0 } },
        }))
      }),
      ctx.sidecar.onNotification('downloadDone', (p) => {
        const o = (p ?? {}) as Record<string, unknown>
        const id = String(o.modelId ?? '')
        this.store.setState((s) => {
          const progress = { ...s.progress }
          delete progress[id]
          return { progress, error: o.ok === false && o.error !== 'cancelled' ? `Download failed: ${String(o.error)}` : s.error }
        })
        void this.refresh()
      }),
    ]
    this.subs.push(...subs)
    void this.refresh()
    return () => {
      for (const d of subs) d()
      this.subs = this.subs.filter((d) => !subs.includes(d))
    }
  }

  async refresh(): Promise<void> {
    this.store.setState({ loading: true })
    try {
      const [info, models] = await Promise.all([
        this.ctx.sidecar.request<SidecarInfo>('titles/info'),
        this.ctx.sidecar.request<ModelStatus[]>('titles/models'),
      ])
      this.store.setState({ info, models, loading: false })
    } catch (e) {
      this.store.setState({ loading: false, error: `The Local Titles sidecar is not available: ${errText(e)}` })
    }
  }

  clearError = () => this.store.setState({ error: null })

  async download(modelId: string): Promise<void> {
    this.store.setState((s) => ({ error: null, progress: { ...s.progress, [modelId]: { downloadedBytes: 0, totalBytes: 0 } } }))
    try {
      await this.ctx.sidecar.request('titles/download', { modelId })
      await this.refresh()
    } catch (e) {
      this.store.setState((s) => {
        const progress = { ...s.progress }
        delete progress[modelId]
        return { progress, error: `Download failed: ${errText(e)}` }
      })
    }
  }

  async cancelDownload(): Promise<void> {
    await this.ctx.sidecar.request('titles/cancelDownload').catch(() => undefined)
  }

  async remove(modelId: string): Promise<void> {
    try {
      await this.ctx.sidecar.request('titles/delete', { modelId })
    } catch (e) {
      this.store.setState({ error: `Delete failed: ${errText(e)}` })
    }
    await this.refresh()
  }

  async setSetting(key: keyof LocalTitleSettings, value: JsonValue): Promise<void> {
    try {
      await this.ctx.settings.set(key, value)
    } catch (e) {
      this.store.setState({ error: errText(e) })
    }
  }

  /**
   * The title generator (`titleGenerators.llama`): `null` when the selected
   * model is not downloaded, so the shell moves on to the next source.
   */
  async generate(req: TitleRequest): Promise<string | null> {
    const s = readSettings(this.ctx)
    try {
      const r = await this.ctx.sidecar.request<{ title: string; device: string }>(
        'titles/generate',
        {
          text: req.text,
          modelId: s.modelId,
          minWords: req.minWords,
          maxWords: req.maxWords,
          deviceMode: s.deviceMode,
          gpuLayers: s.gpuLayers > 0 ? s.gpuLayers : null,
          maxTokens: s.maxTokens,
          temperature: s.temperature,
        },
        { timeoutMs: GENERATE_TIMEOUT_MS },
      )
      return r.title?.trim() || null
    } catch (e) {
      // Not downloaded / no llama backend in this build: pass to the next generator.
      this.ctx.log.debug(`local title generation unavailable: ${errText(e)}`)
      return null
    }
  }
}

const models = new WeakMap<PluginContext, LocalTitlesModel>()

export function localTitlesModel(ctx: PluginContext): LocalTitlesModel {
  let m = models.get(ctx)
  if (!m) {
    m = new LocalTitlesModel(ctx)
    models.set(ctx, m)
  }
  return m
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'Unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let i = 0
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}
