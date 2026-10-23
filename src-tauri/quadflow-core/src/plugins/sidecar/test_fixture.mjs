// Test sidecar for plugins/sidecar/tests.rs, built on the Node helper.
// FIXTURE_MODE: "normal" (default) | "exit-after-init" | "spawn-child"
import { spawn } from 'node:child_process'
import { createServer } from '../../../../../packages/sidecar-sdk-node/index.mjs'

const mode = process.env.FIXTURE_MODE ?? 'normal'

const server = createServer()
  .onInitialize((init, host) => {
    if (mode === 'exit-after-init') setTimeout(() => process.exit(7), 50)
    host.log('info', `initialized as ${init.plugin?.id}`)
    return { capabilities: {} }
  })
  .onRequest('ping', (p) => ({ pong: p, pid: process.pid, env: process.env.QUADFLOW_PLUGIN_ID ?? null }))
  .onRequest('init', (_p, host) => host.init)
  .onRequest('hostCall', async (p, host) => {
    try {
      return { ok: await host.call(p.method, p.params ?? {}) }
    } catch (e) {
      return { error: e.kind ?? 'unknown', message: e.message, data: e.data ?? null }
    }
  })
  .onRequest('emit', (p, host) => {
    host.emit('tick', p)
    host.ui('hello', p)
    return null
  })
  .onRequest('slow', () => new Promise((r) => setTimeout(() => r('late'), 5000)))
  .onRequest('crash', () => process.exit(3))
  .onRequest('stderr', () => {
    process.stderr.write('to stderr\n')
    return null
  })
  .onRequest('spawnChild', () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    return { child: c.pid }
  })

server.run()
