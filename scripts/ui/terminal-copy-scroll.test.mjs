// E2E test of two terminal regressions:
//
// 1. Scrollback after a project switch: project A's terminal has 500 lines of scrollback; switch
//    to project B and back. Both with "Keep terminals alive" off (the PTY is restarted and the saved
//    buffer restored) and on (the live PTY is reattached: the same xterm, with its scrollback, must
//    come back, also for a TUI in the alternate screen). The viewport must scroll with the mouse wheel.
// 2. Copy joins wrapped lines: a long soft-wrapped line and a TUI-style paragraph that was
//    hard-wrapped at the width (explicit newlines, "● " / "  " indent like Claude Code) copy without
//    the wrap breaks, real breaks survive — through Ctrl+Shift+C and right-click copy — and
//    Settings → Terminal → "Join wrapped lines when copying" turns the hard-wrap join off.
//
// The clipboard is never touched: navigator.clipboard.writeText is replaced in the page.
// Run: npm run test:e2e:only (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./harness.mjs";
import { terminalCount, readTerminalLines, typeInTerminal, terminalSize } from "./xterm.mjs";

let s;
let projectA;
let projectB;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const shot = async (n) => { try { await s.screenshot(path.join(SHOTS || s.runDir, `copy-scroll-${n}.png`)); } catch { /* best effort */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 30_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

/** State of the last terminal: buffer + DOM viewport. */
const termState = () => s.page.evaluate(() => {
  const ts = window.__qfHarnessTerms || [];
  const t = ts[ts.length - 1];
  if (!t) return null;
  const v = t.element?.querySelector(".xterm-viewport");
  const b = t.buffer.active;
  return { cols: t.cols, rows: t.rows, length: b.length, baseY: b.baseY, viewportY: b.viewportY, type: b.type, scrollTop: v?.scrollTop ?? -1, connected: !!t.element?.isConnected };
});

async function openTerminal() {
  const before = await terminalCount(s.page);
  await s.page.locator('button[title^="Terminal"]').first().click();
  await waitUntil(async () => (await terminalCount(s.page)) > before, { msg: "new terminal" });
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.includes("PS ")), { msg: "prompt" });
}

async function showSidebar() {
  await waitUntil(async () => {
    if (await s.page.locator('button[title="Keep terminals alive when switching projects"]').first().isVisible().catch(() => false)) return true;
    await s.press("Control+Shift+B");
    await sleep(500);
    return false;
  }, { msg: "the project sidebar", interval: 300 });
}

/** Whether any mounted terminal shows a prompt in `dir` (the project's terminals are shown). */
const promptIn = (dir) => s.eval((d) => {
  const ts = window.__qfHarnessTerms || [];
  return ts.some((t) => {
    const b = t.buffer.active;
    for (let y = b.baseY; y < b.length; y++) if ((b.getLine(y)?.translateToString(true) ?? "").includes(`PS ${d}>`)) return true;
    return false;
  });
}, dir);

/**
 * Switch project through the palette ("Switch Project...") with the folder picker stubbed, then
 * wait until `ready()` (default: a terminal shows a prompt in that directory).
 */
async function switchProject(dir, ready = async () => { await terminalCount(s.page); return promptIn(dir); }) {
  await s.eval((d) => { window.__QF_TEST_PICK_FOLDER__ = () => d; }, dir);
  const input = s.page.locator('input[placeholder="Type a command or search..."]');
  // (Re)open the palette and (re)type until the command is highlighted: the palette can reset
  // its query while the previous switch is still settling.
  await waitUntil(async () => {
    if (!(await input.isVisible().catch(() => false))) {
      await s.press("Control+k");
      await input.waitFor({ state: "visible", timeout: 5_000 });
    }
    if ((await input.inputValue()) !== "Switch Project") await input.fill("Switch Project");
    await sleep(200);
    return s.page.evaluate(() => [...document.querySelectorAll("div.cursor-pointer")]
      .some((r) => r.className.includes("border-vibe-primary") && r.textContent.trim().startsWith("Switch Project")));
  }, { timeout: 15_000, interval: 300, msg: "'Switch Project...' selected" });
  await s.press("Enter");
  await input.waitFor({ state: "hidden", timeout: 5_000 });
  await waitUntil(ready, { msg: `project ${path.basename(dir)} shown` });
}

