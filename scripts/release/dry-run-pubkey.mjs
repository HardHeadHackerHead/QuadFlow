#!/usr/bin/env node
/**
 * Dry runs only (inserted by scripts/release.mjs as the `dry-run-pubkey` phase): put the
 * throwaway updater key's public half ($QUADFLOW_RELEASE_DRY_RUN_PUBKEY) into tauri.conf.json, so
 * `tauri build` — which verifies the updater signature it creates against the configured key —
 * succeeds. scripts/release.mjs restores tauri.conf.json when the dry run ends.
 */
import { TAURI_CONF, fail, pubkeyId, setPubkey } from './lib.mjs'

const pubkey = process.env.QUADFLOW_RELEASE_DRY_RUN_PUBKEY
if (process.env.QUADFLOW_RELEASE_DRY_RUN !== '1') fail('dry-run-pubkey only runs in a release dry run')
if (!pubkeyId(pubkey)) fail('QUADFLOW_RELEASE_DRY_RUN_PUBKEY is not a minisign public key')
setPubkey(TAURI_CONF, pubkey)
console.log(`dry-run-pubkey: tauri.conf.json → throwaway updater key ${pubkeyId(pubkey).toUpperCase()} (restored after the run)`)
