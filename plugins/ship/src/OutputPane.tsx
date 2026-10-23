/**
 * Read-only output pane for run / fix lines. A light ANSI renderer (SGR colors
 * and bold) instead of an embedded xterm: the lines are already split, there is
 * no input, and plain DOM text is selectable and copyable as is.
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { ShipLineEvent } from '@quadflow/plugin-api'

const t = (name: string) => `rgb(var(--qf-term-${name}))`
/** SGR colors from the theme's terminal palette, so the pane follows light/dark. */
const COLORS: Record<number, string> = {
  30: t('bright-black'), 31: t('red'), 32: t('green'), 33: t('yellow'), 34: t('blue'), 35: t('magenta'), 36: t('cyan'), 37: t('white'),
  90: t('bright-black'), 91: t('bright-red'), 92: t('bright-green'), 93: t('bright-yellow'), 94: t('bright-blue'), 95: t('bright-magenta'), 96: t('bright-cyan'), 97: t('bright-white'),
}

/** Split a line into styled runs at SGR sequences; other escapes are dropped. */
export function ansiRuns(text: string, base?: string): { text: string; color?: string; bold?: boolean }[] {
  const out: { text: string; color?: string; bold?: boolean }[] = []
  let color = base
  let bold = false
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), color, bold })
    last = re.lastIndex
    if (m[1] === undefined) continue
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        color = base
        bold = false
      } else if (code === 1) bold = true
      else if (code === 22) bold = false
      else if (code === 39) color = base
      else if (COLORS[code]) color = COLORS[code]
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), color, bold })
  return out
}

interface Row {
  key: number
  node: ReactNode
}

export function OutputPane({ lines }: { lines: ShipLineEvent[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const rows = useMemo(() => {
    const out: Row[] = []
    let lastPhase: string | null = null
    let k = 0
    const push = (text: string, base?: string) => {
      for (const part of text.split('\n')) {
        out.push({
          key: k++,
          node: ansiRuns(part, base).map((r, i) => (
            <span key={i} style={{ color: r.color, fontWeight: r.bold ? 600 : undefined }}>{r.text}</span>
          )),
        })
      }
    }
    for (const l of lines) {
      if (l.phase !== lastPhase) {
        push(`=== ${l.phase} ===`, COLORS[36])
        lastPhase = l.phase
      }
      push(l.line, l.stream === 'stderr' ? COLORS[31] : l.stream === 'meta' ? COLORS[33] : undefined)
    }
    return out
  }, [lines])

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [rows])

  return (
    <div
      ref={ref}
      data-testid="ship-output"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="h-full w-full overflow-auto px-2 py-1 font-mono text-[12px] leading-[1.35] select-text"
      style={{ background: t('bg'), color: t('fg'), fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace' }}
    >
      {rows.length === 0 ? (
        <div style={{ color: t('bright-black') }}>No output yet.</div>
      ) : (
        rows.map((r) => (
          <div key={r.key} className="whitespace-pre-wrap break-all">
            {r.node}
          </div>
        ))
      )}
    </div>
  )
}
