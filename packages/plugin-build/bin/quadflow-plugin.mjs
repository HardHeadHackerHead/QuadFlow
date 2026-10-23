#!/usr/bin/env node
/**
 * quadflow-plugin — build, watch, validate and package a QuadFlow plugin (plugin-system.md §15.1).
 *
 *   quadflow-plugin build [dir] [--no-sidecar]   UI module + sidecar for this machine + checks
 *   quadflow-plugin dev   [dir] [--no-sidecar]   rebuild on change (pair with Settings → Plugins → Load unpacked…)
 *   quadflow-plugin validate [dir]               manifest schema + referenced files + shared imports
 *   quadflow-plugin pack  [dir] [--out <dir>]    release zip <id>-<version>[-<os>-<arch>].zip + .sha256
 *   quadflow-plugin check-shared <file.js…>      only the shared-import check on built modules
 *
 * `dir` defaults to the current directory.
 */
import { resolve } from 'node:path'
import {
  buildPlugin,
  checkBuiltPlugin,
  checkSharedImports,
  packPlugin,
  readManifest,
  watchPlugin,
} from '../src/index.mjs'

const USAGE = `usage: quadflow-plugin <build|dev|validate|pack|check-shared> [dir] [options]
  build [dir] [--no-sidecar]        build the UI module and the sidecar for this machine, then check
  dev [dir] [--no-sidecar]          watch: rebuild on every change (hot reload in QuadFlow's dev mode)
  validate [dir]                    check the manifest, referenced files and shared imports
  pack [dir] [--out <dir>]          write <id>-<version>[-<os>-<arch>].zip + .sha256 (default ./release)
  check-shared <file.js...>         check built modules import only what the host shares`

function parse(argv) {
  const [cmd, ...rest] = argv
  const opts = { cmd, positional: [], sidecar: true, out: null }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--no-sidecar') opts.sidecar = false
    else if (a === '--out') opts.out = rest[++i]
    else if (a === '-h' || a === '--help') opts.cmd = 'help'
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}\n${USAGE}`)
    else opts.positional.push(a)
  }
  return opts
}

async function main() {
  const o = parse(process.argv.slice(2))
  const root = resolve(o.positional[0] ?? '.')
  switch (o.cmd) {
    case 'build': {
      const t0 = Date.now()
      await buildPlugin(root, { sidecar: o.sidecar })
      const m = readManifest(root)
      console.log(`quadflow-plugin: built ${m.id}@${m.version} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return
    }
    case 'dev':
    case 'watch':
      return watchPlugin(root, { sidecar: o.sidecar })
    case 'validate': {
      const r = checkBuiltPlugin(root)
      for (const w of r.warnings) console.warn(`warning: ${w}`)
      if (r.errors.length) {
        console.error(r.errors.join('\n'))
        process.exit(1)
      }
      console.log(`quadflow-plugin: ${readManifest(root).id} is valid`)
      return
    }
    case 'pack': {
      const r = packPlugin(root, o.out ? { outDir: resolve(o.out) } : {})
      console.log(`quadflow-plugin: ${r.file} (${r.entries} files, ${r.size} bytes)\n  sha256 ${r.sha256}`)
      return
    }
    case 'check-shared': {
      const files = o.positional.map((f) => resolve(f))
      if (!files.length) throw new Error(`check-shared needs at least one file\n${USAGE}`)
      const errors = checkSharedImports(files)
      if (errors.length) {
        console.error(errors.join('\n'))
        process.exit(1)
      }
      console.log(`quadflow-plugin: ${files.length} module(s) import only shared names`)
      return
    }
    case 'help':
    case undefined:
      console.log(USAGE)
      return
    default:
      throw new Error(`unknown command ${o.cmd}\n${USAGE}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
