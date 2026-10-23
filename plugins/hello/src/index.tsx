/**
 * `hello` — the example plugin (plugin-system.md §16, PL-2 / PL-3).
 *
 * Exercises the trusted boundary: every import below is an import-map
 * specifier, so at runtime they are the host's module instances.
 *  - `useState` / `useEffect`      → hooks only work with the host's React
 *  - `usePluginContext()`          → reads a React context *provided by the host* (TileHost)
 *  - `useTheme()` from @quadflow/ui → `useSyncExternalStore` on the host's theme store
 *  - a zustand store               → shared zustand, React bindings on the host's React
 *
 * The "Host API" panel (PL-3) calls every §6 method group and shows whether
 * each outcome matches what the host must do (allowed, or rejected in Rust
 * with `permission_denied` for permissions this plugin does not declare).
 * The "Sidecar" panel (PL-7) drives the plugin's Rust sidecar (./sidecar).
 *
 * PL-6: the same bundle also ships as `hello-sandboxed` (plugins/hello-sandboxed),
 * which runs in a sandboxed iframe. There the imports above are the frame
 * runtime's own React / zustand / @quadflow/ui, `ctx` is the RPC client, and
 * module state is per frame (the "all Hello tiles" counter counts this tile's
 * frame only; `activate()` runs in the background frame). The "Sandbox
 * isolation" panel then proves the frame cannot reach Tauri IPC or the host DOM.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { definePlugin, usePluginContext, type SidecarStatus, type TileProps } from '@quadflow/plugin-api'
import { Badge, Button, useTheme } from '@quadflow/ui'
import { CHECKS, SANDBOX_CHECKS, activatedAt, checksFor, markActivated, runCheck, type ApiCheck, type CheckResult } from './apiTests'
import './hello.css'

/** Shared between every open Hello tile (module state = plugin state). */
const useClicks = create<{ total: number; bump(): void }>((set) => ({
  total: 0,
  bump: () => set((s) => ({ total: s.total + 1 })),
}))

/**
 * Runs a list of checks and shows each outcome. `testId` prefixes the
 * data-testids (`hello-api-*` for the host-API panel, `hello-sandbox-*` for the
 * isolation panel shown only when sandboxed).
 */
