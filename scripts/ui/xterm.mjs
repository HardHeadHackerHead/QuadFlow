// xterm.js helpers for the harness.
//
// The app keeps its xterm `Terminal` objects in a module-private registry and
// in TerminalView's `terminalRef` (a React ref), not on `window`. With the
// WebGL renderer the rows are a canvas, so DOM text is not readable either.
// We therefore locate each Terminal by walking the React fiber of the element
// that hosts `.xterm` and finding a ref whose `.current` looks like a
// Terminal. No app code changes are needed.

import { findTerminalsInPage } from "./harness.mjs";

/** Number of xterm terminals currently mounted. Caches them on window.__qfHarnessTerms. */
export async function terminalCount(page) {
  return page.evaluate(findTerminalsInPage);
}

/**
 * Logical lines of terminal #idx (wrapped rows joined, like copy does).
 * Trailing blank lines are dropped.
 */
export async function readTerminalLines(page, idx = -1) {
  await terminalCount(page);
  return page.evaluate((i) => {
    const terms = window.__qfHarnessTerms || [];
    const t = terms[i < 0 ? terms.length + i : i];
    if (!t) throw new Error(`terminal #${i} not found (have ${terms.length})`);
    const b = t.buffer.active;
    const out = [];
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line) continue;
      const s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    return out;
  }, idx);
}

/** Terminal geometry: { cols, rows }. */
export async function terminalSize(page, idx = -1) {
  await terminalCount(page);
  return page.evaluate((i) => {
    const terms = window.__qfHarnessTerms || [];
    const t = terms[i < 0 ? terms.length + i : i];
    return t ? { cols: t.cols, rows: t.rows } : null;
  }, idx);
}

/**
 * Simulate what the app's copy does (terminal.getSelection()) for the buffer
 * rows that contain `needle`: selects the whole logical line and returns the
 * selected text, so callers can assert a wrapped line copies as one line.
 */
export async function copyLineContaining(page, needle, idx = -1) {
  await terminalCount(page);
  return page.evaluate(({ i, needle }) => {
    const terms = window.__qfHarnessTerms || [];
    const t = terms[i < 0 ? terms.length + i : i];
    if (!t) throw new Error("terminal not found");
    const b = t.buffer.active;
    // Find the LAST logical line containing the needle (the output, not the
    // echoed command line, which also contains it).
    let start = -1, end = -1;
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y);
      if (!line || line.isWrapped) continue;
      let e = y, text = line.translateToString(true);
      while (e + 1 < b.length && b.getLine(e + 1)?.isWrapped) {
        e++; text += b.getLine(e).translateToString(true);
      }
      if (text.includes(needle)) { start = y; end = e; }
    }
    if (start < 0) return null;
    t.selectLines(start, end);
    const sel = t.getSelection();
    t.clearSelection();
    return { start, end, rows: end - start + 1, selection: sel };
  }, { i: idx, needle });
}

/** Focus terminal #idx and type text into it (goes to the PTY). */
export async function typeInTerminal(page, text, idx = -1) {
  const boxes = page.locator(".xterm");
  const n = await boxes.count();
  const el = boxes.nth(idx < 0 ? n + idx : idx);
  await el.click();
  await page.keyboard.type(text);
}
