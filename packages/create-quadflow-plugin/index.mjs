#!/usr/bin/env node
/**
 * create-quadflow-plugin — scaffold a QuadFlow plugin (plugin-system.md §15.3).
 *
 *   npm create quadflow-plugin@latest [dir] -- [--template <name>] [--id publisher.name] [--name "Display name"]
 *   node packages/create-quadflow-plugin/index.mjs <dir> --template tile --id acme.hello
 *
 * Templates: tile, tile-sidecar-rust, tile-sidecar-node, cli-command, agent-provider.
 *
 * Dependencies: run from a QuadFlow checkout (or with --local <checkout>), the generated
 * package.json points at the checkout's packages with `file:` specs and the Rust sidecar at its
 * `packages/sidecar-sdk-rust` — nothing needs to be published. `--registry` writes version ranges
 * instead (for when the packages are published).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
const TEMPLATES_DIR = join(HERE, 'templates')

export const TEMPLATES = {
  tile: {
    summary: 'A React tile with settings and a command (runs sandboxed; no permissions)',
    parts: ['common', 'ui', 'tile'],
    ui: true,
  },
  'tile-sidecar-rust': {
    summary: 'A tile that talks to a Rust sidecar process (quadflow-sidecar crate)',
    parts: ['common', 'ui', 'tile-sidecar', 'sidecar-rust'],
    ui: true,
    sidecar: 'rust',
  },
  'tile-sidecar-node': {
    summary: 'A tile that talks to a Node.js sidecar process (@quadflow/sidecar-sdk-node)',
    parts: ['common', 'ui', 'tile-sidecar', 'sidecar-node'],
    ui: true,
    sidecar: 'node',
  },
  'cli-command': {
    summary: 'A `quadflow <command>` CLI subcommand served by a Node sidecar, plus an agent context doc',
    parts: ['common', 'cli-command'],
    sidecar: 'node',
    cli: true,
  },
  'agent-provider': {
    summary: 'An agent provider (a coding-agent CLI in the launch toolbar) with a usage hook served by a Node sidecar',
    parts: ['common', 'ui', 'agent-provider'],
    ui: true,
    sidecar: 'node',
    provider: true,
  },
}

const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*$/
// = quadflow_core::plugins::RESERVED_CLI_NAMES (core commands a plugin may not take).
const RESERVED_CLI = new Set([
  'gui', 'init', 'doctor', 'docs', 'context', 'plugins', 'ideas', 'issues', 'labels', 'epics', 'plans',
  'discovery', 'scripts', 'ship', 'chat', 'missions', 'help', 'version',
])

const USAGE = `usage: create-quadflow-plugin [dir] [options]
  --template <name>   ${Object.keys(TEMPLATES).join(' | ')} (default: tile)
  --id <id>           publisher.name, e.g. acme.word-count (default: example.<dir name>)
  --name <name>       display name (default: from the id)
  --description <t>   one-line description
  --author <name>     author name (default: git user.name)
  --cli-name <name>   cli-command: the subcommand (default: the id's name part)
  --agent-command <c> agent-provider: the agent CLI program (default: the id's name part)
  --local <checkout>  link packages from this QuadFlow checkout (default: the checkout this script is in)
  --registry          use published package versions instead of a checkout
  --no-install        do not run npm install
  --force             write into a non-empty directory
  -y, --yes           no questions; defaults for everything not given

templates:
${Object.entries(TEMPLATES).map(([k, t]) => `  ${k.padEnd(18)} ${t.summary}`).join('\n')}`

function parseArgs(argv) {
  const o = { positional: [], install: true, yes: false, force: false, registry: false }
  const value = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const take = () => (inline !== undefined ? inline : value(i++, flag))
    switch (flag) {
      case '--template': case '-t': o.template = take(); break
      case '--id': o.id = take(); break
      case '--name': o.name = take(); break
      case '--description': o.description = take(); break
      case '--author': o.author = take(); break
      case '--cli-name': o.cliName = take(); break
      case '--agent-command': o.agentCommand = take(); break
      case '--local': o.local = take(); break
      case '--registry': o.registry = true; break
      case '--no-install': o.install = false; break
      case '--force': o.force = true; break
      case '-y': case '--yes': o.yes = true; break
      case '-h': case '--help': o.help = true; break
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${USAGE}`)
        o.positional.push(a)
    }
  }
  return o
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '') || 'plugin'
const titleCase = (s) => s.split(/[-.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
const pascal = (s) => titleCase(s).replace(/ /g, '')
const toPosix = (p) => p.replaceAll('\\', '/')

/** The QuadFlow checkout this script lives in (or `--local`), if any. */
export function findCheckout(from) {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'packages', 'plugin-api', 'package.json')) && existsSync(join(dir, 'packages', 'plugin-build', 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function gitUserName() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** npm dependency specs: `file:` links into a checkout, or published ranges. */
function dependencySpecs(checkout) {
  const pkgVersion = (rel) => JSON.parse(readFileSync(join(checkout, rel, 'package.json'), 'utf8')).version
  if (checkout) {
    const root = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
    const dev = { ...root.dependencies, ...root.devDependencies }
    // Same versions as the checkout, so the types the linked packages see are the plugin's too.
    const installed = (name) => {
      try {
        return JSON.parse(readFileSync(join(checkout, 'node_modules', name, 'package.json'), 'utf8')).version
      } catch {
        return dev[name]
      }
    }
    const link = (rel) => `file:${toPosix(join(checkout, rel))}`
    return {
      '@quadflow/plugin-api': link('packages/plugin-api'),
      '@quadflow/plugin-build': link('packages/plugin-build'),
      '@quadflow/ui': link('packages/ui'),
      '@quadflow/sidecar-sdk-node': link('packages/sidecar-sdk-node'),
      typescript: installed('typescript') ?? '~5.7.3',
      '@types/react': installed('@types/react') ?? '^18.3.18',
      rustSdk: `quadflow-sidecar = { path = ${JSON.stringify(toPosix(join(checkout, 'packages', 'sidecar-sdk-rust')))} }`,
      apiVersion: `^${pkgVersion('packages/plugin-api').split('.')[0]}.0.0`,
    }
  }
  return {
    '@quadflow/plugin-api': '^1.0.0',
    '@quadflow/plugin-build': '^1.0.0',
    '@quadflow/ui': '^0.1.0',
    '@quadflow/sidecar-sdk-node': '^1.0.0',
    typescript: '~5.7.3',
    '@types/react': '^18.3.18',
    rustSdk: 'quadflow-sidecar = "1"',
    apiVersion: '^1.0.0',
  }
}

function manifestFor(t, v) {
  const m = {
    $schema: v.schemaRef,
    id: v.id,
    name: v.name,
    version: '0.1.0',
    description: v.description,
    author: { name: v.author },
    license: 'MIT',
    icon: 'assets/icon.svg',
    category: t.provider ? 'ai-agents' : t.cli ? 'development' : 'other',
    apiVersion: v.apiVersion,
    platforms: ['windows', 'macos', 'linux'],
  }
  if (t.ui) m.ui = t.provider ? { entry: 'dist/index.js' } : { entry: 'dist/index.js', style: 'dist/index.css' }
  const contributes = {}
  if (t.parts.includes('tile') || t.parts.includes('tile-sidecar')) {
    m.activation = ['onTile', 'onCommand']
    contributes.tiles = [
      {
        id: 'main',
        title: v.name,
        description: t.sidecar ? `${v.name} (talks to its ${t.sidecar === 'rust' ? 'Rust' : 'Node'} sidecar)` : `${v.name} tile`,
        icon: 'assets/icon.svg',
        modes: ['pane', 'flyout'],
        flyout: { defaultSize: [420, 480] },
        // Auto-created tool config: listed in the Tools menu and pinned to the toolbar.
        defaultToolConfig: { pinned: true },
      },
    ]
    contributes.commands = [{ id: 'hello', title: `${v.name}: Say hello`, category: v.name }]
    contributes.settings = {
      type: 'object',
      properties: { greeting: { type: 'string', title: 'Greeting', default: 'Hello' } },
      additionalProperties: false,
    }
  }
  if (t.cli) {
    m.activation = ['onCli']
    contributes.cliCommands = [{ name: v.cliName, summary: `${v.name}: example command (try \`quadflow ${v.cliName} --help\`)`, docs: 'docs/cli.md', handler: { type: 'sidecar' } }]
    contributes.agentContextDocs = [{ id: v.slug, title: v.name, file: 'docs/agent.md' }]
  }
  if (t.provider) {
    m.activation = ['onAgentProvider']
    contributes.agentProvider = {
      id: v.providerId,
      displayName: v.name,
      shortName: v.name.slice(0, 12).trim(),
      icon: 'assets/icon.svg',
      color: '#7c5cff',
      installHint: { default: `Install the ${v.agentCommand} CLI and make sure it is on PATH` },
      detect: { command: v.agentCommand, versionArgs: ['--version'], versionRegex: '(\\d+\\.\\d+\\.\\d+)' },
      launch: {
        args: [],
        model: ['--model', '{model}'],
        approvalModes: { default: [] },
        exitCommand: '/exit',
      },
      models: { allowCustom: true },
      sessions: { strategy: 'none' },
      contextFile: 'AGENTS.md',
      hooks: ['usage'],
    }
  }
  if (Object.keys(contributes).length) m.contributes = contributes
  const permissions = []
  if (t.sidecar === 'node') permissions.push('sidecar:runtime:node')
  if (permissions.length) m.permissions = permissions
  if (t.sidecar === 'rust') {
    const exe = (os) => `bin/${v.crate}${os === 'windows' ? '.exe' : ''}`
    m.sidecar = {
      binaries: Object.fromEntries(
        ['windows', 'macos', 'linux'].flatMap((os) => ['x86_64', 'aarch64'].map((arch) => [`${os}-${arch}`, exe(os)])),
      ),
      activation: 'onDemand',
      restart: 'onCrash',
    }
  } else if (t.sidecar === 'node') {
    m.sidecar = { runtime: 'node', entry: 'bin/sidecar.mjs', activation: 'onDemand', restart: 'onCrash' }
  }
  return m
}

function packageJsonFor(t, v, deps) {
  const scripts = t.ui
    ? {
        build: 'tsc --noEmit && quadflow-plugin build',
        dev: 'quadflow-plugin dev',
        typecheck: 'tsc --noEmit',
        validate: 'quadflow-plugin validate',
        pack: 'quadflow-plugin pack',
      }
    : { build: 'quadflow-plugin build', dev: 'quadflow-plugin dev', validate: 'quadflow-plugin validate', pack: 'quadflow-plugin pack' }
  const devDependencies = { '@quadflow/plugin-build': deps['@quadflow/plugin-build'] }
  if (t.ui) {
    devDependencies['@quadflow/plugin-api'] = deps['@quadflow/plugin-api']
    devDependencies['@types/react'] = deps['@types/react']
    devDependencies.typescript = deps.typescript
    if (!t.provider) devDependencies['@quadflow/ui'] = deps['@quadflow/ui']
  }
  if (t.sidecar === 'node') devDependencies['@quadflow/sidecar-sdk-node'] = deps['@quadflow/sidecar-sdk-node']
  return {
    name: v.pkgName,
    version: '0.1.0',
    private: true,
    description: v.description,
    license: 'MIT',
    type: 'module',
    scripts,
    devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

function substitute(text, v) {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in v ? String(v[k]) : m))
}

function copyPart(part, dest, v, written) {
  const src = join(TEMPLATES_DIR, part)
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name)
      if (d.isDirectory()) walk(p)
      else {
        const rel = relative(src, p)
        const outRel = rel
          .split(/[\\/]/)
          .map((s) => (s === '_gitignore' ? '.gitignore' : s))
          .join('/')
        const out = join(dest, outRel)
        mkdirSync(dirname(out), { recursive: true })
        const buf = readFileSync(p)
        const isText = !buf.includes(0)
        writeFileSync(out, isText ? substitute(buf.toString('utf8'), v) : buf)
        written.add(toPosix(outRel))
      }
    }
  }
  walk(src)
}