/** Wheel up over the last terminal; returns the state afterwards. */
async function wheelUp() {
  const box = await s.page.locator(".xterm").last().boundingBox();
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 5; i++) {
    await s.page.mouse.wheel(0, -400);
    await sleep(50);
  }
  await sleep(300);
  await terminalCount(s.page);
  return termState();
}

async function assertScrollable(label) {
  await terminalCount(s.page);
  const st = await waitUntil(async () => {
    const x = await termState();
    return x && x.baseY > 100 && x.viewportY === x.baseY && x.scrollTop > 0 ? x : null;
  }, { msg: `${label}: scrollback present and the viewport synced to the bottom`, timeout: 15_000 });
  const after = await wheelUp();
  assert.ok(after.viewportY < st.viewportY, `${label}: wheel must scroll up (before ${JSON.stringify(st)}, after ${JSON.stringify(after)})`);
  assert.ok(after.scrollTop < st.scrollTop, `${label}: the scrollbar must follow (${st.scrollTop} -> ${after.scrollTop})`);
  // Back to the bottom for the next steps.
  await s.eval(() => { const ts = window.__qfHarnessTerms; ts[ts.length - 1].scrollToBottom(); });
}

before(async () => {
  s = await launch();
  projectA = s.projectDir;
  projectB = fs.mkdtempSync(path.join(path.dirname(s.projectDir), "project-b-"));
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // A project opened for the first time gets the default workspace: make it one plain terminal
  // (the built-in default launches an agent CLI).
  await s.eval(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    await inv("settings_set", { namespace: "shell", key: "defaultWorkspace.panes", value: [{ id: "p1", type: "terminal" }] });
    await inv("settings_set", { namespace: "shell", key: "defaultWorkspace.layoutTree", value: JSON.stringify("p1") });
  });
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("final");
  if (s?.pageErrors.length) console.log("page errors:", JSON.stringify(s.pageErrors, null, 2));
  if (s) await s.close();
});

test("scrollback survives a project switch (PTY restarted, buffer restored)", async () => {
  await openTerminal();
  await typeInTerminal(s.page, '1..500 | % { "line $_" }\r');
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "line 500"), { msg: "500 lines" });
  await assertScrollable("before switching");
  await switchProject(projectB);
  await waitUntil(async () => (await terminalCount(s.page)) === 1, { msg: "project B's terminal" });
  await switchProject(projectA);
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "line 500"), { msg: "A's scrollback restored" });
  const lines = (await readTerminalLines(s.page)).map((l) => l.trim());
  // The restored text starts every line at column 0 (no LF-only staircase).
  for (const n of [1, 123, 250, 499]) assert.ok(lines.includes(`line ${n}`), `restored "line ${n}" (got e.g. ${JSON.stringify(lines.slice(0, 5))})`);
  await assertScrollable("after switching back (restored)");
  await shot("restored");
});

