/**
 * Copy text out of a terminal without the line breaks that only exist because
 * the text was wrapped to the terminal width.
 *
 * Two kinds of wrap reach the buffer:
 *
 * - **Soft wraps**: the terminal itself wrapped a long line (xterm marks the
 *   continuation row `isWrapped`). Those rows are always joined, exactly like
 *   xterm's own `getSelection()` does.
 * - **Hard wraps**: a TUI (agent CLIs, any Ink app) word-wraps its own
 *   output to the width and prints real line breaks / cursor moves, so xterm
 *   never sees a wrap. ConPTY can also re-emit wrapped rows as separate rows
 *   (e.g. in a repaint after a resize). Those are recognized with a word-wrap
 *   heuristic, see {@link isHardWrapContinuation}.
 *
 * Everything here is pure (no xterm import) and unit tested in
 * `scripts/unit/terminalCopy.test.ts`; `terminalSelection.ts` adapts it to xterm.
 */

/** One buffer row of the selection. */
export interface CopyRow {
  /** Selected text of the row (right-trimmed unless the next row soft-wraps it). */
  text: string
  /** Text of the whole row (right-trimmed); used for indentation / marker detection. */
  fullText: string
  /**
   * Cells used by the whole row (index of the last non-blank cell + 1), i.e.
   * where the row's content ends, independent of which part is selected.
   */
  endCol: number
  /** xterm soft wrap: this row continues the previous row. */
  wrapped: boolean
}

export interface JoinOptions {
  /** Terminal width in cells. */
  cols: number
  /** Join hard-wrapped rows (TUI word wrap). Soft wraps are always joined. Default true. */
  joinHardWraps?: boolean
  /** Line separator of the result. Default '\n'. */
  lineBreak?: string
  /**
   * Cells a TUI may leave free at the right edge (right padding, gutter) and
   * still count as "wrapped at the width". Default 2.
   */
  rightMargin?: number
}

// List / bullet markers that start a new item (and define a hanging indent).
// Includes the "●" message and "⎿" tool-result markers agent TUIs print.
const MARKER_RE = /^(\s*)([-*+•●○◦▪▫■□◆◇►▶➤→✓✔✗✘⎿]|\d{1,3}[.)]|[a-z][.)])(\s+)/
// Box drawing (U+2500..U+257F) and block elements (U+2580..U+259F): borders and rules.
const BOX_CHARS = '─-▟'
const BOX_RE = new RegExp(`[${BOX_CHARS}]`)
const BOX_EDGE_START_RE = new RegExp(`^\\s*[${BOX_CHARS}]`)
const BOX_EDGE_END_RE = new RegExp(`[${BOX_CHARS}]\\s*$`)
const RULE_RE = new RegExp(`^[-=_*~${BOX_CHARS}\\s]+$`)
const NBSP_RE = new RegExp(String.fromCharCode(0xa0), 'g')

export function leadingSpaces(s: string): number {
  let n = 0
  while (n < s.length && (s[n] === ' ' || s[n] === '\t')) n++
  return n
}

/** Column where the row's content starts after its indent and list marker. */
export function hangingIndent(s: string): number {
  const m = MARKER_RE.exec(s)
  return m ? m[0].length : leadingSpaces(s)
}

export function startsListItem(s: string): boolean {
  return MARKER_RE.test(s)
}

/** Length (in characters) of the first whitespace-delimited word of `s` after its indent. */
export function firstWordLength(s: string): number {
  const m = /^\S+/.exec(s.slice(leadingSpaces(s)))
  return m ? m[0].length : 0
}

function isRule(s: string): boolean {
  const t = s.trim()
  return t.length >= 3 && RULE_RE.test(t)
}

/**
 * Whether row `next` is a word-wrap continuation of the paragraph whose last
 * row is `prev` (`paraHang` = hanging indent of the paragraph's first row).
 *
 * A word wrapper moves a word to the next row only when it does not fit in
 * the room left on the current row, so the row must end close to the right
 * edge: `room <= firstWord(next) + margin`. In addition the next row must
 * look like a continuation: same hanging indent as the paragraph, not a new
 * list item, not blank, no box borders or horizontal rules.
 *
 * Inherently ambiguous: a line that really ends (almost) at the edge and is
 * followed by a line with the same indent looks exactly like a wrap.
 */
