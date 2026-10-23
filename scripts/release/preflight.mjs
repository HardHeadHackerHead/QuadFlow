#!/usr/bin/env node
/**
 * QuadFlow-specific release preflight, run by the release config's `preflight-release` shell
 * phase right after ship's generic `preflight` checks (clean tree, gh auth, repo reachable, disk
 * space, version files in sync).
 *
 * Checks:
 *  - branch: a cut is made from one of RELEASE_BRANCHES; a `platform` run from the `v<version>` tag;
 *  - the updater public key in tauri.conf.json is set (not the placeholder) and a valid minisign key;
 *  - the updater private key is available (keys/updater.key or TAURI_SIGNING_PRIVATE_KEY), its
 *    password (TAURI_SIGNING_PRIVATE_KEY_PASSWORD or keys/updater.key.password) works, and it
 *    belongs to that public key (checked by signing a scratch file);
 *  - the lockfiles agree with the manifests;
 *  - cut: tag `v<next>` does not exist locally or on GitHub; platform: release `v<version>` exists.
 *
 * Env (set by scripts/release.mjs): QUADFLOW_RELEASE_MODE (`cut` | `platform`, default cut),
 * QUADFLOW_RELEASE_VERSION (the version being released), QUADFLOW_RELEASE_DRY_RUN=1 (problems that
 * only matter for publishing are warnings). The last stderr line summarizes every problem (ship
 * shows the stderr tail as the phase error).
 */
import {
  PUBKEY_PLACEHOLDER,
  RELEASE_BRANCHES,
  ROOT,
  TAURI_CONF,
  appVersion,
  bumpVersion,
  ghAvailable,
  git,
  isSecretKey,
  pubkeyId,
  readJson,
  releaseRepo,
  run,
  signingKeyId,
  updaterKey,
} from './lib.mjs'
import { join } from 'node:path'

const mode = process.env.QUADFLOW_RELEASE_MODE || 'cut'
const dryRun = process.env.QUADFLOW_RELEASE_DRY_RUN === '1'
const version = process.env.QUADFLOW_RELEASE_VERSION || (mode === 'cut' ? bumpVersion(appVersion(), 'patch') : appVersion())
const repo = releaseRepo(readJson(join(ROOT, 'scripts', 'release', 'ship.config.json'))) ?? 'HardHeadHackerHead/QuadFlow'
const tag = `v${version}`

const errors = []
const warnings = []
/** A problem that blocks a real release; in a dry run it is only reported. */
const publishProblem = (m) => (dryRun ? warnings : errors).push(m)
const ok = (m) => console.log(`  ok    ${m}`)

// Branch / tag
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (mode === 'cut') {
  if (RELEASE_BRANCHES.includes(branch)) ok(`on branch ${branch}`)
  else publishProblem(`on branch '${branch}', releases are cut from ${RELEASE_BRANCHES.join(' or ')}`)
} else {
  const at = git('describe', '--exact-match', '--tags', 'HEAD')
  if (at === tag) ok(`HEAD is ${tag}`)
  else publishProblem(`HEAD is not tag ${tag} (git checkout ${tag} before adding a platform build)`)
}

// Updater public key
const conf = readJson(TAURI_CONF)
const pubkey = conf.plugins?.updater?.pubkey ?? ''
const pubId = pubkeyId(pubkey)
if (!pubkey || pubkey === PUBKEY_PLACEHOLDER) {
  publishProblem('updater public key not set in tauri.conf.json (run node scripts/release/generate-updater-key.mjs once)')
} else if (!pubId) {
  errors.push('tauri.conf.json plugins.updater.pubkey is not a minisign public key')
} else ok(`updater public key ${pubId.toUpperCase()}`)

// Updater private key
const { secret, from: secretFrom, password } = updaterKey()
if (!secret) {
  publishProblem('no updater private key (keys/updater.key or TAURI_SIGNING_PRIVATE_KEY) — the build cannot sign updates')
} else if (!isSecretKey(secret)) {
  errors.push(`${secretFrom} is not a Tauri minisign secret key`)
} else {
  // Sign a scratch file: proves the password and yields the key id to compare.
  const probe = signingKeyId(secret, password)
  if (probe.error) errors.push(`cannot sign with ${secretFrom}: ${probe.error}`)
  else if (!pubId) ok(`updater private key (${secretFrom}, key ${probe.id.toUpperCase()}) signs`)
  else if (probe.id === pubId) ok(`updater private key (${secretFrom}) signs and matches the public key`)
  else publishProblem(`${secretFrom} (key ${probe.id.toUpperCase()}) does not match the updater public key ${pubId.toUpperCase()}`)
}

// Lockfiles
const sync = run(process.execPath, [join(ROOT, 'scripts', 'release', 'sync-versions.mjs'), '--check'], { capture: true })
if (sync.status === 0) ok('lockfiles match the manifests')
else errors.push(`lockfiles out of sync with the manifests (node scripts/release/sync-versions.mjs): ${sync.stderr.trim().split('\n').slice(1).join('; ').trim()}`)

// Tag / release on GitHub
if (mode === 'cut') {
  if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) errors.push(`tag ${tag} already exists locally`)
  else ok(`tag ${tag} is free locally`)
}
if (ghAvailable()) {
  const view = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft'], { capture: true })
  if (mode === 'cut') {
    if (view.status === 0) errors.push(`release ${tag} already exists on ${repo} (an orphan draft? gh release delete ${tag} --repo ${repo})`)
    else ok(`no release ${tag} on ${repo} yet`)
  } else if (view.status !== 0) publishProblem(`release ${tag} does not exist on ${repo} — cut it first`)
  else ok(`release ${tag} exists on ${repo}${JSON.parse(view.stdout).isDraft ? ' (draft)' : ''}`)
} else errors.push('gh is not on PATH')

for (const w of warnings) console.log(`  warn  ${w}`)
if (errors.length) {
  for (const e of errors) console.error(`  FAIL  ${e}`)
  console.error(`preflight: ${errors.length} problem(s): ${errors.join('; ')}`)
  process.exit(1)
}
console.log(`preflight: ${mode} ${tag}${dryRun ? ' (dry run)' : ''} — ok${warnings.length ? `, ${warnings.length} warning(s)` : ''}`)
