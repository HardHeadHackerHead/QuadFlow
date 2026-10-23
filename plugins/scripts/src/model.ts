/**
 * The Scripts plugin's state, one per plugin context — the pane tile and the
 * flyout tile share it, so a run started in one is visible (and stoppable) in
 * the other, and closing a tile never kills a run:
 *
 *  - `scripts` / `groups`: live collections (`@quadflow/plugin-kit`) over
 *    `ctx.data.scripts.*` — CLI and other-process edits appear live;
 *  - `detected`: package.json / Python scripts read with `ctx.fs`;
 *  - `environments` + the default environment for scripts that name none;
 *  - `runs`: PTYs this plugin spawned (`ctx.terminals.spawn`, headless). Each
 *    run owns exactly one terminal; exit and output listeners belong to the run
 *    and are disposed when it is closed (never when a tile unmounts — that used
 *    to kill the other members of a parallel group);
 *  - auto-fix: run → on failure launch an agent (`ctx.agents.launch`, the
 *    provider's unattended approval mode) → wait for it (marker, idle, or a
 *    timeout measured from its start; every path removes its listener) → re-run.
 */
import { create } from 'zustand'
import type {
  Disposable,
  PluginContext,
  Script_Serialize,
  ScriptGroup_Serialize,
  ScriptInput_Deserialize,
  TerminalEnvironment_Serialize,
} from '@quadflow/plugin-api'
import { createCollection, launchAgent, type Collection } from '@quadflow/plugin-kit'
import { AUTO_FIX, MAX_RUNS, OUTPUT_TAIL } from './constants'
import { detectScripts, type Detected, type DetectedScript } from './detect'
import { PLATFORM, errorContext, looksFailed, stripAnsi, withExit } from './runLogic'

export type Script = Script_Serialize
export type ScriptGroup = ScriptGroup_Serialize
export type Environment = TerminalEnvironment_Serialize

/** What a run starts: a saved script, or a detected npm / Python script. */
export type RunTarget =
  | { type: 'saved'; script: Script }
  | { type: 'npm'; script: DetectedScript }
  | { type: 'python'; script: DetectedScript }

export type RunStatus = 'starting' | 'running' | 'completed' | 'failed' | 'stopped'

export interface Run {
  id: string
  /** `saved:<id>` / `npm:<name>` / `python:<name>`: "is this script running?" */
  key: string
  label: string
  terminalId: string | null
  status: RunStatus
  exitCode: number | null
  /** The PTY still exists (false once stopped/killed: show the kept output instead). */
  alive: boolean
  startedAt: number
  groupId?: string
  error?: string
}

export type AutoFixPhase = 'idle' | 'running' | 'waiting-agent' | 'success' | 'failed' | 'stopped'
export interface AutoFixState {
  enabled: boolean
  active: boolean
  phase: AutoFixPhase
  attempt: number
  label: string
  message: string
}

interface UiState {
  tab: 'npm' | 'python' | 'saved' | 'groups'
  /** The user picked a tab (no auto-selection afterwards). */
  tabChosen: boolean
  runInNewTerminal: boolean
  panelExpanded: boolean
  /** Set by the `new-script` command: the first visible tile opens the editor. */
  newScriptPending: boolean
  /** Mounted, visible tiles of this plugin (commands open one only when there is none). */
  visibleTiles: number
}

interface RunsState {
  runs: Run[]
  activeRunId: string | null
}

export { PLATFORM, stripAnsi }

export const runsOnThisPlatform = (s: Script) => !s.platforms?.length || s.platforms.includes(PLATFORM)

export const keyOf = (t: RunTarget) => (t.type === 'saved' ? `saved:${t.script.id}` : `${t.type}:${t.script.name}`)

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let seq = 0
const newRunId = () => `run-${Date.now().toString(36)}-${(seq++).toString(36)}`

/** Internal per-run bookkeeping (not rendered). */
interface RunInternals {
  output: string
  subs: Disposable[]
  exited: Promise<number | null>
  resolveExit: (code: number | null) => void
}

