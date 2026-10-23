#!/usr/bin/env node
/**
 * Builds the first-party plugins and stages them into `src-tauri/resources/plugins/<id>/`
 * (plugin-system.md §15.2), where the registry finds them as `bundled` plugins. Runs as
 * tauri.conf.json `beforeBuildCommand` / `beforeDevCommand` (`npm run build:plugins`).
 *
 * Steps:
 *  1. gen-shared-shims (@quadflow/plugin-build's shared-import check reads public/qf-shared/exports.json).
 *  2. `npm run build --if-present` in every `packages/*` workspace.
 *  3. For every `plugins/<id>/` with a `quadflow-plugin.json` (generic — no hardcoded list) whose
 *     bundle policy selects it (scripts/lib/plugins.mjs `BUNDLE_MODES`; default `release`):
 *     validate the manifest → type-check (`tsc -p`, when a tsconfig.json exists) → build
 *     (the package's `build` script — `quadflow-plugin build --no-sidecar` from
 *     @quadflow/plugin-build, which also runs the shared-import check — else `vite build` when a
 *     vite.config.ts exists) → `cargo build --release` of a Rust `sidecar/` crate →
 *     copy `quadflow-plugin.json`, `dist/`, `assets/`, `docs/`, `bin/` and the sidecar binary for
 *     the current target → check every file the manifest references was staged.
 *     A plugin whose package.json has `quadflow.variantOf: "<id>"` has no sources: it stages that
 *     plugin's build under its own manifest. `quadflow.isolation: "sandboxed"` writes
 *     `quadflow-bundle.json` into the staged copy, which makes the registry run that *bundled*
 *     plugin sandboxed (trust can only be lowered; `hello-sandboxed`, PL-6).
 *  4. Stage the sandbox runtime (`packages/plugin-runtime/dist`, PL-6) when it exists.
 *  5. A full run (no ids) removes staged plugins that are no longer selected, so a release build
 *     after a `--dev` build never ships the dev examples.
 *
 * Usage: node scripts/bundle-plugins.mjs [--dev] [--skip-build] [id…]
 *   --dev         also stage `bundle: "dev"` plugins (examples such as `hello`)
 *   --skip-build  only validate + stage existing build output
 *   id…           stage just these plugins (any bundle policy); no stale cleanup
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import {
  ROOT,
  currentTarget,
  discoverPlugins,
  readJson,
  referencedFiles,
  validateManifest,
} from './lib/plugins.mjs'

process.on('uncaughtException', (e) => {
  console.error(`bundle-plugins: ${e.message}`)
  process.exit(1)
})

const OUT_ROOT = join(ROOT, 'src-tauri', 'resources', 'plugins')
const RUNTIME_SRC = join(ROOT, 'packages', 'plugin-runtime', 'dist')
const RUNTIME_OUT = join(ROOT, 'src-tauri', 'resources', 'plugin-runtime')
// Tracked placeholder: tauri.conf.json's `resources/plugins/**/*` glob must match at least one
// file, or tauri-build fails on a fresh clone before any plugin has been staged.
const KEEP = '.gitkeep'
// Run tools via their JS entry points (no shell: the repo path may contain spaces).
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const SHIMS = join(ROOT, 'scripts', 'gen-shared-shims.mjs')

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const only = args.filter((a) => !a.startsWith('--'))
for (const f of flags) {
  if (!['--dev', '--skip-build'].includes(f)) {
    console.error(`bundle-plugins: unknown flag ${f}`)
    process.exit(2)
  }
}
const dev = flags.has('--dev')
const skipBuild = flags.has('--skip-build')

const rel = (p) => relative(ROOT, p).replaceAll('\\', '/')

function run(cmd, cmdArgs, opts = {}) {
  execFileSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts })
}
const node = (script, scriptArgs) => run(process.execPath, [script, ...scriptArgs])

/** `npm <args>`: through npm's own CLI script when we were started by npm, else via the shell. */
function npm(npmArgs) {
  const cli = process.env.npm_execpath
  if (cli && /\.c?js$/.test(cli)) return run(process.execPath, [cli, ...npmArgs])
  // Arguments are plain workspace paths/script names (no spaces), so a shell is safe here.
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, { shell: true })
}

const hasBuildScript = (dir) => {
  const p = join(dir, 'package.json')
  return existsSync(p) && typeof readJson(p).scripts?.build === 'string'
}

function cargoPackageName(cargoToml) {
  const text = readFileSync(cargoToml, 'utf8')
  const pkg = text.split(/^\[/m).find((s) => s.startsWith('package]'))
  const m = pkg?.match(/^\s*name\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error(`${rel(cargoToml)}: no [package] name`)
  return m[1]
}

function cargoTargetDir() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR
  const meta = execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  return JSON.parse(meta).target_directory
}

const target = currentTarget()
const started = Date.now()
const plugins = discoverPlugins()
const known = new Set(plugins.map((p) => p.id))
const unknown = only.filter((id) => !known.has(id))
if (unknown.length) {
  console.error(`bundle-plugins: no plugins/<id>/quadflow-plugin.json for: ${unknown.join(', ')}`)
  process.exit(1)
}
const selected = plugins.filter((p) =>
  only.length ? only.includes(p.id) : p.bundle === 'release' || (dev && p.bundle === 'dev'),
)

/**
 * `package.json` → `quadflow.variantOf: "<id>"`: the plugin has only a manifest; its UI bundle,
 * assets, docs and sidecar come from that plugin's build (e.g. `hello-sandboxed` = `hello`'s
 * bundle run sandboxed, PL-6). The source must be staged in the same run, before it.
 */
function variantSource(plugin) {
  const of = plugin.pkg?.quadflow?.variantOf
  if (of === undefined) return plugin
  const src = plugins.find((p) => p.id === of)
  if (!src || src.pkg?.quadflow?.variantOf) throw new Error(`plugins/${plugin.id}: quadflow.variantOf ${JSON.stringify(of)} is not a plugin with sources`)
  if (!skipBuild && !selected.includes(src)) {
    throw new Error(`plugins/${plugin.id} is a variant of ${of}: stage ${of} in the same run (or use --skip-build)`)
  }
  return src
}
// Sources before their variants.
selected.sort((a, b) => Number(variantSource(a) !== a) - Number(variantSource(b) !== b))

// 1. Shared shims.
node(SHIMS, [])

// 2. Workspace packages (plugin-build, plugin-runtime, … — whichever define a build script).
if (!skipBuild) {
  const pkgsDir = join(ROOT, 'packages')
  for (const d of existsSync(pkgsDir) ? readdirSync(pkgsDir, { withFileTypes: true }) : []) {
    if (d.isDirectory() && hasBuildScript(join(pkgsDir, d.name))) {
      npm(['run', 'build', '--workspace', `packages/${d.name}`])
    }
  }
}

// 3. Plugins.
mkdirSync(OUT_ROOT, { recursive: true })
let targetDir
for (const plugin of selected) {
  const t0 = Date.now()
  const { id, dir, manifest } = plugin
  validateManifest(plugin)
  // `variantOf`: stage another plugin's build output under this manifest (no sources here).
  const src = variantSource(plugin)
  const srcDir = src.dir

  if (!skipBuild && src === plugin) {
    if (existsSync(join(dir, 'tsconfig.json'))) node(TSC, ['-p', join(dir, 'tsconfig.json')])
    if (hasBuildScript(dir)) npm(['run', 'build', '--workspace', rel(dir)])
    else if (existsSync(join(dir, 'vite.config.ts'))) {
      node(VITE, ['build', '--config', join(dir, 'vite.config.ts'), '--logLevel', 'warn'])
    }
  }
  if (manifest.ui?.entry) {
    const entry = join(srcDir, manifest.ui.entry)
    if (!existsSync(entry)) throw new Error(`plugins/${id}: ui.entry ${manifest.ui.entry} was not built`)
  }

  const out = join(OUT_ROOT, id)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  cpSync(join(dir, 'quadflow-plugin.json'), join(out, 'quadflow-plugin.json'))
  for (const base of src === plugin ? [dir] : [srcDir, dir]) {
    for (const sub of ['dist', 'assets', 'docs', 'bin']) {
      if (existsSync(join(base, sub))) cpSync(join(base, sub), join(out, sub), { recursive: true })
    }
  }
  // Build-time isolation override (only ever `sandboxed`; read by the registry for bundled copies).
  const isolation = plugin.pkg?.quadflow?.isolation
  if (isolation !== undefined) {
    if (isolation !== 'sandboxed') throw new Error(`plugins/${id}/package.json: quadflow.isolation can only be "sandboxed"`)
    writeFileSync(join(out, 'quadflow-bundle.json'), JSON.stringify({ isolation }, null, 2) + '\n')
  }

  // Rust sidecar crate (`plugins/<id>/sidecar`, a workspace member or standalone): build for the current target and
  // place the binary where the manifest's `sidecar.binaries[<os>-<arch>]` says.
  const cargoToml = join(srcDir, 'sidecar', 'Cargo.toml')
  if (existsSync(cargoToml)) {
    const crate = cargoPackageName(cargoToml)
    const binRel = manifest.sidecar?.binaries?.[target.key]
    if (!binRel) {
      console.warn(`bundle-plugins: ${id}: sidecar crate ${crate} but no sidecar.binaries["${target.key}"] in the manifest — not staged`)
    } else {
      // A crate with its own [workspace] (e.g. local-titles: llama.cpp) is not a member of the root
      // workspace: build it by manifest path into its own target/.
      const standalone = /^\[workspace\]/m.test(readFileSync(cargoToml, 'utf8'))
      if (!skipBuild) run('cargo', standalone ? ['build', '--release', '--manifest-path', cargoToml] : ['build', '--release', '-p', crate])
      const dir = standalone ? join(srcDir, 'sidecar', 'target') : (targetDir ??= cargoTargetDir())
      const built = join(dir, 'release', crate + (target.os === 'windows' ? '.exe' : ''))
      if (!existsSync(built)) throw new Error(`plugins/${id}: sidecar binary ${built} not found`)
      mkdirSync(dirname(join(out, binRel)), { recursive: true })
      cpSync(built, join(out, binRel))
    }
  }
  // Node sidecar entry outside dist/ (e.g. sidecar/index.mjs).
  const sideEntry = manifest.sidecar?.entry
  if (sideEntry && !existsSync(join(out, sideEntry)) && existsSync(join(srcDir, sideEntry))) {
    mkdirSync(dirname(join(out, sideEntry)), { recursive: true })
    cpSync(join(srcDir, sideEntry), join(out, sideEntry))
  }

  const missing = referencedFiles(manifest, target.key).filter((f) => !existsSync(join(out, f)))
  if (missing.length) {
    throw new Error(`plugins/${id}: manifest references files missing from the staged bundle: ${missing.join(', ')}`)
  }
  console.log(`bundle-plugins: ${id}@${manifest.version} (${plugin.bundle}) → ${rel(out)}/ [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
}

