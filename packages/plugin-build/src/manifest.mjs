/**
 * Manifest helpers: reading `quadflow-plugin.json`, JSON-Schema validation against the schemas
 * shipped in `@quadflow/plugin-api/schema/` (plugin-system.md §3.2), the files a manifest
 * references, and the current build target in manifest notation.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { PACKAGE_DIR, findCheckout } from './shared.mjs'

export const MANIFEST_FILE = 'quadflow-plugin.json'
const MANIFEST_SCHEMA_ID = 'https://quadflow.dev/schema/quadflow-plugin.schema.json'

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

export function readManifest(root) {
  const file = join(root, MANIFEST_FILE)
  if (!existsSync(file)) throw new Error(`${file} not found`)
  try {
    return readJson(file)
  } catch (e) {
    throw new Error(`${file}: ${e.message}`)
  }
}

/** `{ os, arch, key }` of this machine (`windows-x86_64`, `macos-aarch64`, …). */
export function currentTarget() {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  if (!os || !arch) throw new Error(`unsupported build platform ${process.platform}-${process.arch}`)
  return { os, arch, key: `${os}-${arch}` }
}

/** `@quadflow/plugin-api/schema/`, resolved from the plugin first, then from this package. */
export function schemaDir(root) {
  for (const base of [join(root, 'package.json'), join(PACKAGE_DIR, 'package.json')]) {
    try {
      const pkg = createRequire(base).resolve('@quadflow/plugin-api/package.json')
      const dir = join(dirname(pkg), 'schema')
      if (existsSync(join(dir, 'quadflow-plugin.schema.json'))) return dir
    } catch {
      // not resolvable from here
    }
  }
  throw new Error('@quadflow/plugin-api is not installed (needed for the manifest schema)')
}

const validators = new Map()
function manifestValidator(root) {
  const dir = schemaDir(root)
  if (validators.has(dir)) return validators.get(dir)
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.schema.json')).sort()) ajv.addSchema(readJson(join(dir, f)))
  const v = ajv.getSchema(MANIFEST_SCHEMA_ID)
  validators.set(dir, v)
  return v
}

/** Schema + consistency checks. Returns `{ errors, warnings }` (strings). */
export function validateManifest(root, manifest = readManifest(root)) {
  const errors = []
  const warnings = []
  const validate = manifestValidator(root)
  if (!validate(manifest)) {
    for (const e of validate.errors ?? []) {
      errors.push(`quadflow-plugin.json${e.instancePath || ''}: ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
    }
  }
  const pkgFile = join(root, 'package.json')
  if (existsSync(pkgFile)) {
    const pkg = readJson(pkgFile)
    if (pkg.version && manifest.version && pkg.version !== manifest.version) {
      errors.push(`package.json version ${pkg.version} differs from quadflow-plugin.json version ${manifest.version}`)
    }
  }
  if (manifest.contributes?.tiles?.length && !manifest.ui?.entry) {
    errors.push('quadflow-plugin.json: contributes.tiles needs ui.entry (the module that exports the tile components)')
  }
  if (manifest.sidecar?.runtime === 'node' && !(manifest.permissions ?? []).includes('sidecar:runtime:node')) {
    errors.push('quadflow-plugin.json: a sidecar with runtime "node" needs the permission "sidecar:runtime:node"')
  }
  if (manifest.id && !manifest.id.includes('.') && !isFirstPartyDir(root, manifest.id)) {
    warnings.push(`id "${manifest.id}" has no publisher prefix: bare ids are reserved for official plugins (use "publisher.${manifest.id}")`)
  }
  return { errors, warnings }
}

/** `<QuadFlow checkout>/plugins/<id>`: where official (bare-id) plugins live. */
function isFirstPartyDir(root, id) {
  const checkout = findCheckout(root)
  return !!checkout && join(checkout, 'plugins', id).toLowerCase() === join(root).toLowerCase()
}

const looksLikeFile = (v) => typeof v === 'string' && v !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(v)
/** JSON-Schema-valued keys: their properties are user schema, not paths. */
const SCHEMA_KEYS = new Set(['settings', 'configSchema', '$schema'])
const FILE_KEYS = new Set(['icon', 'entry', 'style', 'file', 'docs'])

/**
 * Relative paths a manifest references, as `{ path, kind }` with kind `ui` (ui.entry/style),
 * `sidecar` (sidecar binary for `targetKey` / node entry, exec CLI binaries) or `static`.
 */
export function referencedFiles(manifest, targetKey) {
  const out = new Map()
  const add = (path, kind) => out.has(path) || out.set(path, kind)
  const walk = (node, kind) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, kind))
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'binaries' && v && typeof v === 'object') {
        if (v[targetKey]) add(v[targetKey], 'sidecar')
        continue
      }
      if (SCHEMA_KEYS.has(k)) continue
      if (FILE_KEYS.has(k) && looksLikeFile(v)) add(v, kind)
      else walk(v, kind)
    }
  }
  const { ui, sidecar, ...rest } = manifest
  walk({ ui }, 'ui')
  walk({ sidecar }, 'sidecar')
  walk(rest, 'static')
  return [...out].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path))
}

/** Missing referenced files under `root` (optionally only some kinds). */
export function missingFiles(root, manifest, { kinds, targetKey = currentTarget().key } = {}) {
  return referencedFiles(manifest, targetKey)
    .filter((f) => !kinds || kinds.includes(f.kind))
    .filter((f) => !existsSync(join(root, f.path)))
    .map((f) => f.path)
}

/** Does the plugin ship native binaries (→ one release zip per OS/arch)? */
export function isNative(manifest) {
  if (manifest.sidecar?.binaries) return true
  return (manifest.contributes?.cliCommands ?? []).some((c) => c.handler?.type === 'exec')
}
