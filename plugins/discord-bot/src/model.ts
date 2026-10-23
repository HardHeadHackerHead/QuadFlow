/**
 * Discord bot model: one per plugin context, shared by the pane and flyout
 * tiles and the commands. Replaces the shell's `discordBotStore.ts` +
 * `discord_bridge.rs`:
 *
 *  - settings: guild / channel / role / auto-mirror in `ctx.settings`
 *    (`contributes.settings`), the bot token in `ctx.secrets` (`botToken`);
 *  - the bot runs in the Node sidecar (sidecar/index.mjs), `discord/*` requests;
 *  - mirroring follows terminals with `ctx.terminals.onData` (`terminal:io`),
 *    batched for 300 ms like the old Rust buffer, and types Discord replies
 *    back with `ctx.terminals.write`.
 *
 * Mirroring lives here, not in a tile, so closing the tile does not stop it;
 * `dispose()` (plugin deactivate) does.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { Disposable, JsonValue, PluginContext } from '@quadflow/plugin-api'

export interface DiscordSettings {
  guildId: string
  channelId: string
  qualifiedRoleId: string
  autoMirror: boolean
}

export interface DiscordBotStatus {
  running: boolean
  connected: boolean
  botUsername: string | null
  guildName: string | null
}

export interface MirroredTerminal {
  terminalId: string
  sessionLabel: string
  threadId: string | null
  threadUrl: string | null
}

export interface DiscordState {
  settings: DiscordSettings
  hasToken: boolean
  status: DiscordBotStatus
  mirrored: MirroredTerminal[]
  error: string | null
  isSaving: boolean
  isStarting: boolean
  /** Sidecar process state (stopped | starting | running | restarting | failed). */
  sidecarState: string
}

