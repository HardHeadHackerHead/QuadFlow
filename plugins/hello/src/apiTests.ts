/**
 * The host-API test panel's checks (PL-3): one or more calls per §6 method
 * group. Each check names what it expects — `ok`, or the `HostError.code` the
 * host must reject with (e.g. `permission_denied` for a permission `hello`
 * does not declare) — and passes when the outcome matches.
 *
 * The same bundle runs trusted (`hello`) and sandboxed (`hello-sandboxed`,
 * PL-6). Checks marked `trustedOnly` exercise methods plugin-system.md §7.2 /
 * §8.4 reserve for trusted plugins (`native.*`); a sandboxed run skips them,
 * so its pass count is the trusted count minus those. `SANDBOX_CHECKS` run
 * only in a frame and prove the isolation (no Tauri IPC, no host DOM, limits).
 */
import { HostError, type PluginContext } from '@quadflow/plugin-api'

export type Outcome = 'ok' | string
export interface ApiCheck {
  group: string
  name: string
  expect: Outcome
  /** Needs the host document (native views / geometry): not run sandboxed. */
  trustedOnly?: boolean
  run(ctx: PluginContext, env: { instanceId: string }): Promise<string>
}

/** The checks for this isolation mode. */
export function checksFor(ctx: PluginContext): ApiCheck[] {
  return ctx.plugin.isolation === 'sandboxed' ? CHECKS.filter((c) => !c.trustedOnly) : CHECKS
}
export interface CheckResult {
  check: ApiCheck
  outcome: Outcome
  detail: string
  pass: boolean
  ms: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const short = (v: unknown, n = 70) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export const CHECKS: ApiCheck[] = [
  // lifecycle + feature detection
  {
    group: 'lifecycle',
    name: 'activate() ran',
    expect: 'ok',
    run: async (ctx) => {
      if (activatedAt) return `at ${activatedAt}`
      // Sandboxed: activate() runs in the plugin's background frame, not in this tile frame.
      const r = await ctx.commands.execute<{ activatedAt?: string | null }>(`${ctx.plugin.id}/ping`)
      return r.activatedAt ? `at ${r.activatedAt} (background frame)` : fail('not activated')
    },
  },
  {
    group: 'api',
    name: 'api.has() accurate',
    expect: 'ok',
    run: async (ctx) => {
      const trusted = ctx.plugin.isolation === 'trusted'
      const yes = ['data.ideas.list', 'terminals.spawn', 'fs.readText', 'ui.confirm', 'sidecar.request', ...(trusted ? ['native.tileGeometry'] : [])]
      const no = ['sidecar.nope', 'nope.method', ...(trusted ? [] : ['native.tileGeometry', 'native.captureRegion', 'terminals.attach'])]
      const bad = [...yes.filter((m) => !ctx.api.has(m)), ...no.filter((m) => ctx.api.has(m)).map((m) => `!${m}`)]
      if (bad.length) fail(`wrong: ${bad.join(', ')}`)
      return `agents.launch=${ctx.api.has('agents.launch')}`
    },
  },
  {
    group: 'api',
    name: 'API 1.4 methods present',
    expect: 'ok',
    run: async (ctx) => {
      const added = [
        'data.ship.templates', 'data.ship.init', 'data.ship.detect', 'data.ship.diagnostics', 'data.ship.readinessOne',
        'data.ship.runFix', 'data.ship.configDelete', 'data.ship.restoreBackups',
        'data.chat.settingsGet', 'data.chat.settingsUpdate', 'data.chat.models', 'data.chat.ask',
        'data.missions.proposalSetStatus', 'data.missions.mergeUpdate', 'data.missions.logActivity', 'data.missions.markRead',
        'terminals.focus', 'ui.getToolConfig', 'ui.updateToolConfigSettings', 'ui.openSettings',
        ...(ctx.api.has('agents.launch') ? ['agents.oneShot', 'agents.prepareWorktree'] : []),
        ...(ctx.api.has('agents.providers') ? ['agents.sessionRoots'] : []),
        ...(ctx.plugin.isolation === 'trusted' ? ['native.openWindow', 'native.monitorOf'] : []),
        ...(ctx.plugin.isolation === 'trusted' && ctx.api.has('native.mainWindowHandle') && /Windows/i.test(navigator.userAgent)
          ? ['native.allowSetForeground']
          : []),
      ]
      const missing = added.filter((m) => !ctx.api.has(m))
      if (missing.length) fail(`missing: ${missing.join(', ')}`)
      return `${added.length} present (api ${ctx.api.version})`
    },
  },
  {
    group: 'ui',
    name: 'openTile({ state }) → tile gets it; closeTile → onTileClosed',
    expect: 'ok',
    run: async (ctx) => {
      const probe = `p${Date.now()}`
      let got: { instanceId?: string; state?: { probe?: string; count?: number } } | null = null
      const offState = ctx.events.onPlugin(ctx.plugin.id, 'probe-state', (p) => {
        const v = p as typeof got
        if (v?.state?.probe === probe) got = v
      })
      const closed: string[] = []
      const offClosed = ctx.ui.onTileClosed((e) => void closed.push(e.instanceId))
      try {
        const instanceId = await ctx.ui.openTile('hello', { state: { probe, count: 7 } })
        for (let i = 0; i < 40 && !got; i++) await sleep(100)
        if (!got) fail('the opened tile did not report its state')
        const g = got as NonNullable<typeof got>
        if (g.instanceId !== instanceId || g.state?.count !== 7) fail(`state ${short(g)}`)
        ctx.ui.closeTile(instanceId)
        for (let i = 0; i < 40 && !closed.includes(instanceId); i++) await sleep(100)
        if (!closed.includes(instanceId)) fail('onTileClosed did not fire')
        return `state ok, closed ${instanceId.slice(-6)}`
      } finally {
        offState()
        offClosed()
      }
    },
  },
  {
    group: 'ui',
    name: 'getToolConfig (own configs only)',
    expect: 'ok',
    run: async (ctx) => {
      if ((await ctx.ui.getToolConfig('no-such-config')) !== null) fail('an unknown id returned a config')
      return 'unknown id → null'
    },
  },
  { group: 'ui', name: 'updateToolConfigSettings (unknown id)', expect: 'not_found', run: async (ctx) => short(await ctx.ui.updateToolConfigSettings('no-such-config', { x: 1 })) },
  // hello declares no `data:chat:*` / `data:ship:*` / `agents:launch`: the 1.4 methods are checked in Rust.
  { group: 'api', name: 'chat.settingsGet (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.data.chat.settingsGet()) },
  { group: 'api', name: 'ship.templates (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.data.ship.templates()) },
  { group: 'api', name: 'terminals.focus (foreign terminal)', expect: 'permission_denied', run: async (ctx) => (await ctx.terminals.focus('not-mine'), 'focused') },
  // project / workspace
  { group: 'project', name: 'project.current + list', expect: 'ok', run: async (ctx) => `${ctx.project.current()?.name ?? 'none'}; ${(await ctx.project.list()).length} registered` },
  { group: 'workspace', name: 'workspace.current', expect: 'ok', run: async (ctx) => ctx.workspace.current()?.name ?? 'none' },
  // data
  {
    group: 'data',
    name: 'ideas create/bulkTag/list/delete',
    expect: 'ok',
    run: async (ctx) => {
      const idea = await ctx.data.ideas.create({ content: 'Created by the hello plugin', tags: ['hello'] })
      const tagged = await ctx.data.ideas.bulkTag([idea.id], 'hello-bulk')
      if (!tagged[0]?.tags?.includes('hello-bulk')) throw new Error('bulkTag did not tag the idea')
      const n = (await ctx.data.ideas.list({ tags: ['hello', 'hello-bulk'] })).items.length
      await ctx.data.ideas.delete(idea.id)
      return `created ${idea.id.slice(-6)}, bulk-tagged, listed ${n}, deleted`
    },
  },
  { group: 'data', name: 'issues.list (read)', expect: 'ok', run: async (ctx) => `${(await ctx.data.issues.list()).items.length} issues` },
  { group: 'data', name: 'issues.create (no write grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.data.issues.create({ title: 'x' })) },
  { group: 'data', name: 'projectConfig.get', expect: 'ok', run: async (ctx) => `code ${(await ctx.data.projectConfig.get()).code}` },
  // terminals
  {
    group: 'terminals',
    name: 'spawn headless, read, kill',
    expect: 'ok',
    run: async (ctx) => {
      const t = await ctx.terminals.spawn({ placement: 'none', initCommands: ['echo hello-from-plugin'], title: 'hello' })
      let chunks = 0
      const off = ctx.terminals.onData(t.id, () => void chunks++)
      // Shells take a moment to start (PowerShell profiles, login shells).
      let buf = ''
      for (let i = 0; i < 40 && !buf.includes('hello-from-plugin'); i++) {
        await sleep(250)
        buf = await ctx.terminals.readBuffer(t.id)
      }
      off()
      const listed = (await ctx.terminals.list()).some((x) => x.id === t.id)
      await ctx.terminals.kill(t.id)
      if (!buf.includes('hello-from-plugin')) fail(`buffer: ${short(buf)}`)
      return `pid ${t.pid}, listed=${listed}, ${chunks} chunks`
    },
  },
  { group: 'terminals', name: 'write to a foreign terminal', expect: 'permission_denied', run: async (ctx) => (await ctx.terminals.write('not-mine', 'x'), 'wrote') },
  // API 1.2: `shellPath` must be an absolute path to an existing file.
  { group: 'terminals', name: 'spawn with a relative shellPath', expect: 'invalid_input', run: async (ctx) => short(await ctx.terminals.spawn({ shellPath: 'bash' })) },
  // agents
  {
    group: 'agents',
    name: 'agents.providers',
    expect: 'ok',
    run: async (ctx) => {
      if (!ctx.api.has('agents.providers')) {
        try {
          await ctx.agents.providers()
        } catch (e) {
          if (e instanceof HostError && e.code === 'unsupported') return 'not available yet (AP-1): unsupported'
          throw e
        }
      }
      return `${(await ctx.agents.providers()).length} providers`
    },
  },
  { group: 'agents', name: 'agents.launch (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.agents.launch({ providerId: 'x' })) },
  // events
  {
    group: 'events',
    name: 'emit → onPlugin round trip',
    expect: 'ok',
    run: async (ctx) => {
      let got: unknown = null
      const off = ctx.events.onPlugin(ctx.plugin.id, 'ping', (p) => (got = p))
      ctx.events.emit('ping', { n: 42 })
      // Synchronous for trusted plugins; one round trip in a sandbox frame.
      for (let i = 0; i < 80 && got === null; i++) await sleep(25)
      off()
      if ((got as { n?: number } | null)?.n !== 42) fail('no event')
      return 'received {n: 42}'
    },
  },
  // storage / settings / secrets
  {
    group: 'storage',
    name: 'set/get/keys/delete',
    expect: 'ok',
    run: async (ctx) => {
      await ctx.storage.set('test.value', { at: Date.now() })
      const v = await ctx.storage.get<{ at: number }>('test.value')
      const keys = await ctx.storage.keys('test.')
      await ctx.storage.delete('test.value')
      const gone = (await ctx.storage.get('test.value')) === undefined
      return `got ${typeof v?.at}, keys ${keys.length}, deleted=${gone}`
    },
  },
  {
    group: 'settings',
    name: 'set validated in Rust',
    expect: 'ok',
    run: async (ctx) => {
      const runs = Number(ctx.settings.get('runs') ?? 0) + 1
      await ctx.settings.set('runs', runs)
      let rejected = false
      try {
        await ctx.settings.set('runs', -1)
      } catch (e) {
        rejected = e instanceof HostError && e.code === 'invalid_input'
      }
      if (!rejected) fail('schema violation accepted')
      return `greeting "${ctx.settings.get('greeting')}", runs ${ctx.settings.get('runs')}`
    },
  },
  {
    group: 'secrets',
    name: 'set/get/delete',
    expect: 'ok',
    run: async (ctx) => {
      await ctx.secrets.set('token', 'hello-secret')
      const v = await ctx.secrets.get('token')
      await ctx.secrets.delete('token')
      if (v !== 'hello-secret') fail(`got ${v}`)
      return 'round trip ok'
    },
  },
  // notifications
  { group: 'notifications', name: 'toast', expect: 'ok', run: async (ctx) => (ctx.notifications.toast({ title: 'Hello', body: 'Toast from a plugin', kind: 'success' }), 'shown') },
  { group: 'notifications', name: 'system', expect: 'ok', run: async (ctx) => (await ctx.notifications.system({ title: 'Hello', body: 'System notification from a plugin' }), 'sent') },
  // fs
  {
    group: 'fs',
    name: 'pluginData write/read/list',
    expect: 'ok',
    run: async (ctx) => {
      await ctx.fs.writeText('notes/hello.txt', 'hi there', 'pluginData')
      const text = await ctx.fs.readText('notes/hello.txt', 'pluginData')
      const bytes = await ctx.fs.readBytes('notes/hello.txt', 'pluginData')
      const list = await ctx.fs.list('notes', 'pluginData')
      return `"${text}", ${bytes.length} bytes, ${list.length} entries`
    },
  },
  { group: 'fs', name: 'project list (read grant)', expect: 'ok', run: async (ctx) => `${(await ctx.fs.list('', 'project')).length} entries` },
  { group: 'fs', name: "'..' escape", expect: 'permission_denied', run: async (ctx) => short(await ctx.fs.readText('../outside.txt', 'project')) },
  { group: 'fs', name: 'project write (no grant)', expect: 'permission_denied', run: async (ctx) => (await ctx.fs.writeText('x.txt', 'x', 'project'), 'wrote') },
  // shell / http
  { group: 'shell', name: 'exec git --version', expect: 'ok', run: async (ctx) => short((await ctx.shell.exec({ program: 'git', args: ['--version'] })).stdout.trim()) },
  { group: 'shell', name: 'exec node (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.shell.exec({ program: 'node', args: ['-v'] })) },
  {
    group: 'http',
    name: 'fetch example.com',
    expect: 'ok',
    run: async (ctx) => {
      try {
        const r = await ctx.http.fetch('https://example.com/')
        return `HTTP ${r.status}, ${r.body.length} bytes`
      } catch (e) {
        // Permission passed; only the network failed (offline machine).
        if (e instanceof HostError && e.code === 'external') return `permitted; offline: ${short(e.message, 40)}`
        throw e
      }
    },
  },
  { group: 'http', name: 'fetch other host (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.http.fetch('https://api.github.com/')) },
  // clipboard
  { group: 'clipboard', name: 'writeText', expect: 'ok', run: async (ctx) => (await ctx.clipboard.writeText('copied by the hello plugin'), 'written') },
  { group: 'clipboard', name: 'readText (no grant)', expect: 'permission_denied', run: async (ctx) => short(await ctx.clipboard.readText()) },
  // commands
  {
    group: 'commands',
    name: 'register + execute',
    expect: 'ok',
    run: async (ctx) => {
      const off = ctx.commands.register('ping', (args) => ({ pong: args ?? null }))
      const r = await ctx.commands.execute<{ pong: unknown }>(`${ctx.plugin.id}/ping`, 7)
      off()
      return `pong ${JSON.stringify(r.pong)}`
    },
  },
  // ui / overlay / native
  { group: 'ui', name: 'theme()', expect: 'ok', run: async (ctx) => `${ctx.ui.theme().mode}, ${Object.keys(ctx.ui.theme().colors).length} color tokens` },
  { group: 'overlay', name: 'isAnyOpen()', expect: 'ok', run: async (ctx) => `anyOpen=${ctx.overlay.isAnyOpen()}` },
  {
    group: 'native',
    name: 'tileGeometry(own tile)',
    expect: 'ok',
    trustedOnly: true,
    run: async (ctx, env) => {
      const g = ctx.native.tileGeometry(env.instanceId)
      if (g.css.width <= 0) fail('zero size')
      return `${Math.round(g.css.width)}×${Math.round(g.css.height)} css, ×${g.scaleFactor}, visible=${g.visible}`
    },
  },
  {
    group: 'native',
    name: 'mainWindowHandle',
    expect: 'ok',
    trustedOnly: true,
    run: async (ctx) => {
      if (!ctx.api.has('native.mainWindowHandle')) return 'not on this platform'
      return `handle ${await ctx.native.mainWindowHandle()}`
    },
  },
  { group: 'native', name: 'captureRegion (no grant)', expect: 'permission_denied', trustedOnly: true, run: async (ctx) => short(await ctx.native.captureRegion({ x: 0, y: 0, width: 4, height: 4 })) },
  // sidecar (PL-7): hello's Rust sidecar (plugins/hello/sidecar)
  {
    group: 'sidecar',
    name: 'request ping (starts on demand)',
    expect: 'ok',
    run: async (ctx) => {
      const r = await ctx.sidecar.request<{ pid: number; calls: number }>('ping', { from: 'api-test' })
      return `pid ${r.pid}, call #${r.calls}`
    },
  },
  {
    group: 'sidecar',
    name: 'host/call: storage ok, clipboard:read denied',
    expect: 'ok',
    run: async (ctx) => {
      const r = await ctx.sidecar.request<{ count: number; clipboardRead: { allowed: boolean; code?: string; permission?: string } }>('hostCall')
      if (r.clipboardRead.allowed || r.clipboardRead.code !== 'permission_denied') fail(`clipboard.readText from the sidecar: ${short(r.clipboardRead)}`)
      return `count ${r.count}; denied ${r.clipboardRead.permission}`
    },
  },
  {
    group: 'sidecar',
    name: 'host/emit → events + ui/tick',
    expect: 'ok',
    run: async (ctx) => {
      const at = Date.now()
      let viaEvents = false
      let viaUi = false
      const off1 = ctx.events.onPlugin(ctx.plugin.id, 'tick', (p) => (viaEvents ||= (p as { at?: number } | null)?.at === at))
      const off2 = ctx.sidecar.onNotification('tick', (p) => (viaUi ||= (p as { at?: number } | null)?.at === at))
      try {
        await ctx.sidecar.request('emit', { at })
        for (let i = 0; i < 40 && !(viaEvents && viaUi); i++) await sleep(25)
      } finally {
        off1()
        off2()
      }
      if (!viaEvents || !viaUi) fail(`events=${viaEvents} ui=${viaUi}`)
      return 'both delivered'
    },
  },
  { group: 'sidecar', name: 'reserved method rejected', expect: 'invalid_input', run: async (ctx) => short(await ctx.sidecar.request('host/call')) },
  { group: 'sidecar', name: 'status', expect: 'ok', run: async (ctx) => short(await ctx.sidecar.status()) },
]

/** A raw failure that must happen; returns its message (or fails the check when it did not). */
async function mustFail(what: string, f: () => unknown): Promise<string> {
  try {
    await f()
  } catch (e) {
    return `${what}: ${short(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 60)}`
  }
  return fail(`${what} succeeded`)
}

const hostErrorWith = (e: unknown, code: string, limit?: string) =>
  e instanceof HostError && e.code === code && (!limit || (e.details as { limit?: string } | undefined)?.limit === limit)

/**
 * Sandbox isolation (PL-6), run from inside the plugin's frame with plain web
 * APIs — what a hostile third-party bundle could try. Every check must fail
 * to escape.
 */
export const SANDBOX_CHECKS: ApiCheck[] = [
  {
    group: 'isolation',
    name: 'no window.__TAURI__',
    expect: 'ok',
    run: async () => ('__TAURI__' in window ? fail('window.__TAURI__ is present') : 'absent'),
  },
  {
    group: 'isolation',
    name: 'Tauri IPC unreachable',
    expect: 'ok',
    run: async () => {
      // WebView2 runs Tauri's init scripts in every frame (wry cannot restrict them to the main
      // frame on Windows), so `__TAURI_INTERNALS__` may exist here. It must be inert: the
      // custom-protocol request is blocked (CSP `connect-src 'none'`, `Origin: null`) and the
      // postMessage fallback never reaches the app.
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__
      if (typeof internals?.invoke !== 'function') return 'no IPC internals in this frame'
      const answer = await Promise.race([
        internals.invoke('plugins_list', { includeUnsupported: true }).then(
          (v) => ({ escaped: true, v }),
          (e) => ({ escaped: false, v: e }),
        ),
        sleep(3000).then(() => ({ escaped: false, v: 'no answer' })),
      ])
      if (answer.escaped) fail(`invoke answered: ${short(answer.v)}`)
      return `__TAURI_INTERNALS__.invoke: ${short(String(answer.v), 50)}`
    },
  },
  { group: 'isolation', name: 'parent.document', expect: 'ok', run: () => mustFail('blocked', () => window.parent.document.title) },
  { group: 'isolation', name: 'top.location', expect: 'ok', run: () => mustFail('blocked', () => window.top!.location.href) },
  {
    group: 'isolation',
    name: 'fetch ipc.localhost',
    expect: 'ok',
    run: () => mustFail('blocked', () => fetch('http://ipc.localhost/plugins_list', { method: 'POST', body: '{}' })),
  },
  { group: 'isolation', name: 'fetch ipc://localhost', expect: 'ok', run: () => mustFail('blocked', () => fetch('ipc://localhost/plugins_list', { method: 'POST' })) },
  { group: 'isolation', name: 'fetch the network', expect: 'ok', run: () => mustFail('blocked', () => fetch('https://example.com/')) },
  { group: 'isolation', name: 'localStorage / cookies', expect: 'ok', run: () => mustFail('blocked', () => window.localStorage.getItem('x') ?? document.cookie) },
  {
    group: 'isolation',
    name: 'trusted-only methods',
    expect: 'ok',
    run: async (ctx, env) => {
      const sync = [
        () => ctx.native.tileGeometry(env.instanceId),
        () => ctx.terminals.attach('x', document.body),
      ]
      for (const f of sync) {
        try {
          f()
          fail('a trusted-only method worked')
        } catch (e) {
          if (!hostErrorWith(e, 'unsupported')) throw e
        }
      }
      for (const f of [() => ctx.native.mainWindowHandle(), () => ctx.native.captureRegion({ x: 0, y: 0, width: 1, height: 1 })]) {
        try {
          await f()
          fail('a trusted-only method worked')
        } catch (e) {
          if (!hostErrorWith(e, 'unsupported')) throw e
        }
      }
      return 'native.*, terminals.attach: unsupported'
    },
  },
  {
    group: 'limits',
    name: 'message over 4 MiB rejected',
    expect: 'ok',
    run: async (ctx) => {
      try {
        await ctx.storage.get('x'.repeat(2.2 * 1024 * 1024)) // ~4.4 MB as UTF-16
      } catch (e) {
        if (hostErrorWith(e, 'invalid_input', 'messageSize')) return `invalid_input: ${short((e as Error).message, 50)}`
        throw e
      }
      return fail('accepted')
    },
  },
  {
    group: 'limits',
    name: '200 requests in flight',
    expect: 'ok',
    run: async (ctx) => {
      const n = 260
      const all = await Promise.allSettled(Array.from({ length: n }, () => ctx.storage.keys('limit-test.')))
      const ok = all.filter((r) => r.status === 'fulfilled').length
      const limited = all.filter((r) => r.status === 'rejected' && hostErrorWith(r.reason, 'invalid_input', 'inFlight')).length
      if (ok + limited !== n) fail(`${n - ok - limited} failed otherwise`)
      if (limited === 0) fail(`all ${n} accepted`)
      // The frame recovers once requests complete.
      await ctx.storage.keys('limit-test.')
      return `${ok} served, ${limited} refused (inFlight)`
    },
  },
]

export let activatedAt: string | null = null
export function markActivated() {
  activatedAt = new Date().toLocaleTimeString()
}

function fail(msg: string): never {
  throw new Error(msg)
}

export async function runCheck(ctx: PluginContext, check: ApiCheck, env: { instanceId: string }): Promise<CheckResult> {
  const t0 = performance.now()
  let outcome: Outcome
  let detail: string
  try {
    detail = await check.run(ctx, env)
    outcome = 'ok'
  } catch (e) {
    outcome = e instanceof HostError ? e.code : 'error'
    detail = e instanceof HostError && e.permission ? `needs ${e.permission}` : e instanceof Error ? e.message : String(e)
  }
  return { check, outcome, detail, pass: outcome === check.expect, ms: Math.round(performance.now() - t0) }
}
