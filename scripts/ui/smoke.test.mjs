// E2E smoke test for QuadFlow, driven through the scripts/ui harness.
// Run: npm run test:e2e   (needs a debug exe: npm run build:dev-exe, or QF_UI_MODE=dev)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { terminalCount, readTerminalLines, typeInTerminal, copyLineContaining, terminalSize } from "./xterm.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;

async function shot(name) {
  if (!s) return;
  const dir = SHOTS || s.runDir;
  try { await s.screenshot(path.join(dir, `${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 20_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg}`);
}

before(async () => {
  s = await launch();
});

after(async () => {
  if (!s) return;
  await shot("final");
  if (s.pageErrors.length) console.log("page errors:", JSON.stringify(s.pageErrors, null, 2));
  console.log(`artifacts: ${s.runDir}`);
  await s.close();
});

test("main window renders the workspace (no auth/onboarding screen)", async () => {
  await s.waitFor("#root > *", { timeout: 60_000 });
  // The toolbar's pinned Terminal tool is always present on a fresh profile.
  await s.waitForText("QuadFlow", { timeout: 60_000 });
  const body = await s.allText();
  assert.doesNotMatch(body, /sign in|log in|license key/i, "unexpected auth screen");
  // The harness sets QUADFLOW_SKIP_ONBOARDING=1: no first-run welcome over the workspace.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await s.page.locator("[data-onboarding]").count(), 0, "onboarding must be skipped under the harness");
  await shot("01-launched");
});

test("open a terminal tile and run a command", async () => {
  const btn = s.page.locator('button[title^="Terminal"]').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
  } else {
    // Fallback: command palette (Ctrl+K) -> "New Terminal".
    await s.press("Control+k");
    await s.typeKeys("New Terminal");
    await s.click("text=New Terminal >> nth=-1");
  }
  await waitUntil(() => terminalCount(s.page), { timeout: 30_000, msg: "an xterm terminal" });
  // Wait for the shell prompt before typing.
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim().length > 0),
    { timeout: 30_000, msg: "shell prompt" });
  await typeInTerminal(s.page, "echo qf-smoke\r");
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === "qf-smoke"),
    { timeout: 20_000, msg: "echo output 'qf-smoke'" });
  await shot("02-terminal-echo");
});

test("a long wrapped line copies back as one line", async () => {
  const size = await terminalSize(s.page);
  assert.ok(size && size.cols > 0, "terminal has a size");
  const token = "qfwrap" + "x".repeat(size.cols * 2 + 7);
  // PowerShell: `echo` writes the token as its own output line.
  await typeInTerminal(s.page, `echo ${token}\r`);
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim() === token),
    { timeout: 20_000, msg: "wrapped output reassembled as one logical line" });
  const copied = await copyLineContaining(s.page, token);
  assert.ok(copied, "found the wrapped line in the buffer");
  assert.ok(copied.rows >= 2, `line should span multiple rows (rows=${copied.rows}, cols=${size.cols})`);
  assert.equal(copied.selection.trim(), token, "copy of a soft-wrapped line must not contain line breaks");
  await shot("03-wrap");
});

test("command palette: Escape closes it, Enter runs the selected command", async () => {
  const input = s.page.locator('input[placeholder="Type a command or search..."]');
  await s.press("Control+k");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await s.press("Escape");
  await input.waitFor({ state: "hidden", timeout: 5_000 });
  const before = await terminalCount(s.page);
  await s.press("Control+k");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill("New Terminal");
  // Enter runs the highlighted row; wait until that is "New Terminal" (results can still
  // change while the plugin registry / tool configs finish loading).
  await waitUntil(
    () => s.page.evaluate(() => {
      const rows = [...document.querySelectorAll("div.cursor-pointer")].filter((r) => r.className.includes("border-vibe-primary"));
      return rows.length === 1 && rows[0].textContent.trim() === "New Terminal";
    }),
    { timeout: 10_000, msg: "'New Terminal' selected in the palette" },
  );
  await s.press("Enter");
  await input.waitFor({ state: "hidden", timeout: 5_000 });
  await waitUntil(async () => (await terminalCount(s.page)) > before, { timeout: 30_000, msg: "a new terminal from Enter" });
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => e.message), []);
});
