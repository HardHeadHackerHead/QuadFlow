// `quadflow {{cliName}} …` — served by this sidecar (QuadFlow docs: docs/plugins/cli-commands.md).
//
// The quadflow CLI starts a private instance of the sidecar (env QUADFLOW_SIDECAR_MODE=cli),
// sends `cli/run { argv, cwd, json, projectRoot }`, prints our `cli/output` notifications and
// exits with the `exitCode` we return. Host API calls (`host.call`) use the plugin's permissions.
// Bundled with its dependencies to bin/sidecar.mjs by `npm run build`.
import { createServer } from '@quadflow/sidecar-sdk-node'

const HELP = `usage: quadflow {{cliName}} <command> [--json]

commands:
  hello [name]   greet someone (remembers the last name in plugin storage)
  last           print the last greeted name
  help           this text`

createServer()
  .onInitialize(() => ({ capabilities: { cli: true } }))
  .onRequest('cli/run', async ({ argv = [], json = false, projectRoot = null } = {}, host) => {
    const out = (text) => host.notify('cli/output', { stream: 'stdout', text: text.endsWith('\n') ? text : `${text}\n` })
    const err = (text) => host.notify('cli/output', { stream: 'stderr', text: text.endsWith('\n') ? text : `${text}\n` })
    const [cmd = 'help', ...rest] = argv

    switch (cmd) {
      case 'hello': {
        const name = rest.join(' ') || 'world'
        await host.call('storage.set', { key: 'lastGreeted', value: name })
        if (json) out(JSON.stringify({ ok: true, data: { message: `Hello, ${name}!`, projectRoot } }))
        else out(`Hello, ${name}!`)
        return { exitCode: 0 }
      }
      case 'last': {
        const last = (await host.call('storage.get', { key: 'lastGreeted' })) ?? null
        out(json ? JSON.stringify({ ok: true, data: { last } }) : String(last ?? '(nobody yet)'))
        return { exitCode: 0 }
      }
      case 'help':
      case '--help':
      case '-h':
        out(HELP)
        return { exitCode: 0 }
      default:
        err(`unknown command ${JSON.stringify(cmd)}\n\n${HELP}`)
        return { exitCode: 2 }
    }
  })
  .run()
