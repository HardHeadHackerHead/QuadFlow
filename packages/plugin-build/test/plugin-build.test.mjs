// Unit tests for @quadflow/plugin-build (node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  archiveName,
  checkSharedImports,
  createZip,
  isNative,
  packPlugin,
  referencedFiles,
  validateManifest,
  writeIntegrity,
} from '../src/index.mjs'

const EXPORTS = { react: ['useState', 'useEffect'], '@quadflow/ui': ['Button'] }

/** Independent reader: central directory → local headers → inflate (checks sizes). */
function unzip(buf, dest) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    const lnlen = buf.readUInt16LE(off + 26)
    const lelen = buf.readUInt16LE(off + 28)
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize)
    const data = method === 8 ? inflateRawSync(raw) : raw
    assert.equal(data.length, usize, name)
    mkdirSync(join(dest, name, '..'), { recursive: true })
    writeFileSync(join(dest, name), data)
    p += 46 + nlen + elen + clen
  }
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'qf-plugin-build-'))
}

const MANIFEST = {
  id: 'acme.demo',
  name: 'Demo',
  version: '1.2.3',
  apiVersion: '^1.0.0',
  platforms: ['windows', 'macos', 'linux'],
  icon: 'assets/icon.svg',
  ui: { entry: 'dist/index.js', style: 'dist/index.css' },
  contributes: { tiles: [{ id: 'demo', title: 'Demo', icon: 'assets/icon.svg' }] },
}

