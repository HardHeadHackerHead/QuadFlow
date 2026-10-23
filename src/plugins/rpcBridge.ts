/**
 * Host side of the sandbox RPC (plugin-system.md §8.4).
 *
 * One `message` listener for every sandboxed frame. A message is attributed to
 * a plugin **only** by `event.source === iframe.contentWindow` of a registered
 * frame — a frame cannot claim another plugin's id. Messages without `qf: 1`
 * or from unknown windows are ignored.
 *
 * A `req` / `sub` names a `PluginContext` method (`data.issues.list`, …); the
 * bridge runs it on the plugin's own host context (`createHostContext`, the
 * object trusted plugins get), so privileged calls go through `plugin_invoke`
 * / `plugin_subscribe` and are permission-checked in Rust for *that* plugin.
 * Only methods in `RPC_METHODS` are callable; trusted-only ones (native views,
 * `terminals.attach`) are refused.
 *
 * Limits per frame: messages over `MAX_MESSAGE_BYTES` (4 MiB) and requests
 * beyond `MAX_IN_FLIGHT` (200) outstanding are rejected with `invalid_input`
 * (`details.limit` = `messageSize` / `inFlight`); at most
 * `MAX_SUBSCRIPTIONS` live subscriptions. A frame that sends `ready` twice has
 * navigated away from its document and is cut off.
 */
import { HostError, type Disposable, type JsonValue, type PluginContext } from '@quadflow/plugin-api'
import {
  FRAME_LOCAL_METHODS,
  KILL_SPAWN,
  MAX_IN_FLIGHT,
  MAX_MESSAGE_BYTES,
  RPC_METHODS,
  RPC_PROTOCOL,
  STREAM_CALLBACK_INDEX,
  TRUSTED_ONLY_METHODS,
  estimateSize,
  isRpcMessage,
  type RpcError,
  type RpcInit,
  type RpcTileInit,
  type ToFrame,
  type ToHost,
  type UiOp,
} from '@quadflow/plugin-api/rpc'
import { toHostError } from './hostApi/transport'
import { getTile } from './hostApi/tiles'
import type { PluginInfo } from './registry'

/** Live subscriptions one frame may hold. */
export const MAX_SUBSCRIPTIONS = 1000

export interface FrameOptions {
  iframe: HTMLIFrameElement
  info: PluginInfo
  /** The plugin's host context (privileged calls are checked in Rust for `info.id`). */
  ctx: PluginContext
  role: 'tile' | 'background'
  /** Current tile props (tile frames). */
  tile?: () => RpcTileInit
  /** Entry cache-buster (registry generation / dev reload). */
  bust: string
  onUi?(op: UiOp, value: JsonValue | undefined): void
  onStatus?(state: 'ready' | 'error', error?: string): void
  /** The frame opened / closed its last menu or modal (`@quadflow/ui` overlays, `overlay.register`). */
  onOverlay?(open: boolean): void
}

export interface FrameHandle {
  readonly id: number
  /** Push tile state (visibility, mode) to the frame. */
  update(m: { visible?: boolean; mode?: 'pane' | 'flyout' }): void
  /** Call into the frame (`$command`, `$deactivate`); rejects when the frame goes away. */
  call(fn: '$command' | '$deactivate', args: unknown[], timeoutMs?: number): Promise<unknown>
  dispose(): void
}

type Ctx = Extract<ToFrame, { kind: 'ctx' }>

interface Frame {
  id: number
  o: FrameOptions
  initialized: boolean
  dead: boolean
  inFlight: number
  subs: Map<number, Disposable>
  spawns: Map<number, () => Promise<void>>
  calls: Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer?: ReturnType<typeof setTimeout> }>
  overlays: Set<string>
  pushes: Disposable[]
}

const frames = new Set<Frame>()
let nextFrameId = 1
let nextCallId = 1
let listening = false

function onMessage(e: MessageEvent) {
  if (!isRpcMessage(e.data) || e.source === null) return
  for (const f of frames) {
    if (f.o.iframe.contentWindow === e.source) {
      handle(f, e.data as ToHost)
      return
    }
  }
}

