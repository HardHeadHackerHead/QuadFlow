#!/usr/bin/env node
/**
 * One-time maintainer setup: create the auto-updater signing keypair and put its public key into
 * src-tauri/tauri.conf.json (docs/RELEASING.md "One-time setup").
 *
 *   node scripts/release/generate-updater-key.mjs [--password-env <VAR>] [--key <path>] [--force]
 *
 *  - runs `tauri signer generate --ci -p <password> -w <key>` (default keys/updater.key —
 *    keys/ is gitignored; never commit it). Tauri cannot sign with a key that has an empty
 *    password, so the key always gets one: the value of $VAR with `--password-env VAR`, else
 *    $TAURI_SIGNING_PRIVATE_KEY_PASSWORD, else a random one written to `<key>.password`
 *    (keys/updater.key.password, which the release pipeline reads).
 *  - checks the new key signs and matches its public key,
 *  - writes the public key into `plugins.updater.pubkey` (only that string changes in the file),
 *  - prints the public key.
 *
 * Refuses to replace an existing key unless `--force`: installed copies only accept updates
 * signed with the key whose public half they shipped with. Replacing it means every existing
 * install has to be updated by hand once.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import {
  PUBKEY_PLACEHOLDER,
  ROOT,
  TAURI_CONF as DEFAULT_CONF,
  UPDATER_KEY,
  ensureDir,
  fail,
  pubkeyId,
  readJson,
  run,
  setPubkey,
  signingKeyId,
  tauriCli,
} from './lib.mjs'

const args = process.argv.slice(2)
const opt = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}
const keyPath = opt('--key') ? resolve(opt('--key')) : UPDATER_KEY
const passwordFile = `${keyPath}.password`
const force = args.includes('--force')
// `--conf <file>`: patch another tauri.conf.json (used to test this script on a copy).
const TAURI_CONF = opt('--conf') ? resolve(opt('--conf')) : DEFAULT_CONF
const passwordEnv = opt('--password-env')

const current = readJson(TAURI_CONF).plugins?.updater?.pubkey
if (existsSync(keyPath) && !force) {
  fail(`${keyPath} already exists. Re-running would orphan every installed copy's updates; pass --force only if you mean to rotate the key.`)
}
if (current && current !== PUBKEY_PLACEHOLDER && pubkeyId(current) && !force) {
  fail(`tauri.conf.json already has updater key ${pubkeyId(current).toUpperCase()}. Pass --force to rotate it (installed copies will stop accepting updates).`)
}

let password
let passwordFrom
if (passwordEnv) {
  password = process.env[passwordEnv]
  if (!password) fail(`--password-env ${passwordEnv}: $${passwordEnv} is empty`)
  passwordFrom = `$${passwordEnv}`
} else if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  passwordFrom = '$TAURI_SIGNING_PRIVATE_KEY_PASSWORD'
} else {
  password = randomBytes(24).toString('base64url')
  passwordFrom = relative(ROOT, passwordFile).startsWith('..') ? passwordFile : relative(ROOT, passwordFile)
}

ensureDir(dirname(keyPath))
if (force) {
  for (const f of [keyPath, passwordFile]) {
    if (existsSync(f)) {
      copyFileSync(f, `${f}.replaced-${Date.now()}`)
      console.log(`generate-updater-key: backed up ${f}`)
    }
  }
}
const r = run(process.execPath, [tauriCli(), 'signer', 'generate', '--ci', '-p', password, '-w', keyPath, ...(force ? ['--force'] : [])], {
  capture: true,
})
if (r.status !== 0) {
  console.error(r.stdout, r.stderr)
  fail('`tauri signer generate` failed')
}
if (!passwordEnv && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  writeFileSync(passwordFile, `${password}\n`)
  try {
    chmodSync(passwordFile, 0o600)
    chmodSync(keyPath, 0o600)
  } catch {
    // Windows: ACLs, not modes; keys/ is in the user's checkout.
  }
}
const pubFile = `${keyPath}.pub`
const pubkey = readFileSync(pubFile, 'utf8').trim()
const id = pubkeyId(pubkey)
if (!id) fail(`${pubFile} does not hold a minisign public key`)
const probe = signingKeyId(readFileSync(keyPath, 'utf8').trim(), password)
if (probe.error) fail(`the new key cannot sign: ${probe.error}`)
if (probe.id !== id) fail(`the new private key (${probe.id}) does not match its public key (${id})`)

// Patch only the pubkey string, keeping the rest of tauri.conf.json byte-for-byte.
try {
  setPubkey(TAURI_CONF, pubkey)
} catch (e) {
  fail(e.message)
}
rmSync(pubFile) // the public key lives in tauri.conf.json now

const show = (p) => (relative(ROOT, p).startsWith('..') ? p : relative(ROOT, p))
console.log(`
Updater keypair created (key id ${id.toUpperCase()}).

  private key: ${show(keyPath)}
  password:    ${passwordFrom}
  public key:  written to ${show(TAURI_CONF)} → plugins.updater.pubkey

${pubkey}

Next:
  1. Back up the private key AND its password somewhere safe (password manager / offline).
     Losing either means installed copies can never auto-update again.
  2. Commit ${show(TAURI_CONF)} (the public key only — keys/ is gitignored).
  3. On every other release machine, copy keys/updater.key${passwordEnv || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ? '' : ' and keys/updater.key.password'}
     (or set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD).
`)
