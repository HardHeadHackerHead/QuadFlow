#!/usr/bin/env node
/**
 * QuadFlow's own release pipeline (docs/RELEASING.md). A thin driver around the generic
 * `quadflow ship` pipeline: it reads the tracked config `scripts/release/ship.config.json`, derives
 * the config for this run (this machine's platform, mode, dry run, signing) and runs it with
 * `quadflow-cli ship run <mode> --config <derived>`. No product logic lives in quadflow-core.
 *
 *   node scripts/release.mjs patch|minor|major [options]   cut a release: bump, changelog, check,
 *                                                         build, stage, commit, tag, push, draft
 *                                                         GitHub release, plugin releases
 *   node scripts/release.mjs platform [options]           add this OS's build to the existing
 *                                                         release of the current version (run on
 *                                                         the `v<version>` tag on another machine)
 *   node scripts/release.mjs plugins-index [--dry-run]    regenerate plugins/index.json from the
 *                                                         plugin release archives on GitHub
 *   node scripts/release.mjs publish [<version>] [--dry-run]  un-draft the app release + its plugin releases
 *   node scripts/release.mjs validate                     lint the release config (npm run check)
 *
 * Options:
 *   --dry-run          run everything (checks, bump, `npm run check`, release build, signatures,
 *                      latest.json, plugin archives, changelog) but never commit, tag, push or
 *                      upload; version files / lockfiles / CHANGELOG.md are restored afterwards.
 *                      Without an updater key a throwaway one is generated for the build.
 *   --plan             only print the resolved phase plan (`ship run --dry-run`)
 *   --publish          publish immediately instead of creating draft releases
 *   --skip-check       skip the `npm run check` phase
 *   --reuse-build      skip the build phase and stage the existing artifacts
 *   --sign             Windows: Authenticode-sign the app + installer during the build with
 *                      --sign-command "<template with {file}>" or $QUADFLOW_SIGN_COMMAND
 *                      (e.g. `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}`)
 *   --quadflow <exe>   the quadflow CLI to run (default: $QUADFLOW_BIN, else
 *                      `cargo build --release -p quadflow-core --bin quadflow-cli`)
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT,
  TAURI_CONF,
  UPDATER_KEY,
  pubkeyId,
  tauriCli,
  appVersion,
  bumpVersion,
  ensureDir,
  fail,
  ghAvailable,
  hostTarget,
  isWindows,
  readJson,
  releaseRepo,
  run,
} from './release/lib.mjs'

const CONFIG = join(ROOT, 'scripts', 'release', 'ship.config.json')
const WORK = join(ROOT, 'release') // gitignored
/** Phases this script adds, removes or edits by name; `validate` checks they exist. */
const PHASE = {
  preflight: 'preflight-release',
  check: 'check',
  cutOnly: ['bump', 'sync-lockfiles', 'changelog', 'commit', 'tag', 'push'],
  publishing: ['commit', 'tag', 'push', 'github-release', 'plugins-upload'],
  release: 'github-release',
  pluginsUpload: 'plugins-upload',
  platformPrefix: 'platform:',
}
/** Files a dry run changes and puts back. */
const DRY_RUN_RESTORE = ['package-lock.json', 'Cargo.lock', 'CHANGELOG.md']

const argv = process.argv.slice(2)
const command = argv[0]
const has = (f) => argv.includes(f)
const opt = (n) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const KNOWN = new Set(['--dry-run', '--plan', '--publish', '--skip-check', '--reuse-build', '--sign', '--sign-command', '--quadflow'])
for (const a of argv.slice(1)) {
  if (a.startsWith('--') && !KNOWN.has(a)) fail(`unknown option ${a}`, 2)
}

const config = readJson(CONFIG)
const repo = releaseRepo(config)

// ------------------------------------------------------------------ config derivation

const names = (phases) => phases.flatMap((p) => [p.name, ...names(p.children ?? [])])

