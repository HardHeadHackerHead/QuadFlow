/**
 * `usage` hook (agent-providers.md §9): run the detected `claude` in a hidden
 * plugin terminal, type `/usage`, scrape the rate-limit windows, `/exit`.
 * Port of the former `src-tauri/src/usage_monitor.rs`. No prompt is sent.
 */
import type { AgentUsageSnapshot, AgentUsageWindow, PluginContext } from '@quadflow/plugin-api'
import { PROVIDER_ID, isWindows } from './paths'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(ANSI, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

const PCT = /(\d+(?:\.\d+)?)%\s*used/i
const RESET = /(Resets?\s+.+)/i
const TRUST_PROMPT = /trust this folder/i

/** Parse `/usage` output into windows (labels from the line above each bar). */
export function parseUsageOutput(text: string): AgentUsageWindow[] {
  const lines = text.split(/\r?\n|\r/)
  const bars: number[] = []
  lines.forEach((l, i) => PCT.test(l) && bars.push(i))
  return bars.map((idx, n) => {
    const usedPercent = Math.min(100, Number(PCT.exec(lines[idx])?.[1] ?? 0))
    let label = ''
    for (let j = idx - 1; j >= 0; j--) {
      const prev = lines[j].replace(/[█▌▏▕░▒▓■□─━│|]+/g, ' ').trim()
      if (prev.length < 2 || PCT.test(prev) || RESET.test(prev)) continue
      label = prev
      break
    }
    if (!label) label = n === 0 ? 'Usage' : `Window ${n + 1}`
    let resetsText: string | undefined
    const end = n + 1 < bars.length ? bars[n + 1] : lines.length
    for (let j = idx; j < end; j++) {
      const m = RESET.exec(lines[j].trim())
      if (m) {
        resetsText = m[1].trim()
        break
      }
    }
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `window-${n + 1}`
    return { id, label, usedPercent, resetsText }
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Resolves once no output arrived for `idleMs` (or after `maxMs`). */
async function waitIdle(lastData: () => number, idleMs: number, maxMs: number, until?: () => boolean) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (until?.()) return
    if (Date.now() - lastData() >= idleMs) return
    await sleep(100)
  }
}

export async function fetchUsage(ctx: PluginContext): Promise<AgentUsageSnapshot | null> {
  const det = await ctx.agents.detect(PROVIDER_ID)
  if (!det.installed || !det.path) return null
  const win = isWindows()
  // cmd runs npm `.cmd` shims and native exes alike; the path comes from the
  // core's detection, which rejects quotes and shell metacharacters.
  const term = await ctx.terminals.spawn({
    placement: 'none',
    shell: win ? 'cmd' : 'sh',
    cols: 120,
    rows: 50,
    env: { TERM: 'dumb', NO_COLOR: '1' },
    title: 'Claude usage',
  })
  let out = ''
  let last = Date.now()
  const off = ctx.terminals.onData(term.id, (chunk) => {
    out += chunk
    last = Date.now()
  })
  try {
    await waitIdle(() => last, 600, 3000)
    const cmd = win ? `"${det.path}"` : `'${det.path}'`
    await ctx.terminals.write(term.id, `${cmd}\r`)
    // Startup: wait for the TUI to settle.
    await sleep(2500)
    await waitIdle(() => last, 1200, 8000)
    // Never answer Claude Code's folder-trust dialog on the user's behalf:
    // cancel it (= exit) and report "no data".
    if (TRUST_PROMPT.test(stripAnsi(out))) {
      ctx.log.warn('usage: Claude Code asks whether to trust this folder; open a Claude session here once to enable usage')
      await ctx.terminals.write(term.id, '\x1b')
      await sleep(500)
      return null
    }
    const before = out.length
    await ctx.terminals.write(term.id, '/usage\r')
    await sleep(1500)
    await waitIdle(() => last, 1200, 8000, () => PCT.test(stripAnsi(out.slice(before))) && Date.now() - last > 800)
    await ctx.terminals.write(term.id, '\x1b')
    await sleep(200)
    await ctx.terminals.write(term.id, '/exit\r')
    await sleep(800)
    const text = stripAnsi(out.slice(before))
    const windows = parseUsageOutput(text)
    if (windows.length === 0) {
      ctx.log.warn('usage: no windows found in /usage output', { tail: text.slice(-600) })
      return null
    }
    return { providerId: PROVIDER_ID, fetchedAt: Date.now(), windows }
  } finally {
    off()
    await ctx.terminals.kill(term.id).catch(() => {})
  }
}