export interface ScriptsModel {
  scripts: Collection<Script>
  groups: Collection<ScriptGroup>
  ui: ReturnType<typeof createUi>
  runsStore: ReturnType<typeof createRuns>
  autoFix: ReturnType<typeof createAutoFix>
  detected: ReturnType<typeof createDetected>
  env: ReturnType<typeof createEnv>
  /** Start syncing (tiles call it while mounted). */
  retain(): Disposable
  reloadDetected(): Promise<void>
  reloadEnvironments(detect?: boolean): Promise<void>
  setDefaultEnvironment(name: string | null): Promise<void>

  createScript(input: ScriptInput_Deserialize): Promise<Script>
  updateScript(id: string, input: ScriptInput_Deserialize): Promise<Script>
  deleteScript(id: string): Promise<void>
  saveGroup(id: string | null, g: { name: string; mode: ScriptGroup['mode']; members: { scriptId: string; delayMs: number }[] }): Promise<ScriptGroup>
  deleteGroup(id: string): Promise<void>

  /** Start a run in the output panel (or a workspace terminal when `runInNewTerminal`). */
  run(target: RunTarget): Promise<void>
  /** Start a run in the panel; resolves once its terminal is up. */
  start(target: RunTarget, o?: { groupId?: string }): Promise<Run | null>
  runGroup(group: ScriptGroup): Promise<void>
  stop(runId: string): Promise<void>
  close(runId: string): Promise<void>
  closeAll(): Promise<void>
  stopAll(): Promise<number>
  isRunning(key: string): boolean
  output(runId: string): string
  waitExit(runId: string): Promise<number | null>

  runWithAutoFix(target: RunTarget): Promise<void>
  stopAutoFix(): Promise<void>

  dispose(): Promise<void>
}

function createUi() {
  return create<UiState>(() => ({ tab: 'saved', tabChosen: false, runInNewTerminal: false, panelExpanded: true, newScriptPending: false, visibleTiles: 0 }))
}
function createRuns() {
  return create<RunsState>(() => ({ runs: [], activeRunId: null }))
}
function createAutoFix() {
  return create<AutoFixState>(() => ({ enabled: false, active: false, phase: 'idle', attempt: 0, label: '', message: '' }))
}
function createDetected() {
  return create<Detected & { loading: boolean; root: string | null }>(() => ({ npm: [], npmError: null, python: [], loading: false, root: null }))
}
function createEnv() {
  return create<{ list: Environment[]; defaultName: string | null; detecting: boolean }>(() => ({ list: [], defaultName: null, detecting: false }))
}

const models = new WeakMap<PluginContext, ScriptsModel>()
const all = new Set<ScriptsModel>()

/** Kill every run of every context (plugin `deactivate`). */
export async function disposeAll(): Promise<void> {
  await Promise.all([...all].map((m) => m.dispose()))
}