function derive({ mode, dryRun, skipCheck, publish, signCommand }) {
  const host = hostTarget()
  const cfg = structuredClone(config)
  const platforms = cfg.phases.filter((p) => p.name.startsWith(PHASE.platformPrefix)).map((p) => p.name.slice(PHASE.platformPrefix.length))
  if (!platforms.includes(host.key)) fail(`no release phases for ${host.key} in ${CONFIG} (have: ${platforms.join(', ')})`)
  const drop = new Set()
  for (const p of platforms) if (p !== host.key) drop.add(`${PHASE.platformPrefix}${p}`)
  if (mode === 'platform') PHASE.cutOnly.forEach((n) => drop.add(n))
  if (dryRun) PHASE.publishing.forEach((n) => drop.add(n))
  if (skipCheck) drop.add(PHASE.check)
  cfg.phases = cfg.phases.filter((p) => !drop.has(p.name))

  for (const p of cfg.phases) {
    if (p.name === PHASE.release) {
      p.draft = !publish
      // A platform run adds files to an existing release; its notes were written by the cut.
      if (mode === 'platform') delete p.notesFile
    }
    if (p.name === PHASE.pluginsUpload && publish) p.command += ' --publish'
  }

  if (signCommand) {
    if (host.os !== 'windows') fail('--sign is Authenticode (Windows). macOS signing/notarization: set APPLE_SIGNING_IDENTITY etc. for `tauri build` (docs/RELEASING.md).')
    const i = cfg.phases.findIndex((p) => p.name === `${PHASE.platformPrefix}${host.key}`)
    const seq = cfg.phases[i]
    const installer = seq.children.find((c) => c.type === 'stage_artifact' && /setup\.exe$/.test(c.sourceGlob))
    if (!installer) fail(`${seq.name} has no setup.exe stage phase to verify`)
    const build = seq.children.findIndex((c) => c.type === 'build')
    seq.children.splice(build + 1, 0, { type: 'verify_authenticode', name: 'verify-signature', file: installer.sourceGlob })
    cfg.phases.splice(i, 0, { type: 'patch_tauri_conf', name: 'sign-config', windowsSignCommand: signCommand })
    cfg.phases.splice(i + 2, 0, { type: 'restore_tauri_conf', name: 'restore-config' })
  }
  return { cfg, host }
}

// ------------------------------------------------------------------ quadflow CLI

function quadflowBin() {
  const explicit = opt('--quadflow') ?? process.env.QUADFLOW_BIN
  if (explicit) return explicit
  // Release profile: the CLI then uses the release data profile (`.quadflow/`, like the installed
  // app) without exporting QUADFLOW_PROFILE to every phase, and the release app build reuses the
  // quadflow-core artifacts.
  console.log('release: building the quadflow CLI (cargo build --release -p quadflow-core --bin quadflow-cli)')
  const r = run('cargo', ['build', '--release', '-p', 'quadflow-core', '--bin', 'quadflow-cli'])
  if (r.status !== 0) fail('building quadflow-cli failed')
  const target = process.env.CARGO_TARGET_DIR || join(ROOT, 'target')
  const exe = join(target, 'release', isWindows ? 'quadflow-cli.exe' : 'quadflow-cli')
  if (!existsSync(exe)) fail(`${exe} not found after the build`)
  // Run a copy: the pipeline's own `npm run check` rebuilds target/, and Windows cannot replace
  // an exe that is running.
  const copy = join(ensureDir(join(WORK, '.bin')), isWindows ? 'quadflow-cli.exe' : 'quadflow-cli')
  copyFileSync(exe, copy)
  return copy
}

// ------------------------------------------------------------------ dry-run safety net

/** Snapshot the files a dry run edits; returns a restore function (idempotent). */
function snapshot() {
  const files = [...config.versionFiles.map((v) => v.path), ...DRY_RUN_RESTORE]
  const backupDir = ensureDir(join(WORK, '.dry-run-backup'))
  const saved = files.map((f) => {
    const p = join(ROOT, f)
    const exists = existsSync(p)
    if (exists) copyFileSync(p, join(backupDir, f.replace(/[\\/]/g, '__')))
    return { f, p, exists, bytes: exists ? readFileSync(p) : null }
  })
  let done = false
  return () => {
    if (done) return
    done = true
    for (const s of saved) {
      if (s.exists) writeFileSync(s.p, s.bytes)
      else rmSync(s.p, { force: true })
    }
    rmSync(backupDir, { recursive: true, force: true })
    console.log(`release: dry run — restored ${saved.map((s) => s.f).join(', ')}`)
  }
}

/**
 * A dry run on a machine that cannot sign for real yet (no key, or tauri.conf.json still has the
 * placeholder public key — `tauri build` verifies its signature against it): use a throwaway key
 * and, in a `dry-run-pubkey` phase after the preflight, its public key (restored afterwards).
 */
