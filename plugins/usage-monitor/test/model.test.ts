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
