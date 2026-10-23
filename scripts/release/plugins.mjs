#!/usr/bin/env node
/**
 * Plugin release archives for the official source (plugin-system.md §12.2, §15.2;
 * docs/RELEASING.md "Plugin releases").
 *
 *   pack   --out <dir> [--all]
 *       Zip every publishable plugin (bundle policy `release` or `none`) whose manifest version is
 *       not yet in plugins/index.json into `<dir>/<id>-<version>.zip`, or
 *       `<id>-<version>-<os>-<arch>.zip` (this machine) for plugins with a sidecar. The archive root
 *       is the staged plugin (`src-tauri/resources/plugins/<id>/`, written by the release build's
 *       `npm run build:plugins`); `none` plugins are staged here first. Packed with
 *       `@quadflow/plugin-build`'s `packPlugin` (= `quadflow-plugin pack`): deterministic, so packing
 *       the same build twice gives the same sha256. `--all` packs published versions too.
 *   upload --dir <dir> [--publish] [--dry-run]
 *       Create the `plugin-<id>-v<version>` GitHub release (draft unless --publish) and upload the
 *       archives (`--clobber`; a universal archive already on the release is left alone).
 *   fetch  --out <dir> [--dry-run]
 *       Download the archives of every unpublished plugin version from its GitHub release (drafts
 *       included) — the input for `index`.
 *   index  --assets <dir> [--out <file>]
 *       Run gen-plugin-index.mjs with those archives (default: rewrite plugins/index.json).
 *
 * Env: QUADFLOW_REPO overrides owner/name (default: quadflow_core::urls::REPO).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REPO, discoverPlugins, readJson } from '../lib/plugins.mjs'
import { ROOT, ensureDir, fail, hostTarget, run } from './lib.mjs'

const STAGED = join(ROOT, 'src-tauri', 'resources', 'plugins')
const INDEX = join(ROOT, 'plugins', 'index.json')

const [cmd, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}
const flag = (name) => rest.includes(name)

const tagOf = (id, version) => `plugin-${id}-v${version}`

function publishedVersions() {
  const index = existsSync(INDEX) ? readJson(INDEX) : { plugins: [] }
  return new Map(index.plugins.map((p) => [p.id, new Set(p.versions.map((v) => v.version))]))
}

/** Plugins that belong in the official source and whose current version is unpublished. */
function pending({ all = false } = {}) {
  const published = publishedVersions()
  return discoverPlugins().filter((p) => p.bundle !== 'dev' && (all || !published.get(p.id)?.has(p.manifest.version)))
}

async function pack() {
  const out = opt('--out') ?? fail('pack needs --out <dir>', 2)
  ensureDir(out)
  // PL-10's packager (`quadflow-plugin pack`): deterministic zip, per-platform when native.
  const { isNative, packPlugin } = await import('../../packages/plugin-build/src/index.mjs')
  const target = hostTarget()
  const plugins = pending({ all: flag('--all') })
  if (plugins.length === 0) {
    console.log('plugins: every publishable plugin version is already in plugins/index.json — nothing to pack')
    return
  }
  for (const p of plugins) {
    if (isNative(p.manifest) && !p.manifest.platforms?.includes(target.os)) {
      console.log(`plugins: skip ${p.id}@${p.manifest.version} (no ${target.os} build)`)
      continue
    }
    const staged = join(STAGED, p.id)
    let cleanup = false
    if (p.bundle === 'none' || !existsSync(join(staged, 'quadflow-plugin.json'))) {
      // Not part of the app bundle (or not staged yet): stage just this plugin, pack, remove.
      const r = run(process.execPath, [join(ROOT, 'scripts', 'bundle-plugins.mjs'), p.id])
      if (r.status !== 0) fail(`staging ${p.id} failed`)
      cleanup = p.bundle === 'none'
    }
    // Pack the staged copy — exactly what the app bundle ships (its build output and the sidecar
    // for this target) — rather than the source folder.
    const manifest = readJson(join(staged, 'quadflow-plugin.json'))
    if (manifest.version !== p.manifest.version) {
      fail(`${p.id}: staged version ${manifest.version} != plugins/${p.name} version ${p.manifest.version} (stale build?)`)
    }
    const r = packPlugin(staged, { outDir: out })
    console.log(`plugins: ${basename(r.file)}  ${r.entries} file(s), ${(r.size / 1024).toFixed(1)} KiB, sha256 ${r.sha256.slice(0, 12)}…`)
    if (cleanup) rmSync(staged, { recursive: true, force: true })
  }
}