function dryRunKey(env, cfg) {
  const hasKey = existsSync(UPDATER_KEY) || env.TAURI_SIGNING_PRIVATE_KEY
  if (hasKey && pubkeyId(readJson(TAURI_CONF).plugins?.updater?.pubkey)) return
  const dir = ensureDir(join(WORK, '.dry-run-key'))
  const key = join(dir, 'updater.key')
  // Tauri cannot sign with an empty password, so the throwaway key has a (public) one.
  const password = 'quadflow-dry-run'
  const r = run(process.execPath, [tauriCli(), 'signer', 'generate', '--ci', '-p', password, '-w', key, '--force'], { capture: true })
  if (r.status !== 0) fail(`could not generate a throwaway updater key: ${r.stderr}`)
  // The pipeline's load_env_from_file phases would replace the throwaway key with keys/*.
  cfg.phases = cfg.phases.filter((p) => !(p.type === 'load_env_from_file' && /^TAURI_SIGNING_PRIVATE_KEY/.test(p.var)))
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(key, 'utf8').trim()
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password
  env.QUADFLOW_RELEASE_DRY_RUN_PUBKEY = readFileSync(`${key}.pub`, 'utf8').trim()
  const at = cfg.phases.findIndex((p) => p.name === PHASE.preflight) + 1
  cfg.phases.splice(at, 0, { type: 'shell', name: 'dry-run-pubkey', command: 'node scripts/release/dry-run-pubkey.mjs' })
  console.log('release: dry run — no usable updater keypair: signing with a throwaway key (release/.dry-run-key/)')
}

// ------------------------------------------------------------------ commands

function shipRun(mode) {
  const dryRun = has('--dry-run')
  const plan = has('--plan')
  const signCommand = has('--sign') ? (opt('--sign-command') ?? process.env.QUADFLOW_SIGN_COMMAND) : null
  if (has('--sign') && !signCommand) fail('--sign needs --sign-command "<template with {file}>" or $QUADFLOW_SIGN_COMMAND', 2)
  const { cfg, host } = derive({ mode, dryRun, skipCheck: has('--skip-check'), publish: has('--publish'), signCommand })

  const current = appVersion()
  const version = mode === 'platform' ? current : bumpVersion(current, mode)
  const env = {
    ...process.env,
    QUADFLOW_RELEASE_MODE: mode === 'platform' ? 'platform' : 'cut',
    QUADFLOW_RELEASE_VERSION: version,
    QUADFLOW_RELEASE_DRY_RUN: dryRun || plan ? '1' : '',
  }
  if (dryRun && !plan) dryRunKey(env, cfg)
  const derived = join(ensureDir(WORK), `.ship.${host.key}.json`)
  writeFileSync(derived, JSON.stringify(cfg, null, 2) + '\n')

  const shipMode = mode === 'platform' ? 'deploy' : mode
  const args = ['ship', 'run', shipMode, '--config', derived]
  if (plan) args.push('--dry-run')
  if (has('--reuse-build')) args.push('--reuse-build')
  const bin = quadflowBin()
  // Ship keeps its run records in the project store; a fresh clone has none yet (gitignored).
  if (run(bin, ['ship', 'diagnostics', '--json'], { env, capture: true }).status === 5) {
    console.log('release: no QuadFlow project store in this checkout yet — `quadflow init`')
    const r = run(bin, ['init', '--name', config.productName, '--code', 'QF'], { env })
    if (r.status !== 0) fail('quadflow init failed')
  }
  console.log(
    `release: ${mode === 'platform' ? `add ${host.key} to` : `${mode} →`} v${version} on ${host.key}` +
      `${plan ? ' (plan only)' : dryRun ? ' (dry run: nothing is committed, tagged, pushed or uploaded)' : has('--publish') ? ' (publish)' : ' (draft)'}`,
  )
  console.log(`release: $ ${bin} ${args.join(' ')}\n`)

  const restore = dryRun && !plan ? snapshot() : null
  const onSignal = () => {
    restore?.()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const started = Date.now()
  let status
  try {
    status = run(bin, args, { env }).status
  } finally {
    restore?.()
  }
  const mins = ((Date.now() - started) / 60000).toFixed(1)
  const staging = join(WORK, `v${version}`)
  if (!plan && existsSync(staging)) {
    console.log(`\nrelease: staged in ${staging}`)
    const list = (dir, pre = '') => {
      for (const f of readdirSync(dir).sort()) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) list(p, `${pre}${f}/`)
        else console.log(`  ${pre}${f}  (${(statSync(p).size / 1048576).toFixed(2)} MiB)`)
      }
    }
    list(staging)
  }
  console.log(`\nrelease: ${status === 0 ? 'done' : `FAILED (exit ${status})`} in ${mins} min`)
  if (status === 0 && !dryRun && !plan) {
    console.log(`
Next:
  - other platforms: on each machine, \`git fetch --tags && git checkout v${version}\`, then
    \`npm run release -- platform\` (macOS / Linux; latest.json merges automatically).
  - plugins: once every platform is uploaded, \`npm run release -- plugins-index\`, commit plugins/index.json.
  - review the draft at https://github.com/${repo}/releases/tag/v${version}, then
    \`npm run release -- publish ${version}\`.`)
  }
  process.exit(status)
}