function ensureListener() {
  if (listening) return
  listening = true
  window.addEventListener('message', onMessage)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rpcError(e: unknown): RpcError {
  const h = toHostError(e)
  return { code: h.code, message: h.message, details: h.details === undefined ? undefined : cloneable(h.details) as JsonValue }
}

function limitError(limit: 'messageSize' | 'inFlight' | 'subscriptions', message: string, extra?: Record<string, number>): RpcError {
  return { code: 'invalid_input', message, details: { limit, ...extra } }
}

/** A structured-clone-safe copy: functions dropped (e.g. `http.fetch`'s `text()`), errors flattened. */
export function cloneable(v: unknown, depth = 0): unknown {
  if (typeof v === 'function' || typeof v === 'symbol') return undefined
  if (v === null || typeof v !== 'object') return v
  if (depth > 64) return null
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date || v instanceof Blob || v instanceof RegExp) return v
  if (v instanceof Error) return { name: v.name, message: v.message }
  if (Array.isArray(v)) return v.map((x) => {
    const c = cloneable(x, depth + 1)
    return c === undefined ? null : c
  })
  if (v instanceof Map || v instanceof Set) return v
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) {
    const c = cloneable((v as Record<string, unknown>)[k], depth + 1)
    if (c !== undefined) out[k] = c
  }
  return out
}

function post(f: Frame, m: ToFrame) {
  if (f.dead) return
  const w = f.o.iframe.contentWindow
  if (!w) return
  try {
    w.postMessage(m, '*')
  } catch (e) {
    // DataCloneError in a result: answer with an error instead.
    if (m.kind === 'res') w.postMessage({ qf: RPC_PROTOCOL, kind: 'res', id: m.id, error: rpcError(e) } satisfies ToFrame, '*')
    else console.warn(`[sandbox:${f.o.info.id}] cannot post ${m.kind}:`, e)
  }
}

/** `ctx` path → the host function (allowlisted names only). */
function resolveMethod(ctx: PluginContext, method: string): ((...a: unknown[]) => unknown) | null {
  let o: unknown = ctx
  for (const k of method.split('.')) {
    if (o === null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) return null
    o = (o as Record<string, unknown>)[k]
  }
  return typeof o === 'function' ? (o as (...a: unknown[]) => unknown) : null
}

/** Methods `api.has()` reports inside a frame of this plugin. */
export function frameMethods(ctx: PluginContext): string[] {
  const names = new Set<string>([...Object.keys(RPC_METHODS), ...FRAME_LOCAL_METHODS, 'settings.getAll'])
  const trustedOnly = new Set<string>(TRUSTED_ONLY_METHODS)
  return [...names].filter((m) => !trustedOnly.has(m) && ctx.api.has(m)).sort()
}

/** Instance-taking UI calls may only target this plugin's own tiles. */
const OWN_TILE_ARG = new Set(['ui.closeTile', 'ui.focusTile', 'notifications.attention'])

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------

