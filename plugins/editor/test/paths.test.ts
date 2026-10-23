import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extensionOf, fileNameOf, isEnvFileName, normalizePath, resolveTarget, targetKey } from '../src/paths.ts'

test('normalizePath', () => {
  assert.equal(normalizePath('C:\\proj\\src\\a.ts'), 'C:/proj/src/a.ts')
  assert.equal(normalizePath('./src//a.ts'), 'src/a.ts')
  assert.equal(normalizePath('/home/u/p/'), '/home/u/p')
})

test('resolveTarget: relative paths are project-relative', () => {
  assert.deepEqual(resolveTarget('src\\a.ts', 'C:\\proj'), { path: 'src/a.ts', scope: 'project' })
})

test('resolveTarget: absolute path under the project root (Windows, any case)', () => {
  assert.deepEqual(resolveTarget('c:\\Proj\\src\\a.ts', 'C:\\proj'), { path: 'src/a.ts', scope: 'project' })
  assert.deepEqual(resolveTarget('C:/proj/README.md', 'C:\\proj\\'), { path: 'README.md', scope: 'project' })
})

test('resolveTarget: POSIX paths are case-sensitive', () => {
  assert.deepEqual(resolveTarget('/home/u/p/a.rs', '/home/u/p'), { path: 'a.rs', scope: 'project' })
  assert.equal(resolveTarget('/home/u/P/a.rs', '/home/u/p').scope, 'absolute')
})

test('resolveTarget: outside the project, or a sibling with the same prefix', () => {
  assert.deepEqual(resolveTarget('C:\\other\\a.ts', 'C:\\proj'), { path: 'C:/other/a.ts', scope: 'absolute' })
  assert.equal(resolveTarget('C:\\proj2\\a.ts', 'C:\\proj').scope, 'absolute')
  assert.equal(resolveTarget('C:\\proj\\a.ts', null).scope, 'absolute')
})

test('targetKey ignores case on Windows paths only', () => {
  assert.equal(targetKey({ path: 'C:/A/b.ts', scope: 'absolute' }), targetKey({ path: 'c:\\a\\B.ts', scope: 'absolute' }))
  assert.notEqual(targetKey({ path: 'src/A.ts', scope: 'project' }), targetKey({ path: 'src/a.ts', scope: 'project' }))
})

test('file name, extension, env files', () => {
  assert.equal(fileNameOf('src/lib/a.test.ts'), 'a.test.ts')
  assert.equal(extensionOf('src/lib/a.test.TS'), '.ts')
  assert.equal(extensionOf('Makefile'), '')
  assert.equal(extensionOf('.env'), '')
  assert.ok(isEnvFileName('.env') && isEnvFileName('.env.local') && isEnvFileName('prod.env'))
  assert.ok(!isEnvFileName('environment.ts'))
})
