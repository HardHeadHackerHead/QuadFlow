/**
 * @quadflow/plugin-build — build preset and tooling for QuadFlow plugins (plugin-system.md §15.1).
 *
 *   // vite.config.ts
 *   import { defineQuadflowPlugin } from '@quadflow/plugin-build'
 *   export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)) })
 *
 * The config builds the UI module in library mode (`formats: ['es']`) from `src/index.tsx` to the
 * manifest's `ui.entry` (default `dist/index.js`) and `ui.style` (`dist/index.css`), keeps the
 * host's shared modules (the import map, §8.3) external, and after every build — including each
 * `--watch` rebuild — validates the manifest, checks that every import of a shared module names
 * something the host exports, checks the files the manifest references, and writes
 * `dist/.integrity.json`.
 *
 * The `quadflow-plugin` CLI (bin/quadflow-plugin.mjs) wraps this and adds sidecar builds
 * (Rust crate in `sidecar/`, or a Node entry bundled to the manifest's `sidecar.entry`),
 * `validate` and `pack` (release zip + sha256 for `gen-plugin-index --assets`).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path'
import { PACKAGE_DIR, checkSharedImports, sharedExports, sharedSpecifiers } from './shared.mjs'
import { currentTarget, isNative, missingFiles, readJson, readManifest, referencedFiles, validateManifest } from './manifest.mjs'
import { createZip } from './zip.mjs'

export { checkSharedImports, sharedExports, sharedSpecifiers } from './shared.mjs'
export { currentTarget, isNative, missingFiles, readManifest, referencedFiles, validateManifest } from './manifest.mjs'
export { createZip } from './zip.mjs'

export const INTEGRITY_FILE = '.integrity.json'
const ENTRY_CANDIDATES = ['src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js']
const NODE_SIDECAR_CANDIDATES = ['sidecar/index.ts', 'sidecar/index.mts', 'sidecar/index.mjs', 'sidecar/index.js']

const POSTCSS_CONFIGS = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts', '.postcssrc', '.postcssrc.json']

const toPosix = (p) => p.replaceAll('\\', '/')

/** Source entry of the UI module (`src/index.tsx`, `.ts`, `.jsx`, `.js`). */
export function findUiSource(root) {
  return ENTRY_CANDIDATES.find((c) => existsSync(join(root, c))) ?? null
}

function walkFiles(dir, base = dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) out.push(...walkFiles(p, base))
    else if (d.isFile()) out.push(p)
  }
  return out
}

/** sha256 of every build output file (`dist/**`, `bin/**`) → `dist/.integrity.json`. */
export function writeIntegrity(root, outDir = join(root, 'dist')) {
  const files = {}
  for (const sub of ['dist', 'bin']) {
    for (const f of walkFiles(join(root, sub))) {
      const rel = toPosix(relative(root, f))
      if (basename(f) === INTEGRITY_FILE) continue
      files[rel] = createHash('sha256').update(readFileSync(f)).digest('hex')
    }
  }
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, INTEGRITY_FILE), JSON.stringify({ algorithm: 'sha256', files: sorted }, null, 2) + '\n')
  return sorted
}

/** Checks a built plugin. `kinds` limits the referenced-file check (`ui`, `sidecar`, `static`). */
export function checkBuiltPlugin(root, { kinds, manifest = readManifest(root) } = {}) {
  const { errors, warnings } = validateManifest(root, manifest)
  const missing = missingFiles(root, manifest, { kinds })
  for (const m of missing) errors.push(`quadflow-plugin.json references ${m}, which does not exist`)
  const js = walkFiles(join(root, 'dist')).filter((f) => ['.js', '.mjs'].includes(extname(f)))
  // A Node sidecar bundle is not a browser module: it may import node: builtins.
  const sidecarEntry = manifest.sidecar?.entry && resolve(root, manifest.sidecar.entry)
  errors.push(...checkSharedImports(js.filter((f) => resolve(f) !== sidecarEntry)))
  return { errors, warnings }
}

function report(prefix, { errors, warnings }, { throwOnError = true } = {}) {
  for (const w of warnings) console.warn(`${prefix}: warning: ${w}`)
  if (errors.length) {
    const msg = `${prefix}: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`
    if (throwOnError) throw new Error(msg)
    console.error(msg)
  }
}

/** Vite plugin: post-build checks + integrity after every (re)build. */
export function quadflowPostBuild({ root, check = true } = {}) {
  let watching = false
  let builds = 0
  return {
    name: 'quadflow-plugin-post-build',
    apply: 'build',
    buildStart() {
      watching = this.meta.watchMode
    },
    closeBundle: {
      sequential: true,
      handler() {
        if (!check) return
        const result = checkBuiltPlugin(root, { kinds: ['ui', 'static'] })
        // In watch mode a broken rebuild must not kill the watcher.
        report('quadflow-plugin', result, { throwOnError: !watching })
        writeIntegrity(root)
        if (watching && result.errors.length === 0) {
          console.log(`quadflow-plugin: ${builds++ ? 'rebuilt' : 'built'} ${new Date().toLocaleTimeString()}`)
        }
      },
    },
  }
}

