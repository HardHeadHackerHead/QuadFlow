// node --test --experimental-strip-types "scripts/unit/*.test.ts"  (part of npm run check)
// Pure copy-join logic of terminal tiles (src/lib/terminalCopy.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  joinWrappedText,
  joinSelectedRows,
  hangingIndent,
  firstWordLength,
  isHardWrapContinuation,
  rowsFromText,
  type CopyRow,
} from '../../src/lib/terminalCopy.ts'

/** Word-wrap `text` to `width` like a TUI does (greedy, breaks long words), prefixing rows. */
function wrap(text: string, width: number, first = '', rest = first.replace(/./g, ' ')): string[] {
  const out: string[] = []
  let line = ''
  let prefix = first
  const push = () => {
    out.push(prefix + line)
    prefix = rest
    line = ''
  }
  for (let word of text.split(' ')) {
    const room = () => width - prefix.length - line.length - (line ? 1 : 0)
    while (word.length > width - prefix.length) {
      if (line) push()
      const cut = width - prefix.length
      line = word.slice(0, cut)
      word = word.slice(cut)
      push()
    }
    if (!word) continue
    if (word.length > room()) push()
    line += (line ? ' ' : '') + word
  }
  if (line || out.length === 0) push()
  return out
}

const PARA =
  'When the window is thinner than the line and I copy a paragraph that has no line breaks, ' +
  'the copied text should come out as one paragraph again, without a break at every place where it wrapped.'

test('wrap helper produces rows no wider than the width', () => {
  for (const r of wrap(PARA, 40, '● ')) assert.ok(r.length <= 40, r)
})

test('prose paragraph hard-wrapped at the width joins into one line', () => {
  for (const cols of [30, 40, 57, 80]) {
    const text = wrap(PARA, cols).join('\n')
    assert.equal(joinWrappedText(text, cols), PARA, `cols ${cols}`)
  }
})

test('paragraph breaks (blank lines) survive', () => {
  const cols = 40
  const p2 = 'A second paragraph that also wraps over more than one row of the terminal.'
  const text = [...wrap(PARA, cols), '', ...wrap(p2, cols)].join('\n')
  assert.equal(joinWrappedText(text, cols), `${PARA}\n\n${p2}`)
})

test('Claude Code style "● " message with a hanging indent joins', () => {
  const cols = 50
  const rows = wrap(PARA, cols, '● ')
  assert.ok(rows.length > 2)
  assert.ok(rows[1].startsWith('  ') && !rows[1].startsWith('   '))
  assert.equal(joinWrappedText(rows.join('\n'), cols), `● ${PARA}`)
})

test('Claude Code tool result "  ⎿  " block joins its continuation rows', () => {
  const cols = 45
  const rows = wrap(PARA, cols, '  ⎿  ')
  assert.equal(joinWrappedText(rows.join('\n'), cols), `  ⎿  ${PARA}`)
})

test('bullet list: items stay separate, wrapped items join', () => {
  const cols = 40
  const a = 'First item that is long enough to wrap onto a second row here.'
  const b = 'Second item, short.'
  const c = 'Third item which also wraps because it has quite a few words in it.'
  const text = [...wrap(a, cols, '- '), ...wrap(b, cols, '- '), ...wrap(c, cols, '- ')].join('\n')
  assert.equal(joinWrappedText(text, cols), `- ${a}\n- ${b}\n- ${c}`)
})

test('numbered list inside a Claude Code message', () => {
  const cols = 44
  const intro = 'Here is the plan for the change we discussed earlier today:'
  const one = 'Move the copy logic into a pure function with tests.'
  const two = 'Use it from every copy path of the terminal tile.'
  const text = [...wrap(intro, cols, '● '), ...wrap(one, cols, '  1. '), ...wrap(two, cols, '  2. ')].join('\n')
  assert.equal(joinWrappedText(text, cols), `● ${intro}\n  1. ${one}\n  2. ${two}`)
})

test('code with indentation keeps every line', () => {
  const code = [
    'function joinRows(rows) {',
    '  const out = []',
    '  for (const row of rows) {',
    '    if (row.wrapped) out[out.length - 1] += row.text',
    '    else out.push(row.text)',
    '  }',
    '  return out.join("\\n")',
    '}',
  ].join('\n')
  // Widths wider than the longest line (52): a line ending exactly at the edge is ambiguous by design.
  for (const cols of [60, 80, 120]) assert.equal(joinWrappedText(code, cols), code, `cols ${cols}`)
})

test('code block indented inside a message keeps its lines', () => {
  const cols = 50
  const text = ['● Run this:', '', '    npm run check', '    npm run test:e2e:only', '', '  Then report back.'].join('\n')
  assert.equal(joinWrappedText(text, cols), text)
})

test('short lines (shell output) are never joined', () => {
  const out = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
  assert.equal(joinWrappedText(out, 80), out)
})

test('a line that genuinely ends far from the edge keeps its break even before a long word', () => {
  const text = 'Short heading\nSupercalifragilisticexpialidocious follows here'
  assert.equal(joinWrappedText(text, 80), text)
})

