#!/usr/bin/env node
// Local pre-push checks. QuadFlow has no hosted CI: run `npm run check` before
// pushing or opening a pull request. Fails fast on the first broken step.
import { spawnSync } from 'node:child_process'

const steps = [
  ['no agent literals in core/shell', 'node', ['scripts/check-agent-literals.mjs']],
  ['typecheck', 'npx', ['tsc', '--noEmit']],
  ['web build', 'npm', ['run', 'build:web']],
  // Optional heavy plugin sidecars (candle) are workspace members but never part of the app check;
  // build them explicitly (`npm run build:sidecar` in plugins/semantic-search).
  ['cargo check', 'cargo', ['check', '--workspace', '--exclude', 'semantic-search-sidecar']],
  ['core tests', 'cargo', ['test', '-p', 'quadflow-core']],
  ['sidecar sdk tests (rust)', 'cargo', ['test', '-p', 'quadflow-sidecar']],
  ['sidecar sdk tests (node)', 'node', ['--test', 'packages/sidecar-sdk-node/test/server.test.mjs']],
  // Standalone crate outside the workspace; the stub build needs no C++ toolchain (llama.cpp off).
  ['local-titles sidecar tests', 'cargo', ['test', '--manifest-path', 'plugins/local-titles/sidecar/Cargo.toml', '--no-default-features']],
  ['bindings export', 'cargo', ['test', '-p', 'quadflow-tauri', '--test', 'export_bindings']],
  ['bindings drift', 'git', ['diff', '--exit-code', '--', 'src/generated', 'packages/plugin-api/src/generated']],
  ['plugins build', 'npm', ['run', 'check:plugins']],
  ['codex plugin tests', 'npm', ['test', '--workspace', 'plugins/codex']],
  ['plugin-build tests', 'node', ['--test', 'packages/plugin-build/test/plugin-build.test.mjs']],
  ['create-quadflow-plugin tests', 'node', ['--test', 'packages/create-quadflow-plugin/test/create.test.mjs']],
  ['plugin docs (manifest reference drift, TypeDoc)', 'npm', ['run', 'check:docs']],
  ['usage-monitor plugin tests', 'npm', ['test', '--workspace', 'plugins/usage-monitor']],
  ['missions plugin tests', 'npm', ['test', '--workspace', 'plugins/missions']],
  ['scripts plugin tests', 'npm', ['test', '--workspace', 'plugins/scripts']],
  // Not bundled (bundle "none"), so check:plugins does not build it: build its UI and run its tests here.
  ['semantic-search plugin (UI build)', 'npm', ['run', 'build', '--workspace', 'plugins/semantic-search']],
  ['semantic-search plugin tests', 'npm', ['test', '--workspace', 'plugins/semantic-search']],
  // Streamer kit (bundle policy `none`: not staged by `check:plugins`): type-check + build UI and sidecars, sidecar tests.
  ['streamer plugins typecheck', 'npm', ['run', 'typecheck', '--workspace', 'plugins/youtube-live', '--workspace', 'plugins/youtube-shorts', '--workspace', 'plugins/obs-tracker']],
  // obs-tracker ships a Windows sidecar only (manifest `platforms: ["windows"]`).
  ['streamer plugins build', 'npm', ['run', 'build', '--workspace', 'plugins/youtube-live', '--workspace', 'plugins/youtube-shorts', ...(process.platform === 'win32' ? ['--workspace', 'plugins/obs-tracker'] : [])]],
  ['streamer sidecar tests', 'cargo', ['test', '-p', 'youtube-live-sidecar', '-p', 'obs-tracker-sidecar']],
  // local-titles + discord-bot (bundle `none`): type-check + build (local-titles: UI only — its
  // llama.cpp sidecar is `npm run build:release`; discord-bot: UI + bundled Node sidecar).
  ['local-titles / discord-bot typecheck', 'npm', ['run', 'typecheck', '--workspace', 'plugins/local-titles', '--workspace', 'plugins/discord-bot']],
  ['local-titles / discord-bot build', 'npm', ['run', 'build', '--workspace', 'plugins/local-titles', '--workspace', 'plugins/discord-bot']],
  ['plugin index drift', 'npm', ['run', 'check:index']],
  ['release config', 'npm', ['run', 'check:release']],
  ['clippy', 'cargo', ['clippy', '-p', 'quadflow-core']],
]

// Tests must never touch the OS keychain.
const env = { ...process.env, QUADFLOW_SECRETS_BACKEND: 'memory' }

for (const [name, cmd, args] of steps) {
  console.log(`\n▶ ${name}: ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env })
  if (r.status !== 0) {
    console.error(`\n✗ ${name} failed${name === 'bindings drift' ? ' — commit the regenerated bindings' : ''}`)
    process.exit(r.status ?? 1)
  }
}
console.log('\n✓ all checks passed')