function ChecksPanel(props: {
  instanceId: string
  title: string
  checks: ApiCheck[]
  testId: string
  note?: string
  children?: ReactNode
}) {
  const { instanceId, title, checks, testId, note, children } = props
  const ctx = usePluginContext()
  const [results, setResults] = useState<CheckResult[]>([])
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    setResults([])
    const out: CheckResult[] = []
    for (const c of checks) {
      out.push(await runCheck(ctx, c, { instanceId }))
      setResults([...out])
    }
    setRunning(false)
    ctx.log.info(`${title} tests`, { passed: out.filter((r) => r.pass).length, total: out.length })
  }

  const passed = results.filter((r) => r.pass).length
  const done = !running && results.length === checks.length
  return (
    <section className="qf-hello__api" data-testid={`${testId}-panel`}>
      <div className="qf-hello__row">
        <h3 className="qf-hello__subtitle">{title}</h3>
        <Button size="sm" data-testid={`${testId}-run`} disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : `Run ${checks.length} tests`}
        </Button>
        {results.length > 0 && (
          <Badge
            tone={done && passed === checks.length ? 'success' : running ? 'neutral' : 'warning'}
            data-testid={`${testId}-summary`}
            data-done={done}
            data-passed={passed}
            data-total={checks.length}
          >
            {passed}/{results.length} pass{done ? '' : ` (of ${checks.length})`}
          </Badge>
        )}
        {children}
      </div>
      {note && <div className="qf-hello__muted">{note}</div>}
      <table className="qf-hello__table">
        <tbody>
          {results.map((r) => (
            <tr key={`${r.check.group}/${r.check.name}`} data-testid={`${testId}-row`} data-pass={r.pass}>
              <td className={r.pass ? 'qf-hello__pass' : 'qf-hello__fail'}>{r.pass ? '✓' : '✗'}</td>
              <td className="qf-hello__group">{r.check.group}</td>
              <td>{r.check.name}</td>
              <td className="qf-hello__outcome">{r.outcome === 'ok' ? 'ok' : r.outcome}</td>
              <td className="qf-hello__detail">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ApiPanel({ instanceId }: { instanceId: string }) {
  const ctx = usePluginContext()
  const [dialog, setDialog] = useState('')
  const checks = checksFor(ctx)
  const skipped = CHECKS.length - checks.length
  const note = [dialog, skipped ? `${skipped} trusted-only checks (native.*) are not run sandboxed` : ''].filter(Boolean).join(' · ')
  return (
    <ChecksPanel instanceId={instanceId} title="Host API" checks={checks} testId="hello-api" note={note || undefined}>
      <Button
        size="sm"
        variant="ghost"
        data-testid="hello-api-confirm"
        onClick={async () => setDialog(`confirm → ${await ctx.ui.confirm({ title: 'Hello', message: 'ui.confirm from a plugin' })}`)}
      >
        Confirm…
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => setDialog(`prompt → ${JSON.stringify(await ctx.ui.prompt({ title: 'Hello', label: 'Your name', initial: 'World' }))}`)}
      >
        Prompt…
      </Button>
    </ChecksPanel>
  )
}

/** Sidecar panel (PL-7): drives hello's Rust sidecar — ping, host call, event, crash, restart. */
function SidecarPanel() {
  const ctx = usePluginContext()
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [result, setResult] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [logs, setLogs] = useState<string[]>([])

  useEffect(() => {
    void ctx.sidecar.status().then(setStatus, () => {})
    const offStatus = ctx.sidecar.onStatus(setStatus)
    const push = (s: string) => setEvents((e) => [`${new Date().toLocaleTimeString()} ${s}`, ...e].slice(0, 6))
    const offEv = ctx.events.onPlugin(ctx.plugin.id, 'tick', (p) => push(`events: tick ${JSON.stringify(p)}`))
    const offUi = ctx.sidecar.onNotification('tick', (p) => push(`ui/tick ${JSON.stringify(p)}`))
    return () => {
      offStatus()
      offEv()
      offUi()
    }
  }, [ctx])

  const act = (label: string, f: () => Promise<unknown>) => async () => {
    setResult(`${label}…`)
    try {
      setResult(`${label} → ${JSON.stringify(await f())}`)
    } catch (e) {
      setResult(`${label} ✗ ${e instanceof Error ? e.message : String(e)}`)
    }
    setLogs((await ctx.sidecar.logs().catch(() => [])).slice(-8))
  }

  const tone = status?.state === 'running' ? 'success' : status?.state === 'failed' ? 'error' : status?.state === 'stopped' ? 'neutral' : 'warning'
  return (
    <section className="qf-hello__api" data-testid="hello-sidecar-panel">
      <div className="qf-hello__row">
        <h3 className="qf-hello__subtitle">Sidecar</h3>
        <Badge tone={tone} data-testid="hello-sidecar-state">
          {status?.state ?? '…'}
        </Badge>
        <span className="qf-hello__muted" data-testid="hello-sidecar-pid">
          {status?.pid ? `pid ${status.pid}` : 'no process'} · restarts {status?.restarts ?? 0}
        </span>
      </div>
      {status?.lastError && (
        <div className="qf-hello__muted" data-testid="hello-sidecar-error">
          last error: {status.lastError}
        </div>
      )}
      <div className="qf-hello__row">
        <Button size="sm" data-testid="hello-sidecar-ping" onClick={act('ping', () => ctx.sidecar.request('ping', { at: Date.now() }))}>
          Ping
        </Button>
        <Button size="sm" variant="ghost" data-testid="hello-sidecar-hostcall" onClick={act('hostCall', () => ctx.sidecar.request('hostCall'))}>
          Host call
        </Button>
        <Button size="sm" variant="ghost" data-testid="hello-sidecar-emit" onClick={act('emit', () => ctx.sidecar.request('emit', { at: Date.now() }))}>
          Emit event
        </Button>
        <Button size="sm" variant="ghost" data-testid="hello-sidecar-crash" onClick={act('crash', () => ctx.sidecar.request('crash'))}>
          Crash
        </Button>
        <Button size="sm" variant="ghost" data-testid="hello-sidecar-restart" onClick={act('restart', () => ctx.sidecar.restart())}>
          Restart
        </Button>
      </div>
      {result && (
        <div className="qf-hello__detail" data-testid="hello-sidecar-result">
          {result}
        </div>
      )}
      {events.map((e) => (
        <div key={e} className="qf-hello__detail" data-testid="hello-sidecar-event">
          {e}
        </div>
      ))}
      {logs.length > 0 && (
        <pre className="qf-hello__log" data-testid="hello-sidecar-logs">
          {logs.join('\n')}
        </pre>
      )}
    </section>
  )
}

function HelloTile({ mode, instance, setTitle, setState }: TileProps) {
  const ctx = usePluginContext()
  const theme = useTheme()
  const total = useClicks((s) => s.total)
  const bump = useClicks((s) => s.bump)
  const saved =
    typeof instance.state === 'object' && instance.state && 'count' in instance.state
      ? Number((instance.state as { count: unknown }).count) || 0
      : 0
  const [count, setCount] = useState(saved)
  const [mountedAt] = useState(() => new Date().toLocaleTimeString())

  // API checks: a tile opened with `ui.openTile(id, { state: { probe } })` reports the state it got.
  useEffect(() => {
    const st = instance.state
    if (st && typeof st === 'object' && !Array.isArray(st) && 'probe' in st) ctx.events.emit('probe-state', { instanceId: instance.id, state: st })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTitle(count === 0 ? 'Hello' : `Hello (${count})`)
    setState({ count })
  }, [count]) // eslint-disable-line react-hooks/exhaustive-deps

  const project = ctx.project.current()

  return (
    <div className="qf-hello" data-testid="hello-tile" data-mode={mode}>
      <div className="qf-hello__row">
        <h2 className="qf-hello__title">Hello from a plugin</h2>
        <Badge tone="success">{mode}</Badge>
      </div>
      <dl className="qf-hello__facts">
        <dt>Host context</dt>
        <dd data-testid="hello-context">
          ok: {ctx.plugin.id} v{ctx.plugin.version} ({ctx.plugin.isolation}), API {ctx.api.version}
        </dd>
        <dt>Theme (shared @quadflow/ui)</dt>
        <dd data-testid="hello-theme">
          {theme.mode} (preference: {theme.preference})
        </dd>
        <dt>Project</dt>
        <dd>{project ? `${project.name} (${project.config?.code ?? '?'})` : 'none'}</dd>
        <dt>Mounted</dt>
        <dd>{mountedAt}</dd>
      </dl>
      <div className="qf-hello__row">
        <Button
          data-testid="hello-click"
          onClick={() => {
            setCount((c) => c + 1)
            bump()
          }}
        >
          Clicked {count}×
        </Button>
        <span className="qf-hello__muted" data-testid="hello-total">
          all Hello tiles: {total}
        </span>
      </div>
      <SidecarPanel />
      <ApiPanel instanceId={instance.id} />
      {ctx.plugin.isolation === 'sandboxed' && (
        <ChecksPanel instanceId={instance.id} title="Sandbox isolation" checks={SANDBOX_CHECKS} testId="hello-sandbox" />
      )}
    </div>
  )
}

export default definePlugin({
  activate(ctx) {
    markActivated()
    ctx.log.info('activated', { api: ctx.api.version, project: ctx.project.current()?.name ?? null })
  },
  tiles: { hello: HelloTile },
  commands: {
    ping: (_ctx, args) => ({ pong: args ?? null, activatedAt }),
  },
})