test('a line ending at the edge followed by a new item / blank / other indent keeps its break', () => {
  const cols = 20
  const full = 'x'.repeat(cols)
  assert.equal(joinWrappedText(`${full}\n- item`, cols), `${full}\n- item`)
  assert.equal(joinWrappedText(`${full}\n\nnext`, cols), `${full}\n\nnext`)
  assert.equal(joinWrappedText(`${full}\n    indented`, cols), `${full}\n    indented`)
})

test('a word longer than the width (URL) broken at the edge joins without a space', () => {
  const cols = 30
  const url = 'https://example.com/a/very/long/path/that/does/not/fit/in/one/row?q=1'
  const text = wrap(`See ${url} for details`, cols).join('\n')
  assert.equal(joinWrappedText(text, cols), `See ${url} for details`)
})

test('ConPTY-style rows filled to the last column (lost soft wrap) join without a space', () => {
  const cols = 25
  const long = 'abcdefghijklmnopqrstuvwxyz0123456789-the-end'
  const rows = [long.slice(0, 25), long.slice(25)]
  assert.equal(joinWrappedText(rows.join('\n'), cols), long)
  // A shell line with spaces, cut by characters over several rows.
  // (Cut points avoid spaces: a row starting with a space has another indent and is not joined.)
  const cmd = 'PS C:\\work> echo theX quick brown fox jumps over the lazy dog again and again'
  const cut: string[] = []
  for (let i = 0; i < cmd.length; i += 20) cut.push(cmd.slice(i, i + 20))
  assert.ok(cut.length >= 3 && cut.slice(0, -1).every((r) => r.trimEnd().length === 20))
  assert.equal(joinWrappedText(cut.join('\n'), 20), cmd)
})

test('CRLF and lone CR line endings behave like LF', () => {
  const cols = 40
  const rows = wrap(PARA, cols)
  assert.equal(joinWrappedText(rows.join('\r\n'), cols), PARA)
  assert.equal(joinWrappedText(`a\r\nb\r\n\r\nc`, cols), 'a\nb\n\nc')
})

test('lineBreak option is used for kept breaks', () => {
  assert.equal(joinWrappedText('one\ntwo', 80, { lineBreak: '\r\n' }), 'one\r\ntwo')
})

test('joinHardWraps: false keeps hard wraps but still joins soft wraps', () => {
  const cols = 40
  const text = wrap(PARA, cols).join('\n')
  assert.equal(joinWrappedText(text, cols, { joinHardWraps: false }), text)
  const rows: CopyRow[] = [
    { text: 'x'.repeat(10), fullText: 'x'.repeat(10), endCol: 10, wrapped: false },
    { text: 'yyy', fullText: 'yyy', endCol: 3, wrapped: true },
  ]
  assert.equal(joinSelectedRows(rows, { cols: 10, joinHardWraps: false }), 'xxxxxxxxxxyyy')
})

test('soft-wrapped rows keep a space that sits at the wrap point', () => {
  const rows: CopyRow[] = [
    { text: 'hello the', fullText: 'hello the', endCol: 9, wrapped: false },
    { text: 'world', fullText: 'world', endCol: 5, wrapped: true },
  ]
  // The adapter passes the untrimmed row text when the next row soft-wraps.
  rows[0].text = 'hello the '
  assert.equal(joinSelectedRows(rows, { cols: 10 }), 'hello the world')
})

test('box borders and horizontal rules are never joined', () => {
  const cols = 30
  const box = ['╭────────────────────────────╮', '│ > type here                │', '╰────────────────────────────╯'].join('\n')
  assert.equal(joinWrappedText(box, cols), box)
  const rule = `${'─'.repeat(cols)}\nText after the rule`
  assert.equal(joinWrappedText(rule, cols), rule)
})

test('non-breaking spaces become regular spaces', () => {
  assert.equal(joinWrappedText('a b', 80), 'a b')
})

test('selection starting mid-paragraph joins the rest of the paragraph', () => {
  const cols = 40
  const rows = rowsFromText(wrap(PARA, cols, '● ').join('\n'))
  // Start the selection at the second row (a continuation row).
  const picked = rows.slice(1)
  const expected = PARA.slice(PARA.indexOf(picked[0].text.trim()))
  assert.equal(joinSelectedRows(picked, { cols }), `  ${expected}`)
})

test('helpers', () => {
  assert.equal(hangingIndent('● Hello'), 2)
  assert.equal(hangingIndent('  ⎿  Read 3 files'), 5)
  assert.equal(hangingIndent('  12. Step'), 6)
  assert.equal(hangingIndent('    plain'), 4)
  assert.equal(firstWordLength('   word next'), 4)
  const prev: CopyRow = { text: 'x'.repeat(37), fullText: 'x'.repeat(37), endCol: 37, wrapped: false }
  const next = (t: string): CopyRow => ({ text: t, fullText: t, endCol: t.length, wrapped: false })
  // 3 cells left: "abcd" (4) could not fit after a space -> wrap; "a" fits with margin 0.
  assert.equal(isHardWrapContinuation(prev, next('abcd rest'), 0, 40), true)
  assert.equal(isHardWrapContinuation(prev, next('a rest'), 0, 40, 0), false)
})
