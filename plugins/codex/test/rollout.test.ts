// node --test --experimental-strip-types plugins/codex/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKTREE_END,
  WORKTREE_START,
  applyWorktreeRegion,
  contextUsageFromRollout,
  homeRelativeSessionPath,
  relativeToRoot,
  renderWorktreeRegion,
  usageFromRollout,
} from '../src/rollout.ts'

const meta = JSON.stringify({ type: 'session_meta', payload: { id: '01a1664a-57ae-7af1-92f9-aba4bb448849', cwd: 'C:\\p' } })
const tokenCount = (info: unknown, rate_limits: unknown = null) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info, rate_limits } })
const info = (total: number, reasoning = 0, window = 475000) => ({
  total_token_usage: { total_tokens: total * 10 },
  last_token_usage: { input_tokens: total - 100, output_tokens: 100, reasoning_output_tokens: reasoning, total_tokens: total },
  model_context_window: window,
})

test('contextUsage: newest token_count with info wins', () => {
  const text = [meta, tokenCount(info(1000)), tokenCount(null), tokenCount(info(49607, 226)), tokenCount(null), ''].join('\n')
  assert.deepEqual(contextUsageFromRollout(text), { usedTokens: 49381, limitTokens: 475000, estimated: false })
})

test('contextUsage: estimate after the last compaction when no token info', () => {
  const big = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(4000) } })
  const small = JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(400) } })
  const text = [meta, big, big, JSON.stringify({ type: 'compacted' }), small].join('\n')
  const u = contextUsageFromRollout(text)
  assert.ok(u && u.estimated && u.limitTokens === null)
  assert.equal(u.usedTokens, Math.round(small.length / 4))
  assert.equal(contextUsageFromRollout(''), null)
})

test('contextUsage: a truncated first line of a tail window is ignored', () => {
  const text = '_tokens":1}}}\n' + tokenCount(info(5000))
  assert.equal(contextUsageFromRollout(text)?.usedTokens, 5000)
})

test('usage: codex limit windows, labels, ms reset times, expired windows', () => {
  const now = 1_792_000_000_000
  const rl = {
    limit_id: 'codex',
    primary: { used_percent: 4.0, window_minutes: 300, resets_at: 1792735524 },
    secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1791000000 },
    plan_type: 'plus',
  }
  const premium = { limit_id: 'premium', primary: { used_percent: 50, window_minutes: 60, resets_at: 1792735524 }, secondary: null }
  const text = [meta, tokenCount(info(10), rl), tokenCount(null, premium)].join('\n')
  assert.deepEqual(usageFromRollout(text, now), {
    providerId: 'codex',
    fetchedAt: now,
    plan: 'plus',
    windows: [
      { id: 'primary', label: '5h', usedPercent: 4, resetsAt: 1792735524000 },
      { id: 'secondary', label: 'Weekly', usedPercent: 0 },
    ],
  })
  // Only a non-codex limit present → used as the fallback.
  assert.equal(usageFromRollout([meta, tokenCount(null, premium)].join('\n'), now)?.windows[0].label, '1h')
  // No rate-limit data at all.
  assert.equal(usageFromRollout([meta, tokenCount(info(1), { limit_id: 'codex', primary: null, secondary: null })].join('\n'), now), null)
})

test('session path → home-relative', () => {
  assert.equal(
    homeRelativeSessionPath('C:\\Users\\me\\.codex\\sessions\\2026\\10\\22\\rollout-x.jsonl'),
    '.codex/sessions/2026/10/22/rollout-x.jsonl',
  )
  assert.equal(homeRelativeSessionPath('/home/me/.codex/sessions/a.jsonl'), '.codex/sessions/a.jsonl')
  assert.equal(homeRelativeSessionPath('/srv/codex-home/sessions/a.jsonl'), null)
  assert.equal(homeRelativeSessionPath('/home/me/.codex/../etc/passwd'), null)
})

test('worktree path relative to the project root', () => {
  assert.equal(relativeToRoot('C:\\Proj', 'c:\\proj\\.worktrees\\a'), '.worktrees/a')
  assert.equal(relativeToRoot('C:\\Proj\\', 'C:\\Proj'), '')
  assert.equal(relativeToRoot('C:\\Proj', 'C:\\Project2\\a'), null)
  assert.equal(relativeToRoot('/home/me/p', '/home/me/P/a'), null) // case-sensitive off Windows
  assert.equal(relativeToRoot('/home/me/p', '/home/me/p/w/../x'), null)
})

test('worktree region: render, append, replace idempotently, preserve outside content', () => {
  const r1 = renderWorktreeRegion({ allowedPaths: ['src/a.ts'], readOnlyPaths: ['docs'], coordinator: false }, '## Mission\nShip it.')
  assert.ok(r1.startsWith(WORKTREE_START) && r1.trimEnd().endsWith(WORKTREE_END))
  assert.match(r1, /`src\/a\.ts`/)
  assert.match(r1, /Read but never modify/)
  assert.match(r1, /Ship it\./)
  const coord = renderWorktreeRegion({ allowedPaths: ['x'], readOnlyPaths: [], coordinator: true }, '')
  assert.match(coord, /coordinator/)
  assert.doesNotMatch(coord, /`x`/)

  assert.equal(applyWorktreeRegion('', r1), r1)
  const user = '# Notes\r\nkeep me\r\n'
  const once = applyWorktreeRegion(user, r1)
  assert.ok(once.startsWith(user))
  const r2 = renderWorktreeRegion({ allowedPaths: [], readOnlyPaths: [], coordinator: false }, '')
  const twice = applyWorktreeRegion(once + 'tail\n', r2)
  assert.equal(twice, user + '\n' + r2 + 'tail\n')
  assert.equal(applyWorktreeRegion(twice, r2), twice)
  assert.throws(() => applyWorktreeRegion(WORKTREE_START + '\nbroken', r2), /without end marker/)
})
