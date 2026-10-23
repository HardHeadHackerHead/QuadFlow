#!/usr/bin/env node
// Core and shell know no specific agent CLI (agent-providers.md §0.1): every
// agent-specific string lives in a provider plugin under plugins/. This check
// fails on any such literal in the core or the shell.
//
// Scanned: src/, src-tauri/src/, src-tauri/quadflow-core/src/.
// Skipped: src/generated/ (regenerated from Rust, which is scanned itself).
// ALLOW: explicit, tiny per-file exceptions — `{ file, match, reason }`; a
// line is allowed only if it contains `match`. Keep it empty if at all possible.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIRS = ['src', 'src-tauri/src', 'src-tauri/quadflow-core/src']
const SKIP = ['src/generated']
const EXT = /\.(ts|tsx|js|mjs|jsx|rs|css|html|json|md|sql|toml)$/i
// `claude` also covers CLAUDE.md and ~/.claude; `codex` covers ~/.codex.
const BANNED = /claude|codex|--session-id|--dangerously|--full-auto/i
const ALLOW = []

const norm = (p) => p.split(sep).join('/')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = norm(relative(ROOT, p))
    if (SKIP.some((s) => rel === s || rel.startsWith(`${s}/`))) continue
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (EXT.test(name)) yield { p, rel }
  }
}

const hits = []
for (const d of DIRS) {
  for (const { p, rel } of walk(join(ROOT, d))) {
    readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (!BANNED.test(line)) return
      if (ALLOW.some((a) => a.file === rel && line.includes(a.match))) return
      hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
}

if (hits.length) {
  console.error('Agent-specific literals in core/shell (move them into a provider plugin manifest or hook):')
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log(`no agent-specific literals in ${DIRS.join(', ')}`)
