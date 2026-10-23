// QuadFlow sidecar helper for Node.js (plugin-system.md §10). Single file, no
// dependencies: copy it next to your sidecar or import `@quadflow/sidecar-sdk-node`.
//
//   import { createServer } from '@quadflow/sidecar-sdk-node'
//   createServer()
//     .onRequest('ping', (params) => ({ pong: params }))
//     .onRequest('count', async (_p, host) => host.call('storage.get', { key: 'count' }))
//     .run()
//
// Protocol: JSON-RPC 2.0, one JSON object per line on stdin/stdout. Never write
// anything else to stdout — use `host.log()` or stderr (captured into the plugin log).

import { createInterface } from 'node:readline'

/** A JSON-RPC error. `kind` is the QuadFlow error code (`permission_denied`, …) when the host sent one. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
    this.kind = data && typeof data === 'object' && typeof data.code === 'string' ? data.code : undefined
  }
}

const HOST_ERROR = -32000
const METHOD_NOT_FOUND = -32601

export function createServer({ input = process.stdin, output = process.stdout } = {}) {
  const requests = new Map()
  const notifications = new Map()
  const pending = new Map()
  let nextId = 1
  let initParams = null
  let onInit = null
  let onShutdown = null
  let finish

  const write = (msg) => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  const host = {
    /** Raw request to the host. */
    request(method, params = {}, { timeoutMs = 30000 } = {}) {
      const id = `n${nextId++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new RpcError(HOST_ERROR, `host request ${method} timed out`, { code: 'external' }))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        write({ id, method, params })
      })
    },
    /** `host/call`: any host API method, checked against the plugin's permissions. */
    call(method, params = {}, opts) {
      return host.request('host/call', { method, params }, opts)
    },
    notify(method, params = {}) {
      write({ method, params })
    },
    /** `ctx.events.onPlugin('<pluginId>', topic, …)` in the plugin's UI (and other plugins) receives it. */
    emit(topic, payload = null) {
      host.notify('host/emit', { topic, payload })
    },
    /** `ctx.sidecar.onNotification(name, …)` in the plugin's UI receives it. */
    ui(name, params = null) {
      host.notify(`ui/${name}`, params)
    },
    log(level, message) {
      host.notify('host/log', { level, message: String(message) })
    },
    /** `initialize` params (host, plugin, project, settings, locale); null before the handshake. */
    get init() {
      return initParams
    },
  }

  const respond = async (id, fn, params) => {
    try {
      const result = await fn(params ?? {}, host)
      write({ id, result: result === undefined ? null : result })
    } catch (e) {
      const err =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: HOST_ERROR, message: e instanceof Error ? e.message : String(e), data: { code: 'internal' } }
      write({ id, error: err })
    }
  }

  const handle = (msg) => {
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      if (msg.method === 'initialize') {
        initParams = msg.params ?? {}
        return respond(msg.id, async () => (onInit ? await onInit(initParams, host) : null) ?? { capabilities: {} })
      }
      if (msg.method === 'shutdown') return respond(msg.id, async () => (onShutdown ? onShutdown(host) : null))
      const fn = requests.get(msg.method)
      if (!fn) return write({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: `unknown method ${msg.method}` } })
      return respond(msg.id, fn, msg.params)
    }
    if (msg.method !== undefined) {
      if (msg.method === 'exit') return finish()
      const fn = notifications.get(msg.method)
      if (fn) Promise.resolve().then(() => fn(msg.params ?? {}, host)).catch((e) => host.log('error', e?.stack ?? e))
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data))
    else p.resolve(msg.result ?? null)
  }

  const server = {
    host,
    onRequest(method, fn) {
      requests.set(method, fn)
      return server
    },
    onNotification(method, fn) {
      notifications.set(method, fn)
      return server
    },
    /** Return value becomes the `initialize` result (`{ capabilities }`). */
    onInitialize(fn) {
      onInit = fn
      return server
    },
    onShutdown(fn) {
      onShutdown = fn
      return server
    },
    /** Serve until `exit` or stdin closes; then exits the process (unless `{ exit: false }`). */
    run({ exit = true } = {}) {
      const done = new Promise((resolve) => (finish = resolve))
      const rl = createInterface({ input, crlfDelay: Infinity })
      rl.on('line', (line) => {
        if (!line.trim()) return
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          process.stderr.write(`sidecar: ignoring non-JSON line from host\n`)
          return
        }
        handle(msg)
      })
      rl.on('close', () => finish())
      return done.then(() => {
        rl.close()
        for (const p of pending.values()) clearTimeout(p.timer)
        if (exit) process.exit(0)
      })
    },
  }
  return server
}
