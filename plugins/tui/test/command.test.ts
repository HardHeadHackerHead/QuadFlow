import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandLine, parseCommandLine, programFrom, quoteArg, resolveCwd } from '../src/command.ts'

test('programFrom reads tool-config settings', () => {
  assert.equal(programFrom({}), null)
  assert.equal(programFrom({ executablePath: '  ' }), null)
  assert.deepEqual(programFrom({ executablePath: ' lazygit ', args: ['-p', 3], initCommands: ['', 'nvm use'] }), {
    executablePath: 'lazygit',
    args: ['-p'],
    workingDirectory: '',
    initCommands: ['nvm use'],
  })
})

test('parseCommandLine groups quotes', () => {
  assert.deepEqual(parseCommandLine('node -i'), { executablePath: 'node', args: ['-i'] })
  assert.deepEqual(parseCommandLine(`"C:\\Program Files\\x.exe" --a "b c" 'd' ""`), {
    executablePath: 'C:\\Program Files\\x.exe',
    args: ['--a', 'b c', 'd', ''],
  })
  assert.equal(parseCommandLine('   '), null)
})

test('quoteArg', () => {
  assert.equal(quoteArg('--flag=1', 'posix'), '--flag=1')
  assert.equal(quoteArg("it's", 'posix'), `'it'\\''s'`)
  assert.equal(quoteArg("it's here", 'powershell'), `'it''s here'`)
  assert.equal(quoteArg('', 'powershell'), "''")
})

test('commandLine per shell', () => {
  const p = { executablePath: 'C:\\Tools\\lazygit.exe', args: ['-p', 'a b'], workingDirectory: '', initCommands: [] }
  assert.equal(commandLine(p, 'powershell'), `& "C:\\Tools\\lazygit.exe" -p 'a b'`)
  assert.equal(commandLine({ ...p, executablePath: 'htop', args: [] }, 'posix'), 'htop')
  assert.equal(commandLine({ ...p, executablePath: 'tool.py', args: [] }, 'powershell'), 'python "tool.py"')
  assert.equal(commandLine({ ...p, executablePath: 'tool.py', args: ['x'] }, 'posix'), 'python3 tool.py x')
})

test('resolveCwd', () => {
  assert.equal(resolveCwd('', 'C:\\proj'), undefined)
  assert.equal(resolveCwd('sub/dir', 'C:\\proj\\'), 'C:\\proj\\sub\\dir')
  assert.equal(resolveCwd('./web', '/home/u/p'), '/home/u/p/web')
  assert.equal(resolveCwd('D:\\other', 'C:\\proj'), 'D:\\other')
})
