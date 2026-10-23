/**
 * The iframe-side `PluginContext` (plugin-system.md §8.4): the same API a
 * trusted plugin gets, implemented over postMessage RPC to the host bridge.
 *
 *  - privileged and UI methods become `req` / `sub` messages (see `./protocol`);
 *    the host runs them on the plugin's own host context, so permissions are
 *    checked in Rust exactly as for trusted plugins;
 *  - synchronous getters (`project.current()`, `settings.get()`, `ui.theme()`,
 *    `overlay.isAnyOpen()`, `api.has()`, `issues.displayRef()`) read state the
 *    host pushes in `init` and `ctx` messages;
 *  - trusted-only methods (`terminals.attach`, `native.*`) are unavailable:
 *    `api.has()` is false and they reject / throw `unsupported`.
 *
 * Used by the sandbox runtime's bootstrap (`packages/plugin-runtime/src/frame.tsx`).
 * Plugins never import this module; they receive the context.
 */
import { HostError, type Disposable, type JsonValue, type PluginContext, type ThemeSnapshot } from '@quadflow/plugin-api'
import {
  KILL_SPAWN,
  RPC_METHODS,
  RPC_PROTOCOL,
  STREAM_CALLBACK_INDEX,
  TRUSTED_ONLY_METHODS,
  isRpcMessage,
  type RpcError,
  type RpcInit,
  type RpcProject,
  type ToFrame,
  type ToHost,
  type UiOp,
} from './protocol'

export interface RpcEndpoint {
  post(msg: ToHost): void
  listen(cb: (msg: ToFrame) => void): void
}

/** The frame's parent window; only messages from it are accepted. */
export function windowEndpoint(target: Window = window.parent): RpcEndpoint {
  return {
    post: (msg) => target.postMessage(msg, '*'),
    listen: (cb) =>
      window.addEventListener('message', (e) => {
        if (e.source !== target || !isRpcMessage(e.data)) return
        cb(e.data as ToFrame)
      }),
  }
}

type CtxMessage = Extract<ToFrame, { kind: 'ctx' }>
type CallHandler = (args: unknown[], sub?: number) => unknown

export interface RpcFrame {
  init: RpcInit
  ctx: PluginContext
  /** Report that the frame finished loading (or failed). */
  status(state: 'ready' | 'error', error?: string): void
  /** Tile props callbacks (`setTitle`, `setState`, …). */
  ui(op: UiOp, value?: JsonValue): void
  /** Answer host `call`s for `fn` (`$command`, `$deactivate`). */
  onCall(fn: '$command' | '$deactivate', handler: CallHandler): void
  /** Every `ctx` message, after the context's caches were updated. */
  onCtx(cb: (m: CtxMessage) => void): Disposable
}

export function toRpcError(e: unknown): RpcError {
  if (e instanceof HostError) return { code: e.code, message: e.message, details: e.details }
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) }
}

function fromRpcError(e: RpcError | undefined): HostError {
  return new HostError(e?.code ?? 'internal', e?.message ?? 'unknown error', e?.details)
}

function unsupported(method: string): HostError {
  return new HostError('unsupported', `${method} is not available to sandboxed plugins`)
}

/** Set `obj[a][b]…[last] = value`, creating intermediate objects. */
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let o = obj
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>
  o[parts[parts.length - 1]] = value
}