// 4. Sandbox runtime (PL-6).
if (existsSync(RUNTIME_SRC)) {
  rmSync(RUNTIME_OUT, { recursive: true, force: true })
  cpSync(RUNTIME_SRC, RUNTIME_OUT, { recursive: true })
  // Tracked placeholder for tauri.conf.json's `resources/plugin-runtime/**/*` glob (fresh clones).
  writeFileSync(join(RUNTIME_OUT, KEEP), '')
  console.log(`bundle-plugins: plugin-runtime → ${rel(RUNTIME_OUT)}/`)
}

// 5. Stale cleanup (full runs only).
if (only.length === 0) {
  const keep = new Set(selected.map((p) => p.id))
  for (const d of readdirSync(OUT_ROOT, { withFileTypes: true })) {
    if (d.name === KEEP || keep.has(d.name)) continue
    rmSync(join(OUT_ROOT, d.name), { recursive: true, force: true })
    console.log(`bundle-plugins: removed stale ${rel(join(OUT_ROOT, d.name))}`)
  }
  // tauri-build copies the resources next to the exe (`target/<profile>/resources/plugins/`)
  // but never deletes there: a plugin that was removed or renamed in this checkout would stay
  // bundled in every later local build (e.g. both `legacy` and its successor `core` active).
  // Only ids that no longer exist at all are pruned — the other profile may stage a different
  // selection (`--dev`).
  const known = new Set(plugins.map((p) => p.id))
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(ROOT, 'target')
  const profileDirs = []
  for (const d of existsSync(targetDir) ? readdirSync(targetDir, { withFileTypes: true }) : []) {
    if (!d.isDirectory()) continue
    profileDirs.push(join(targetDir, d.name)) // debug, release, …
    for (const p of readdirSync(join(targetDir, d.name), { withFileTypes: true })) {
      if (p.isDirectory()) profileDirs.push(join(targetDir, d.name, p.name)) // <triple>/<profile>
    }
  }
  for (const profile of profileDirs) {
    const copied = join(profile, 'resources', 'plugins')
    if (!existsSync(copied)) continue
    for (const d of readdirSync(copied, { withFileTypes: true })) {
      if (!d.isDirectory() || known.has(d.name)) continue
      rmSync(join(copied, d.name), { recursive: true, force: true })
      console.log(`bundle-plugins: removed stale ${rel(join(copied, d.name))}`)
    }
  }
}

const skipped = plugins.filter((p) => !selected.includes(p)).map((p) => `${p.id} (${p.bundle})`)
console.log(
  `bundle-plugins: staged ${selected.length} plugin(s) for ${target.key} in ${((Date.now() - started) / 1000).toFixed(1)}s` +
    (skipped.length ? `; not bundled: ${skipped.join(', ')}` : ''),
)