function pluginsIndex() {
  const dryRun = has('--dry-run')
  const assets = join(WORK, 'plugin-assets')
  rmSync(assets, { recursive: true, force: true })
  const s = run(process.execPath, [join(ROOT, 'scripts', 'release', 'plugins.mjs'), 'fetch', '--out', assets])
  if (s.status !== 0) process.exit(s.status)
  const out = dryRun ? ['--out', join(WORK, 'plugins-index.preview.json')] : []
  const r = run(process.execPath, [join(ROOT, 'scripts', 'release', 'plugins.mjs'), 'index', '--assets', assets, ...out])
  if (r.status !== 0) process.exit(r.status)
  if (!dryRun) console.log('release: review `git diff plugins/index.json`, then commit and push it (installs read it from the default branch).')
}

function publish() {
  const version = argv[1] && !argv[1].startsWith('--') ? argv[1].replace(/^v/, '') : appVersion()
  const dryRun = has('--dry-run')
  if (!ghAvailable()) fail('gh is not on PATH')
  const exec = (args) => {
    console.log(`${dryRun ? '[dry-run] ' : ''}$ gh ${args.join(' ')}`)
    if (!dryRun && run('gh', args).status !== 0) fail(`gh ${args.join(' ')} failed`)
  }
  const list = run('gh', ['release', 'list', '--repo', repo, '--limit', '200', '--json', 'tagName,isDraft'], { capture: true })
  if (list.status !== 0) fail(`gh release list failed: ${list.stderr}`)
  const drafts = JSON.parse(list.stdout).filter((r) => r.isDraft).map((r) => r.tagName)
  // Plugin releases first: the app's latest.json must never point at plugins that 404.
  for (const tag of drafts.filter((t) => t.startsWith('plugin-'))) exec(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest=false'])
  if (drafts.includes(`v${version}`)) exec(['release', 'edit', `v${version}`, '--repo', repo, '--draft=false', '--latest'])
  else console.log(`release: v${version} is not a draft on ${repo} (already published, or not cut yet)`)
}

function validate() {
  const errors = []
  if (config.formatVersion !== 1) errors.push('formatVersion must be 1')
  const all = names(config.phases)
  const dupes = all.filter((n, i) => all.indexOf(n) !== i)
  if (dupes.length) errors.push(`duplicate phase names: ${[...new Set(dupes)].join(', ')}`)
  for (const n of [PHASE.preflight, PHASE.check, PHASE.release, PHASE.pluginsUpload, ...PHASE.cutOnly, ...PHASE.publishing]) {
    if (!all.includes(n)) errors.push(`phase \`${n}\` (used by scripts/release.mjs) is missing`)
  }
  const platforms = config.phases.filter((p) => p.name.startsWith(PHASE.platformPrefix))
  if (!platforms.length) errors.push('no platform:<os>-<arch> sequences')
  for (const p of platforms) {
    if (p.type !== 'sequence') errors.push(`${p.name} must be a sequence`)
    for (const t of ['build', 'read_updater_sig', 'build_latest_json']) {
      if (!(p.children ?? []).some((c) => c.type === t)) errors.push(`${p.name} has no ${t} phase`)
    }
  }
  const versions = config.versionFiles.map((vf) => {
    const text = readFileSync(join(ROOT, vf.path), 'utf8')
    const v =
      vf.kind === 'json'
        ? JSON.parse(text)[vf.key]
        : new RegExp(`^\\[${vf.key.split('.')[0]}\\][^]*?^${vf.key.split('.')[1]}\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1]
    if (!v) errors.push(`${vf.path}: no ${vf.key}`)
    return `${vf.path}=${v}`
  })
  if (new Set(versions.map((v) => v.split('=')[1])).size > 1) errors.push(`version files disagree: ${versions.join(', ')}`)
  if (!repo?.includes('/')) errors.push('no gh_release / build_latest_json repo')
  const sync = run(process.execPath, [join(ROOT, 'scripts', 'release', 'sync-versions.mjs'), '--check'], { capture: true })
  if (sync.status !== 0) errors.push(sync.stderr.trim())
  if (errors.length) fail(`release config problems:\n  ${errors.join('\n  ')}`)
  console.log(`release: config ok (${all.length} phases, platforms: ${platforms.map((p) => p.name.slice(PHASE.platformPrefix.length)).join(', ')}, v${appVersion()} → ${repo})`)
}

switch (command) {
  case 'patch':
  case 'minor':
  case 'major':
  case 'platform':
    shipRun(command)
    break
  case 'plugins-index':
    pluginsIndex()
    break
  case 'publish':
    publish()
    break
  case 'validate':
    validate()
    break
  default:
    fail('usage: node scripts/release.mjs patch|minor|major|platform [--dry-run|--plan|--publish|--skip-check|--reuse-build|--sign] | plugins-index | publish [<version>] | validate', 2)
}