/** Send `ready`, wait for the host's `init`, and build the frame's context. */
export function connectRpc(endpoint: RpcEndpoint): Promise<RpcFrame> {
  return new Promise((resolveInit) => {
    let nextId = 1
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; onEvent?(a: unknown[]): void }>()
    const subs = new Map<number, (...a: unknown[]) => unknown>()
    const callHandlers = new Map<string, CallHandler>()
    const ctxListeners = new Set<(m: CtxMessage) => void>()
    let init: RpcInit | null = null

    const post = (m: ToHost) => endpoint.post(m)

    const request = (method: string, args: unknown[], onEvent?: (a: unknown[]) => void) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject, onEvent })
        try {
          post({ qf: RPC_PROTOCOL, kind: 'req', id, method, params: args })
        } catch (e) {
          // DataCloneError (functions, DOM nodes in the arguments).
          pending.delete(id)
          reject(new HostError('invalid_input', `${method}: arguments cannot be sent to the host (${e instanceof Error ? e.message : String(e)})`))
        }
      })

    const fire = (method: string, args: unknown[]) => {
      try {
        post({ qf: RPC_PROTOCOL, kind: 'req', id: nextId++, method, params: args })
      } catch (e) {
        console.warn(`[plugin] ${method}:`, e)
      }
    }

    const subscribe = (topic: string, args: unknown[], cb: (...a: unknown[]) => unknown): Disposable => {
      const id = nextId++
      subs.set(id, cb)
      // The ack (`res`) only matters for errors: log them like the trusted host does.
      pending.set(id, {
        resolve: () => {},
        reject: (e) => {
          subs.delete(id)
          console.error(`[plugin] ${topic} failed:`, e)
        },
      })
      post({ qf: RPC_PROTOCOL, kind: 'sub', id, topic, params: args })
      return () => {
        if (!subs.delete(id)) return
        pending.delete(id)
        post({ qf: RPC_PROTOCOL, kind: 'unsub', id })
      }
    }

    endpoint.listen((m) => {
      switch (m.kind) {
        case 'init':
          if (init) return
          init = m
          resolveInit(build(m))
          return
        case 'res': {
          const p = pending.get(m.id)
          if (!p) return
          if (!subs.has(m.id)) pending.delete(m.id)
          if (m.error) p.reject(fromRpcError(m.error))
          else p.resolve(m.result)
          return
        }
        case 'evt': {
          const s = subs.get(m.id)
          if (s) s(...m.payload)
          else pending.get(m.id)?.onEvent?.(m.payload)
          return
        }
        case 'ctx':
          applyCtx(m)
          ctxListeners.forEach((cb) => cb(m))
          return
        case 'call': {
          const h = m.fn === '$handler' ? (args: unknown[]) => subs.get(m.sub ?? -1)?.(...args) : callHandlers.get(m.fn)
          const reply = (result?: unknown, error?: RpcError) => {
            try {
              post({ qf: RPC_PROTOCOL, kind: 'ret', id: m.id, result, error })
            } catch (e) {
              post({ qf: RPC_PROTOCOL, kind: 'ret', id: m.id, error: toRpcError(new HostError('internal', `result cannot be sent: ${String(e)}`)) })
            }
          }
          if (!h) return reply(undefined, { code: 'not_found', message: `no handler for ${m.fn}` })
          Promise.resolve()
            .then(() => h(m.args, m.sub))
            .then((r) => reply(r === undefined ? null : r), (e) => reply(undefined, toRpcError(e)))
          return
        }
      }
    })

    // ---- state pushed by the host ----
    let project: RpcProject | null = null
    let workspace: { id: string; name: string } | null = null
    let settings: Record<string, JsonValue> = {}
    let theme: ThemeSnapshot
    let anyOverlay = false
    const projectCbs = new Set<(p: unknown) => void>()
    const workspaceCbs = new Set<(w: unknown) => void>()
    const settingsCbs = new Set<(k: string, v: JsonValue) => void>()
    const themeCbs = new Set<(t: ThemeSnapshot) => void>()
    const overlayCbs = new Set<(s: { anyOpen: boolean; rects: [] }) => void>()

    function applyCtx(m: CtxMessage) {
      if ('project' in m && m.project !== undefined) {
        const changed = m.project?.id !== project?.id
        project = m.project
        if (changed) projectCbs.forEach((cb) => cb(project))
      }
      if ('workspace' in m && m.workspace !== undefined) {
        const changed = m.workspace?.id !== workspace?.id
        workspace = m.workspace
        if (changed) workspaceCbs.forEach((cb) => cb(workspace))
      }
      if (m.settings) {
        const prev = settings
        settings = m.settings
        for (const k of new Set([...Object.keys(prev), ...Object.keys(settings)])) {
          if (JSON.stringify(prev[k]) !== JSON.stringify(settings[k])) settingsCbs.forEach((cb) => cb(k, settings[k] ?? null))
        }
      }
      if (m.theme) {
        theme = m.theme
        themeCbs.forEach((cb) => cb(theme))
      }
      if (m.overlay && m.overlay.anyOpen !== anyOverlay) {
        anyOverlay = m.overlay.anyOpen
        overlayCbs.forEach((cb) => cb({ anyOpen: anyOverlay, rects: [] }))
      }
    }

    const local = <T>(set: Set<T>, cb: T): Disposable => {
      set.add(cb)
      return () => set.delete(cb)
    }

    function build(i: RpcInit): RpcFrame {
      project = i.project
      workspace = i.workspace
      settings = i.settings
      theme = i.theme
      anyOverlay = i.overlay.anyOpen
      const methods = new Set(i.api.methods)

      // Generic part: every RPC method by kind.
      const ctx: Record<string, unknown> = {}
      for (const [name, kind] of Object.entries(RPC_METHODS)) {
        if (kind === 'call') setPath(ctx, name, (...args: unknown[]) => request(name, args))
        else if (kind === 'fire') setPath(ctx, name, (...args: unknown[]) => void fire(name, args))
        else if (kind === 'sub') {
          setPath(ctx, name, (...args: unknown[]) => {
            const cb = args.pop() as (...a: unknown[]) => unknown
            if (typeof cb !== 'function') throw new HostError('invalid_input', `${name}: the last argument must be a callback`)
            return subscribe(name, args, cb)
          })
        } else {
          const at = STREAM_CALLBACK_INDEX[name]
          setPath(ctx, name, (...args: unknown[]) => {
            const cb = args[at] as (e: unknown) => void
            const sent = args.slice()
            sent[at] = null
            return request(name, sent, (payload) => cb?.(payload[0]))
          })
        }
      }
      for (const name of TRUSTED_ONLY_METHODS) {
        const sync = name === 'native.tileGeometry' || name === 'native.onTileGeometry' || name === 'terminals.attach'
        setPath(ctx, name, sync ? () => { throw unsupported(name) } : () => Promise.reject(unsupported(name)))
      }

      // Specials.
      setPath(ctx, 'plugin', Object.freeze({ ...i.plugin }))
      setPath(ctx, 'api', Object.freeze({ version: i.api.version, has: (m: string) => methods.has(m) }))
      // The host logger prints to the shell console and the app log (one line per call).
      const logTo = (level: 'debug' | 'info' | 'warn' | 'error') => (...a: unknown[]) => {
        const json = a.map((x) => {
          if (x instanceof Error) return `${x.name}: ${x.message}`
          try {
            return JSON.parse(JSON.stringify(x ?? null)) as JsonValue
          } catch {
            return String(x)
          }
        })
        fire(`log.${level}`, json)
      }
      setPath(ctx, 'log', { debug: logTo('debug'), info: logTo('info'), warn: logTo('warn'), error: logTo('error') })
      setPath(ctx, 'project.current', () => project)
      setPath(ctx, 'project.onDidChange', (cb: (p: unknown) => void) => local(projectCbs, cb))
      setPath(ctx, 'workspace.current', () => workspace)
      setPath(ctx, 'workspace.onDidChange', (cb: (w: unknown) => void) => local(workspaceCbs, cb))
      setPath(ctx, 'settings.get', (k: string) => settings[k])
      setPath(ctx, 'settings.getAll', () => ({ ...settings }))
      setPath(ctx, 'settings.onDidChange', (cb: (k: string, v: JsonValue) => void) => local(settingsCbs, cb))
      setPath(ctx, 'ui.theme', () => theme)
      setPath(ctx, 'ui.onThemeChange', (cb: (t: ThemeSnapshot) => void) => local(themeCbs, cb))
      setPath(ctx, 'overlay.isAnyOpen', () => anyOverlay)
      setPath(ctx, 'overlay.onChange', (cb: (s: { anyOpen: boolean; rects: [] }) => void) => {
        cb({ anyOpen: anyOverlay, rects: [] })
        return local(overlayCbs, cb)
      })
      setPath(ctx, 'overlay.register', (id: string, open: boolean) => fire('overlay.register', [id, open]))
      setPath(ctx, 'data.issues.displayRef', (issue: { number: number }, o?: { projectRoot?: string }) => {
        const code = !o?.projectRoot || o.projectRoot === project?.root ? (project?.config as { code?: string } | null)?.code : undefined
        return code ? `${code}-${issue.number}` : `#${issue.number}`
      })
      setPath(ctx, 'data.watchProject', (root: string) => {
        fire('data.watchProject', [root])
        return () => {}
      })
      setPath(ctx, 'commands.register', (cmdId: string, handler: (args?: JsonValue) => unknown) => {
        if (!i.commands.includes(cmdId)) {
          throw new HostError('invalid_input', `command ${JSON.stringify(cmdId)} is not declared in contributes.commands`)
        }
        return subscribe('commands.register', [cmdId], (args) => handler(args as JsonValue))
      })
      setPath(ctx, 'http.fetch', async (url: string, init?: unknown) => {
        const r = (await request('http.fetch', [url, init])) as { status: number; headers: Record<string, string>; body: Uint8Array }
        const text = () => new TextDecoder().decode(r.body)
        return { status: r.status, headers: r.headers, body: r.body, text, json: <T,>() => JSON.parse(text()) as T }
      })
      setPath(ctx, 'shell.spawn', (options: unknown, onEvent: (e: unknown) => void) =>
        new Promise((resolve, reject) => {
          const id = nextId
          let started = false
          // The spawn request stays open (events arrive with its id); the host
          // acknowledges the start with an early `evt` of `{ $started: true }`.
          request('shell.spawn', [options, null], (payload) => {
            const e = payload[0] as { $started?: boolean }
            if (e && e.$started) {
              started = true
              resolve({ kill: async () => void (await request(KILL_SPAWN, [id])) })
            } else onEvent?.(e)
          }).then(
            () => {},
            (e) => {
              if (!started) reject(e)
            },
          )
        }),
      )

      const frame: RpcFrame = {
        init: i,
        ctx: ctx as unknown as PluginContext,
        status: (state, error) => post({ qf: RPC_PROTOCOL, kind: 'status', state, error }),
        ui: (op, value) => post({ qf: RPC_PROTOCOL, kind: 'ui', op, value }),
        onCall: (fn, handler) => void callHandlers.set(fn, handler),
        onCtx: (cb) => local(ctxListeners, cb),
      }
      return frame
    }

    post({ qf: RPC_PROTOCOL, kind: 'ready' })
  })
}
