// node --test --experimental-strip-types plugins/scripts/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorContext, looksFailed, platformOf, stripAnsi, withExit } from '../src/runLogic.ts'

test('platform from the user agent', () => {
  assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120'), 'windows')
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos')
  assert.equal(platformOf('Mozilla/5.0 (X11; Linux x86_64)'), 'linux')
})

test('every shell leaves after the command (so the run ends with an exit code)', () => {
  assert.equal(withExit('npm run build', 'cmd'), 'npm run build & exit')
  assert.equal(withExit('npm run build', 'powershell'), 'npm run build; exit $LASTEXITCODE')
  assert.equal(withExit('npm run build', 'pwsh'), 'npm run build; exit $LASTEXITCODE')
  assert.equal(withExit('make', 'bash'), 'make; exit')
  assert.equal(withExit('make', 'zsh'), 'make; exit')
  // Default shell: PowerShell on Windows, POSIX elsewhere.
  assert.equal(withExit('x', null, 'windows'), 'x; exit $LASTEXITCODE')
  assert.equal(withExit('x', undefined, 'linux'), 'x; exit')
})

test('failure = non-zero exit or an error pattern', () => {
  assert.equal(looksFailed(1, 'all good'), true)
  assert.equal(looksFailed(0, 'Done in 2s'), false)
  assert.equal(looksFailed(null, 'Done'), false)
  assert.equal(looksFailed(0, 'src/a.ts(3,1): error TS2304: Cannot find name'), true)
  assert.equal(looksFailed(null, '\x1b[31mnpm ERR!\x1b[0m missing script'), true)
  assert.equal(looksFailed(0, '0 errors, 2 warnings'), false)
})

test('ANSI is stripped and the error context keeps errors plus the tail', () => {
  assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m\r\n50%\r100%'), 'ok\r\n50%\n100%')
  const out = ['start', 'error: boom', ...Array.from({ length: 200 }, (_, i) => `line ${i}`)].join('\n')
  const ctx = errorContext(out)
  assert.ok(ctx.includes('error: boom'))
  assert.ok(ctx.includes('line 199'))
  assert.ok(!ctx.includes('line 50\n'))
  assert.ok(ctx.split('\n').length <= 150)
})
