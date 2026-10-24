// node --test --experimental-strip-types plugins/usage-monitor/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  levelOf,
  maxPercent,
  newlyCritical,
  normalizeSettings,
  providerRows,
  resetLabel,
  countdown,
  isHidden,
  miniGroups,
  miniTooltip,
  shortLabel,
  toggleHidden,
  visibleMax,
} from '../src/model.ts'

const snap = (providerId: string, ...pcts: number[]) => ({
  providerId,
  fetchedAt: 1,
  windows: pcts.map((usedPercent, i) => ({ id: `w${i}`, label: `Window ${i}`, usedPercent })),
})

test('settings: defaults, clamping, poll minimum', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  const s = normalizeSettings({ cooldownSeconds: 5, backgroundPollSeconds: 30, warningThreshold: 150, criticalThreshold: 'x' })
  assert.equal(s.cooldownSeconds, 60)
  assert.equal(s.backgroundPollSeconds, 300)
  assert.equal(s.warningThreshold, 100)
  assert.equal(s.criticalThreshold, DEFAULT_SETTINGS.criticalThreshold)
  assert.equal(normalizeSettings({ backgroundPollSeconds: 0 }).backgroundPollSeconds, 0)
})

test('rows keep every provider, with or without data', () => {
  const providers = [
    { id: 'claude-code', name: 'Claude', color: null },
    { id: 'codex', name: 'Codex', color: '#10a37f' },
  ]
  const rows = providerRows(providers, {
    codex: { status: 'ok', snapshot: snap('codex', 12, 40), error: null, checkedAt: 5 },
  })
  assert.deepEqual(
    rows.map((r) => [r.provider.id, r.status, r.snapshot?.windows.length ?? 0]),
    [
      ['claude-code', 'idle', 0],
      ['codex', 'ok', 2],
    ],
  )
})

test('max percent across providers', () => {
  assert.equal(maxPercent([]), null)
  assert.equal(maxPercent([null, snap('a')]), null)
  assert.equal(maxPercent([snap('a', 10, 55), null, snap('b', 30)]), 55)
})

test('levels follow the thresholds', () => {
  const t = { warningThreshold: 75, criticalThreshold: 90 }
  assert.equal(levelOf(10, t), 'ok')
  assert.equal(levelOf(50, t), 'elevated')
  assert.equal(levelOf(75, t), 'warning')
  assert.equal(levelOf(95, t), 'critical')
})

test('critical toast fires only on the crossing', () => {
  assert.deepEqual(newlyCritical(null, snap('a', 95, 10), 90).map((w) => w.id), ['w0'])
  assert.deepEqual(newlyCritical(snap('a', 92, 10), snap('a', 95, 10), 90), [])
  assert.deepEqual(newlyCritical(snap('a', 92, 80), snap('a', 95, 91), 90).map((w) => w.id), ['w1'])
  assert.deepEqual(newlyCritical(snap('a', 95), null, 90), [])
})

test('reset labels', () => {
  assert.equal(resetLabel({ id: 'a', label: 'A', usedPercent: 1, resetsText: 'Resets 5pm' }), 'Resets 5pm')
  assert.equal(resetLabel({ id: 'a', label: 'A', usedPercent: 1 }), null)
  const now = 1_000_000_000
  assert.equal(resetLabel({ id: 'a', label: 'A', usedPercent: 1, resetsAt: now + 30 * 60_000 }, now), 'Resets in 30m')
  assert.equal(resetLabel({ id: 'a', label: 'A', usedPercent: 1, resetsAt: now + 125 * 60_000 }, now), 'Resets in 2h 5m')
  assert.equal(resetLabel({ id: 'a', label: 'A', usedPercent: 1, resetsAt: now + 50 * 3_600_000 }, now), 'Resets in 2d 2h')
})

// Shapes as the provider hooks report them (plugins/claude-code, plugins/codex fixtures).
const NOW = Date.UTC(2026, 9, 23, 20, 40)
const claude = {
  providerId: 'claude-code',
  fetchedAt: NOW,
  plan: 'Max',
  windows: [
    { id: 'session', label: 'Current session', usedPercent: 11, resetsAt: NOW + 339 * 60_000, resetsText: 'Resets 10:19pm (America/New_York)' },
    { id: 'week', label: 'Current week (all models)', usedPercent: 82, resetsAt: NOW + 3 * 86_400_000 + 15 * 3_600_000 },
    { id: 'week-fable', label: 'Current week (Fable)', usedPercent: 0 },
  ],
}
const codex = {
  providerId: 'codex',
  fetchedAt: NOW,
  plan: 'plus',
  windows: [
    { id: 'primary', label: '5h', usedPercent: 99, resetsAt: NOW + 45 * 60_000 },
    { id: 'secondary', label: 'Weekly', usedPercent: 16 },
  ],
}
const rows = providerRows(
  [
    { id: 'claude-code', name: 'Claude', color: '#d97757' },
    { id: 'codex', name: 'Codex', color: '#10a37f' },
    { id: 'other', name: 'Other', color: null },
  ],
  {
    'claude-code': { status: 'ok', snapshot: claude, error: null, checkedAt: NOW },
    codex: { status: 'ok', snapshot: codex, error: null, checkedAt: NOW },
  },
)

