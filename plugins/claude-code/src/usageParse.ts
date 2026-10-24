/**
 * Parse Claude Code's `/usage` panel (Settings → Usage) from the rendered
 * screen (./screen.ts). Pure, no host calls: `test/` runs it under plain node
 * against sanitized real captures (test/fixtures/).
 *
 * The panel (Claude Code 2.1.x) looks like:
 *
 *     Current session
 *     █████▌                                             11% used
 *     Resets 10:19pm (America/New_York)
 *
 *     Current week (all models)
 *     █████████████████████████████████████████          82% used
 *     Resets Oct 27, 7:59am (America/New_York)
 *
 *     Current week (Fable)                     ← one block per model-specific weekly limit
 *                                                         0% used
 *     Resets Oct 27, 8am (America/New_York)
 *
 * Every `NN% used` bar becomes a window, labelled by the line above it, with
 * the `Resets …` line below it (text kept verbatim, and parsed into an epoch
 * when it is unambiguous).
 */

export interface ClaudeUsageWindow {
  id: string
  label: string
  usedPercent: number
  resetsAt?: number
  resetsText?: string
}

export interface ClaudeUsageParse {
  windows: ClaudeUsageWindow[]
  /** "Max", "Pro", … from the welcome banner (`· Claude Max`), when shown. */
  plan?: string
}

const PCT = /(\d+(?:\.\d+)?)\s*%\s*used\b/i
const RESET_LINE = /^\s*(Resets?\b.*)$/i
const BAR_GLYPHS = /[█▉▊▋▌▍▎▏▐░▒▓■□▕─━│|]+/g
const PANEL_TABS = /\bStatus\b.*\bConfig\b.*\bUsage\b/
const PLAN = /·\s*Claude\s+(Max|Pro|Team|Enterprise|Free)\b/i
/** Screens that are still loading (the panel redraws once the data arrived). */
export const USAGE_LOADING = /\b(Loading|Refreshing|Fetching)\b[^\n]*…|\bLoading usage\b/i

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Stable ids: `session`, `week`, `week-<model>`, else a slug of the label. */
export function windowId(label: string, n: number): string {
  const l = label.trim().toLowerCase()
  if (/^(current )?session$/.test(l) || /5[- ]?hour/.test(l)) return 'session'
  const week = /^(?:current )?week(?:ly)?(?:\s*\(([^)]*)\))?$/.exec(l)
  if (week) {
    const model = (week[1] ?? '').trim()
    return !model || /^all( models)?$/.test(model) ? 'week' : `week-${slug(model.replace(/\s+only$/, ''))}`
  }
  return slug(l) || `window-${n + 1}`
}

const clean = (s: string) => s.replace(BAR_GLYPHS, ' ').replace(/\s+/g, ' ').trim()

/** Windows (and the plan) from the screen lines of a finished `/usage` panel. */
export function parseUsageScreen(lines: string[], now = Date.now()): ClaudeUsageParse {
  let plan: string | undefined
  for (const l of lines) {
    const m = PLAN.exec(l)
    if (m) plan = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  }
  // Only the panel: everything after its tab row, when present.
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PANEL_TABS.test(lines[i])) {
      start = i + 1
      break
    }
  }
  const windows: ClaudeUsageWindow[] = []
  const seen = new Set<string>()
  for (let i = start; i < lines.length; i++) {
    const m = PCT.exec(lines[i])
    if (!m) continue
    // The label: the bar line's own text before the bar, else the nearest line above.
    let label = clean(lines[i].slice(0, m.index))
    for (let j = i - 1; !label && j >= Math.max(start, i - 3); j--) {
      const prev = clean(lines[j])
      if (!prev || PCT.test(prev) || RESET_LINE.test(prev)) continue
      label = prev
    }
    if (!label) label = windows.length === 0 ? 'Usage' : `Window ${windows.length + 1}`
    let resetsText: string | undefined
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const r = RESET_LINE.exec(lines[j])
      if (r) {
        resetsText = r[1].replace(/\s+/g, ' ').trim()
        break
      }
      if (PCT.test(lines[j])) break
    }
    let id = windowId(label, windows.length)
    if (seen.has(id)) id = `${id}-${windows.length + 1}`
    seen.add(id)
    const resetsAt = resetsText ? parseResetsAt(resetsText, now) : undefined
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, Number(m[1]))),
      ...(resetsText ? { resetsText } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
  }
  return { windows, ...(plan ? { plan } : {}) }
}

// ---------------------------------------------------------------------------
// "Resets …" → epoch ms
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return undefined
  }
}

/** Wall-clock fields of `t` in `tz` (local time zone when undefined). */
function zonedParts(t: number, tz: string | undefined) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  const p: Record<string, number> = {}
  for (const part of f.formatToParts(new Date(t))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second }
}

/** Epoch ms of a wall-clock time in `tz`. */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string | undefined): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  const offsetAt = (t: number) => {
    const z = zonedParts(t, tz)
    return Date.UTC(z.y, z.mo, z.d, z.h, z.mi, z.s) - Math.floor(t / 1000) * 1000
  }
  const o1 = offsetAt(guess)
  const t1 = guess - o1
  const o2 = offsetAt(t1)
  return o2 === o1 ? t1 : guess - o2
}

/**
 * Parse Claude Code's reset text: `Resets 10:19pm (America/New_York)`,
 * `Resets Oct 27, 8am (Europe/Berlin)`, `Resets in 2h 5m`. A time without a
 * date is its next occurrence; a date without a year is this year's (or next
 * year's, when that is already well past). `undefined` when unsure.
 */
export function parseResetsAt(text: string, now = Date.now()): number | undefined {
  const rel = /Resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?/i.exec(text)
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const mins = Number(rel[1] ?? 0) * 1440 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)
    return now + mins * 60_000
  }
  const m =
    /Resets?\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(([^)]+)\))?/i.exec(
      text,
    )
  if (!m) return undefined
  const [, mon, day, year, hh, mm, ampm, zone] = m
  if (!ampm && mm === undefined) return undefined // "Resets 5" — not a time
  let h = Number(hh)
  if (ampm) {
    if (h < 1 || h > 12) return undefined
    const pm = ampm[0].toLowerCase() === 'p'
    h = (h % 12) + (pm ? 12 : 0)
  } else if (h > 23) return undefined
  const mi = Number(mm ?? 0)
  if (mi > 59) return undefined
  const tz = validZone(zone?.trim())
  if (zone && !tz && !/^(local|utc)$/i.test(zone.trim())) return undefined
  const zoneId = tz ?? (zone && /^utc$/i.test(zone.trim()) ? 'UTC' : undefined)
  const today = zonedParts(now, zoneId)
  if (mon) {
    const mo = MONTHS.indexOf(mon.toLowerCase())
    if (mo < 0) return undefined
    const d = Number(day)
    let y = year ? Number(year) : today.y
    let t = zonedToEpoch(y, mo, d, h, mi, zoneId)
    if (!year && t < now - 2 * 86_400_000) t = zonedToEpoch(++y, mo, d, h, mi, zoneId)
    return t
  }
  let t = zonedToEpoch(today.y, today.mo, today.d, h, mi, zoneId)
  if (t <= now - 60_000) t = zonedToEpoch(today.y, today.mo, today.d + 1, h, mi, zoneId)
  return t
}