function handle(f: Frame, m: ToHost) {
  if (f.dead) return
  const size = estimateSize(m, MAX_MESSAGE_BYTES)
  const id = (m as { id?: unknown }).id
  const hasId = typeof id === 'number' && Number.isSafeInteger(id)
  if (size > MAX_MESSAGE_BYTES) {
    console.warn(`[sandbox:${f.o.info.id}] dropped a ${m.kind} message over ${MAX_MESSAGE_BYTES} bytes`)
    if (hasId && (m.kind === 'req' || m.kind === 'sub')) {
      post(f, {
        qf: RPC_PROTOCOL,
        kind: 'res',
        id: id as number,
        error: limitError('messageSize', `message exceeds the ${MAX_MESSAGE_BYTES / (1024 * 1024)} MiB limit`, { max: MAX_MESSAGE_BYTES }),
      })
    }
    return
  }
  if (m.kind === 'ready') {
    if (f.initialized) {
      // A second document in the same frame: it navigated away. Cut it off.
      fail(f, 'the plugin frame navigated away from its document')
      return
    }
    f.initialized = true
    sendInit(f)
    return
  }
  if (!f.initialized) return
  switch (m.kind) {
    case 'req':
      if (hasId && typeof m.method === 'string') void handleReq(f, id as number, m.method, Array.isArray(m.params) ? m.params : [])
      return
    case 'sub':
      if (hasId && typeof m.topic === 'string') handleSub(f, id as number, m.topic, Array.isArray(m.params) ? m.params : [])
      return
    case 'unsub':
      if (hasId) {
        f.subs.get(id as number)?.()
        f.subs.delete(id as number)
      }
      return
    case 'ret': {
      const c = hasId ? f.calls.get(id as number) : undefined
      if (!c) return
      f.calls.delete(id as number)
      if (c.timer) clearTimeout(c.timer)
      if (m.error) c.reject(new HostError(m.error.code ?? 'internal', String(m.error.message ?? 'error'), m.error.details))
      else c.resolve(m.result)
      return
    }
    case 'ui':
      if (f.o.role === 'tile' && ['setTitle', 'setState', 'setAttention', 'close', 'resize'].includes(m.op)) f.o.onUi?.(m.op, m.value)
      return
    case 'status':
      if (m.state === 'ready' || m.state === 'error') f.o.onStatus?.(m.state, typeof m.error === 'string' ? m.error.slice(0, 2000) : undefined)
      return
  }
}

function respond(f: Frame, id: number, p: Promise<unknown>): Promise<void> {
  return p.then(
    (result) => post(f, { qf: RPC_PROTOCOL, kind: 'res', id, result: cloneable(result) }),
    (e) => post(f, { qf: RPC_PROTOCOL, kind: 'res', id, error: rpcError(e) }),
  )
}

async function handleReq(f: Frame, id: number, method: string, args: unknown[]) {
  const { ctx, info } = f.o
  const kind = Object.prototype.hasOwnProperty.call(RPC_METHODS, method) ? RPC_METHODS[method] : undefined
  if (method !== KILL_SPAWN && kind !== 'fire' && f.inFlight >= MAX_IN_FLIGHT) {
    post(f, {
      qf: RPC_PROTOCOL,
      kind: 'res',
      id,
      error: limitError('inFlight', `more than ${MAX_IN_FLIGHT} requests in flight`, { max: MAX_IN_FLIGHT }),
    })
    return
  }
  if (method === KILL_SPAWN) {
    const kill = f.spawns.get(Number(args[0]))
    await respond(f, id, kill ? kill() : Promise.resolve())
    return
  }
  const refuse = (code: 'unsupported' | 'invalid_input' | 'permission_denied', message: string) =>
    post(f, { qf: RPC_PROTOCOL, kind: 'res', id, error: { code, message } })
  if (!kind || kind === 'sub') {
    if ((TRUSTED_ONLY_METHODS as readonly string[]).includes(method)) return refuse('unsupported', `${method} is not available to sandboxed plugins`)
    return refuse('invalid_input', `unknown method ${JSON.stringify(method)}`)
  }
  const fn = resolveMethod(ctx, method)
  if (!fn) return refuse('unsupported', `${method} is not available`)
  // Refusals are answered even for `fire` methods (the RPC client ignores them; raw senders see why).
  if (OWN_TILE_ARG.has(method) && getTile(String(args[0]))?.pluginId !== info.id) {
    return refuse('permission_denied', `${method}: not a tile of ${info.id}`)
  }

  if (kind === 'fire') {
    try {
      if (method === 'overlay.register') {
        const [overlayId, open] = args
        if (typeof overlayId !== 'string' || overlayId.length > 200) return
        const key = `f${f.id}:${overlayId}`
        const before = f.overlays.size > 0
        if (open) f.overlays.add(key)
        else f.overlays.delete(key)
        fn(key, !!open)
        if (before !== f.overlays.size > 0) f.o.onOverlay?.(f.overlays.size > 0)
        return
      }
      fn(...args)
    } catch (e) {
      console.warn(`[sandbox:${info.id}] ${method}:`, e)
    }
    return
  }

  f.inFlight++
  try {
    if (kind === 'stream') {
      const at = STREAM_CALLBACK_INDEX[method]
      const a = args.slice()
      if (method === 'shell.spawn') {
        let finished = false
        let finish!: () => void
        const exited = new Promise<void>((r) => (finish = r))
        const done = () => {
          if (finished) return
          finished = true
          f.spawns.delete(id)
          post(f, { qf: RPC_PROTOCOL, kind: 'res', id, result: null })
          finish()
        }
        a[at] = (e: unknown) => {
          post(f, { qf: RPC_PROTOCOL, kind: 'evt', id, payload: [cloneable(e)] })
          if (e && typeof e === 'object' && 'exit' in e) done()
        }
        try {
          const h = (await fn(...a)) as { kill(): Promise<void> }
          f.spawns.set(id, async () => {
            await h.kill()
            done()
          })
          post(f, { qf: RPC_PROTOCOL, kind: 'evt', id, payload: [{ $started: true }] })
        } catch (e) {
          post(f, { qf: RPC_PROTOCOL, kind: 'res', id, error: rpcError(e) })
          return
        }
        // Stays in flight until the process exits (or is killed; teardown kills it).
        await exited
        return
      }
      a[at] = (e: unknown) => post(f, { qf: RPC_PROTOCOL, kind: 'evt', id, payload: [cloneable(e)] })
      await respond(f, id, Promise.resolve().then(() => fn(...a)))
      return
    }
    await respond(f, id, Promise.resolve().then(() => fn(...args)))
  } finally {
    f.inFlight--
  }
}

