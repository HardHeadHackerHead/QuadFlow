// Sidecar of the `{{id}}` agent provider: serves the hooks listed in the manifest's
// `agentProvider.hooks` as `agentProvider/<hook>` requests (QuadFlow docs:
// docs/plugins/agent-providers.md). Bundled to bin/sidecar.mjs by `npm run build`.
// stdout is the protocol channel — log with console.error or host.log().
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from '@quadflow/sidecar-sdk-node'

const run = promisify(execFile)

createServer()
  .onInitialize(() => ({ capabilities: { agentProvider: true } }))
  // Account usage / rate-limit windows (Usage Monitor). Return null when there is no data.
  .onRequest('agentProvider/usage', async (_params, host) => {
    try {
      // A real provider asks its CLI (or reads its files). Replace with e.g.
      //   const { stdout } = await run('{{agentCommand}}', ['usage', '--json'])
      // (shell on Windows so npm-installed `.cmd` shims resolve; the arguments are constants)
      await run('{{agentCommand}}', ['--version'], { timeout: 5000, windowsHide: true, shell: process.platform === 'win32' })
    } catch (e) {
      host.log('info', `{{agentCommand}} not available: ${e.message}`)
      return null
    }
    return {
      providerId: '{{providerId}}',
      fetchedAt: Date.now(),
      windows: [{ id: 'session', label: 'Current session', usedPercent: 0 }],
    }
  })
  .run()
