/**
 * A tiny virtual terminal: replays raw PTY output (text + the VT/ANSI control
 * sequences TUIs and Windows ConPTY emit) onto a `cols` × `rows` screen with
 * scrollback and returns the final text, one string per line.
 *
 * Why: Claude Code's `/usage` panel is a TUI. Its frames arrive as absolute
 * column jumps (`ESC[54G`), relative cursor moves (`ESC[20A`) and partial
 * redraws of changed cells. Stripping the escapes glues words together and
 * mixes stale and fresh frames; replaying them yields the screen the user sees.
 *
 * Pure (no host calls), so `test/` runs it under plain node.
 */

/** Wide (2-cell) code points: emoji and East Asian wide ranges, roughly. */
function cellWidth(cp: number): number {
  if (cp < 0x1100) return 1
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

export function renderScreen(raw: string, cols = 120, rows = 50): string[] {
  const lines: string[][] = []
  let top = 0 // first line of the visible screen (lines above it are scrollback)
  let row = 0
  let col = 0
  let pendingWrap = false
  let saved = { row: 0, col: 0 }

  const ensure = (r: number) => {
    while (lines.length <= r) lines.push([])
  }
  ensure(rows - 1)
  const clampCol = (c: number) => Math.max(0, Math.min(cols - 1, c))
  const clampRow = (r: number) => Math.max(top, Math.min(top + rows - 1, r))
  const lineFeed = () => {
    if (row >= top + rows - 1) {
      top++
      row = top + rows - 1
    } else row++
    ensure(row)
  }
  const put = (r: number, c: number, ch: string) => {
    ensure(r)
    const l = lines[r]
    while (l.length < c) l.push(' ')
    l[c] = ch
  }
  const eraseLine = (r: number, from: number, to: number) => {
    const l = lines[r]
    if (!l) return
    for (let c = from; c < Math.min(to, l.length); c++) l[c] = ' '
  }
  const blankLines = (from: number, to: number) => {
    for (let r = from; r <= to; r++) {
      ensure(r)
      lines[r] = []
    }
  }

  let i = 0
  const n = raw.length
  while (i < n) {
    const ch = raw[i]
    const code = ch.charCodeAt(0)
    if (ch === '\x1b') {
      const next = raw[i + 1]
      if (next === '[') {
        // CSI: ESC [ params intermediates final
        let j = i + 2
        let params = ''
        while (j < n && /[0-9;:?<=>]/.test(raw[j])) params += raw[j++]
        while (j < n && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j++
        const final = raw[j] ?? ''
        i = j + 1
        const priv = /^[?<=>]/.test(params)
        const nums = params.replace(/^[?<=>]/, '').split(';').map((p) => (p === '' ? NaN : Number(p.split(':')[0])))
        const arg = (k: number, d: number) => (Number.isFinite(nums[k]) && nums[k] > 0 ? nums[k] : d)
        if (priv) {
          // Alternate screen on: a fresh, empty screen.
          if ((final === 'h' || final === 'l') && /(^|;)(1049|47|1047)(;|$)/.test(params.slice(1))) {
            blankLines(top, top + rows - 1)
            row = top
            col = 0
          }
          continue
        }
        pendingWrap = false
        switch (final) {
          case 'A':
            row = clampRow(row - arg(0, 1))
            break
          case 'B':
          case 'e':
            row = clampRow(row + arg(0, 1))
            break
          case 'C':
          case 'a':
            col = clampCol(col + arg(0, 1))
            break
          case 'D':
            col = clampCol(col - arg(0, 1))
            break
          case 'E':
            row = clampRow(row + arg(0, 1))
            col = 0
            break
          case 'F':
            row = clampRow(row - arg(0, 1))
            col = 0
            break
          case 'G':
          case '`':
            col = clampCol(arg(0, 1) - 1)
            break
          case 'd':
            row = clampRow(top + arg(0, 1) - 1)
            break
          case 'H':
          case 'f':
            row = clampRow(top + arg(0, 1) - 1)
            col = clampCol(arg(1, 1) - 1)
            break
          case 'K': {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0
            if (mode === 0) eraseLine(row, col, Infinity)
            else if (mode === 1) eraseLine(row, 0, col + 1)
            else eraseLine(row, 0, Infinity)
            break
          }
          case 'J': {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0
            if (mode === 0) {
              eraseLine(row, col, Infinity)
              blankLines(row + 1, top + rows - 1)
            } else if (mode === 1) {
              blankLines(top, row - 1)
              eraseLine(row, 0, col + 1)
            } else {
              blankLines(top, top + rows - 1)
              if (mode === 3) {
                lines.splice(0, top)
                row -= top
                top = 0
              }
            }
            break
          }
          case 'X':
            eraseLine(row, col, col + arg(0, 1))
            break
          case 'P': {
            ensure(row)
            lines[row].splice(col, arg(0, 1))
            break
          }
          case '@': {
            ensure(row)
            const l = lines[row]
            while (l.length < col) l.push(' ')
            l.splice(col, 0, ...Array<string>(arg(0, 1)).fill(' '))
            if (l.length > cols) l.length = cols
            break
          }
          case 'L': {
            const k = Math.min(arg(0, 1), top + rows - row)
            lines.splice(row, 0, ...Array.from({ length: k }, () => [] as string[]))
            lines.splice(top + rows, k)
            break
          }
          case 'M': {
            const k = Math.min(arg(0, 1), top + rows - row)
            lines.splice(row, k)
            lines.splice(top + rows - k, 0, ...Array.from({ length: k }, () => [] as string[]))
            break
          }
          case 's':
            saved = { row: row - top, col }
            break
          case 'u':
            row = clampRow(top + saved.row)
            col = clampCol(saved.col)
            break
          default:
            // SGR (m), modes, scroll regions, … do not change the text.
            break
        }
        continue
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        // OSC / DCS / APC / PM / SOS: skip to BEL or ST.
        let j = i + 2
        while (j < n && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++
        i = raw[j] === '\x07' ? j + 1 : j + 2
        continue
      }
      if (next === '7') saved = { row: row - top, col }
      else if (next === '8') {
        row = clampRow(top + saved.row)
        col = clampCol(saved.col)
      } else if (next === 'D') lineFeed()
      else if (next === 'E') {
        lineFeed()
        col = 0
      } else if (next === 'M') row = clampRow(row - 1)
      // ESC ( B and friends carry one more byte.
      i += next === '(' || next === ')' || next === '*' || next === '+' || next === '#' ? 3 : 2
      continue
    }
    if (ch === '\r') {
      col = 0
      pendingWrap = false
      i++
      continue
    }
    if (ch === '\n' || ch === '\x0b' || ch === '\x0c') {
      lineFeed()
      pendingWrap = false
      i++
      continue
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1)
      pendingWrap = false
      i++
      continue
    }
    if (ch === '\t') {
      col = clampCol((Math.floor(col / 8) + 1) * 8)
      i++
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      i++
      continue
    }
    // A printable code point (surrogate pairs kept together).
    const cp = raw.codePointAt(i) ?? code
    const s = String.fromCodePoint(cp)
    i += s.length
    const w = cellWidth(cp)
    if (pendingWrap || col + w > cols) {
      col = 0
      lineFeed()
      pendingWrap = false
    }
    put(row, col, s)
    if (w === 2) put(row, col + 1, '')
    if (col + w >= cols) {
      col = cols - 1
      pendingWrap = true
    } else col += w
  }
  return lines.map((l) => l.join('').replace(/\s+$/, ''))
}
