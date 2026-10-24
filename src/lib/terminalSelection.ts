/**
 * The one place terminal tiles turn a selection into clipboard text
 * (Ctrl+C / Ctrl+Shift+C, right-click copy, copy on select).
 *
 * With "Join wrapped lines when copying" on, the selected buffer rows go
 * through `joinSelectedRows` (soft wraps + TUI hard wraps joined); with it
 * off, xterm's own `getSelection()` is used unchanged.
 */
import type { Terminal, IBufferLine } from '@xterm/xterm'
import { joinSelectedRows, type CopyRow } from './terminalCopy'

const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent || '')

/** Cells used by a buffer row: index of its last non-blank cell + its width. */
function usedCells(line: IBufferLine): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x)
    if (!cell) continue
    const chars = cell.getChars()
    if (chars !== '' && chars.trim() !== '') return x + Math.max(1, cell.getWidth())
  }
  return 0
}

/** Selected rows of `terminal` as `CopyRow`s (empty when nothing is selected). */
export function selectedRows(terminal: Terminal): CopyRow[] {
  const range = terminal.getSelectionPosition()
  if (!range) return []
  const buffer = terminal.buffer.active
  // getSelectionPosition: 0-based [col, row], end col exclusive.
  const { start, end } = range
  const rows: CopyRow[] = []
  for (let y = start.y; y <= end.y; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    const nextWraps = y < end.y && !!buffer.getLine(y + 1)?.isWrapped
    const startCol = y === start.y ? start.x : 0
    const endCol = y === end.y ? end.x : undefined
    // Keep trailing spaces when the next row soft-wraps this one (a space at the wrap point is content).
    const text = line.translateToString(!nextWraps, startCol, endCol)
    rows.push({
      text,
      fullText: line.translateToString(true),
      endCol: usedCells(line),
      wrapped: y > start.y && line.isWrapped,
    })
  }
  return rows
}

/** Clipboard text for the terminal's current selection ('' when none). */
export function getCopyText(terminal: Terminal, joinWrappedLines: boolean): string {
  if (!terminal.hasSelection()) return ''
  if (!joinWrappedLines) return terminal.getSelection()
  try {
    const rows = selectedRows(terminal)
    if (rows.length === 0) return terminal.getSelection()
    return joinSelectedRows(rows, { cols: terminal.cols, lineBreak: IS_WINDOWS ? '\r\n' : '\n' })
  } catch {
    return terminal.getSelection()
  }
}