export function isHardWrapContinuation(prev: CopyRow, next: CopyRow, paraHang: number, cols: number, rightMargin = 2): boolean {
  const prevText = prev.fullText
  const nextText = next.fullText
  if (prevText.trim() === '' || nextText.trim() === '') return false
  if (startsListItem(nextText)) return false
  if (BOX_EDGE_END_RE.test(prevText) || BOX_EDGE_START_RE.test(nextText)) return false
  if (isRule(prevText) || isRule(nextText)) return false
  // Rows with box characters inside on both sides are layout (tables), not prose.
  if (BOX_RE.test(nextText) && BOX_RE.test(prevText)) return false
  if (leadingSpaces(nextText) !== paraHang) return false
  const room = cols - prev.endCol
  if (room < 0) return false
  const word = firstWordLength(nextText)
  if (word === 0) return false
  return room <= word + rightMargin
}

type Join = 'none' | 'soft' | 'hard'

function clean(s: string): string {
  return s.replace(NBSP_RE, ' ')
}

/**
 * Build the clipboard text for the selected rows: soft-wrapped rows are
 * concatenated, hard-wrapped rows (see {@link isHardWrapContinuation}) are
 * joined, everything else keeps its line break.
 *
 * Separator of a hard-wrap join: a word wrapper drops the space at the break,
 * so it is put back, unless the logical line was wrapped by characters
 * (every joined row filled to the last column, as when ConPTY re-emits a long
 * shell line) or the row is a single word filling the whole width (a URL or
 * path longer than the width, broken inside the word).
 */
export function joinSelectedRows(rows: CopyRow[], opts: JoinOptions): string {
  const { cols } = opts
  const joinHard = opts.joinHardWraps ?? true
  const lineBreak = opts.lineBreak ?? '\n'
  const margin = opts.rightMargin ?? 2

  // Pass 1: how each row attaches to the previous one.
  const joins: Join[] = []
  let paraHang = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (i > 0 && row.wrapped) {
      joins.push('soft')
    } else if (i > 0 && joinHard && isHardWrapContinuation(rows[i - 1], row, paraHang, cols, margin)) {
      joins.push('hard')
    } else {
      joins.push('none')
      paraHang = hangingIndent(row.fullText)
    }
  }

  // Pass 2: build each logical line (rows i..j-1), choosing the hard-join separator.
  const out: string[] = []
  for (let i = 0; i < rows.length; ) {
    let j = i + 1
    while (j < rows.length && joins[j] !== 'none') j++
    // Char-wrapped: at least two hard joins, all after rows filled to the edge. (One filled
    // row alone is more likely a word wrap that happened to end exactly at the edge.)
    let hardJoins = 0
    let charWrapped = true
    for (let k = i + 1; k < j; k++) {
      if (joins[k] !== 'hard') continue
      hardJoins++
      if (rows[k - 1].endCol < cols) charWrapped = false
    }
    charWrapped = charWrapped && hardJoins >= 2
    let line = clean(rows[i].text)
    for (let k = i + 1; k < j; k++) {
      const text = clean(rows[k].text)
      if (joins[k] === 'soft') {
        line += text
        continue
      }
      const prev = rows[k - 1]
      const prevContent = prev.fullText.slice(hangingIndent(prev.fullText))
      const brokenWord = prev.endCol >= cols && !/\s/.test(prevContent)
      const noSpace = charWrapped || brokenWord || line === '' || /\s$/.test(line)
      // A char-wrapped row keeps its leading spaces (content); a word-wrapped row's indent is layout.
      line += charWrapped ? text : (noSpace ? '' : ' ') + text.replace(/^[ \t]+/, '')
    }
    out.push(line)
    i = j
  }
  return out.join(lineBreak)
}

/**
 * Plain text as rows (tests, text printed with LF or CRLF): every line is one
 * row, `endCol` is its trimmed length (ASCII: one cell per character).
 */
export function rowsFromText(text: string): CopyRow[] {
  return text.split(/\r?\n|\r/).map((line) => {
    const t = line.replace(/\s+$/, '')
    return { text: t, fullText: t, endCol: t.length, wrapped: false }
  })
}

/** Join hard-wrapped lines of plain text as it would be copied from a `cols`-wide terminal. */
export function joinWrappedText(text: string, cols: number, opts: Omit<JoinOptions, 'cols'> = {}): string {
  return joinSelectedRows(rowsFromText(text), { ...opts, cols })
}
