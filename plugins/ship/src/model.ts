/**
 * Ship tool state over the public host API (`ctx.data.ship.*`).
 *
 * One model per plugin context (pane and flyout share it). The run history is
 * a `@quadflow/plugin-kit` collection over the `ship_runs` domain with `ship`
 * as a related domain, so one reference-counted subscription (project-filtered
 * in Rust, `watchProject` for CLI edits) drives both the history and config
 * reloads. A run started here streams over `data.ship.run`; external-terminal
 * phases run in a terminal tile spawned through `ctx.terminals`.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { createCollection, type Collection } from '@quadflow/plugin-kit'
import type {
  Disposable,
  PluginContext,
  ShipConfig_Serialize,
  ShipDiagnostics_Serialize,
  ShipExternalRequest,
  ShipLineEvent,
  ShipPhaseEvent_Serialize,
  ShipPhaseResult_Serialize,
  ShipReadinessCheck_Serialize,
  ShipRunEvent_Serialize,
  ShipRunMode,
  ShipRun_Serialize,
  ShipStatus_Serialize,
  ShipValidation,
} from '@quadflow/plugin-api'

const TERMINAL_LINE_CAP = 5000

export interface ShipRunFlags {
  skipBuild?: boolean
  reuseBuild?: boolean
  dryRun?: boolean
  draft?: boolean
}

export interface ShipState {
  config: ShipConfig_Serialize | null
  /** The config has been loaded at least once for the current project. */
  configLoaded: boolean
  status: ShipStatus_Serialize | null
  validation: ShipValidation | null
  readiness: ShipReadinessCheck_Serialize[]
  readinessLoading: boolean
  diagnostics: ShipDiagnostics_Serialize | null
  /** Project kind for the template picker (diagnostics or detect). */
  projectKind: string | null

  /** The in-flight (or last finished) run started from this window. */
  liveRun: ShipRun_Serialize | null
  liveProgress: ShipPhaseEvent_Serialize | null
  terminalLines: ShipLineEvent[]
  notices: { kind: string; files?: string[]; ts: number }[]

  loading: boolean
  error: string | null
  running: boolean
  rechecking: string[]
  runningFix: string | null
  replayingRun: ShipRun_Serialize | null
}

export interface ShipModel {
  use: UseBoundStore<StoreApi<ShipState>>
  runs: Collection<ShipRun_Serialize>
  /** Start syncing (tiles call it in an effect). */
  retain(): Disposable
  loadAll(): Promise<void>
  loadReadiness(): Promise<void>
  loadDiagnostics(): Promise<void>
  recheckOne(checkId: string): Promise<void>
  runFix(checkId: string): Promise<void>
  init(template: string, params: Record<string, string>): Promise<void>
  deleteConfig(): Promise<void>
  run(mode: ShipRunMode, flags?: ShipRunFlags): Promise<ShipRun_Serialize | null>
  abort(runId?: string): Promise<void>
  restoreBackups(): Promise<string[] | null>
  enterReplay(run: ShipRun_Serialize): void
  exitReplay(): void
  clearError(): void
  clearTerminal(): void
}

const msg = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e))

const INITIAL: ShipState = {
  config: null,
  configLoaded: false,
  status: null,
  validation: null,
  readiness: [],
  readinessLoading: false,
  diagnostics: null,
  projectKind: null,
  liveRun: null,
  liveProgress: null,
  terminalLines: [],
  notices: [],
  loading: false,
  error: null,
  running: false,
  rechecking: [],
  runningFix: null,
  replayingRun: null,
}

const models = new WeakMap<PluginContext, ShipModel>()

export function shipModel(ctx: PluginContext): ShipModel {
  let m = models.get(ctx)
  if (!m) {
    m = createShipModel(ctx)
    models.set(ctx, m)
  }
  return m
}

