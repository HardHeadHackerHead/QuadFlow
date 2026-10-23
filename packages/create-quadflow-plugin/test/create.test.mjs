// Tests of create-quadflow-plugin (node --test): every template scaffolds a schema-valid plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create, TEMPLATES } from '../index.mjs'
import { validateManifest } from '../../plugin-build/src/index.mjs'

const quiet = { log: () => {}, interactive: false }

function walk(dir, out = []) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name)
    if (d.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

for (const template of Object.keys(TEMPLATES)) {
  test(`template ${template}: valid manifest, no placeholders left`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qf-create-'))
    try {
      const dir = join(root, 'my-plugin')
      const r = await create([dir, '--template', template, '--id', 'acme.my-plugin', '--no-install', '--author', 'Tester'], quiet)
      assert.equal(r.id, 'acme.my-plugin')
      const manifest = JSON.parse(readFileSync(join(dir, 'quadflow-plugin.json'), 'utf8'))
      const { errors, warnings } = validateManifest(dir, manifest)
      assert.deepEqual(errors, [])
      assert.deepEqual(warnings, [])
      for (const f of walk(dir)) {
        if (statSync(f).size > 1 << 20) continue
        assert.doesNotMatch(readFileSync(f, 'utf8'), /\{\{\w+\}\}/, f)
      }
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      assert.equal(pkg.version, manifest.version)
      assert.match(pkg.scripts.build, /quadflow-plugin build/)
      assert.equal(pkg.scripts.dev, 'quadflow-plugin dev')
      assert.match(pkg.devDependencies['@quadflow/plugin-build'], /^file:/, 'linked to this checkout')
      assert.ok(readdirSync(dir).includes('.gitignore'))
      if (TEMPLATES[template].sidecar === 'rust') {
        const cargo = readFileSync(join(dir, 'sidecar', 'Cargo.toml'), 'utf8')
        assert.match(cargo, /quadflow-sidecar = \{ path = ".*packages\/sidecar-sdk-rust" \}/)
        assert.match(cargo, /^\[workspace\]$/m, 'standalone outside the checkout')
        assert.equal(manifest.sidecar.binaries['windows-x86_64'], 'bin/my-plugin-sidecar.exe')
      }
      if (TEMPLATES[template].sidecar === 'node') {
        assert.deepEqual(manifest.sidecar, { runtime: 'node', entry: 'bin/sidecar.mjs', activation: 'onDemand', restart: 'onCrash' })
        assert.ok(manifest.permissions.includes('sidecar:runtime:node'))
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('registry mode writes version ranges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-create-'))
  try {
    const dir = join(root, 'p')
    await create([dir, '--template', 'tile-sidecar-rust', '--id', 'acme.p', '--no-install', '--registry'], quiet)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(pkg.devDependencies['@quadflow/plugin-api'], '^1.0.0')
    assert.match(readFileSync(join(dir, 'sidecar', 'Cargo.toml'), 'utf8'), /quadflow-sidecar = "1"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bad ids, reserved CLI names and non-empty folders are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qf-create-'))
  try {
    await assert.rejects(create([join(root, 'a'), '--id', 'nodot', '--no-install'], quiet), /publisher\.name/)
    await assert.rejects(create([join(root, 'b'), '--id', 'Acme.X', '--no-install'], quiet), /publisher\.name/)
    await assert.rejects(create([join(root, 'c'), '--template', 'cli-command', '--id', 'acme.c', '--cli-name', 'issues', '--no-install'], quiet), /not allowed/)
    await assert.rejects(create([join(root, 'd'), '--template', 'nope', '--no-install'], quiet), /unknown template/)
    await create([join(root, 'e'), '--id', 'acme.e', '--no-install'], quiet)
    await assert.rejects(create([join(root, 'e'), '--id', 'acme.e', '--no-install'], quiet), /not empty/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