function handleSub(f: Frame, id: number, topic: string, args: unknown[]) {
  const { ctx, info } = f.o
  const ack = (error?: RpcError) => post(f, { qf: RPC_PROTOCOL, kind: 'res', id, result: null, error })
  if (f.subs.has(id)) return ack({ code: 'invalid_input', message: `subscription ${id} exists` })
  if (f.subs.size >= MAX_SUBSCRIPTIONS) {
    return ack(limitError('subscriptions', `more than ${MAX_SUBSCRIPTIONS} subscriptions`, { max: MAX_SUBSCRIPTIONS }))
  }
  if (!Object.prototype.hasOwnProperty.call(RPC_METHODS, topic) || RPC_METHODS[topic] !== 'sub') {
    return ack({ code: 'invalid_input', message: `${JSON.stringify(topic)} is not a subscription` })
  }
  const fn = resolveMethod(ctx, topic)
  if (!fn) return ack({ code: 'unsupported', message: `${topic} is not available` })
  const cb =
    topic === 'commands.register'
      ? (cmdArgs?: unknown) => callFrame(f, '$handler', [cmdArgs ?? null], id)
      : (...a: unknown[]) => post(f, { qf: RPC_PROTOCOL, kind: 'evt', id, payload: a.map((x) => cloneable(x)) })
  try {
    const dispose = fn(...args, cb)
    f.subs.set(id, typeof dispose === 'function' ? (dispose as Disposable) : () => {})
    ack()
  } catch (e) {
    console.warn(`[sandbox:${info.id}] ${topic}:`, e)
    ack(rpcError(e))
  }
}

