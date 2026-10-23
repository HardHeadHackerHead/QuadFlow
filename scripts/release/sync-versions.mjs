#!/usr/bin/env node
/**
 * After `quadflow ship`'s version_bump: carry the app version into the lockfiles, which the ship
 * version files do not cover — `package-lock.json` (root `version` + `packages[""].version`) and
 * `Cargo.lock` (the `quadflow-tauri` / `quadflow-core` package entries). Text edits only, so
 * formatting and line endings are kept and nothing is resolved or downloaded.
 *
 *   node scripts/release/sync-versions.mjs [--check]
 *
 * `--check` changes nothing and exits 1 when a lockfile disagrees with its manifest.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, fail } from './lib.mjs'

const check = process.argv.includes('--check')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const tomlPackage = (p) => {
  const t = read(p)
  const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(t)?.[1]
  const version = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(t)?.[1]
  if (!name || !version) fail(`${p}: no [package] name/version`)
  return { name, version }
}

const appVersion = JSON.parse(read('package.json')).version
const crates = [tomlPackage('src-tauri/Cargo.toml'), tomlPackage('src-tauri/quadflow-core/Cargo.toml')]
const problems = []
const edits = []

// package-lock.json: the root `version` and `packages[""].version` (the first two occurrences).
{
  const file = 'package-lock.json'
  const text = read(file)
  const lock = JSON.parse(text)
  if (lock.version !== appVersion || lock.packages?.['']?.version !== appVersion) {
    problems.push(`${file}: root version ${lock.version} != package.json ${appVersion}`)
    let n = 0
    const next = text.replace(/("version":\s*")[^"]*(")/g, (m, a, b) => (n++ < 2 ? `${a}${appVersion}${b}` : m))
    const after = JSON.parse(next)
    if (after.version !== appVersion || after.packages[''].version !== appVersion) fail(`${file}: unexpected layout, not edited`)
    edits.push([file, next])
  }
}

// Cargo.lock: `[[package]]\nname = "<crate>"\nversion = "<v>"`.
{
  const file = 'Cargo.lock'
  let text = read(file)
  for (const { name, version } of crates) {
    const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")([^"]*)(")`)
    const m = re.exec(text)
    if (!m) fail(`${file}: no entry for ${name}`)
    if (m[2] !== version) {
      problems.push(`${file}: ${name} ${m[2]} != Cargo.toml ${version}`)
      text = text.replace(re, `$1${version}$3`)
    }
  }
  if (problems.some((p) => p.startsWith(file))) edits.push([file, text])
}

if (check) {
  if (problems.length) fail(`lockfiles out of sync:\n  ${problems.join('\n  ')}\nRun: node scripts/release/sync-versions.mjs`)
  console.log('sync-versions: lockfiles match the manifests')
} else {
  for (const [file, text] of edits) writeFileSync(join(ROOT, file), text)
  console.log(edits.length ? `sync-versions: updated ${edits.map(([f]) => f).join(', ')}` : 'sync-versions: lockfiles already in sync')
}