/** `{ id, version, file }` for every `<id>-<version>[-<os>-<arch>].zip` in `dir` that matches a plugin. */
function archivesIn(dir) {
  const plugins = discoverPlugins()
  const out = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.zip')).sort()) {
    const p = plugins.find((p) => file === `${p.id}-${p.manifest.version}.zip` || file.startsWith(`${p.id}-${p.manifest.version}-`))
    if (p) out.push({ id: p.id, name: p.manifest.name, version: p.manifest.version, universal: file === `${p.id}-${p.manifest.version}.zip`, file })
  }
  return out
}

function gh(args, { dryRun = false, capture = false } = {}) {
  console.log(`${dryRun ? '[dry-run] ' : ''}$ gh ${args.join(' ')}`)
  if (dryRun) return { status: 0, stdout: '' }
  return run('gh', args, { capture })
}

function upload() {
  const dir = opt('--dir') ?? fail('upload needs --dir <dir>', 2)
  const dryRun = flag('--dry-run')
  const draft = !flag('--publish')
  if (!existsSync(dir)) {
    console.log(`plugins: ${dir} does not exist — nothing to upload`)
    return
  }
  const archives = archivesIn(dir)
  if (archives.length === 0) console.log('plugins: no plugin archives to upload')
  for (const a of archives) {
    const tag = tagOf(a.id, a.version)
    const view = run('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets'], { capture: true })
    const assets = view.status === 0 ? JSON.parse(view.stdout).assets.map((x) => x.name) : null
    if (assets === null) {
      const notes = `${a.name} ${a.version} for QuadFlow. Install from Settings → Plugins (official source).`
      const r = gh(['release', 'create', tag, '--repo', REPO, '--title', `${a.name} v${a.version}`, '--notes', notes, ...(draft ? ['--draft'] : [])], { dryRun })
      if (r.status !== 0) fail(`gh release create ${tag} failed`)
    }
    if (a.universal && assets?.includes(a.file)) {
      console.log(`plugins: ${tag} already has ${a.file} — kept (published archives are immutable)`)
      continue
    }
    const r = gh(['release', 'upload', tag, join(dir, a.file), '--repo', REPO, '--clobber'], { dryRun })
    if (r.status !== 0) fail(`uploading ${a.file} to ${tag} failed`)
  }
}

function fetch() {
  const out = opt('--out') ?? fail('fetch needs --out <dir>', 2)
  const dryRun = flag('--dry-run')
  ensureDir(out)
  for (const p of pending()) {
    const tag = tagOf(p.id, p.manifest.version)
    const r = gh(['release', 'download', tag, '--repo', REPO, '--pattern', '*.zip', '--dir', out, '--clobber'], { dryRun, capture: true })
    if (r.status !== 0) console.log(`plugins: no release ${tag} yet (${(r.stderr || '').trim().split('\n')[0]}) — ${p.id} stays unlisted`)
  }
  const n = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith('.zip') && statSync(join(out, f)).isFile()).length : 0
  console.log(`plugins: ${n} archive(s) in ${out}`)
}

function index() {
  const assets = opt('--assets') ?? fail('index needs --assets <dir>', 2)
  const args = [join(ROOT, 'scripts', 'gen-plugin-index.mjs'), '--assets', assets]
  if (opt('--out')) args.push('--out', opt('--out'))
  if (!existsSync(assets)) ensureDir(assets)
  const r = run(process.execPath, args)
  if (r.status !== 0) process.exit(r.status)
}

const commands = { pack, upload, fetch, index }
if (!commands[cmd]) fail(`usage: plugins.mjs ${Object.keys(commands).join('|')} …`, 2)
try {
  await commands[cmd]()
} catch (e) {
  fail(e.message)
}