export function scriptsModel(ctx: PluginContext): ScriptsModel {
  const existing = models.get(ctx)
  if (existing) return existing

  const scripts = createCollection<Script>(ctx, {
    domain: 'scripts',
    list: async (c, root) => {
      const r = await c.data.scripts.list({ includeArchived: false }, { projectRoot: root })
      return { items: r.items, errors: r.errors }
    },
    get: (c, id, root) => c.data.scripts.get(id, { projectRoot: root }),
    normalize: (s) => s,
    compare: (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
  })
  const groups = createCollection<ScriptGroup>(ctx, {
    domain: 'script_groups',
    list: async (c, root) => {
      const r = await c.data.scripts.groups.list({ projectRoot: root })
      return { items: r.items, errors: r.errors }
    },
    get: (c, id, root) => c.data.scripts.groups.get(id, { projectRoot: root }),
    normalize: (g) => ({ ...g, members: [...(g.members ?? [])].sort((a, b) => a.order - b.order) }),
    compare: (a, b) => a.name.localeCompare(b.name),
  })

  const ui = createUi()
  const runsStore = createRuns()
  const autoFix = createAutoFix()
  const detected = createDetected()
  const env = createEnv()
  const internals = new Map<string, RunInternals>()
  let autoFixStopped = false
  let autoFixAgentTerminal: string | null = null

  const patchRun = (id: string, patch: Partial<Run>) =>
    runsStore.setState((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) }))
  const getRun = (id: string) => runsStore.getState().runs.find((r) => r.id === id)
  const toastError = (title: string, e: unknown) => ctx.notifications.toast({ kind: 'error', title, body: errText(e) })

  async function reloadDetected() {
    const root = ctx.project.current()?.root ?? null
    if (!root) {
      detected.setState({ npm: [], npmError: null, python: [], loading: false, root: null })
      return
    }
    detected.setState({ loading: true })
    try {
      const d = await detectScripts(ctx)
      if ((ctx.project.current()?.root ?? null) !== root) return
      detected.setState({ ...d, loading: false, root })
    } catch (e) {
      ctx.log.warn('script detection failed:', e)
      detected.setState({ loading: false })
    }
  }

  async function reloadEnvironments(detect = false) {
    if (detect) env.setState({ detecting: true })
    try {
      const list = detect ? await ctx.data.scripts.environments.detect() : await ctx.data.scripts.environments.list()
      env.setState({ list })
      if (detect) ctx.notifications.toast({ kind: 'success', title: `${list.filter((e) => e.available).length} terminal environments found` })
    } catch (e) {
      if (detect) toastError('Could not detect environments', e)
      else ctx.log.warn('environments.list failed:', e)
    } finally {
      if (detect) env.setState({ detecting: false })
    }
  }

  async function setDefaultEnvironment(name: string | null) {
    env.setState({ defaultName: name })
    try {
      if (name) await ctx.storage.set('defaultEnvironment', name, 'global')
      else await ctx.storage.delete('defaultEnvironment', 'global')
    } catch (e) {
      ctx.log.warn('could not store the default environment:', e)
    }
  }

  // ---- syncing, reference-counted by mounted tiles ----
  let refs = 0
  let offs: Disposable[] = []
  function retain(): Disposable {
    const releases = [scripts.retain(), groups.retain()]
    if (refs++ === 0) {
      void reloadDetected()
      void reloadEnvironments()
      void ctx.storage
        .get<string>('defaultEnvironment', 'global')
        .then((n) => env.setState({ defaultName: typeof n === 'string' && n ? n : null }))
        .catch(() => {})
      offs = [
        ctx.project.onDidChange(() => {
          ui.setState({ tabChosen: false })
          void reloadDetected()
        }),
        // Environments are machine-wide (no project filter).
        ctx.data.onDidChange({ domain: 'environments' }, () => void reloadEnvironments()),
      ]
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const r of releases) r()
      if (--refs > 0) return
      for (const o of offs) o()
      offs = []
    }
  }

  // ---- script / group mutations (explicit projectRoot, results merged) ----
  async function createScript(input: ScriptInput_Deserialize) {
    const projectRoot = scripts.root()
    const s = await ctx.data.scripts.create(input, { projectRoot })
    scripts.apply(projectRoot, s)
    return s
  }
  async function updateScript(id: string, input: ScriptInput_Deserialize) {
    const projectRoot = scripts.root()
    // Replace every editable field (absent optional fields are cleared).
    const s = await ctx.data.scripts.update(
      id,
      {
        name: input.name,
        command: input.command,
        description: input.description ?? null,
        setupCommands: input.setupCommands ?? [],
        env: input.env ?? {},
        platforms: input.platforms ?? [],
        shell: input.shell ?? null,
        workingDirectory: input.workingDirectory ?? null,
        environment: input.environment ?? null,
        kind: input.kind ?? 'command',
        previewUrl: input.previewUrl ?? null,
        autoOpenPreview: input.autoOpenPreview ?? false,
      },
      { projectRoot },
    )
    scripts.apply(projectRoot, s)
    return s
  }
  async function deleteScript(id: string) {
    const projectRoot = scripts.root()
    await ctx.data.scripts.delete(id, { projectRoot })
    scripts.remove(projectRoot, [id])
    void groups.reload(true) // the core also removed it from every group
  }
  async function saveGroup(id: string | null, g: { name: string; mode: ScriptGroup['mode']; members: { scriptId: string; delayMs: number }[] }) {
    const projectRoot = groups.root()
    const members = g.members.map((m, order) => ({ scriptId: m.scriptId, order, delayMs: Math.max(0, Math.round(m.delayMs)) }))
    const saved = id
      ? await ctx.data.scripts.groups.update(id, { name: g.name, mode: g.mode, members }, { projectRoot })
      : await ctx.data.scripts.groups.create({ name: g.name, mode: g.mode, members }, { projectRoot })
    groups.apply(projectRoot, saved)
    return saved
  }
  async function deleteGroup(id: string) {
    const projectRoot = groups.root()
    await ctx.data.scripts.groups.delete(id, { projectRoot })
    groups.remove(projectRoot, [id])
  }

  // ---- runs ----
  /** How to start `t`: spawn options + the lines to type (the last one exits the shell when `exit`). */
  async function prepare(t: RunTarget, root: string, exit: boolean) {
    const defaultEnvironment = env.getState().defaultName
    if (t.type === 'saved') {
      const r = await ctx.data.scripts.resolveCommand(t.script.id, { defaultEnvironment }, { projectRoot: root })
      // fullCommand may span lines (cmd: the env `set`s first); each line is typed.
      const lines = r.fullCommand.split(/\r?\n/).filter((l) => l.trim())
      if (exit && lines.length) lines[lines.length - 1] = withExit(lines[lines.length - 1], r.shell)
      return {
        spawn: { cwd: r.cwd, ...(r.shellPath ? { shellPath: r.shellPath } : { shell: r.shell }) },
        lines,
      }
    }
    const line = t.type === 'npm' ? `npm run ${t.script.name}` : t.script.command
    const e = defaultEnvironment ? env.getState().list.find((x) => x.name === defaultEnvironment && x.available) : undefined
    return {
      // The environment brings its shell, init commands and variables.
      spawn: { cwd: root, ...(e ? { environmentId: e.id } : {}) },
      lines: [exit ? withExit(line, e?.shell) : line],
    }
  }

  function isRunning(key: string) {
    return runsStore.getState().runs.some((r) => r.key === key && (r.status === 'running' || r.status === 'starting'))
  }

  async function makeRoom() {
    const { runs } = runsStore.getState()
    if (runs.length < MAX_RUNS) return
    const victim = runs.find((r) => r.status !== 'running' && r.status !== 'starting') ?? runs[0]
    await close(victim.id)
  }

  async function start(t: RunTarget, o: { groupId?: string } = {}): Promise<Run | null> {
    const root = ctx.project.current()?.root
    if (!root) {
      ctx.notifications.toast({ kind: 'warning', title: 'No project is open' })
      return null
    }
    await makeRoom()
    let resolveExit!: (code: number | null) => void
    const exited = new Promise<number | null>((r) => (resolveExit = r))
    const run: Run = {
      id: newRunId(),
      key: keyOf(t),
      label: t.script.name,
      terminalId: null,
      status: 'starting',
      exitCode: null,
      alive: false,
      startedAt: Date.now(),
      ...(o.groupId ? { groupId: o.groupId } : {}),
    }
    const inner: RunInternals = { output: '', subs: [], exited, resolveExit }
    internals.set(run.id, inner)
    runsStore.setState((s) => ({ runs: [...s.runs, run], activeRunId: run.id }))
    ui.setState({ panelExpanded: true })

    try {
      const p = await prepare(t, root, true)
      const h = await ctx.terminals.spawn({ ...p.spawn, initCommands: p.lines, placement: 'none', title: t.script.name })
      if (!internals.has(run.id)) {
        // Closed while starting.
        void ctx.terminals.kill(h.id).catch(() => {})
        return null
      }
      inner.subs.push(
        ctx.terminals.onData(h.id, (chunk) => {
          inner.output = (inner.output + chunk).slice(-OUTPUT_TAIL)
        }),
        ctx.terminals.onExit(h.id, ({ code }) => {
          const cur = getRun(run.id)
          if (cur && cur.status !== 'stopped') patchRun(run.id, { status: code === 0 || code === null ? 'completed' : 'failed', exitCode: code })
          inner.resolveExit(code)
        }),
      )
      patchRun(run.id, { terminalId: h.id, status: 'running', alive: true })
    } catch (e) {
      patchRun(run.id, { status: 'failed', error: errText(e) })
      inner.resolveExit(null)
      toastError(`Cannot run "${t.script.name}"`, e)
      return getRun(run.id) ?? null
    }

    if (t.type === 'saved' && t.script.kind === 'server' && t.script.autoOpenPreview && t.script.previewUrl) {
      const url = t.script.previewUrl
      setTimeout(() => {
        ctx.commands.execute('web-preview/open-url', { url }).catch((e) => ctx.log.warn('could not open the web preview:', e))
      }, 500)
    }
    return getRun(run.id) ?? null
  }

  /** Run in a new workspace terminal (stays open; not tracked in the panel). */
  async function runInTerminal(t: RunTarget) {
    const root = ctx.project.current()?.root
    if (!root) return
    try {
      const p = await prepare(t, root, false)
      await ctx.terminals.spawn({ ...p.spawn, initCommands: p.lines, placement: 'split-active', title: t.script.name })
    } catch (e) {
      toastError(`Cannot run "${t.script.name}"`, e)
    }
  }

  async function run(t: RunTarget) {
    if (ui.getState().runInNewTerminal) return runInTerminal(t)
    if (autoFix.getState().enabled && !(t.type === 'saved' && t.script.kind === 'server')) return runWithAutoFix(t)
    await start(t)
  }

  async function waitExit(runId: string) {
    const inner = internals.get(runId)
    return inner ? inner.exited : getRun(runId)?.exitCode ?? null
  }

  async function runGroup(group: ScriptGroup) {
    const byId = new Map(scripts.use.getState().items.map((s) => [s.id, s]))
    const members = [...(group.members ?? [])].sort((a, b) => a.order - b.order)
    const missing = members.filter((m) => !byId.has(m.scriptId)).length
    if (missing) ctx.notifications.toast({ kind: 'warning', title: `${group.name}: ${missing} missing script(s) skipped` })
    const targets = members.flatMap((m) => {
      const s = byId.get(m.scriptId)
      return s ? [{ m, t: { type: 'saved', script: s } as RunTarget }] : []
    })
    if (group.mode === 'sequential') {
      for (const { t } of targets) {
        const r = await start(t, { groupId: group.id })
        if (!r || !r.terminalId) return
        const code = await waitExit(r.id)
        const after = getRun(r.id)
        if (after?.status === 'stopped' || (code !== null && code !== 0)) {
          ctx.notifications.toast({ kind: 'warning', title: `${group.name} stopped`, body: `"${r.label}" did not finish successfully.` })
          return
        }
      }
      return
    }
    // Parallel: every member, each after its own delay. Runs are independent:
    // nothing about starting, finishing or viewing one touches another.
    await Promise.all(
      targets.map(async ({ m, t }) => {
        if ((m.delayMs ?? 0) > 0) await sleep(m.delayMs ?? 0)
        await start(t, { groupId: group.id })
      }),
    )
  }

  async function stop(runId: string) {
    const r = getRun(runId)
    if (!r?.terminalId || !r.alive) return
    patchRun(runId, { status: r.status === 'running' || r.status === 'starting' ? 'stopped' : r.status, alive: false })
    try {
      await ctx.terminals.kill(r.terminalId)
    } catch {
      // already gone
    }
    internals.get(runId)?.resolveExit(getRun(runId)?.exitCode ?? null)
  }

  async function close(runId: string) {
    await stop(runId)
    const inner = internals.get(runId)
    if (inner) for (const d of inner.subs) d()
    internals.delete(runId)
    runsStore.setState((s) => {
      const runs = s.runs.filter((r) => r.id !== runId)
      const activeRunId = s.activeRunId === runId ? (runs[runs.length - 1]?.id ?? null) : s.activeRunId
      return { runs, activeRunId }
    })
  }

  async function closeAll() {
    await Promise.all(runsStore.getState().runs.map((r) => close(r.id)))
  }

  async function stopAll() {
    const live = runsStore.getState().runs.filter((r) => r.alive && (r.status === 'running' || r.status === 'starting'))
    await Promise.all(live.map((r) => stop(r.id)))
    return live.length
  }

  // ---- auto-fix ----
  /** Wait for the fixing agent: marker, idle, stop, or `maxWaitMs` after it started. Always unsubscribes. */
  function waitForAgent(terminalId: string): Promise<boolean> {
    const startedAt = Date.now()
    let lastOutput = startedAt
    let tail = ''
    return new Promise((resolve) => {
      let settled = false
      let off: Disposable | null = null
      let exitOff: Disposable | null = null
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        off?.()
        exitOff?.()
        resolve(ok)
      }
      const poll = setInterval(() => {
        const now = Date.now()
        if (autoFixStopped) return finish(false)
        if (tail.includes(AUTO_FIX.marker)) return finish(true)
        if (now - startedAt > AUTO_FIX.maxWaitMs) return finish(false)
        if (now - lastOutput > AUTO_FIX.idleMs) return finish(true)
      }, 1000)
      try {
        off = ctx.terminals.onData(terminalId, (chunk) => {
          lastOutput = Date.now()
          tail = (tail + stripAnsi(chunk)).slice(-8192)
        })
        // The agent's terminal was closed: nothing more to wait for.
        exitOff = ctx.terminals.onExit(terminalId, () => finish(true))
      } catch (e) {
        ctx.log.warn('cannot follow the agent terminal:', e)
        finish(false)
      }
    })
  }

  async function runWithAutoFix(t: RunTarget) {
    if (autoFix.getState().active) {
      ctx.notifications.toast({ kind: 'warning', title: 'Auto-fix is already running' })
      return
    }
    autoFixStopped = false
    const set = (p: Partial<AutoFixState>) => autoFix.setState(p)
    set({ active: true, phase: 'running', attempt: 0, label: t.script.name, message: '' })
    try {
      for (let attempt = 1; attempt <= AUTO_FIX.maxAttempts; attempt++) {
        if (autoFixStopped) break
        set({ attempt, phase: 'running', message: `Running "${t.script.name}"…` })
        const r = await start(t)
        if (!r?.terminalId) {
          set({ phase: 'failed', message: r?.error ?? 'The script could not be started' })
          return
        }
        const code = await waitExit(r.id)
        if (autoFixStopped || getRun(r.id)?.status === 'stopped') break
        const output = internals.get(r.id)?.output ?? ''
        if (!looksFailed(code, output)) {
          set({ phase: 'success', message: attempt === 1 ? 'Succeeded' : `Succeeded after ${attempt - 1} fix(es)` })
          return
        }
        if (attempt === AUTO_FIX.maxAttempts) {
          set({ phase: 'failed', message: 'Still failing after the last attempt — please fix manually' })
          return
        }
        set({ phase: 'waiting-agent', message: 'An agent is fixing the errors…' })
        const prompt = `Fix the following build errors from script "${t.script.name}". After fixing, say "${AUTO_FIX.marker}" on its own line.

Build errors:
\`\`\`
${errorContext(output)}
\`\`\`

Please analyze these errors and make the necessary code changes to fix them.`
        const h = await launchAgent(ctx, prompt, { autoSubmit: true, approvalMode: 'unattended', title: `Auto-fix: ${t.script.name}` })
        if (!h) {
          set({ phase: 'failed', message: 'No agent could be launched' })
          return
        }
        autoFixAgentTerminal = h.id
        const ok = await waitForAgent(h.id)
        autoFixAgentTerminal = null
        if (autoFixStopped) break
        if (!ok) {
          set({ phase: 'failed', message: 'The agent timed out' })
          return
        }
        set({ message: 'The agent finished — re-running…' })
        await sleep(1000)
      }
      if (autoFixStopped) set({ phase: 'stopped', message: 'Stopped' })
    } finally {
      set({ active: false })
    }
  }

  async function stopAutoFix() {
    autoFixStopped = true
    autoFix.setState({ phase: 'stopped', message: 'Stopped' })
    const term = autoFixAgentTerminal
    autoFixAgentTerminal = null
    if (term) await ctx.terminals.kill(term).catch(() => {})
  }

  const m: ScriptsModel = {
    scripts,
    groups,
    ui,
    runsStore,
    autoFix,
    detected,
    env,
    retain,
    reloadDetected,
    reloadEnvironments,
    setDefaultEnvironment,
    createScript,
    updateScript,
    deleteScript,
    saveGroup,
    deleteGroup,
    run,
    start,
    runGroup,
    stop,
    close,
    closeAll,
    stopAll,
    isRunning,
    output: (id) => internals.get(id)?.output ?? '',
    waitExit,
    runWithAutoFix,
    stopAutoFix,
    async dispose() {
      await stopAutoFix()
      await closeAll()
    },
  }
  models.set(ctx, m)
  all.add(m)
  return m
}
