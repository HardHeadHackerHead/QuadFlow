/**
 * Pure helpers over Codex rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 * and worktree context regions. No host calls here, so `test/` runs them under plain node.
 *
 * Rollout lines used (codex-cli 0.163):
 *   {"type":"event_msg","payload":{"type":"token_count",
 *     "info":{"last_token_usage":{"input_tokens":…,"total_tokens":…,"reasoning_output_tokens":…},
 *             "model_context_window":475000} | null,
 *     "rate_limits":{"limit_id":"codex","primary":{"used_percent":4.0,"window_minutes":300,"resets_at":<epoch s>},
 *                    "secondary":{…},"plan_type":"plus"}}}
 *   {"type":"compacted",…}   (history was summarised; older lines no longer count)
 */

/** agent-providers.md §4.2 `ContextUsage`. */
export interface CodexContextUsage {
  usedTokens: number
  limitTokens: number | null
  estimated: boolean
}

/** agent-providers.md §4.2 `UsageSnapshot`. */
export interface CodexUsageSnapshot {
  providerId: string
  fetchedAt: number
  plan?: string
  windows: { id: string; label: string; usedPercent: number; resetsAt?: number; resetsText?: string }[]
}

/** agent-providers.md §4.2 `WorktreeScope`. */
export interface CodexWorktreeScope {
  allowedPaths: string[]
  readOnlyPaths: string[]
  coordinator: boolean
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Parse JSONL lines, newest first, skipping blank/partial/invalid lines. */
function* linesNewestFirst(text: string): Generator<Json> {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l || l[0] !== '{') continue
    try {
      const v: unknown = JSON.parse(l)
      if (isObj(v)) yield v
    } catch {
      // a partially written last line, or the first line of a tail window
    }
  }
}

function tokenCountPayload(line: Json): Json | null {
  if (line.type !== 'event_msg' || !isObj(line.payload)) return null
  return line.payload.type === 'token_count' ? line.payload : null
}

/**
 * Context-window usage of a session from (the tail of) its rollout file: the
 * newest `token_count` event with `info` wins (exact). Without one, estimate
 * 4 chars/token over the text after the last `compacted` line.
 */