/**
 * Tailwind for a plugin's own utilities (the shell's Tailwind only scans the shell): the
 * `@quadflow/ui` preset (theme-token colors), no preflight (the host owns base styles), and every
 * rule scoped under `scope` (`important: '.qf-<id>'`) so the plugin stylesheet cannot restyle the
 * shell or other plugins. Wrap each rendered root (tiles, portal content) in that class.
 * `tailwindcss` and `@quadflow/ui` are resolved from the plugin, then from this package.
 */
function tailwindPlugin(root, { scope, content }) {
  if (typeof scope !== 'string' || !/^\.[A-Za-z][\w-]*$/.test(scope)) {
    throw new Error('defineQuadflowPlugin({ tailwind: { scope } }): scope must be a class selector like ".qf-my-plugin"')
  }
  const load = (spec) => {
    for (const base of [join(root, 'package.json'), join(PACKAGE_DIR, 'package.json')]) {
      try {
        return createRequire(base)(spec)
      } catch {
        // try the next base
      }
    }
    throw new Error(`defineQuadflowPlugin({ tailwind }): cannot resolve ${spec} (add it as a dev dependency)`)
  }
  const tailwindcss = load('tailwindcss')
  return tailwindcss({
    presets: [load('@quadflow/ui/tailwind-preset')],
    content: content ?? [`${toPosix(root)}/src/**/*.{ts,tsx,js,jsx}`],
    important: scope,
    corePlugins: { preflight: false },
  })
}

/**
 * The Vite config for a plugin's UI module.
 * @param {{ root: string, entry?: string, react?: boolean, check?: boolean, tailwind?: { scope: string, content?: string[] }, vite?: import('vite').UserConfig }} o
 */
export function defineQuadflowPlugin(o) {
  if (!o?.root) throw new Error('defineQuadflowPlugin({ root }): root is required')
  const root = resolve(o.root)
  const manifest = readManifest(root)
  const uiEntry = manifest.ui?.entry ?? 'dist/index.js'
  const outDir = posix.dirname(toPosix(uiEntry))
  const entry = o.entry ?? findUiSource(root)
  if (!entry) throw new Error(`${root}: no UI source (${ENTRY_CANDIDATES.join(', ')}); pass defineQuadflowPlugin({ entry })`)
  const cssName = manifest.ui?.style ? posix.basename(toPosix(manifest.ui.style)) : 'index.css'
  const css = o.tailwind
    ? { postcss: { plugins: [tailwindPlugin(root, o.tailwind)] } }
    : POSTCSS_CONFIGS.some((c) => existsSync(join(root, c)))
      ? {}
      : { postcss: {} }
  const external = sharedSpecifiers()
  const plugins = []
  if (o.react !== false && /\.[jt]sx$/.test(entry)) plugins.push(reactPlugin())
  plugins.push(quadflowPostBuild({ root, check: o.check !== false }))
  const base = {
    root,
    configFile: false,
    publicDir: false,
    plugins,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    // Scoped Tailwind (option `tailwind`), else only the plugin's own PostCSS config — never one
    // found further up (e.g. the host's Tailwind).
    css,
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      cssCodeSplit: false,
      minify: true,
      lib: { entry, formats: ['es'], fileName: () => posix.basename(toPosix(uiEntry)) },
      rollupOptions: {
        external,
        output: { assetFileNames: (a) => (a.name?.endsWith('.css') ? cssName : 'assets/[name]-[hash][extname]') },
      },
    },
  }
  return mergeConfig(base, o.vite ?? {})
}

// `vite` and `@vitejs/plugin-react` are resolved from this package (not the plugin), so a plugin
// only needs @quadflow/plugin-build as a dev dependency. Loaded with top-level await so that
// `defineQuadflowPlugin()` can stay synchronous inside a vite.config.* file.
const viteMod = await import('vite')
const reactFactory = (await import('@vitejs/plugin-react')).default
const loadVite = async () => viteMod
const reactPlugin = () => reactFactory()
const mergeConfig = (a, b) => viteMod.mergeConfig(a, b)

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']