function callFrame(f: Frame, fn: '$command' | '$handler' | '$deactivate', args: unknown[], sub?: number, timeoutMs?: number): Promise<unknown> {
  if (f.dead) return Promise.reject(new HostError('unsupported', `the frame of ${f.o.info.id} is gone`))
  return new Promise((resolve, reject) => {
    const id = nextCallId++
    const entry: Frame['calls'] extends Map<number, infer V> ? V : never = { resolve, reject }
    if (timeoutMs) {
      entry.timer = setTimeout(() => {
        f.calls.delete(id)
        reject(new HostError('internal', `${fn} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    }
    f.calls.set(id, entry)
    post(f, { qf: RPC_PROTOCOL, kind: 'call', id, fn, sub, args: args.map((a) => cloneable(a)) })
  })
}

function sendInit(f: Frame) {
  const { ctx, info, role } = f.o
  const init: RpcInit = {
    qf: RPC_PROTOCOL,
    kind: 'init',
    role,
    plugin: { id: info.id, version: ctx.plugin.version, isolation: 'sandboxed' },
    api: { version: ctx.api.version, methods: frameMethods(ctx) },
    commands: (info.manifest?.contributes?.commands ?? []).map((c) => c.id),
    project: cloneable(ctx.project.current()) as RpcInit['project'],
    workspace: ctx.workspace.current(),
    settings: cloneable(ctx.settings.getAll()) as Record<string, JsonValue>,
    theme: cloneable(ctx.ui.theme()) as RpcInit['theme'],
    overlay: { anyOpen: ctx.overlay.isAnyOpen() },
    bust: f.o.bust,
    tile: f.o.tile ? (cloneable(f.o.tile()) as RpcTileInit) : undefined,
  }
  post(f, init)
  const push = (m: Omit<Ctx, 'qf' | 'kind'>) => post(f, { qf: RPC_PROTOCOL, kind: 'ctx', ...(cloneable(m) as object) })
  let anyOpen = init.overlay.anyOpen
  f.pushes.push(
    ctx.project.onDidChange((p) => push({ project: p as Ctx['project'] })),
    ctx.workspace.onDidChange((w) => push({ workspace: w })),
    ctx.settings.onDidChange(() => push({ settings: ctx.settings.getAll() })),
    ctx.ui.onThemeChange((t) => push({ theme: t })),
    ctx.overlay.onChange((s) => {
      if (s.anyOpen === anyOpen) return
      anyOpen = s.anyOpen
      push({ overlay: { anyOpen } })
    }),
  )
}

function teardown(f: Frame) {
  if (f.dead) return
  f.dead = true
  frames.delete(f)
  f.pushes.forEach((d) => d())
  f.subs.forEach((d) => {
    try {
      d()
    } catch {
      /* already gone */
    }
  })
  f.subs.clear()
  f.spawns.forEach((kill) => void kill().catch(() => {}))
  f.spawns.clear()
  f.calls.forEach((c) => {
    if (c.timer) clearTimeout(c.timer)
    c.reject(new HostError('unsupported', `the frame of ${f.o.info.id} is gone`))
  })
  f.calls.clear()
  for (const key of f.overlays) {
    try {
      f.o.ctx.overlay.register(key, false)
    } catch {
      /* ignore */
    }
  }
  if (f.overlays.size > 0) f.o.onOverlay?.(false)
  f.overlays.clear()
}

function fail(f: Frame, reason: string) {
  console.error(`[sandbox:${f.o.info.id}] ${reason}`)
  const onStatus = f.o.onStatus
  teardown(f)
  onStatus?.('error', reason)
}

/** Register a frame before (or right after) its `src` is set. */
export function registerFrame(o: FrameOptions): FrameHandle {
  ensureListener()
  const f: Frame = {
    id: nextFrameId++,
    o,
    initialized: false,
    dead: false,
    inFlight: 0,
    subs: new Map(),
    spawns: new Map(),
    calls: new Map(),
    overlays: new Set(),
    pushes: [],
  }
  frames.add(f)
  return {
    id: f.id,
    update: (m) => {
      if (f.initialized) post(f, { qf: RPC_PROTOCOL, kind: 'ctx', ...m })
    },
    call: (fn, args, timeoutMs) => callFrame(f, fn, args, undefined, timeoutMs),
    dispose: () => teardown(f),
  }
}

/** Live frames (diagnostics / tests). */
export function sandboxFrameCount(pluginId?: string): number {
  let n = 0
  frames.forEach((f) => {
    if (!pluginId || f.o.info.id === pluginId) n++
  })
  return n
}
