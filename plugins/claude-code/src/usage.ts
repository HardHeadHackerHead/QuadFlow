/**
 * `usage` hook (agent-providers.md §9): run the detected `claude` in a hidden
 * plugin terminal, open `/usage`, replay the terminal output onto a virtual
 * screen (./screen.ts), read every rate-limit window off it (./usageParse.ts),
 * `/exit`. No prompt is sent.
 */
import type { AgentUsageSnapshot, PluginContext } from '@quadflow/plugin-api'
import { PROVIDER_ID, isWindows } from './paths'
import { renderScreen } from './screen'
import { USAGE_LOADING, parseUsageScreen } from './usageParse'

/** Tall enough that the whole panel stays on screen (redraws cannot reach scrolled-off lines). */
const COLS = 120
const ROWS = 100

const TRUST_PROMPT = /trust this folder/i
const PCT = /\d+(?:\.\d+)?\s*%\s*used\b/i

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Resolves once no output arrived for `idleMs` (or after `maxMs`), or `until()` holds. */
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
    cols: COLS,
    rows: ROWS,
    env: { TERM: 'dumb', NO_COLOR: '1' },
    title: 'Claude usage',
  })
  let out = ''
  let last = Date.now()
  const off = ctx.terminals.onData(term.id, (chunk) => {
    out += chunk
    last = Date.now()
  })
  const screenText = () => renderScreen(out, COLS, ROWS)
  try {
    await waitIdle(() => last, 600, 3000)
    const cmd = win ? `"${det.path}"` : `'${det.path}'`
    await ctx.terminals.write(term.id, `${cmd}\r`)
    // Startup: wait for the TUI to settle.
    await sleep(2500)
    await waitIdle(() => last, 1200, 8000)
    // Never answer Claude Code's folder-trust dialog on the user's behalf:
    // cancel it (= exit) and report "no data".
    if (TRUST_PROMPT.test(screenText().join('\n'))) {
      ctx.log.warn('usage: Claude Code asks whether to trust this folder; open a Claude session here once to enable usage')
      await ctx.terminals.write(term.id, '\x1b')
      await sleep(500)
      return null
    }
    await ctx.terminals.write(term.id, '/usage\r')
    await sleep(1500)
    // The panel first shows cached numbers with "Refreshing…", then redraws
    // only the changed cells. Wait for a quiet screen without a loading marker.
    const settled = () => {
      if (Date.now() - last < 1000) return false
      const text = screenText().join('\n')
      return PCT.test(text) && !USAGE_LOADING.test(text)
    }
    await waitIdle(() => last, 4000, 15000, settled)
    const parsed = parseUsageScreen(screenText(), Date.now())
    await ctx.terminals.write(term.id, '\x1b')
    await sleep(200)
    await ctx.terminals.write(term.id, '/exit\r')
    await sleep(800)
    if (parsed.windows.length === 0) {
      ctx.log.warn('usage: no windows found in /usage output', { tail: screenText().slice(-30).join('\n') })
      return null
    }
    return {
      providerId: PROVIDER_ID,
      fetchedAt: Date.now(),
      ...(parsed.plan ? { plan: parsed.plan } : {}),
      windows: parsed.windows,
    }
  } finally {
    off()
    await ctx.terminals.kill(term.id).catch(() => {})
  }
}