/** Build (or watch) the UI module. Uses the plugin's vite.config.* when present. */
export async function buildUi(root, { watch = false } = {}) {
  const manifest = readManifest(root)
  if (!manifest.ui?.entry) return null
  const vite = await loadVite()
  const configFile = VITE_CONFIGS.map((c) => join(root, c)).find((c) => existsSync(c))
  const inline = configFile
    ? { root, configFile, logLevel: 'warn' }
    : defineQuadflowPlugin({ root })
  return vite.build({ ...inline, build: { ...(inline.build ?? {}), ...(watch ? { watch: {} } : {}) } })
}

// ---------------------------------------------------------------------------
// Sidecars
// ---------------------------------------------------------------------------

function cargoPackageName(cargoToml) {
  const text = readFileSync(cargoToml, 'utf8')
  const pkg = text.split(/^\[/m).find((s) => s.startsWith('package]'))
  const m = pkg?.match(/^\s*name\s*=\s*"([^"]+)"/m)
  if (!m) throw new Error(`${cargoToml}: no [package] name`)
  return m[1]
}

function cargoTargetDir(cargoToml) {
  if (process.env.CARGO_TARGET_DIR) return resolve(process.env.CARGO_TARGET_DIR)
  const meta = execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', cargoToml], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
  return JSON.parse(meta).target_directory
}

/** What kind of sidecar the plugin has: `{ kind: 'rust', cargoToml }`, `{ kind: 'node', source }` or null. */
export function sidecarSource(root, manifest = readManifest(root)) {
  const cargoToml = join(root, 'sidecar', 'Cargo.toml')
  if (existsSync(cargoToml)) return { kind: 'rust', cargoToml }
  if (manifest.sidecar?.runtime === 'node') {
    const source = NODE_SIDECAR_CANDIDATES.find((c) => existsSync(join(root, c)))
    if (source && toPosix(source) !== toPosix(manifest.sidecar.entry)) return { kind: 'node', source }
  }
  return null
}

function runAsync(cmd, args, opts) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts })
    p.on('error', fail)
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))))
  })
}

/** `cargo build --release` of `sidecar/` → copied to `sidecar.binaries[<current target>]`. */
export async function buildRustSidecar(root, { profile = 'release' } = {}) {
  const manifest = readManifest(root)
  const cargoToml = join(root, 'sidecar', 'Cargo.toml')
  const crate = cargoPackageName(cargoToml)
  const target = currentTarget()
  const binRel = manifest.sidecar?.binaries?.[target.key]
  if (!binRel) throw new Error(`quadflow-plugin.json: sidecar.binaries has no entry for ${target.key}`)
  const args = ['build', '--manifest-path', cargoToml, '-p', crate]
  if (profile === 'release') args.push('--release')
  await runAsync('cargo', args, { cwd: root })
  const built = join(cargoTargetDir(cargoToml), profile === 'release' ? 'release' : 'debug', crate + (target.os === 'windows' ? '.exe' : ''))
  if (!existsSync(built)) throw new Error(`sidecar binary ${built} was not built`)
  const dest = join(root, binRel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(built, dest)
  return dest
}

/**
 * Modules a Node sidecar bundle leaves as runtime imports: `package.json` →
 * `quadflow.sidecarExternal: string[]`. For optional native add-ons that a dependency loads in a
 * try/catch (discord.js: `zlib-sync`, `bufferutil`, `utf-8-validate`), which the bundler cannot
 * resolve when they are not installed.
 */
function sidecarExternals(root) {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  const ext = readJson(pkgPath)?.quadflow?.sidecarExternal
  return Array.isArray(ext) ? ext.filter((x) => typeof x === 'string') : []
}

/** Bundles the Node sidecar source (with its dependencies, e.g. the sidecar SDK) to `sidecar.entry`. */
export async function buildNodeSidecar(root, { watch = false } = {}) {
  const manifest = readManifest(root)
  const src = sidecarSource(root, manifest)
  if (src?.kind !== 'node') return null
  const vite = await loadVite()
  const external = sidecarExternals(root)
  const entry = toPosix(manifest.sidecar.entry)
  return vite.build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    ssr: { noExternal: true, target: 'node', ...(external.length ? { external } : {}) },
    build: {
      ssr: src.source,
      outDir: posix.dirname(entry),
      emptyOutDir: false,
      target: 'node18',
      minify: false,
      // Keep Node's lazy `require` semantics for bundled CommonJS: packages with require cycles
      // (discord.js) otherwise break at load ("Class extends value undefined").
      commonjsOptions: { strictRequires: true },
      ...(watch ? { watch: {} } : {}),
      rollupOptions: {
        ...(external.length ? { external } : {}),
        output: { format: 'es', entryFileNames: posix.basename(entry), inlineDynamicImports: true },
      },
    },
  })
}

/**
 * Full build: UI module, then the sidecar for this machine, then the complete file check and the
 * integrity file. `sidecar: false` skips sidecars (QuadFlow's own bundler builds them itself).
 */
