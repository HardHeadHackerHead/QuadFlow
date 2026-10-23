/**
 * Shared helpers for the first-party plugin scripts (plugin-system.md §2, §15.2):
 * discovery of `plugins/<id>/`, bundle policy, manifest/index schema validation.
 *
 * Used by scripts/bundle-plugins.mjs and scripts/gen-plugin-index.mjs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PLUGINS_DIR = join(ROOT, 'plugins')
export const SCHEMA_DIR = join(ROOT, 'packages', 'plugin-api', 'schema')

/**
 * GitHub `owner/name` of the official repository, read from its single source of truth
 * `quadflow_core::urls::REPO` (plugin-system.md §12.1); `QUADFLOW_REPO` overrides (forks).
 */
export const REPO = process.env.QUADFLOW_REPO || readCoreRepo()

function readCoreRepo() {
  const file = join(ROOT, 'src-tauri', 'quadflow-core', 'src', 'urls.rs')
  const m = readFileSync(file, 'utf8').match(/pub const REPO: &str = "([^"]+)";/)
  if (!m) throw new Error(`could not read \`pub const REPO\` from ${file}`)
  return m[1]
}

/**
 * Bundle policy, from `plugins/<id>/package.json` → `"quadflow": { "bundle": … }`:
 *  - `release` (default): shipped inside the app (`src-tauri/resources/plugins/<id>`) and listed
 *    in `plugins/index.json` with `bundled: true`.
 *  - `dev`: example/test plugin; only staged by `bundle-plugins.mjs --dev` (isolated dev builds,
 *    `tauri dev`) and never listed in the index.
 *  - `none`: not shipped; installed from the official source (heavy optional plugins, §15.2).
 */
export const BUNDLE_MODES = ['release', 'dev', 'none']

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** `{ os, arch, key }` of the current build target, in manifest notation (`windows-x86_64`). */
export function currentTarget() {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  if (!os || !arch) throw new Error(`unsupported build platform ${process.platform}-${process.arch}`)
  return { os, arch, key: `${os}-${arch}` }
}

/**
 * Every directory under `plugins/` that contains a `quadflow-plugin.json`, sorted by id.
 * Returns `{ id, dir, manifest, pkg, bundle }`.
 */
export function discoverPlugins() {
  if (!existsSync(PLUGINS_DIR)) return []
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(PLUGINS_DIR, d.name, 'quadflow-plugin.json')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const dir = join(PLUGINS_DIR, name)
      const manifest = readJson(join(dir, 'quadflow-plugin.json'))
      const pkgPath = join(dir, 'package.json')
      const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null
      const bundle = pkg?.quadflow?.bundle ?? 'release'
      if (!BUNDLE_MODES.includes(bundle)) {
        throw new Error(`plugins/${name}/package.json: quadflow.bundle must be one of ${BUNDLE_MODES.join(', ')} (got ${JSON.stringify(bundle)})`)
      }
      return { id: manifest.id, dir, name, manifest, pkg, bundle }
    })
}

const AGENT_PROVIDER_SCHEMA_ID = 'https://quadflow.dev/schema/agent-provider.schema.json'
let ajv
function validator(schemaFile) {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    // Register every schema first so cross-file `$ref`s (agent-provider, …) resolve.
    for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')).sort()) {
      ajv.addSchema(readJson(join(SCHEMA_DIR, f)))
    }
    // Same fallback as core (quadflow-core/src/plugins/schema.rs) until AP-1 commits it.
    if (!ajv.getSchema(AGENT_PROVIDER_SCHEMA_ID)) {
      ajv.addSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: AGENT_PROVIDER_SCHEMA_ID, type: 'object' })
    }
  }
  const schema = readJson(join(SCHEMA_DIR, schemaFile))
  return ajv.getSchema(schema.$id)
}

function formatErrors(errors) {
  return (errors ?? []).map((e) => `  ${e.instancePath || '/'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`).join('\n')
}

/** Validates a plugin manifest against quadflow-plugin.schema.json + the directory name rule. */
export function validateManifest(plugin) {
  const validate = validator('quadflow-plugin.schema.json')
  if (!validate(plugin.manifest)) {
    throw new Error(`plugins/${plugin.name}/quadflow-plugin.json is invalid:\n${formatErrors(validate.errors)}`)
  }
  if (plugin.manifest.id !== plugin.name) {
    throw new Error(`plugins/${plugin.name}: manifest id "${plugin.manifest.id}" must equal the directory name`)
  }
  if (plugin.pkg && plugin.pkg.version !== plugin.manifest.version) {
    throw new Error(`plugins/${plugin.name}: package.json version ${plugin.pkg.version} != manifest version ${plugin.manifest.version}`)
  }
}

/** Validates an index document against plugin-index.schema.json. */
export function validateIndex(index, label = 'plugins/index.json') {
  const validate = validator('plugin-index.schema.json')
  if (!validate(index)) throw new Error(`${label} is invalid:\n${formatErrors(validate.errors)}`)
}

/** Manifest `relPath` values (schema-enforced) — anything but a URL names a file in the plugin. */
const looksLikeFile = (v) => typeof v === 'string' && v !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(v)
/** JSON-Schema-valued keys: their `file`/`icon`-like properties are user schema, not paths. */
const SCHEMA_KEYS = new Set(['settings', 'configSchema', '$schema'])
const FILE_KEYS = new Set(['icon', 'entry', 'style', 'file'])

/**
 * Relative paths a manifest references (ui entry/style, icons, agent docs, sidecar entry and the
 * sidecar binary for `targetKey`). Used to check a staged plugin is complete.
 */
export function referencedFiles(manifest, targetKey) {
  const out = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      if (k === 'binaries' && v && typeof v === 'object') {
        if (v[targetKey]) out.add(v[targetKey])
        continue
      }
      if (SCHEMA_KEYS.has(k)) continue
      if (FILE_KEYS.has(k) && looksLikeFile(v)) out.add(v)
      else walk(v)
    }
  }
  walk(manifest)
  return [...out].sort()
}

/** Minimal semver compare (x.y.z[-pre]) for sorting index versions newest first. */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = String(v).split('-', 2)
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] ?? 0) !== (pb.nums[i] ?? 0)) return (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre < pb.pre ? -1 : 1
}