async function ask(rl, question, def) {
  const a = (await rl.question(`${question}${def ? ` (${def})` : ''}: `)).trim()
  return a || def
}

export async function create(argv, { log = console.log, interactive = process.stdin.isTTY && process.stdout.isTTY } = {}) {
  const o = parseArgs(argv)
  if (o.help) {
    log(USAGE)
    return null
  }
  const prompt = interactive && !o.yes
  const rl = prompt ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    let dirArg = o.positional[0]
    if (!dirArg && rl) dirArg = await ask(rl, 'Directory', 'my-quadflow-plugin')
    if (!dirArg) dirArg = 'my-quadflow-plugin'
    const dest = resolve(dirArg)

    let template = o.template
    if (!template && rl) {
      log('Templates:')
      Object.entries(TEMPLATES).forEach(([k, t], i) => log(`  ${i + 1}. ${k.padEnd(18)} ${t.summary}`))
      const a = await ask(rl, 'Template (number or name)', 'tile')
      template = /^\d+$/.test(a) ? Object.keys(TEMPLATES)[Number(a) - 1] : a
    }
    template ??= 'tile'
    const t = TEMPLATES[template]
    if (!t) throw new Error(`unknown template ${JSON.stringify(template)} (${Object.keys(TEMPLATES).join(', ')})`)

    const defaultId = `example.${slugify(basename(dest))}`
    let id = o.id ?? (rl ? await ask(rl, 'Plugin id (publisher.name)', defaultId) : defaultId)
    if (!ID_RE.test(id)) {
      throw new Error(`plugin id ${JSON.stringify(id)} must look like publisher.name (lowercase, digits, dashes; bare ids are reserved for official plugins)`)
    }
    const slug = id.split('.')[1]
    const name = o.name ?? (rl ? await ask(rl, 'Display name', titleCase(slug)) : titleCase(slug))
    const description = o.description ?? `${name}: a QuadFlow plugin.`
    const author = o.author ?? gitUserName() ?? 'Your Name'

    const cliName = o.cliName ?? slug.slice(0, 32)
    if (t.cli && (!/^[a-z][a-z0-9-]{1,31}$/.test(cliName) || RESERVED_CLI.has(cliName))) {
      throw new Error(`--cli-name ${JSON.stringify(cliName)} is not allowed (pattern ^[a-z][a-z0-9-]{1,31}$, not a core command)`)
    }
    const agentCommand = o.agentCommand ?? slug
    if (t.provider && !/^[A-Za-z0-9._-]+$/.test(agentCommand)) throw new Error(`--agent-command ${JSON.stringify(agentCommand)} must be a bare program name`)

    if (existsSync(dest) && readdirSync(dest).length && !o.force) {
      throw new Error(`${dest} is not empty (use --force to write into it)`)
    }

    const checkout = o.registry ? null : o.local ? resolve(o.local) : findCheckout(HERE)
    if (o.local && !findCheckout(checkout)) throw new Error(`--local ${o.local} is not a QuadFlow checkout`)
    const deps = dependencySpecs(checkout)
    const insideCheckout = checkout && !relative(checkout, dest).startsWith('..') && !/^[a-z]:/i.test(relative(checkout, dest))

    const v = {
      id,
      slug,
      name,
      description,
      author,
      cliName,
      agentCommand,
      providerId: slug.slice(0, 32).replace(/^[^a-z]+/, '') || 'agent',
      pascal: pascal(slug),
      cls: `qfp-${slug}`,
      crate: `${slug}-sidecar`,
      pkgName: `${id.split('.')[0]}-${slug}`.replace(/[^a-z0-9-]/g, '-'),
      year: new Date().getFullYear(),
      apiVersion: deps.apiVersion,
      rustSdk: deps.rustSdk,
      // A crate inside the QuadFlow checkout joins its Cargo workspace (`plugins/*/sidecar`);
      // anywhere else it is its own workspace root.
      workspaceTable: insideCheckout ? '' : '\n# Standalone crate (not part of a surrounding Cargo workspace).\n[workspace]\n',
      schemaRef: './node_modules/@quadflow/plugin-api/schema/quadflow-plugin.schema.json',
      templateName: template,
    }
    v.readmeNotes = readmeNotes(t, v)

    mkdirSync(dest, { recursive: true })
    const written = new Set()
    for (const part of t.parts) copyPart(part, dest, v, written)
    writeFileSync(join(dest, 'quadflow-plugin.json'), JSON.stringify(manifestFor(t, v), null, 2) + '\n')
    writeFileSync(join(dest, 'package.json'), JSON.stringify(packageJsonFor(t, v, deps), null, 2) + '\n')
    written.add('quadflow-plugin.json').add('package.json')

    log(`\nCreated ${id} (${template}) in ${dest}`)
    log(checkout ? `  linked to the QuadFlow checkout at ${checkout}` : '  using published @quadflow/* packages')
    if (o.install) {
      log('\nInstalling dependencies (npm install)…')
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: dest, stdio: 'inherit', shell: process.platform === 'win32' })
      if (r.status !== 0) throw new Error('npm install failed (re-run it in the plugin directory)')
    }
    const rel = relative(process.cwd(), dest)
    const cd = !rel ? '.' : rel.startsWith('..') ? dest : rel
    log(`\nNext steps:
  cd ${cd.includes(' ') ? JSON.stringify(cd) : cd}${o.install ? '' : '\n  npm install'}
  npm run build          # ${[t.ui && 'UI module', t.sidecar && `${t.sidecar} sidecar`].filter(Boolean).join(' + ')}
  npm run dev            # rebuild on every change
Then in QuadFlow: Settings → Plugins → "Load unpacked…" → pick this folder. Edits hot-reload.
Docs: docs/plugins/getting-started.md in the QuadFlow repository.`)
    return { dest, id, template, files: [...written].sort() }
  } finally {
    rl?.close()
  }
}