/** "✔ name — passed in 1.2s" line for a finished phase. */
export function phaseSummaryLine(p: ShipPhaseResult_Serialize): string | null {
  if (p.status !== 'passed' && p.status !== 'failed' && p.status !== 'skipped') return null
  const dur = p.durationMs ?? 0
  const durStr = dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`
  const symbol = p.status === 'passed' ? '\x1b[32m✔' : p.status === 'failed' ? '\x1b[31m✖' : '\x1b[90m∘'
  let line = `${symbol} ${p.name} — ${p.status} in ${durStr}\x1b[0m`
  if (p.status === 'failed' && p.error) line += `\n\x1b[31m  ↳ ${p.error}\x1b[0m`
  return line
}

function createShipModel(ctx: PluginContext): ShipModel {
  const use = create<ShipState>(() => ({ ...INITIAL }))
  const runs = createCollection<ShipRun_Serialize>(ctx, {
    domain: 'ship_runs',
    relatedDomains: ['ship'],
    list: (c, root) => c.data.ship.runs({ projectRoot: root }),
    get: (c, id, root) => c.data.ship.runGet(id, { projectRoot: root }),
    normalize: (r) => ({ ...r, phases: r.phases ?? [], artifacts: r.artifacts ?? [] }),
    compare: (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1),
  })
  const root = () => ctx.project.current()?.root ?? null
  const set = use.setState
  const get = use.getState

  /** Run `f` against the current root; drop the result if the project changed meanwhile. */
  async function withRoot<T>(f: (root: string) => Promise<T>, apply: (v: T) => void): Promise<void> {
    const r = root()
    if (!r) return
    const v = await f(r)
    if (root() === r) apply(v)
  }

  // ---- terminal-line batching: chatty builds emit hundreds of lines per second ----
  const lineBuffer: ShipLineEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    flushTimer = null
    if (lineBuffer.length === 0) return
    const batch = lineBuffer.splice(0, lineBuffer.length)
    set((s) => {
      const merged = [...s.terminalLines, ...batch]
      return { terminalLines: merged.length > TERMINAL_LINE_CAP ? merged.slice(-TERMINAL_LINE_CAP) : merged }
    })
  }
  const pushLine = (l: ShipLineEvent) => {
    lineBuffer.push(l)
    if (flushTimer == null) flushTimer = setTimeout(flush, 50)
  }

  async function loadDiagnostics() {
    try {
      await withRoot((r) => ctx.data.ship.diagnostics({ projectRoot: r }), (d) => set({ diagnostics: d, projectKind: d.projectKind ?? null }))
    } catch (e) {
      set({ error: msg(e) })
    }
  }

  async function loadStatus() {
    if (!get().config) return
    await withRoot((r) => ctx.data.ship.status({ projectRoot: r }), (status) => set({ status })).catch((e) => set({ error: msg(e) }))
  }

  async function loadReadiness() {
    set({ readinessLoading: true })
    try {
      await withRoot((r) => ctx.data.ship.readiness({ projectRoot: r }), (readiness) => set({ readiness }))
    } catch (e) {
      set({ error: msg(e) })
    } finally {
      set({ readinessLoading: false })
    }
  }

  async function loadAll() {
    const r = root()
    if (!r) {
      set({ ...INITIAL })
      return
    }
    set({ loading: true })
    try {
      void loadDiagnostics()
      let config: ShipConfig_Serialize | null = null
      try {
        await withRoot((p) => ctx.data.ship.configGet({ projectRoot: p }), (c) => {
          config = c
          set({ config: c, configLoaded: true })
        })
      } catch (e) {
        set({ config: null, configLoaded: true, error: `Failed to load the ship config: ${msg(e)}` })
      }
      if (config) {
        await Promise.all([
          loadStatus(),
          withRoot((p) => ctx.data.ship.validate({ projectRoot: p }), (validation) => set({ validation })).catch(() => {}),
        ])
        void loadReadiness()
      } else {
        set({ status: null, validation: null, readiness: [] })
      }
    } finally {
      set({ loading: false })
    }
  }

  // ---- change events (via the runs collection) ----
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pendingConfig = false
  const scheduleRefresh = (config: boolean) => {
    pendingConfig ||= config
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      const full = pendingConfig
      pendingConfig = false
      if (full) void loadAll()
      else void loadStatus()
    }, 150)
  }

  let refs = 0
  let releaseRuns: Disposable | null = null
  let unsubStore: (() => void) | null = null
  let projectOff: Disposable | null = null

  function retain(): Disposable {
    if (refs++ === 0) {
      releaseRuns = runs.retain()
      unsubStore = runs.use.subscribe((s, prev) => {
        if (s.relatedVersion !== prev.relatedVersion) scheduleRefresh(true)
        else if (s.items !== prev.items && s.root === prev.root) scheduleRefresh(false)
      })
      projectOff = ctx.project.onDidChange(() => {
        set({ ...INITIAL })
        void loadAll()
      })
      void loadAll()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--refs > 0) return
      releaseRuns?.()
      unsubStore?.()
      projectOff?.()
      releaseRuns = null
      unsubStore = null
      projectOff = null
    }
  }

  function onRunEvent(r: string, ev: ShipRunEvent_Serialize) {
    if (root() !== r) return
    switch (ev.type) {
      case 'started':
        set({ liveRun: ev.run })
        break
      case 'phase': {
        const e = ev.event
        set((s) => {
          const base = s.liveRun?.id === e.runId ? s.liveRun : runs.use.getState().items.find((x) => x.id === e.runId) ?? null
          const phases = [...(base?.phases ?? [])]
          phases[e.index] = e.phase
          return {
            liveProgress: e,
            liveRun: base ? { ...base, phases } : s.liveRun,
          }
        })
        const line = phaseSummaryLine(e.phase)
        if (line) pushLine({ runId: e.runId, phase: e.phase.name, stream: e.phase.status === 'failed' ? 'stderr' : 'stdout', line, ts: Date.now() })
        break
      }
      case 'line':
        pushLine(ev.event)
        break
      case 'restored_backups':
        set((s) => ({ notices: [...s.notices, { kind: 'restored_backups', files: ev.files, ts: Date.now() }].slice(-10) }))
        break
      case 'external_request':
        void runInTerminal(ctx, ev.request)
        break
    }
  }

  return {
    use,
    runs,
    retain,
    loadAll,
    loadReadiness,
    loadDiagnostics,

    async recheckOne(checkId) {
      set((s) => ({ rechecking: [...s.rechecking, checkId] }))
      try {
        await withRoot((r) => ctx.data.ship.readinessOne(checkId, { projectRoot: r }), (c) =>
          set((s) => ({ readiness: s.readiness.map((x) => (x.id === checkId ? c : x)) })))
      } catch (e) {
        set({ error: msg(e) })
      } finally {
        set((s) => ({ rechecking: s.rechecking.filter((x) => x !== checkId) }))
      }
    },

    async runFix(checkId) {
      set({ runningFix: checkId })
      try {
        await withRoot((r) => ctx.data.ship.runFix(checkId, pushLine, { projectRoot: r }), (c) =>
          set((s) => ({ readiness: s.readiness.map((x) => (x.id === checkId ? c : x)) })))
      } catch (e) {
        set({ error: msg(e) })
      } finally {
        flush()
        set({ runningFix: null })
      }
    },

    async init(template, params) {
      set({ loading: true, error: null })
      try {
        await withRoot((r) => ctx.data.ship.init({ template, params }, { projectRoot: r }), (config) => set({ config }))
        await loadAll()
      } catch (e) {
        set({ loading: false, error: msg(e) })
        throw e
      }
    },

    async deleteConfig() {
      try {
        await withRoot((r) => ctx.data.ship.configDelete({ projectRoot: r }), () => set({ config: null, status: null, validation: null, readiness: [] }))
        await loadDiagnostics()
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    async run(mode, flags = {}) {
      const r = root()
      if (!r || get().running) return null
      set({ running: true, error: null, liveProgress: null, liveRun: null, terminalLines: [], replayingRun: null })
      try {
        const run = await ctx.data.ship.run(
          { mode, dryRun: flags.dryRun ?? false, skipBuild: flags.skipBuild ?? false, reuseBuild: flags.reuseBuild ?? false, draft: flags.draft ?? false },
          (ev) => onRunEvent(r, ev),
          { projectRoot: r },
        )
        if (root() === r) set({ liveRun: run })
        return run
      } catch (e) {
        if (root() === r) set({ error: msg(e) })
        return null
      } finally {
        flush()
        if (root() === r) {
          set({ running: false })
          void runs.reload(true)
          void loadStatus()
        }
      }
    },

    async abort(runId) {
      const id = runId ?? get().liveRun?.id ?? null
      await withRoot((r) => ctx.data.ship.abort(id, { projectRoot: r }), () => {}).catch((e) => set({ error: msg(e) }))
      await runs.reload(true)
    },

    async restoreBackups() {
      let restored: string[] = []
      await withRoot((r) => ctx.data.ship.restoreBackups({ projectRoot: r }), (v) => { restored = v }).catch((e) => set({ error: msg(e) }))
      return restored
    },

    enterReplay: (run) => set({ replayingRun: run }),
    exitReplay: () => set({ replayingRun: null }),
    clearError: () => set({ error: null }),
    clearTerminal: () => set({ terminalLines: [] }),
  }
}

/**
 * External-terminal phase: spawn a terminal tile in the phase's cwd, run the
 * command with exit markers, watch for them, report back to the waiting run.
 * cmd on Windows / bash elsewhere so `&&` / `||` work.
 */
export async function runInTerminal(ctx: PluginContext, req: ShipExternalRequest): Promise<void> {
  const tag = req.requestId.replace(/[^a-zA-Z0-9]/g, '')
  const ok = `__SHIP_OK_${tag}__`
  const fail = `__SHIP_FAIL_${tag}__`
  const complete = (r: { success: boolean; exitCode?: number | null; terminalId?: string | null; error?: string | null }) =>
    ctx.data.ship.externalComplete(req.requestId, r).catch((e) => ctx.log.warn('externalComplete failed:', e))
  let terminalId: string
  try {
    const windows = /Windows/i.test(navigator.userAgent)
    const h = await ctx.terminals.spawn({
      cwd: req.cwd,
      shell: windows ? 'cmd' : 'bash',
      placement: 'split-active',
      title: `Ship: ${req.phase}`,
    })
    terminalId = h.id
  } catch (e) {
    await complete({ success: false, error: `could not open a terminal: ${msg(e)}` })
    return
  }

  let done = false
  let tail = ''
  const subs: Disposable[] = []
  const finish = async (success: boolean, error: string | null) => {
    if (done) return
    done = true
    for (const d of subs) d()
    await complete({ success, exitCode: success ? 0 : 1, terminalId, error })
  }
  subs.push(
    ctx.terminals.onData(terminalId, (chunk) => {
      // Markers may be split across chunks; keep a short rolling tail. Strip ANSI/OSC
      // sequences and line breaks (the PTY wraps long lines), then ignore the markers
      // inside the echoed command itself (`echo <marker>`).
      const clean = chunk
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[@-_]/g, '')
        .replace(/[\r\n]/g, '')
      tail = (tail + clean).slice(-2048)
      const printed = (m: string) => tail.split(m).slice(0, -1).some((before) => !/echo\s*$/i.test(before))
      if (printed(ok)) void finish(true, null)
      else if (printed(fail)) void finish(false, 'command exited non-zero')
    }),
  )
  subs.push(ctx.terminals.onExit(terminalId, () => void finish(false, 'terminal closed before the command finished')))
  await new Promise((r) => setTimeout(r, 600))
  try {
    await ctx.terminals.write(terminalId, `${req.command} && echo ${ok} || echo ${fail}\r`)
  } catch (e) {
    await finish(false, `could not write the command: ${msg(e)}`)
  }
}

/** True when any readiness check is at `fail` (warnings never block). */
export function readinessBlocks(readiness: ShipReadinessCheck_Serialize[]): boolean {
  return readiness.some((c) => c.level === 'fail')
}