export const SECRET_TOKEN = 'botToken'
/** Output is collected per terminal for this long before one `discord/output`. */
const OUTPUT_BATCH_MS = 300
const STOPPED: DiscordBotStatus = { running: false, connected: false, botUsername: null, guildName: null }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class DiscordModel {
  readonly store: UseBoundStore<StoreApi<DiscordState>>
  private readonly subs: Disposable[] = []
  private readonly mirrors = new Map<string, Disposable[]>()
  private readonly buffers = new Map<string, { data: string; timer: ReturnType<typeof setTimeout> }>()
  private started = false

  constructor(private readonly ctx: PluginContext) {
    this.store = create<DiscordState>(() => ({
      settings: this.readSettings(),
      hasToken: false,
      status: { ...STOPPED },
      mirrored: [],
      error: null,
      isSaving: false,
      isStarting: false,
      sidecarState: 'stopped',
    }))
  }

  /** Subscriptions (idempotent): sidecar notifications, settings, auto-mirror. */
  init(): void {
    if (this.started) return
    this.started = true
    const { ctx } = this
    void ctx.secrets.get(SECRET_TOKEN).then(
      (t) => this.store.setState({ hasToken: !!t }),
      () => this.store.setState({ hasToken: false }),
    )
    this.subs.push(
      ctx.settings.onDidChange(() => this.store.setState({ settings: this.readSettings() })),
      ctx.sidecar.onStatus((s) => {
        this.store.setState({ sidecarState: s.state })
        // A crashed / stopped sidecar has no bot: drop the mirrors.
        if (s.state !== 'running' && s.state !== 'starting') this.botStopped()
      }),
      ctx.sidecar.onNotification('status', (p) => this.onStatus(p)),
      ctx.sidecar.onNotification('threadCreated', (p) => this.onThreadCreated(p)),
      ctx.sidecar.onNotification('reply', (p) => this.onReply(p)),
      ctx.sidecar.onNotification('error', (p) => {
        const o = (p ?? {}) as Record<string, unknown>
        this.store.setState({ error: str(o.message) || 'Discord error' })
      }),
      ctx.events.on('terminal.created', (p) => void this.maybeAutoMirror(p)),
    )
  }

  dispose(): void {
    for (const id of [...this.mirrors.keys()]) this.dropMirror(id)
    for (const d of this.subs.splice(0)) d()
    this.started = false
  }

  private readSettings(): DiscordSettings {
    const s = this.ctx.settings
    return {
      guildId: str(s.get('guildId')),
      channelId: str(s.get('channelId')),
      qualifiedRoleId: str(s.get('qualifiedRoleId')),
      autoMirror: s.get('autoMirror') === true,
    }
  }

  clearError = () => this.store.setState({ error: null })

  /**
   * Save the form. `token`: `undefined` = unchanged, `''` = delete, else store
   * it in the OS keychain (never in settings).
   */
  async saveSettings(next: DiscordSettings, token?: string): Promise<void> {
    this.store.setState({ isSaving: true, error: null })
    try {
      const prev = this.store.getState().settings
      for (const key of ['guildId', 'channelId', 'qualifiedRoleId', 'autoMirror'] as const) {
        if (next[key] !== prev[key]) await this.ctx.settings.set(key, next[key] as JsonValue)
      }
      if (token !== undefined) {
        if (token) await this.ctx.secrets.set(SECRET_TOKEN, token)
        else await this.ctx.secrets.delete(SECRET_TOKEN)
        this.store.setState({ hasToken: !!token })
      }
      this.store.setState({ settings: this.readSettings() })
      if (this.store.getState().status.running) {
        await this.ctx.sidecar
          .request('discord/updateSettings', { qualifiedRoleId: next.qualifiedRoleId || null, channelId: next.channelId })
          .catch(() => undefined)
      }
    } catch (e) {
      this.store.setState({ error: `Failed to save settings: ${errText(e)}` })
    } finally {
      this.store.setState({ isSaving: false })
    }
  }

  async start(): Promise<void> {
    this.store.setState({ isStarting: true, error: null })
    try {
      const token = await this.ctx.secrets.get(SECRET_TOKEN)
      if (!token) throw new Error('Set the bot token first')
      const s = this.readSettings()
      if (!s.guildId || !s.channelId) throw new Error('Server (guild) ID and channel ID are required')
      await this.ctx.sidecar.request(
        'discord/init',
        { token, guildId: s.guildId, channelId: s.channelId, qualifiedRoleId: s.qualifiedRoleId || null },
        { timeoutMs: 30_000 },
      )
      this.store.setState((s) => ({ status: { ...s.status, running: true } }))
    } catch (e) {
      this.store.setState({ error: `Failed to start bot: ${errText(e)}` })
    } finally {
      this.store.setState({ isStarting: false })
    }
  }

  async stop(): Promise<void> {
    this.store.setState({ error: null })
    try {
      await this.ctx.sidecar.request('discord/stop', {}, { timeoutMs: 15_000 })
    } catch (e) {
      this.store.setState({ error: `Failed to stop bot: ${errText(e)}` })
    }
    this.botStopped()
  }

  isMirrored(terminalId: string): boolean {
    return this.mirrors.has(terminalId)
  }

  async mirror(terminalId: string, sessionLabel: string): Promise<void> {
    if (this.mirrors.has(terminalId)) return
    if (!this.store.getState().status.running) {
      this.store.setState({ error: 'Start the bot before sharing a terminal' })
      throw new Error('The Discord bot is not running')
    }
    this.store.setState({ error: null })
    const { ctx } = this
    // Subscribe first so no output between thread creation and here is lost.
    this.mirrors.set(terminalId, [
      ctx.terminals.onData(terminalId, (chunk) => this.queueOutput(terminalId, chunk)),
      ctx.terminals.onExit(terminalId, () => void this.unmirror(terminalId)),
    ])
    this.store.setState((s) => ({
      mirrored: [...s.mirrored, { terminalId, sessionLabel, threadId: null, threadUrl: null }],
    }))
    try {
      await ctx.sidecar.request('discord/createThread', { terminalId, sessionLabel }, { timeoutMs: 30_000 })
    } catch (e) {
      this.dropMirror(terminalId)
      this.store.setState({ error: `Failed to mirror terminal: ${errText(e)}` })
      throw e
    }
  }

  async unmirror(terminalId: string): Promise<void> {
    if (!this.mirrors.has(terminalId)) return
    this.flush(terminalId)
    this.dropMirror(terminalId)
    await this.ctx.sidecar.request('discord/closeThread', { terminalId }).catch((e) => {
      this.store.setState({ error: `Failed to close the thread: ${errText(e)}` })
    })
  }

  async toggle(terminalId: string, sessionLabel: string): Promise<void> {
    if (this.isMirrored(terminalId)) await this.unmirror(terminalId)
    else await this.mirror(terminalId, sessionLabel)
  }

  openThread(url: string): void {
    void this.ctx.shell.openExternal(url).catch((e) => this.store.setState({ error: errText(e) }))
  }

  // ---- internals ----

  private queueOutput(terminalId: string, chunk: string) {
    const b = this.buffers.get(terminalId)
    if (b) {
      b.data += chunk
      return
    }
    this.buffers.set(terminalId, { data: chunk, timer: setTimeout(() => this.flush(terminalId), OUTPUT_BATCH_MS) })
  }

  private flush(terminalId: string) {
    const b = this.buffers.get(terminalId)
    if (!b) return
    clearTimeout(b.timer)
    this.buffers.delete(terminalId)
    if (b.data) this.ctx.sidecar.notify('discord/output', { terminalId, data: b.data })
  }

  private dropMirror(terminalId: string) {
    const b = this.buffers.get(terminalId)
    if (b) clearTimeout(b.timer)
    this.buffers.delete(terminalId)
    for (const d of this.mirrors.get(terminalId) ?? []) d()
    this.mirrors.delete(terminalId)
    this.store.setState((s) => ({ mirrored: s.mirrored.filter((m) => m.terminalId !== terminalId) }))
  }

  private botStopped() {
    for (const id of [...this.mirrors.keys()]) this.dropMirror(id)
    this.store.setState({ status: { ...STOPPED } })
  }

  private onStatus(p: JsonValue) {
    const o = (p ?? {}) as Record<string, unknown>
    const running = o.running !== false
    this.store.setState((s) => ({
      status: {
        running,
        connected: !!o.connected,
        botUsername: typeof o.botUsername === 'string' ? o.botUsername : s.status.botUsername,
        guildName: typeof o.guildName === 'string' ? o.guildName : s.status.guildName,
      },
    }))
    if (!running) this.botStopped()
  }

  private onThreadCreated(p: JsonValue) {
    const o = (p ?? {}) as Record<string, unknown>
    const terminalId = str(o.terminalId)
    this.store.setState((s) => ({
      mirrored: s.mirrored.map((m) =>
        m.terminalId === terminalId ? { ...m, threadId: str(o.threadId) || null, threadUrl: str(o.threadUrl) || null } : m,
      ),
    }))
  }

  private onReply(p: JsonValue) {
    const o = (p ?? {}) as Record<string, unknown>
    const terminalId = str(o.terminalId)
    if (!terminalId || !this.mirrors.has(terminalId)) return
    void this.ctx.terminals.write(terminalId, str(o.content) + '\r').catch(() => undefined)
  }

  private async maybeAutoMirror(p: JsonValue) {
    const id = str((p as Record<string, unknown> | null)?.id)
    const { settings, status } = this.store.getState()
    if (!id || !settings.autoMirror || !status.running) return
    const t = (await this.ctx.terminals.list().catch(() => [])).find((x) => x.id === id)
    await this.mirror(id, t?.title || 'Terminal').catch(() => undefined)
  }
}

const models = new WeakMap<PluginContext, DiscordModel>()

export function discordModel(ctx: PluginContext): DiscordModel {
  let m = models.get(ctx)
  if (!m) {
    m = new DiscordModel(ctx)
    models.set(ctx, m)
  }
  m.init()
  return m
}