test('shared-import check: only shared specifiers and exported names', () => {
  const dir = tmp()
  try {
    const ok = join(dir, 'ok.js')
    writeFileSync(ok, `import R, { useState as s, useEffect } from "react";\nimport { Button } from '@quadflow/ui';\nimport './chunk.js';\nexport default 1`)
    assert.deepEqual(checkSharedImports([ok], EXPORTS), [])

    const bad = join(dir, 'bad.js')
    writeFileSync(bad, `import { useState, useNope } from "react";\nimport x from "lodash";\nconst m = import("left-pad");\nexport * from "zustand";`)
    const errors = checkSharedImports([bad], EXPORTS)
    assert.equal(errors.length, 4, errors.join('\n'))
    assert.match(errors[0], /no runtime export "useNope"/)
    assert.ok(errors.some((e) => e.includes('"lodash"') && e.includes('not a shared module')))
    assert.ok(errors.some((e) => e.includes('"left-pad"')))
    assert.ok(errors.some((e) => e.includes('"zustand"')))

    // Import-looking text inside strings / comments / templates is not an import (CodeMirror's
    // JavaScript completions contain `import {${names}} from "${module}"`).
    const strings = join(dir, 'strings.js')
    writeFileSync(
      strings,
      [
        'const snip = "import {${names}} from \\"${module}\\"";',
        '// import x from "lodash"',
        'const t = `import "left-pad"`;',
        'export default [snip, t]',
      ].join('\n'),
    )
    assert.deepEqual(checkSharedImports([strings], EXPORTS), [])

    // MIG-github's false positives: `"import"` / 'Failed to import' string literals.
    const literals = join(dir, 'literals.js')
    writeFileSync(
      literals,
      [
        `const kinds = ["import","require"];`,
        `const e = new Error('Failed to import "settings.json"');`,
        `const msg = "import 'lodash' first";`,
        `import{useEffect as u}from"react";import*as R from"react";export{useState}from"react";import"./side.js";`,
        `export default [kinds, e, msg, u, R]`,
      ].join('\n'),
    )
    assert.deepEqual(checkSharedImports([literals], EXPORTS), [])
    const minified = join(dir, 'min.js')
    writeFileSync(minified, `var a=1;import{nope as n}from"react";import*as L from"lodash";export*from"zustand";export default [a,n,L]`)
    const minErrors = checkSharedImports([minified], EXPORTS)
    assert.equal(minErrors.length, 3, minErrors.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('referenced files are classified; native plugins get a per-target archive name', () => {
  const m = {
    ...MANIFEST,
    sidecar: { binaries: { 'windows-x86_64': 'bin/demo.exe', 'linux-x86_64': 'bin/demo' } },
    contributes: { ...MANIFEST.contributes, agentContextDocs: [{ id: 'demo', title: 'Demo', file: 'docs/agent.md' }], settings: { properties: { icon: { type: 'string' } } } },
  }
  const files = referencedFiles(m, 'linux-x86_64')
  assert.deepEqual(files, [
    { path: 'assets/icon.svg', kind: 'static' },
    { path: 'bin/demo', kind: 'sidecar' },
    { path: 'dist/index.css', kind: 'ui' },
    { path: 'dist/index.js', kind: 'ui' },
    { path: 'docs/agent.md', kind: 'static' },
  ])
  assert.equal(isNative(m), true)
  assert.equal(archiveName(m, { key: 'linux-x86_64' }), 'acme.demo-1.2.3-linux-x86_64.zip')
  assert.equal(archiveName(MANIFEST, { key: 'linux-x86_64' }), 'acme.demo-1.2.3.zip')
  const node = { ...MANIFEST, sidecar: { runtime: 'node', entry: 'bin/sidecar.mjs' } }
  assert.equal(isNative(node), false)
})

test('manifest validation reports schema errors and inconsistencies', () => {
  const dir = tmp()
  try {
    const bad = { ...MANIFEST, version: 'one', sidecar: { runtime: 'node', entry: 'bin/s.mjs' }, contributes: { tiles: [{ id: 'x', title: 'X' }] } }
    delete bad.ui
    const r = validateManifest(dir, bad)
    assert.ok(r.errors.some((e) => e.includes('/version')), r.errors.join('\n'))
    assert.ok(r.errors.some((e) => e.includes('needs ui.entry')))
    assert.ok(r.errors.some((e) => e.includes('sidecar:runtime:node')))
    const bare = validateManifest(dir, { ...MANIFEST, id: 'demo' })
    assert.deepEqual(bare.errors, [])
    assert.equal(bare.warnings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pack writes a deterministic zip with the manifest at the archive root', () => {
  const dir = tmp()
  try {
    writeFileSync(join(dir, 'quadflow-plugin.json'), JSON.stringify(MANIFEST))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }))
    writeFileSync(join(dir, 'README.md'), '# Demo\n')
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'dist', 'index.js'), 'import { useState } from "react"; export default { tiles: {} }\n'.repeat(20))
    writeFileSync(join(dir, 'dist', 'index.css'), '.a{color:red}')
    writeFileSync(join(dir, 'assets', 'icon.svg'), '<svg/>')
    writeFileSync(join(dir, 'src', 'index.tsx'), 'not packed')
    writeIntegrity(dir)
    const r1 = packPlugin(dir, { outDir: join(dir, 'out') })
    assert.match(r1.file, /acme\.demo-1\.2\.3\.zip$/)
    assert.equal(readFileSync(`${r1.file}.sha256`, 'utf8'), `${r1.sha256}  acme.demo-1.2.3.zip\n`)
    const r2 = packPlugin(dir, { outDir: join(dir, 'out2') })
    assert.equal(r2.sha256, r1.sha256, 'same inputs → same bytes')

    const x = join(dir, 'x')
    mkdirSync(x)
    unzip(readFileSync(r1.file), x)
    assert.equal(readFileSync(join(x, 'dist', 'index.js'), 'utf8'), readFileSync(join(dir, 'dist', 'index.js'), 'utf8'))
    assert.equal(JSON.parse(readFileSync(join(x, 'quadflow-plugin.json'), 'utf8')).id, 'acme.demo')
    assert.equal(readFileSync(join(x, 'README.md'), 'utf8'), '# Demo\n')
    assert.ok(JSON.parse(readFileSync(join(x, 'dist', '.integrity.json'), 'utf8')).files['dist/index.js'])
    assert.throws(() => readFileSync(join(x, 'src', 'index.tsx')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zip rejects unsafe names', () => {
  assert.throws(() => createZip([{ name: '../x', data: Buffer.from('') }]))
  assert.throws(() => createZip([{ name: 'a\\b', data: Buffer.from('') }]))
})
