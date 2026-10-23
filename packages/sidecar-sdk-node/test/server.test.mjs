import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { createServer, RpcError } from '../index.mjs'

function harness(build) {
  const input = new PassThrough()
  const output = new PassThrough()
  const server = build(createServer({ input, output }))
  const done = server.run({ exit: false })
  const lines = createInterface({ input: output })
  const queue = []
  const waiters = []
  lines.on('line', (l) => {
    const m = JSON.parse(l)
    const w = waiters.shift()
    if (w) w(m)
    else queue.push(m)
  })
  const recv = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)))
  const send = (m) => input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
  return { send, recv, done, end: () => input.end() }
}

test('handshake, requests, host calls, errors, exit', async () => {
  const h = harness((s) =>
    s
      .onRequest('ping', (p) => ({ pong: p }))
      .onRequest('count', (_p, host) => host.call('storage.get', { key: 'n' }))
      .onRequest('denied', async (_p, host) => {
        try {
          await host.call('secrets.get', { name: 'x' })
          return 'allowed'
        } catch (e) {
          assert.ok(e instanceof RpcError)
          return e.kind
        }
      })
      .onRequest('boom', () => {
        throw new Error('nope')
      }),
  )
  h.send({ id: 1, method: 'initialize', params: { plugin: { id: 'p' } } })
  assert.deepEqual(await h.recv(), { jsonrpc: '2.0', id: 1, result: { capabilities: {} } })
  h.send({ method: 'initialized', params: {} })

  h.send({ id: 2, method: 'ping', params: { a: 1 } })
  assert.deepEqual((await h.recv()).result, { pong: { a: 1 } })

  h.send({ id: 3, method: 'count' })
  const call = await h.recv()
  assert.equal(call.method, 'host/call')
  assert.deepEqual(call.params, { method: 'storage.get', params: { key: 'n' } })
  h.send({ id: call.id, result: 5 })
  assert.deepEqual(await h.recv(), { jsonrpc: '2.0', id: 3, result: 5 })

  h.send({ id: 4, method: 'denied' })
  const c2 = await h.recv()
  h.send({ id: c2.id, error: { code: -32000, message: 'denied', data: { code: 'permission_denied', details: { permission: 'secrets' } } } })
  assert.equal((await h.recv()).result, 'permission_denied')

  h.send({ id: 5, method: 'boom' })
  assert.equal((await h.recv()).error.message, 'nope')
  h.send({ id: 6, method: 'missing' })
  assert.equal((await h.recv()).error.code, -32601)

  h.send({ id: 7, method: 'shutdown' })
  assert.deepEqual(await h.recv(), { jsonrpc: '2.0', id: 7, result: null })
  h.send({ method: 'exit' })
  await h.done
})
