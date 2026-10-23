#!/usr/bin/env node
/**
 * Generates `plugins/index.json`, the official plugin source index (plugin-system.md §12.2, §15.2),
 * validated against `packages/plugin-api/schema/plugin-index.schema.json`. Never hand-edit it.
 *
 * Inputs:
 *  - every `plugins/<id>/quadflow-plugin.json` whose bundle policy is `release` or `none`
 *    (`dev` examples are never published) → plugin-level metadata, `bundled`;
 *  - the version records already in `plugins/index.json` → kept verbatim (a published version is
 *    immutable: url/sha256/size never change once released);
 *  - `--assets <dir>`: release archives `<id>-<version>.zip` / `<id>-<version>-<os>-<arch>.zip`
 *    (the `plugin-<id>-v<version>` GitHub release assets) → adds a version record for the
 *    manifest's current version (sha256 + size computed here).
 * A plugin is listed once it has at least one released version (`versions` has `minItems: 1`).
 *
 * Usage:
 *   node scripts/gen-plugin-index.mjs                    write plugins/index.json
 *   node scripts/gen-plugin-index.mjs --check            exit 1 if the committed file drifted (npm run check:index)
 *   node scripts/gen-plugin-index.mjs --assets <dir> [--released-at <ISO date>]
 *   … [--out <file>]                                     write there instead of plugins/index.json
 *                                                        (release dry runs preview the index)
 *
 * Env: QUADFLOW_REPO overrides owner/name (default: quadflow_core::urls::REPO).
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLUGINS_DIR,
  REPO,
  compareSemver,
  discoverPlugins,
  readJson,
  validateIndex,
  validateManifest,
} from './lib/plugins.mjs'

process.on('uncaughtException', (e) => {
  console.error(`gen-plugin-index: ${e.message}`)
  process.exit(1)
})

const INDEX = join(PLUGINS_DIR, 'index.json')

function parseArgs(argv) {
  const opts = { check: false, assets: null, releasedAt: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opts.check = true
    else if (a === '--assets') opts.assets = argv[++i]
    else if (a === '--released-at') opts.releasedAt = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else {
      console.error(`gen-plugin-index: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (opts.check && (opts.assets || opts.out)) {
    console.error('gen-plugin-index: --check cannot be combined with --assets or --out')
    process.exit(2)
  }
  return opts
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const rawUrl = (path) => `https://raw.githubusercontent.com/${REPO}/HEAD/${path}`
const releaseUrl = (id, version, file) => `https://github.com/${REPO}/releases/download/plugin-${id}-v${version}/${file}`

/** Version record for `plugin`'s current version from archives in `dir`, or null if none. */
function versionFromAssets(plugin, dir, releasedAt) {
  const { id, version, apiVersion, platforms, permissions = [] } = plugin.manifest
  const prefix = `${id}-${version}`
  const files = readdirSync(dir).filter((f) => f === `${prefix}.zip` || new RegExp(`^${prefix.replace(/[.+]/g, '\\$&')}-(windows|macos|linux)-(x86_64|aarch64)\\.zip$`).test(f))
  if (files.length === 0) return null
  const record = { version, apiVersion, platforms, permissions }
  const single = files.find((f) => f === `${prefix}.zip`)
  if (single) {
    if (files.length > 1) throw new Error(`${id}@${version}: both a universal and per-platform archives in ${dir}`)
    const p = join(dir, single)
    Object.assign(record, { url: releaseUrl(id, version, single), sha256: sha256(p), size: statSync(p).size })
  } else {
    const sums = {}
    const sizes = {}
    for (const f of files.sort()) {
      const key = f.slice(prefix.length + 1, -'.zip'.length)
      sums[key] = sha256(join(dir, f))
      sizes[key] = statSync(join(dir, f)).size
    }
    Object.assign(record, { url: releaseUrl(id, version, `${prefix}-{os}-{arch}.zip`), sha256: sums, size: sizes })
  }
  record.releasedAt = releasedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return record
}

function build(opts) {
  const previous = existsSync(INDEX) ? readJson(INDEX) : null
  const prevById = new Map((previous?.plugins ?? []).map((p) => [p.id, p]))
  const entries = []
  for (const plugin of discoverPlugins()) {
    if (plugin.bundle === 'dev') continue
    validateManifest(plugin)
    const m = plugin.manifest
    const versions = [...(prevById.get(m.id)?.versions ?? [])]
    if (opts.assets) {
      const rec = versionFromAssets(plugin, opts.assets, opts.releasedAt)
      if (rec) {
        const existing = versions.find((v) => v.version === rec.version)
        if (!existing) versions.push(rec)
        else if (JSON.stringify(existing.sha256) !== JSON.stringify(rec.sha256)) {
          throw new Error(`${m.id}@${rec.version} is already published with different archives (versions are immutable — bump the version)`)
        }
      }
    }
    if (versions.length === 0) continue
    versions.sort((a, b) => compareSemver(b.version, a.version))
    const entry = { id: m.id, name: m.name, description: m.description ?? '' }
    if (m.icon) entry.icon = rawUrl(`plugins/${plugin.name}/${m.icon}`)
    if (m.category) entry.category = m.category
    if (m.homepage) entry.homepage = m.homepage
    entry.repository = m.repository ?? `https://github.com/${REPO}/tree/HEAD/plugins/${plugin.name}`
    entry.bundled = plugin.bundle === 'release'
    entry.versions = versions
    entries.push(entry)
  }
  const index = {
    formatVersion: 1,
    name: 'QuadFlow',
    homepage: `https://github.com/${REPO}`,
    plugins: entries,
  }
  validateIndex(index)
  return JSON.stringify(index, null, 2) + '\n'
}

const opts = parseArgs(process.argv.slice(2))
const next = build(opts)
if (opts.check) {
  const current = existsSync(INDEX) ? readFileSync(INDEX, 'utf8').replace(/\r\n/g, '\n') : null
  if (current !== next) {
    console.error(
      current === null
        ? 'gen-plugin-index: plugins/index.json is missing.'
        : 'gen-plugin-index: plugins/index.json is out of date with the plugin manifests.',
    )
    console.error('Run `npm run gen:plugin-index` and commit the result.')
    process.exit(1)
  }
  console.log('gen-plugin-index: plugins/index.json is up to date')
} else {
  const dest = opts.out ?? INDEX
  writeFileSync(dest, next)
  console.log(`gen-plugin-index: wrote ${opts.out ?? 'plugins/index.json'} (${JSON.parse(next).plugins.length} plugin(s))`)
}
