/** Pure formatting helpers (unit-tested in test/format.test.ts). */

export type ScoreLevel = 'high' | 'medium' | 'low' | 'poor'

export function scoreLevel(score: number): ScoreLevel {
  if (score >= 0.7) return 'high'
  if (score >= 0.5) return 'medium'
  if (score >= 0.3) return 'low'
  return 'poor'
}

/** `0.734` → `73%`. */
export function formatScore(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

export function scoreTone(score: number): 'success' | 'warning' | 'secondary' | 'neutral' {
  switch (scoreLevel(score)) {
    case 'high':
      return 'success'
    case 'medium':
      return 'warning'
    case 'low':
      return 'secondary'
    default:
      return 'neutral'
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** "3 min ago", "2 d ago", or a date for anything older than 30 days. */
export function formatAge(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d <= 30) return `${d} d ago`
  return new Date(ms).toLocaleDateString()
}

/** Last `n` segments of a path, `/`-joined. */
export function tailPath(p: string, n = 2): string {
  return p.split(/[/\\]+/).filter(Boolean).slice(-n).join('/')
}

export function fileName(p: string): string {
  return tailPath(p, 1)
}

/**
 * A readable project label from a provider's project folder name. Providers often encode
 * the working directory into a folder name (path separators replaced by `-`); show the
 * last segment of that.
 */
export function projectLabel(project: string): string {
  if (!project) return ''
  const parts = project.split(/[/\\]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? project
  if (parts.length > 1) return last
  const dashed = last.split('-').filter(Boolean)
  return dashed.length > 2 ? dashed.slice(-2).join('-') : last
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`
}

/** Context block for pasting search excerpts into an agent prompt. */
export function contextBlock(items: { project: string; role?: string | null; content: string }[]): string {
  return items
    .map((r, i) => `--- Related context ${i + 1} (${projectLabel(r.project) || 'session'}, ${r.role || 'unknown'}) ---\n${r.content}`)
    .join('\n\n')
}

/** Text of a progress line, e.g. "Embedding 3/10 · chunk 40/120". */
export function progressText(p: {
  phase: string
  current: number
  total: number
  chunk: number
  chunks: number
  downloadedBytes?: number | null
  totalBytes?: number | null
  fileName?: string | null
}): string {
  const phase = p.phase.charAt(0).toUpperCase() + p.phase.slice(1)
  if (p.phase === 'downloading') {
    const of = p.totalBytes ? ` of ${formatBytes(p.totalBytes)}` : ''
    return `Downloading model${p.fileName ? ` (${p.fileName})` : ''} · ${formatBytes(p.downloadedBytes ?? 0)}${of}`
  }
  if (p.phase === 'scanning' || p.phase === 'loading') return `${phase}…`
  const sessions = p.total ? ` ${Math.min(p.current + 1, p.total)}/${p.total}` : ''
  const chunks = p.chunks ? ` · chunk ${p.chunk}/${p.chunks}` : ''
  return `${phase}${sessions}${chunks}`
}

/** 0–100 overall progress of a job (undefined = indeterminate). */
export function progressPercent(p: { phase: string; current: number; total: number; chunk: number; chunks: number; downloadedBytes?: number | null; totalBytes?: number | null }): number | undefined {
  if (p.phase === 'downloading') return p.totalBytes ? (100 * (p.downloadedBytes ?? 0)) / p.totalBytes : undefined
  if (!p.total) return undefined
  const within = p.chunks ? p.chunk / p.chunks : 0
  return (100 * (p.current + within)) / p.total
}

/** Palette query `semantic search: q`, `semantic: q` or `ss: q` → `q` (else null). */
export function paletteQuery(query: string): string | null {
  const m = /^\s*(?:semantic(?:\s+search)?|ss)\s*:\s*(.+)$/i.exec(query)
  return m ? m[1].trim() : null
}