test('mini settings: style and hidden list are normalised', () => {
  assert.equal(DEFAULT_SETTINGS.miniStyle, 'percent')
  assert.deepEqual(DEFAULT_SETTINGS.miniHidden, [])
  const s = normalizeSettings({ miniStyle: 'bogus', miniHidden: ['codex', 'codex', 3, '', 'claude-code/week'] })
  assert.equal(s.miniStyle, 'percent')
  assert.deepEqual(s.miniHidden, ['codex', 'claude-code/week'])
  assert.equal(normalizeSettings({ miniStyle: 'countdown' }).miniStyle, 'countdown')
  assert.deepEqual(normalizeSettings({ miniHidden: 'x' }).miniHidden, [])
})

test('mini: short labels', () => {
  const sl = (id: string, label: string) => shortLabel({ id, label })
  assert.equal(sl('session', 'Current session'), '5h')
  assert.equal(sl('week', 'Current week (all models)'), 'Wk')
  assert.equal(sl('week-fable', 'Current week (Fable)'), 'Fable')
  assert.equal(sl('week-sonnet', 'Current week (Sonnet only)'), 'Sonnet')
  assert.equal(sl('primary', '5h'), '5h')
  assert.equal(sl('secondary', 'Weekly'), 'Wk')
  assert.equal(sl('premium-primary', 'GPT-5 Pro 1h'), 'GPT-5')
  assert.equal(sl('extra-usage', 'Extra usage'), 'Extra')
  assert.equal(sl('x', 'Supercalifragilistic usage'), 'Superca…')
})

test('mini: countdown', () => {
  assert.equal(countdown(undefined, NOW), null)
  assert.equal(countdown(NOW - 5000, NOW), '0m')
  assert.equal(countdown(NOW + 45 * 60_000, NOW), '45m')
  assert.equal(countdown(NOW + 120 * 60_000, NOW), '2h')
  assert.equal(countdown(NOW + 339 * 60_000, NOW), '5h39m')
  assert.equal(countdown(NOW + 3 * 86_400_000 + 15 * 3_600_000, NOW), '3d15h')
  assert.equal(countdown(NOW + 2 * 86_400_000, NOW), '2d')
})

test('mini: every window by default, hide providers and single windows', () => {
  const all = miniGroups(rows, DEFAULT_SETTINGS)
  assert.deepEqual(
    all.map((g) => [g.provider.id, g.windows.map((w) => `${w.short}:${w.level}`)]),
    [
      ['claude-code', ['5h:ok', 'Wk:warning', 'Fable:ok']],
      ['codex', ['5h:critical', 'Wk:ok']],
    ],
  )
  assert.equal(visibleMax(all), 99)
  const s = normalizeSettings({ miniHidden: ['codex', 'claude-code/week-fable'] })
  const some = miniGroups(rows, s)
  assert.deepEqual(some.map((g) => [g.provider.id, g.windows.map((w) => w.key)]), [['claude-code', ['claude-code/session', 'claude-code/week']]])
  assert.equal(visibleMax(some), 82)
  assert.equal(visibleMax(miniGroups(rows, normalizeSettings({ miniHidden: ['codex', 'claude-code'] }))), null)
  assert.equal(isHidden(s.miniHidden, 'codex', 'primary'), true)
  assert.deepEqual(toggleHidden(['a'], 'b', true), ['a', 'b'])
  assert.deepEqual(toggleHidden(['a', 'b'], 'a', false), ['b'])
  assert.deepEqual(toggleHidden(['a'], 'a', true), ['a'])
})

test('mini: tooltip lists every provider and window with resets', () => {
  assert.equal(
    miniTooltip(rows, NOW),
    [
      'Claude (Max)',
      '  Current session: 11% used · Resets 10:19pm (America/New_York)',
      '  Current week (all models): 82% used · Resets in 3d 15h',
      '  Current week (Fable): 0% used',
      'Codex (plus)',
      '  5h: 99% used · Resets in 45m',
      '  Weekly: 16% used',
      'Other: no data',
    ].join('\n'),
  )
  assert.match(miniTooltip([], NOW), /no data yet/)
})
