// Shared helpers for the QuadFlow release scripts (docs/RELEASING.md).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json')
export const UPDATER_KEY = join(ROOT, 'keys', 'updater.key')
/** Its password, written by generate-updater-key.mjs when none was supplied (keys/ is gitignored). */
export const UPDATER_KEY_PASSWORD = join(ROOT, 'keys', 'updater.key.password')

/** The updater key + password this machine would sign with: files in keys/ win over the env. */
export function updaterKey(env = process.env) {
  let secret = env.TAURI_SIGNING_PRIVATE_KEY || null
  let from = 'TAURI_SIGNING_PRIVATE_KEY'
  if (existsSync(UPDATER_KEY)) {
    secret = readFileSync(UPDATER_KEY, 'utf8').trim()
    from = 'keys/updater.key'
  } else if (secret && existsSync(secret)) {
    from = secret // TAURI_SIGNING_PRIVATE_KEY may hold a path
    secret = readFileSync(secret, 'utf8').trim()
  }
  let password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || null
  if (existsSync(UPDATER_KEY_PASSWORD)) password = readFileSync(UPDATER_KEY_PASSWORD, 'utf8').trim()
  return { secret, from, password }
}
/** The value `plugins.updater.pubkey` holds until `generate-updater-key.mjs` has been run. */
export const PUBKEY_PLACEHOLDER = 'UPDATER_PUBKEY_NOT_SET__run_node_scripts/release/generate-updater-key.mjs'
/** Branches a release may be cut from. */
export const RELEASE_BRANCHES = ['main', 'oss']

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
export const isWindows = process.platform === 'win32'

/** Run a command; inherit stdio unless `capture`. Never throws — check `.status`. */
export function run(cmd, args, { capture = false, cwd = ROOT, env, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    input,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    // npm/npx are .cmd shims on Windows and need a shell; plain exes do not.
    shell: isWindows && /^(npm|npx)$/.test(cmd),
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

/** `git …` output (trimmed), or null on failure. */
export function git(...args) {
  const r = run('git', args, { capture: true })
  return r.status === 0 ? r.stdout.trim() : null
}

export function ghAvailable() {
  return run('gh', ['--version'], { capture: true }).status === 0
}

/** `{ os, arch, key }` of this machine in manifest notation (`windows-x86_64`). */
export function hostTarget() {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch]
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)
  return { os, arch, key: `${os}-${arch}` }
}

/** Current app version (package.json is canonical; `npm run release validate` checks the rest agree). */
export const appVersion = () => readJson(join(ROOT, 'package.json')).version

export function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) throw new Error(`version ${v} is not x.y.z`)
  let [maj, min, pat] = m.slice(1).map(Number)
  if (kind === 'major') [maj, min, pat] = [maj + 1, 0, 0]
  else if (kind === 'minor') [min, pat] = [min + 1, 0]
  else if (kind === 'patch') pat += 1
  else throw new Error(`unknown bump ${kind}`)
  return `${maj}.${min}.${pat}`
}

/** The newest `v<x.y.z>` tag reachable from HEAD, or null. */
export function lastReleaseTag() {
  return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
}

/** The GitHub `owner/name` the release config publishes to. */
export function releaseRepo(config) {
  const walk = (phases) => {
    for (const p of phases) {
      if (p.type === 'gh_release' || p.type === 'build_latest_json') return p.repo
      const c = p.children && walk(p.children)
      if (c) return c
    }
    return null
  }
  return walk(config.phases)
}

/** Decode a Tauri minisign key file/string (base64 of the minisign text) → `{ comment, bytes }`. */
export function decodeMinisign(b64) {
  const text = Buffer.from(String(b64).trim(), 'base64').toString('utf8')
  const [comment, body] = text.split('\n')
  if (!comment?.startsWith('untrusted comment:') || !body) return null
  return { comment, bytes: Buffer.from(body.trim(), 'base64') }
}

/** Key id bytes 2..10 of a minisign key/signature, as hex in minisign's display order (LE). */
const keyIdHex = (bytes) => Buffer.from(bytes.subarray(2, 10)).reverse().toString('hex')

/** Key id (hex) of a Tauri updater public key, or null if it is not one. */
export function pubkeyId(b64) {
  const k = decodeMinisign(b64)
  if (!k || !k.comment.includes('public key') || k.bytes.length !== 42) return null
  return keyIdHex(k.bytes)
}

/** Whether `b64` looks like a Tauri (rsign) secret key. Its key id is encrypted with the password. */
export function isSecretKey(b64) {
  const k = decodeMinisign(b64)
  return !!k && k.comment.includes('secret key') && k.bytes.length >= 62
}

/** The Tauri CLI's JS entry (run with node, no shell: the repo path may contain spaces). */
export function tauriCli() {
  return createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js')
}

/**
 * Prove that `secret` + `password` can sign: sign a scratch file with `tauri signer sign` and
 * read the key id out of the signature (minisign signature = alg(2) ‖ key id(8) ‖ sig(64)).
 * Returns `{ id }` (hex) or `{ error }`. Note: Tauri cannot use a key with an empty password,
 * so every updater key has one.
 */
export function signingKeyId(secret, password) {
  if (!password) return { error: 'no password (TAURI_SIGNING_PRIVATE_KEY_PASSWORD / keys/updater.key.password)' }
  const dir = mkdtempSync(join(tmpdir(), 'qf-sign-'))
  try {
    const file = join(dir, 'probe.txt')
    writeFileSync(file, 'quadflow release preflight\n')
    const r = spawnSync(process.execPath, [tauriCli(), 'signer', 'sign', '-k', secret, '-p', password, file], {
      encoding: 'utf8',
      input: '',
      timeout: 120_000,
    })
    if (r.status !== 0) {
      const msg = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean).pop()
      return { error: r.status === null ? 'tauri signer sign timed out' : msg || `tauri signer sign exited ${r.status}` }
    }
    const sig = decodeMinisign(readFileSync(`${file}.sig`, 'utf8'))
    if (!sig || sig.bytes.length < 10) return { error: 'tauri signer sign wrote an unreadable signature' }
    return { id: keyIdHex(sig.bytes) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Set `plugins.updater.pubkey` in a tauri.conf.json, changing only that string. */
export function setPubkey(confPath, pubkey) {
  const text = readFileSync(confPath, 'utf8')
  const re = /("pubkey"\s*:\s*")[^"]*(")/
  if (!re.test(text)) throw new Error(`${confPath} has no plugins.updater.pubkey entry to patch`)
  writeFileSync(confPath, text.replace(re, `$1${pubkey}$2`))
  if (readJson(confPath).plugins?.updater?.pubkey !== pubkey) throw new Error(`patching ${confPath} failed`)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function fail(msg, code = 1) {
  console.error(`release: ${msg}`)
  process.exit(code)
}
