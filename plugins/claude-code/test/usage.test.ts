// node --test --experimental-strip-types plugins/claude-code/test/
// Fixtures (test/fixtures/usage-conpty-*.json, `output` = the raw bytes as a JSON string so
// git's LF normalisation cannot touch the CRs): Windows ConPTY output of a real `claude`
// 2.1.296 session (`/usage` opened in a 120-column terminal), sanitized (user name and paths
// replaced). No test here runs a CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderScreen } from '../src/screen.ts'
import { parseResetsAt, parseUsageScreen, windowId } from '../src/usageParse.ts'

const fixture = (name: string): string => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')).output
/** 2026-10-23 16:40 in New York (EDT, UTC-4) — when the fixtures were captured. */
const NOW = Date.UTC(2026, 9, 23, 20, 40)

test('screen: text, CR overwrite, absolute columns, relative redraws, erase', () => {
  assert.deepEqual(renderScreen('hello\rj', 20, 5).slice(0, 1), ['jello'])
  assert.deepEqual(renderScreen('a\x1b[5Gb\x1b[10Gc', 20, 5)[0], 'a   b    c')
  // A diff redraw: up two lines, rewrite one cell.
  assert.deepEqual(renderScreen('10% used\r\nResets 5pm\r\n\x1b[2A\x1b[1C1', 20, 5).slice(0, 2), ['11% used', 'Resets 5pm'])
  assert.deepEqual(renderScreen('abcdef\x1b[3G\x1b[K', 20, 5)[0], 'ab')
  assert.deepEqual(renderScreen('x\r\ny\x1b[2J\x1b[Hz', 20, 3).slice(0, 2), ['z', ''])
  // Deferred wrap: a full-width line followed by CRLF does not leave a blank line.
  assert.deepEqual(renderScreen('abcd\r\nef', 4, 5).slice(0, 2), ['abcd', 'ef'])
  // OSC titles are skipped; wide chars take two cells.
  assert.deepEqual(renderScreen('\x1b]0;title\x07ok', 20, 3)[0], 'ok')
  assert.deepEqual(renderScreen('\u{1F600}\x1b[3Gx', 20, 3)[0], '\u{1F600}x')
  // Scrolling: cursor-up cannot reach lines that scrolled off.
  assert.deepEqual(renderScreen('1\r\n2\r\n3\r\n4\x1b[9A\rX', 10, 2), ['1', '2', 'X', '4'])
})

const expected = (sessionPct: number) => ({
  plan: 'Max',
  windows: [
    {
      id: 'session',
      label: 'Current session',
      usedPercent: sessionPct,
      resetsText: 'Resets 10:19pm (America/New_York)',
      resetsAt: Date.UTC(2026, 9, 24, 2, 19),
    },
    {
      id: 'week',
      label: 'Current week (all models)',
      usedPercent: 82,
      resetsText: 'Resets Oct 27, 7:59am (America/New_York)',
      resetsAt: Date.UTC(2026, 9, 27, 11, 59),
    },
    {
      id: 'week-fable',
      label: 'Current week (Fable)',
      usedPercent: 0,
      resetsText: 'Resets Oct 27, 8am (America/New_York)',
      resetsAt: Date.UTC(2026, 9, 27, 12, 0),
    },
  ],
})

test('real /usage capture, 120x100 (the hook\'s size): every window, with resets', () => {
  const lines = renderScreen(fixture('usage-conpty-120x100'), 120, 100)
  // The panel's partial redraw (10% → 11%, cached → fresh) is applied.
  assert.deepEqual(parseUsageScreen(lines, NOW), expected(11))
})

test('real /usage capture, 120x50: the panel is taller than the screen and still parses', () => {
  const lines = renderScreen(fixture('usage-conpty-120x50'), 120, 50)
  assert.deepEqual(parseUsageScreen(lines, NOW), expected(10))
})

test('synthetic panel: model-specific weeks, extra usage, labels on the bar line', () => {
  const screen = [
    '  Settings  Status   Config   Usage   Stats',
    '',
    '  Current session',
    '  ███                    6% used',
    '  Resets 3pm (Europe/Berlin)',
    '',
    '  Current week (all models)',
    '  ████████               40% used',
    '  Resets Nov 2, 10am (Europe/Berlin)',
    '',
    '  Current week (Opus)',
    '  ██                     12% used',
    '',
    '  Current week (Sonnet only)',
    '                          0% used',
    '  Resets Nov 2, 10am (Europe/Berlin)',
    '',
    '  Extra usage',
    '  █████████              55% used',
    '  $5.50 / $10.00 spent · Resets Dec 1 (Europe/Berlin)',
  ]
  const r = parseUsageScreen(screen, NOW)
  assert.deepEqual(
    r.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsText ?? null]),
    [
      ['session', 'Current session', 6, 'Resets 3pm (Europe/Berlin)'],
      ['week', 'Current week (all models)', 40, 'Resets Nov 2, 10am (Europe/Berlin)'],
      ['week-opus', 'Current week (Opus)', 12, null],
      ['week-sonnet', 'Current week (Sonnet only)', 0, 'Resets Nov 2, 10am (Europe/Berlin)'],
      ['extra-usage', 'Extra usage', 55, null],
    ],
  )
  // 3pm Berlin (CEST, UTC+2) on Oct 23 is already past at NOW → tomorrow; Nov 2 is after the DST switch (CET).
  assert.equal(r.windows[0].resetsAt, Date.UTC(2026, 9, 24, 13, 0))
  assert.equal(r.windows[1].resetsAt, Date.UTC(2026, 10, 2, 9, 0))
  assert.equal(r.plan, undefined)
  assert.deepEqual(parseUsageScreen(['nothing here'], NOW), { windows: [] })
})

test('reset text → epoch', () => {
  assert.equal(parseResetsAt('Resets in 2h 5m', NOW), NOW + 125 * 60_000)
  assert.equal(parseResetsAt('Resets in 3 days', NOW), NOW + 3 * 1440 * 60_000)
  assert.equal(parseResetsAt('Resets 11pm (UTC)', NOW), Date.UTC(2026, 9, 23, 23, 0))
  assert.equal(parseResetsAt('Resets 8pm (UTC)', NOW), Date.UTC(2026, 9, 24, 20, 0))
  // A date in early January seen in late October is next year's.
  assert.equal(parseResetsAt('Resets Jan 3, 9:30am (UTC)', NOW), Date.UTC(2027, 0, 3, 9, 30))
  assert.equal(parseResetsAt('Resets Oct 22, 9am (UTC)', NOW), Date.UTC(2026, 9, 22, 9, 0))
  for (const bad of ['Resets soon', 'Resets 5', 'Resets 13pm', 'Resets 5pm (Mars/Olympus)', 'nothing']) {
    assert.equal(parseResetsAt(bad, NOW), undefined, bad)
  }
})

test('window ids', () => {
  assert.equal(windowId('Current session', 0), 'session')
  assert.equal(windowId('Current week (all models)', 1), 'week')
  assert.equal(windowId('Current week (Sonnet only)', 2), 'week-sonnet')
  assert.equal(windowId('Current week (Opus 4.1)', 2), 'week-opus-4-1')
  assert.equal(windowId('Extra usage', 3), 'extra-usage')
  assert.equal(windowId('***', 3), 'window-4')
})
