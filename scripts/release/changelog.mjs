#!/usr/bin/env node
/**
 * Release notes from git history (docs/RELEASING.md).
 *
 *   node scripts/release/changelog.mjs --version <x.y.z> [--notes <file>] [--since <ref>] [--no-write]
 *
 * Collects the non-merge commit subjects since the previous `v*` tag (or `--since`; all of
 * history before the first release), prepends a `## v<version> — <date>` section to CHANGELOG.md
 * (created if missing; an existing section for that version is replaced), and writes the section
 * body plus a compare link to `--notes` — the GitHub release notes (`gh_release.notesFile`).
 * `--no-write` leaves CHANGELOG.md alone and only prints / writes the notes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO } from '../lib/plugins.mjs'
import { ROOT, ensureDir, fail, git, lastReleaseTag } from './lib.mjs'

const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const version = opt('--version') ?? fail('changelog needs --version <x.y.z>', 2)
const notesFile = opt('--notes')
const since = opt('--since') ?? lastReleaseTag()
const noWrite = args.includes('--no-write')

const range = since ? `${since}..HEAD` : 'HEAD'
const log = git('log', '--no-merges', '--pretty=format:%s (%h)', range)
if (log === null) fail(`git log ${range} failed`)
const SKIP = /^(Release v\d|Merge |WIP\b|.* WIP:)/
const items = log
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !SKIP.test(l))
  .map((l) => `- ${l}`)
const date = new Date().toISOString().slice(0, 10)
const body = items.length ? items.join('\n') : '- Maintenance release.'
const section = `## v${version} — ${date}\n\n${body}\n`

if (!noWrite) {
  const file = join(ROOT, 'CHANGELOG.md')
  const HEADER = '# Changelog\n\nAll notable changes to QuadFlow. Generated from git history by `scripts/release/changelog.mjs` at release time.\n'
  let text = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : HEADER
  // Replace an earlier section for this version (a re-run after a failed release).
  const own = new RegExp(`## v${version.replace(/\./g, '\\.')} — [^\\n]*\\n[\\s\\S]*?(?=\\n## v|$)`)
  text = text.replace(own, '').replace(/\n{3,}/g, '\n\n')
  const first = text.indexOf('\n## ')
  text = first < 0 ? `${text.trimEnd()}\n\n${section}` : `${text.slice(0, first).trimEnd()}\n\n${section}\n${text.slice(first + 1)}`
  writeFileSync(file, text.trimEnd() + '\n')
  console.log(`changelog: CHANGELOG.md ← v${version} (${items.length} change(s) since ${since ?? 'the first commit'})`)
}

if (notesFile) {
  const compare = since ? `\n\n**Full changelog**: https://github.com/${REPO}/compare/${since}...v${version}` : ''
  ensureDir(dirname(notesFile))
  writeFileSync(notesFile, `${body}${compare}\n`)
  console.log(`changelog: release notes → ${notesFile}`)
} else if (noWrite) {
  process.stdout.write(section)
}
