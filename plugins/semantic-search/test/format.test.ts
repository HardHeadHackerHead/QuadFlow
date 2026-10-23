import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextBlock, formatAge, formatBytes, formatScore, paletteQuery, progressPercent, progressText, projectLabel, scoreLevel } from '../src/format.ts'

test('palette query prefixes', () => {
  assert.equal(paletteQuery('semantic search: websocket reconnect'), 'websocket reconnect')
  assert.equal(paletteQuery('Semantic: foo'), 'foo')
  assert.equal(paletteQuery('ss:bar baz '), 'bar baz')
  assert.equal(paletteQuery('websocket'), null)
  assert.equal(paletteQuery('semantic search'), null)
})

test('scores and sizes', () => {
  assert.equal(formatScore(0.734), '73%')
  assert.equal(formatScore(1.4), '100%')
  assert.equal(scoreLevel(0.75), 'high')
  assert.equal(scoreLevel(0.2), 'poor')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(91_000_000), '87 MB')
  assert.equal(formatBytes(null), '—')
})

test('ages', () => {
  const now = 1_000_000_000_000
  assert.equal(formatAge(null, now), 'never')
  assert.equal(formatAge(now - 10_000, now), 'just now')
  assert.equal(formatAge(now - 5 * 60_000, now), '5 min ago')
  assert.equal(formatAge(now - 3 * 86_400_000, now), '3 d ago')
})

test('project labels from provider folder names', () => {
  assert.equal(projectLabel('C--Users-me-src-my-app'), 'my-app')
  assert.equal(projectLabel('/home/me/work/api'), 'api')
  assert.equal(projectLabel('proj'), 'proj')
  assert.equal(projectLabel(''), '')
})

test('progress', () => {
  const p = { phase: 'embedding', current: 1, total: 4, chunk: 5, chunks: 10 }
  assert.equal(progressText(p), 'Embedding 2/4 · chunk 5/10')
  assert.equal(progressPercent(p), 37.5)
  assert.equal(progressPercent({ phase: 'scanning', current: 0, total: 0, chunk: 0, chunks: 0 }), undefined)
  assert.match(progressText({ phase: 'downloading', current: 0, total: 0, chunk: 0, chunks: 0, downloadedBytes: 2048, totalBytes: 4096, fileName: 'model.safetensors' }), /model\.safetensors.*2\.0 KB of 4\.0 KB/)
})

test('context block', () => {
  const t = contextBlock([{ project: 'C--x-my-app', role: 'user', content: 'hello' }])
  assert.equal(t, '--- Related context 1 (my-app, user) ---\nhello')
})