function readmeNotes(t, v) {
  const notes = []
  if (t.ui && !t.provider) {
    notes.push(`- \`src/index.tsx\` — the plugin module: \`definePlugin({ tiles, commands, activate })\`. The tile keeps its
  counter in \`instance.state\` via \`setState()\`, so it survives hot reloads and app restarts.`)
  }
  if (t.sidecar === 'rust') {
    notes.push(`- \`sidecar/\` — the Rust sidecar crate (\`${v.crate}\`, built with \`cargo build --release\` by
  \`npm run build\` and copied to \`bin/\`). It answers \`greet\` requests from the tile
  (\`ctx.sidecar.request('greet', …)\`). Rebuilding it while QuadFlow runs restarts the process.`)
  }
  if (t.sidecar === 'node' && !t.cli && !t.provider) {
    notes.push(`- \`sidecar/index.mjs\` — the Node.js sidecar, bundled to \`bin/sidecar.mjs\`. Needs the permission
  \`sidecar:runtime:node\` (QuadFlow asks you to approve it) and \`node\` on PATH.`)
  }
  if (t.cli) {
    notes.push(`- \`sidecar/index.mjs\` — handles \`quadflow ${v.cliName} …\` (JSON-RPC \`cli/run\`), bundled to
  \`bin/sidecar.mjs\`. Try \`quadflow ${v.cliName} hello --json\` once the plugin is loaded.
- \`docs/agent.md\` — an agent context doc: \`quadflow docs ${v.slug === v.id ? v.id : `${v.id}.${v.slug}`}\` prints it.`)
  }
  if (t.provider) {
    notes.push(`- \`quadflow-plugin.json\` → \`contributes.agentProvider\` — how QuadFlow detects and launches \`${v.agentCommand}\`.
- \`sidecar/index.mjs\` — serves the \`usage\` hook (\`agentProvider/usage\`), bundled to \`bin/sidecar.mjs\`; needs the
  permission \`sidecar:runtime:node\` and \`node\` on PATH.
- \`src/index.ts\` — the (minimal) UI module; a trusted plugin may implement hooks there instead.`)
  }
  return notes.join('\n')
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  create(process.argv.slice(2)).catch((e) => {
    console.error(`create-quadflow-plugin: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  })
}

// Exported for tests.
export { parseArgs, manifestFor, packageJsonFor }
