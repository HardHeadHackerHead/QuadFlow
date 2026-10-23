// E2E test of the TUI plugin (plugins/tui, MIG-tui): a tool config of the `tui/run` tile runs
// an interactive program (the Node REPL) in a PTY the plugin owns; typing reaches it and its
// output shows; in a flyout the program keeps running while the flyout is closed and the
// reopened flyout re-attaches to it; "Run Program in Tile…" runs an ad-hoc command line.
//
// Run: node --test scripts/ui/tui.test.mjs   (dev exe: npm run build:dev-exe, or QF_UI_EXE;
// the plugin must be built: npm run build in plugins/tui)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { tauriInvoke, useFirstPartyPlugins } from "./dev-plugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const NAME = "Node REPL qf-e2e";

async function shot(name) {
  if (!s) return;
  try { await s.screenshot(path.join(SHOTS || s.runDir, `${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 20_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg}`);
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function openPalette() {
  // Older hosts' attached xterm swallows Ctrl+K: take focus out of the terminal first.
  await s.eval(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

async function runFromPalette(title, subtitle = "") {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc(title)}\\s*${esc(subtitle)}\\s*$`) }).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const tuiTiles = () => s.page.locator('[data-plugin-id="tui"][data-plugin-tile="run"]');
let paneInstance = null;
/** The node REPL prompt on its own line (xterm rows use non-breaking spaces). */
const PROMPT = /^>[\s ]*$/m;
/** Tiles other than the first test's pane (flyouts, ad-hoc tiles). */
const otherTiles = () => s.page.locator(`[data-plugin-id="tui"][data-plugin-tile="run"]:not([data-plugin-instance="${paneInstance}"])`);
/** The xterm view of a tile (DOM renderer: rows are text). */
const screenText = (tile) => tile.locator(".xterm-rows").innerText().catch(() => "");

async function closeFlyout() {
  // Escape typed into a focused terminal goes to the program, not to the flyout.
  await s.eval(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await s.press("Escape");
}

async function typeInto(tile, text) {
  // Focus xterm's input directly (a flyout's click-outside layer sits over the page).
  await tile.locator('[data-testid="tui-terminal"] textarea').evaluate((el) => el.focus());
  await s.typeKeys(text);
  await s.press("Enter");
}

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await useFirstPartyPlugins(s, ["tui"], {
    // A configured TUI tool: the Node REPL (absolute path of this node, so PATH does not matter).
    beforeReload: (s) =>
      tauriInvoke(s, "tool_configs_create", {
        input: { pluginId: "tui", contributionId: "run", name: NAME, settings: { executablePath: process.execPath, args: ["-i"] } },
      }),
  });
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("tui-final");
  if (s) await s.close();
});

test("a configured TUI tool runs its program in a pane; input and output work", async () => {
  await runFromPalette(`Open ${NAME}`, "TUI Tool");
  const tile = tuiTiles().first();
  await tile.locator('[data-testid="tui-tile"]').waitFor({ timeout: 30_000 });
  paneInstance = await tile.getAttribute("data-plugin-instance");
  await waitUntil(async () => PROMPT.test(await screenText(tile)), { timeout: 30_000, msg: "the node REPL prompt" });
  await typeInto(tile, "6*7");
  await waitUntil(async () => /\b42\b/.test(await screenText(tile)), { msg: "42 from the REPL" });
  await shot("tui-pane");
});

test("in a flyout the program survives closing and reopening the flyout", async () => {
  await runFromPalette(`Open ${NAME} in Flyout`, "TUI Tool");
  await waitUntil(async () => (await tuiTiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  const flyout = otherTiles().first();
  await waitUntil(async () => PROMPT.test(await screenText(flyout)), { timeout: 30_000, msg: "the REPL prompt in the flyout" });
  const termId = await flyout.locator('[data-testid="tui-tile"]').getAttribute("data-terminal-id");
  await typeInto(flyout, "qf=21");
  await waitUntil(async () => /\b21\b/.test(await screenText(flyout)), { msg: "21 in the flyout" });
  await shot("tui-flyout");

  await closeFlyout();
  await waitUntil(async () => !(await otherTiles().first().isVisible().catch(() => false)), { msg: "the flyout to close" });
  await runFromPalette(`Open ${NAME} in Flyout`, "TUI Tool");
  await waitUntil(async () => (await tuiTiles().count()) >= 2, { timeout: 30_000, msg: "the reopened flyout" });
  const again = otherTiles().first();
  await waitUntil(async () => (await again.locator('[data-testid="tui-tile"]').getAttribute("data-terminal-id")) === termId, {
    msg: "the same PTY after reopening",
  });
  // Scrollback is back, and the REPL still has its state.
  await waitUntil(async () => (await screenText(again)).includes("qf=21"), { msg: "the scrollback" });
  await typeInto(again, "qf*2");
  await waitUntil(async () => /\b42\b/.test(await screenText(again)), { msg: "42 from the same REPL" });
  await shot("tui-flyout-reopened");
  await closeFlyout();
});

test("Run Program in Tile… runs an ad-hoc command line", async () => {
  await runFromPalette("Run Program in Tile…", "TUI");
  const input = s.page.locator('[data-testid="plugin-prompt-input"]');
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.fill(`node -e "console.log('adhoc-qf-' + (40 + 2))"`);
  await s.page.locator('[data-testid="plugin-prompt-ok"]').click();
  const tile = s.page.locator('[data-plugin-id="tui"][data-plugin-tile="run"]', { hasText: "adhoc-qf-42" }).first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  // An ad-hoc tile is titled after its program, not after the tool config it borrowed.
  await waitUntil(async () => (await s.page.locator(".mosaic-tile", { hasText: "adhoc-qf-42" }).first().innerText()).includes(NAME) === false, { msg: "the ad-hoc tile title" });
  await shot("tui-adhoc");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e.message ?? e)), []);
});
