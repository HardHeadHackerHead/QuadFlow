// Sidecar of the `{{id}}` QuadFlow plugin: NDJSON JSON-RPC 2.0 over stdin/stdout
// (QuadFlow docs: docs/plugins/sidecars.md). Bundled with its dependencies to bin/sidecar.mjs
// by `npm run build`; QuadFlow runs it with the system `node` (permission sidecar:runtime:node).
// stdout is the protocol channel — log with console.error (captured into the plugin log) or host.log().
import { createServer, RpcError } from '@quadflow/sidecar-sdk-node'

let calls = 0

createServer()
  .onInitialize((init, host) => {
    host.log('info', `initialized; project = ${init.project?.root ?? 'none'}`)
    return { capabilities: {} }
  })
  .onRequest('greet', async ({ name = 'world' } = {}, host) => {
    if (!String(name).trim()) throw new RpcError(-32602, 'name must not be empty')
    calls += 1
    // Host API calls run with the plugin's permissions; storage needs none.
    await host.call('storage.set', { key: 'lastGreeted', value: name })
    return { message: `Hello, ${name}!`, pid: process.pid, calls }
  })
  .onNotification('settings/didChange', (p, host) => host.log('info', `settings changed: ${JSON.stringify(p)}`))
  .run()