export async function buildPlugin(root, { sidecar = true } = {}) {
  root = resolve(root)
  await buildUi(root)
  const manifest = readManifest(root)
  const src = sidecar ? sidecarSource(root, manifest) : null
  if (src?.kind === 'rust') await buildRustSidecar(root)
  if (src?.kind === 'node') await buildNodeSidecar(root)
  const result = checkBuiltPlugin(root, { kinds: sidecar ? undefined : ['ui', 'static'] })
  report('quadflow-plugin', result)
  writeIntegrity(root)
  return result
}

/**
 * Dev loop: rebuild the UI module on every source change (Vite watch) and the sidecar when its
 * sources change. QuadFlow's dev mode picks up `dist/**` and the sidecar binary (hot reload,
 * sidecar restart). Resolves never; stop with Ctrl+C.
 */
export async function watchPlugin(root, { sidecar = true } = {}) {
  root = resolve(root)
  const manifest = readManifest(root)
  const src = sidecar ? sidecarSource(root, manifest) : null
  if (src?.kind === 'rust') {
    await buildRustSidecar(root, { profile: 'release' }).catch((e) => console.error(`quadflow-plugin: ${e.message}`))
    let timer
    let running = Promise.resolve()
    fsWatch(join(root, 'sidecar'), { recursive: true }, (_e, file) => {
      if (!file || /(^|[\\/])target([\\/]|$)/.test(file)) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        running = running.then(async () => {
          console.log('quadflow-plugin: sidecar changed — rebuilding')
          try {
            await buildRustSidecar(root)
            writeIntegrity(root)
            console.log('quadflow-plugin: sidecar rebuilt')
          } catch (e) {
            console.error(`quadflow-plugin: ${e.message}`)
          }
        })
      }, 300)
    })
  }
  // `vite.build({ watch })` resolves with the watcher before the first build is done; wait for
  // it, so "watching" means edits from now on are picked up.
  const firstBuild = (watcher) =>
    new Promise((ok) => {
      if (!watcher?.on) return ok()
      const onEvent = (e) => {
        if (e.code === 'END' || e.code === 'ERROR') {
          watcher.off?.('event', onEvent)
          ok()
        }
      }
      watcher.on('event', onEvent)
    })
  if (src?.kind === 'node') await firstBuild(await buildNodeSidecar(root, { watch: true }))
  if (manifest.ui?.entry) await firstBuild(await buildUi(root, { watch: true }))
  console.log('quadflow-plugin: watching for changes (Ctrl+C to stop)')
  return new Promise(() => {})
}

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

const PACK_DIRS = ['dist', 'assets', 'docs']
const PACK_FILES = ['quadflow-plugin.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE']

/** Archive name per plugin-system.md §15.2: `<id>-<version>[-<os>-<arch>].zip`. */
export function archiveName(manifest, target = currentTarget()) {
  return `${manifest.id}-${manifest.version}${isNative(manifest) ? `-${target.key}` : ''}.zip`
}

/**
 * Release zip for this machine's target (+ `<zip>.sha256`) in `outDir`. Contents: the manifest,
 * `dist/`, `assets/`, `docs/`, top-level README/LICENSE/CHANGELOG, and every file the manifest
 * references for this target (sidecar binary or Node entry). The archive root holds
 * `quadflow-plugin.json`, as installs require (§12.3). Run after a build.
 */
export function packPlugin(root, { outDir = join(root, 'release') } = {}) {
  root = resolve(root)
  const manifest = readManifest(root)
  const result = checkBuiltPlugin(root, { manifest })
  report('quadflow-plugin pack', result)
  const target = currentTarget()
  const names = new Set()
  for (const f of PACK_FILES) if (existsSync(join(root, f))) names.add(f)
  for (const d of PACK_DIRS) for (const f of walkFiles(join(root, d))) names.add(toPosix(relative(root, f)))
  for (const { path } of referencedFiles(manifest, target.key)) names.add(toPosix(path))
  const binaries = new Set(
    [manifest.sidecar?.binaries?.[target.key], ...(manifest.contributes?.cliCommands ?? []).map((c) => c.handler?.binaries?.[target.key])]
      .filter(Boolean)
      .map(toPosix),
  )
  const entries = [...names].map((name) => ({ name, data: readFileSync(join(root, name)), executable: binaries.has(name) }))
  const zip = createZip(entries)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, archiveName(manifest, target))
  writeFileSync(file, zip)
  const sha256 = createHash('sha256').update(zip).digest('hex')
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`)
  return { file, sha256, size: statSync(file).size, entries: entries.length }
}

/** The plugin's package.json, if any. */
export function readPackage(root) {
  const p = join(root, 'package.json')
  return existsSync(p) ? readJson(p) : null
}