test("with 'Keep terminals alive' the same live terminal comes back, scrollable", async () => {
  await showSidebar();
  await s.click('button[title="Keep terminals alive when switching projects"]');
  await s.press("Control+Shift+B"); // hide the sidebar again (tile width back to normal)
  await typeInTerminal(s.page, '1..400 | % { "keep $_" }\r');
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "keep 400"), { msg: "400 lines" });
  await switchProject(projectB);
  await waitUntil(async () => (await terminalCount(s.page)) === 1, { msg: "project B's terminal" });
  await switchProject(projectA);
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "keep 400"), { msg: "A's live terminal" });
  const lines = (await readTerminalLines(s.page)).map((l) => l.trim());
  assert.ok(lines.includes("keep 1") && lines.includes("keep 200"), "the whole scrollback is still there");
  assert.ok(lines.includes("line 250"), "including the older restored output");
  await assertScrollable("after switching back (kept alive)");
  // Output produced while the project was not shown is not lost either.
  await typeInTerminal(s.page, "Start-Sleep 3; 'written-while-away'\r");
  await switchProject(projectB);
  await sleep(4000);
  await switchProject(projectA);
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "written-while-away"), { msg: "output written while away" });
  await shot("kept-alive");
});

test("a TUI in the alternate screen keeps its screen across a switch", async () => {
  // Enter the alternate screen, draw, and wait for a key (like a full-screen TUI), then leave it.
  const esc = "$([char]27)";
  await typeInTerminal(s.page, `Write-Host -NoNewline "${esc}[?1049h${esc}[2J${esc}[HALT-SCREEN-TUI"; $null = [Console]::ReadKey($true); Write-Host -NoNewline "${esc}[?1049l"\r`);
  await waitUntil(async () => {
    await terminalCount(s.page);
    const st = await termState();
    return st?.type === "alternate" && (await readTerminalLines(s.page)).some((l) => l.includes("ALT-SCREEN-TUI"));
  }, { msg: "alternate screen drawn" });
  await switchProject(projectB);
  await switchProject(projectA, async () => {
    await terminalCount(s.page);
    return (await termState())?.type === "alternate";
  });
  assert.ok((await readTerminalLines(s.page)).some((l) => l.includes("ALT-SCREEN-TUI")), "the TUI's screen is still drawn");
  // A key ends the "TUI": it leaves the alternate screen.
  await typeInTerminal(s.page, "q");
  await waitUntil(async () => (await termState())?.type === "normal", { msg: "back in the normal screen" });
  await assertScrollable("after leaving the alternate screen");
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const PARA =
  "When the window is thinner than the line and I copy a paragraph that has no line breaks, " +
  "the copied text should come out as one paragraph again, without a break at every place where it wrapped.";

/** Greedy word wrap like a TUI (first-row prefix, hanging indent for the rest). */
function wrap(text, width, first = "", rest = " ".repeat(first.length)) {
  const out = [];
  let line = "";
  let prefix = first;
  for (const word of text.split(" ")) {
    if (line && prefix.length + line.length + 1 + word.length > width) {
      out.push(prefix + line);
      prefix = rest;
      line = word;
    } else line += (line ? " " : "") + word;
  }
  out.push(prefix + line);
  return out;
}

async function installClipboardSpy() {
  await s.eval(() => {
    window.__qfCopied = [];
    navigator.clipboard.writeText = async (t) => { window.__qfCopied.push(t); };
  });
}
const lastCopied = () => s.eval(() => (window.__qfCopied || []).at(-1) ?? null);

/** Select buffer rows [from, to] of the last terminal. */
const selectRows = (from, to) => s.eval(({ from, to }) => {
  const ts = window.__qfHarnessTerms; const t = ts[ts.length - 1];
  t.selectLines(from, to);
  return t.hasSelection();
}, { from, to });

/** Buffer rows of the marker lines BEGIN-COPY / END-COPY (the output, not the command line). */
const markerRows = () => s.eval(() => {
  const ts = window.__qfHarnessTerms; const t = ts[ts.length - 1];
  const b = t.buffer.active;
  let begin = -1, end = -1;
  for (let y = 0; y < b.length; y++) {
    const txt = b.getLine(y)?.translateToString(true) ?? "";
    if (txt === "BEGIN-COPY") begin = y;
    if (txt === "END-COPY") end = y;
  }
  return { begin, end };
});

let expected;
let expectedNoHardJoin;

test("copy joins soft and TUI hard wraps, keeps real breaks (Ctrl+Shift+C)", async () => {
  // A narrow tile: three terminals side by side.
  await openTerminal();
  await openTerminal();
  await terminalCount(s.page);
  const { cols } = await terminalSize(s.page);
  assert.ok(cols > 20 && cols < 120, `a narrow terminal (cols=${cols})`);
  const long = `${PARA} ${PARA}`; // well over two rows: soft-wrapped by the terminal
  assert.ok(long.length > cols * 2);
  const tuiRows = wrap(PARA, cols, "● ");
  const list = [...wrap("First item of a list that is long enough to wrap onto the next row of the tile.", cols, "  - "), ...wrap("Second item.", cols, "  - ")];
  const code = ["    function hello() {", "      return 42", "    }"];
  const file = path.join(projectA, "copy-fixture.txt");
  const body = ["BEGIN-COPY", long, "", ...tuiRows, "", ...list, "", ...code, "END-COPY"];
  // UTF-8 with BOM, CRLF: Windows PowerShell reads it as UTF-8 and prints the "●".
  fs.writeFileSync(file, String.fromCharCode(0xfeff) + body.join("\r\n") + "\r\n");
  expected = ["BEGIN-COPY", long, "", `● ${PARA}`, "",
    "  - First item of a list that is long enough to wrap onto the next row of the tile.", "  - Second item.", "",
    ...code, "END-COPY"].join("\n");
  expectedNoHardJoin = ["BEGIN-COPY", long, "", ...tuiRows, "", ...list, "", ...code, "END-COPY"].join("\n");

  await typeInTerminal(s.page, "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Content -Encoding UTF8 copy-fixture.txt\r");
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "END-COPY"), { msg: "fixture printed" });
  await installClipboardSpy();
  const { begin, end } = await markerRows();
  assert.ok(begin >= 0 && end > begin, `markers found (${begin}..${end})`);
  assert.ok(await selectRows(begin, end), "selected");
  await s.eval(() => { const ts = window.__qfHarnessTerms; ts[ts.length - 1].focus(); });
  await s.press("Control+Shift+C");
  const copied = await waitUntil(lastCopied, { msg: "Ctrl+Shift+C copied", timeout: 5_000 });
  assert.equal(copied.replace(/\r\n/g, "\n"), expected);
  await shot("copy");
});

