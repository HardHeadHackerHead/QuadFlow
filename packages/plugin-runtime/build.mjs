#!/usr/bin/env node
/**
 * Builds the sandbox runtime (plugin-system.md §8.4) into `dist/`, which
 * scripts/bundle-plugins.mjs stages as `src-tauri/resources/plugin-runtime/`
 * (served at `qfplugin://…/_runtime/`).
 *
 * Output — one ES module per shared specifier (same file names as the trusted
 * shims in public/qf-shared/, see scripts/gen-shared-shims.mjs), each built
 * with every *other* shared specifier external, so a frame has exactly one
 * React, one zustand, one @quadflow/ui and one @quadflow/plugin-api:
 *
 *   react.js  react-jsx-runtime.js  react-dom.js  react-dom-client.js  zustand.js
 *   plugin-api.js  ui.js
 *   frame.js     the bootstrap (RPC context, theme, module load, tile render)
 *   runtime.css  @quadflow/ui tokens + the Tailwind classes its components use
 *
 * The named exports of the CJS packages come from public/qf-shared/exports.json
 * (written by gen-shared-shims), so a plugin built against the trusted shims
 * links against the runtime too.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const require = createRequire(join(root, 'package.json'))
const { build } = await import('vite')
const react = (await import('@vitejs/plugin-react')).default
const tailwind = require('tailwindcss')
const autoprefixer = require('autoprefixer')

/** Keep in sync with SHARED in scripts/gen-shared-shims.mjs and RUNTIME_MODULES in assets.rs. */
const SHARED = [
  { spec: 'react', file: 'react.js', kind: 'cjs' },
  { spec: 'react/jsx-runtime', file: 'react-jsx-runtime.js', kind: 'cjs' },
  { spec: 'react-dom', file: 'react-dom.js', kind: 'cjs' },
  { spec: 'react-dom/client', file: 'react-dom-client.js', kind: 'cjs' },
  { spec: 'zustand', file: 'zustand.js', kind: 'esm' },
  { spec: '@quadflow/plugin-api', file: 'plugin-api.js', kind: 'ts' },
  { spec: '@quadflow/ui', file: 'ui.js', kind: 'ts' },
]
const SPECS = SHARED.map((s) => s.spec)

const exportsFile = join(root, 'public', 'qf-shared', 'exports.json')
if (!existsSync(exportsFile)) execFileSync(process.execPath, [join(root, 'scripts', 'gen-shared-shims.mjs')], { stdio: 'inherit' })
const exportNames = JSON.parse(readFileSync(exportsFile, 'utf8'))

const outDir = join(here, 'dist')
const entriesDir = join(here, 'node_modules', '.entries')
rmSync(outDir, { recursive: true, force: true })
rmSync(entriesDir, { recursive: true, force: true })
mkdirSync(entriesDir, { recursive: true })

function entrySource(s) {
  const names = exportNames[s.spec] ?? []
  if (s.kind !== 'cjs') {
    return `import * as m from ${JSON.stringify(s.spec)};\nexport * from ${JSON.stringify(s.spec)};\nexport default m;\n`
  }
  // CommonJS: the namespace's default is module.exports; re-export every name the shims export.
  return [
    `import * as ns from ${JSON.stringify(s.spec)};`,
    'const m = ns.default ?? ns;',
    'export default m;',
    names.length ? `export const { ${names.join(', ')} } = m;` : '',
    '',
  ].join('\n')
}

const started = Date.now()
// Type-check the bootstrap (and, through it, @quadflow/plugin-api/rpc).
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(here, 'tsconfig.json')], { stdio: 'inherit' })

const common = (self) => ({
  configFile: false,
  root: here,
  logLevel: 'warn',
  mode: 'production',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [react()],
  css: { postcss: { plugins: [tailwind(join(here, 'tailwind.config.cjs')), autoprefixer()] } },
  build: {
    outDir,
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      // Every other shared specifier stays a bare import (→ the frame's import map).
      external: (id) => SPECS.includes(id) && id !== self,
    },
  },
})

for (const s of SHARED) {
  const entry = join(entriesDir, s.file)
  writeFileSync(entry, entrySource(s))
  const cfg = common(s.spec)
  cfg.build.lib = { entry, formats: ['es'], fileName: () => s.file }
  await build(cfg)
}

const frame = common(null)
frame.build.lib = { entry: join(here, 'src', 'frame.tsx'), formats: ['es'], fileName: () => 'frame.js' }
frame.build.rollupOptions.output = { assetFileNames: 'runtime.[ext]' }
await build(frame)

for (const f of [...SHARED.map((s) => s.file), 'frame.js', 'runtime.css']) {
  if (!existsSync(join(outDir, f))) throw new Error(`plugin-runtime: ${f} was not built`)
}
console.log(`plugin-runtime: built dist/ in ${((Date.now() - started) / 1000).toFixed(1)}s`)