export function contextUsageFromRollout(text: string): CodexContextUsage | null {
  let charsSinceCompact = 0
  for (const line of linesNewestFirst(text)) {
    const p = tokenCountPayload(line)
    if (p && isObj(p.info)) {
      const info = p.info
      const last = isObj(info.last_token_usage) ? info.last_token_usage : null
      const total = num(last?.total_tokens)
      if (last && total !== null) {
        // Reasoning tokens are dropped from the context after each turn.
        const used = Math.max(0, total - (num(last.reasoning_output_tokens) ?? 0))
        return { usedTokens: used, limitTokens: num(info.model_context_window), estimated: false }
      }
    }
    if (line.type === 'compacted') break
    charsSinceCompact += JSON.stringify(line).length
  }
  if (charsSinceCompact === 0) return null
  return { usedTokens: Math.round(charsSinceCompact / 4), limitTokens: null, estimated: true }
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback
  if (minutes === 10080) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

const MAIN_LIMIT = 'codex'

/**
 * Account rate-limit windows from the newest `token_count` event of every
 * limit (`limit_id`) that carries any: the main `codex` limit's windows first
 * (ids `primary` / `secondary`), then each other limit's (ids
 * `<limit>-primary`, labels prefixed with the limit's name). A window whose
 * reset time has passed is reported as 0 % used. `null` when the text has no
 * rate-limit data. (Rollouts also carry limits with `primary: null` — e.g.
 * `premium` on plans without it — which are skipped.)
 */
export function usageFromRollout(text: string, now: number): CodexUsageSnapshot | null {
  const limits = new Map<string, Json>()
  for (const line of linesNewestFirst(text)) {
    const p = tokenCountPayload(line)
    const rl = p && isObj(p.rate_limits) ? p.rate_limits : null
    if (!rl || !(isObj(rl.primary) || isObj(rl.secondary))) continue
    const id = typeof rl.limit_id === 'string' && rl.limit_id ? rl.limit_id : MAIN_LIMIT
    if (!limits.has(id)) limits.set(id, rl)
  }
  if (limits.size === 0) return null
  const ordered = [...limits.entries()].sort(([a], [b]) => (a === MAIN_LIMIT ? -1 : b === MAIN_LIMIT ? 1 : 0))
  const windows: CodexUsageSnapshot['windows'] = []
  for (const [limitId, rl] of ordered) {
    const main = limitId === MAIN_LIMIT
    const name = typeof rl.limit_name === 'string' && rl.limit_name.trim() ? rl.limit_name.trim() : limitId
    for (const [key, fb] of [
      ['primary', 'Session'],
      ['secondary', 'Weekly'],
    ] as const) {
      const w = rl[key]
      if (!isObj(w)) continue
      const used = num(w.used_percent)
      if (used === null) continue
      const resetsSec = num(w.resets_at)
      const resetsAt = resetsSec === null ? undefined : Math.round(resetsSec * 1000)
      const expired = resetsAt !== undefined && resetsAt <= now
      const label = windowLabel(num(w.window_minutes), fb)
      windows.push({
        id: main ? key : `${limitId}-${key}`,
        label: main ? label : `${name} ${label}`,
        usedPercent: expired ? 0 : Math.min(100, Math.max(0, used)),
        ...(resetsAt !== undefined && !expired ? { resetsAt } : {}),
      })
    }
  }
  if (windows.length === 0) return null
  const first = ordered[0][1]
  const plan = typeof first.plan_type === 'string' ? first.plan_type : undefined
  return { providerId: 'codex', fetchedAt: now, ...(plan ? { plan } : {}), windows }
}

/**
 * `sessionPath` (absolute, under `~/.codex/sessions`) → a path relative to the
 * home directory for the `home` fs scope; `null` when it is not under `.codex/`.
 */
export function homeRelativeSessionPath(sessionPath: string): string | null {
  const p = sessionPath.replaceAll('\\', '/')
  const i = p.lastIndexOf('/.codex/')
  if (i < 0) return null
  const rel = p.slice(i + 1)
  return rel.split('/').some((s) => s === '..') ? null : rel
}

/** `worktreePath` relative to `projectRoot` (forward slashes), or `null` if outside it. */
export function relativeToRoot(projectRoot: string, worktreePath: string): string | null {
  const norm = (s: string) => s.replaceAll('\\', '/').replace(/\/+$/, '')
  const root = norm(projectRoot)
  const wt = norm(worktreePath)
  const caseless = /^[A-Za-z]:\//.test(root) // Windows drive paths compare case-insensitively
  const r = caseless ? root.toLowerCase() : root
  const w = caseless ? wt.toLowerCase() : wt
  if (w === r) return ''
  if (!w.startsWith(r + '/')) return null
  const rel = wt.slice(root.length + 1)
  return rel.split('/').some((s) => s === '..') ? null : rel
}

export const WORKTREE_START = '<!-- quadflow:worktree:start — managed by QuadFlow, do not edit -->'
export const WORKTREE_END = '<!-- quadflow:worktree:end -->'

/** The worktree region body (advisory: Codex has no hook to enforce it). */
export function renderWorktreeRegion(scope: CodexWorktreeScope, contextMarkdown: string): string {
  const out: string[] = [WORKTREE_START, '## Worktree scope', '']
  out.push(
    'You are working in a git worktree prepared by QuadFlow. Codex cannot enforce these rules,',
    'so they are your responsibility: follow them exactly.',
    '',
  )
  if (scope.coordinator) {
    out.push('- You are the **coordinator**: do not create, edit or delete files. Plan, review and delegate', '  through `quadflow missions …` / `quadflow issues …`.')
  } else if (scope.allowedPaths.length > 0) {
    out.push('- Only create, edit or delete files under:')
    for (const p of scope.allowedPaths) out.push(`  - \`${p}\``)
  } else {
    out.push('- You may edit any file in this worktree.')
  }
  if (scope.readOnlyPaths.length > 0) {
    out.push('- Read but never modify:')
    for (const p of scope.readOnlyPaths) out.push(`  - \`${p}\``)
  }
  const extra = contextMarkdown.trim()
  if (extra) out.push('', extra)
  out.push(WORKTREE_END)
  return out.join('\n') + '\n'
}

/**
 * Replace the worktree region in `current` (or append it). Content outside the
 * markers is preserved byte-for-byte. A start marker without an end marker is
 * an error (no silent truncation).
 */
export function applyWorktreeRegion(current: string, region: string): string {
  const start = current.indexOf(WORKTREE_START)
  if (start < 0) {
    if (!current) return region
    return current + (current.endsWith('\n') ? '\n' : '\n\n') + region
  }
  const endAt = current.indexOf(WORKTREE_END, start)
  if (endAt < 0) throw new Error('AGENTS.md: worktree region start marker without end marker')
  let after = endAt + WORKTREE_END.length
  if (current.startsWith('\r\n', after)) after += 2
  else if (current[after] === '\n') after += 1
  return current.slice(0, start) + region + current.slice(after)
}