test("right-click copies the selection (and clears it)", async () => {
  const { begin, end } = await markerRows();
  await s.eval(() => { window.__qfCopied = []; });
  assert.ok(await selectRows(begin, end));
  await s.page.locator(".xterm").last().click({ button: "right" });
  const copied = await waitUntil(lastCopied, { msg: "right-click copied", timeout: 5_000 });
  assert.equal(copied.replace(/\r\n/g, "\n"), expected);
  assert.equal(await s.eval(() => { const ts = window.__qfHarnessTerms; return ts[ts.length - 1].hasSelection(); }), false);
});

test("Settings → Terminal: turning off 'Join wrapped lines' keeps the TUI's breaks", async () => {
  await s.click('button[title="Settings"]');
  await s.clickText("Open Settings");
  await s.page.locator(".fixed.inset-0 button", { hasText: /^\s*Terminal\s*$/ }).first().click();
  const row = s.page.locator('[data-testid="setting-join-wrapped-lines"]');
  await row.waitFor({ timeout: 10_000 });
  await row.locator("button").last().click();
  await s.press("Escape");
  await sleep(300);
  const { begin, end } = await markerRows();
  await s.eval(() => { window.__qfCopied = []; });
  assert.ok(await selectRows(begin, end));
  await s.eval(() => { const ts = window.__qfHarnessTerms; ts[ts.length - 1].focus(); });
  await s.press("Control+Shift+C");
  const copied = await waitUntil(lastCopied, { msg: "copied with the setting off", timeout: 5_000 });
  assert.equal(copied.replace(/\r\n/g, "\n"), expectedNoHardJoin);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => e.message), []);
});
