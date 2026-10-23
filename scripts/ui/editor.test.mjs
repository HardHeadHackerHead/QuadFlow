// E2E test of the Editor plugin (plugins/editor, MIG-editor): `editor/open` from the palette
// opens a scratch file of the project in an editor tile, the file is edited and saved through
// `ctx.fs` and changes on disk, opening the same file again (relative or absolute path)
// focuses the existing tile instead of opening a second one.
//
// Run: node --test scripts/ui/editor.test.mjs   (dev exe: npm run build:dev-exe, or QF_UI_EXE;
// the plugin must be built: npm run build in plugins/editor)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launch } from "./harness.mjs";
import { useFirstPartyPlugins } from "./dev-plugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const FILE = "notes-qf-e2e.ts";

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

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

async function runCommand(title) {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

async function answerPrompt(value) {
  const input = s.page.locator('[data-testid="plugin-prompt-input"]');
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.fill(value);
  await s.page.locator('[data-testid="plugin-prompt-ok"]').click();
  // The dialog is gone once the answer was handed to the plugin: a following prompt cannot be
  // confused with this one (filled while it is still on screen).
  await input.waitFor({ state: "detached", timeout: 10_000 });
}

const editorTiles = () => s.page.locator('[data-plugin-id="editor"][data-plugin-tile="file"]');
const fileOnDisk = () => readFileSync(path.join(s.projectDir, FILE), "utf8");

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  writeFileSync(path.join(s.projectDir, FILE), "const greeting = 'hello'\n");
  if (await useFirstPartyPlugins(s, ["editor"])) await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("editor-final");
  if (s) await s.close();
});

test("editor/open opens a project file; edit + save changes it on disk", async () => {
  await runCommand("Open File in Editor…");
  await answerPrompt(FILE);
  const tile = editorTiles().first();
  await tile.locator('[data-testid="editor-tile"]').waitFor({ timeout: 30_000 });
  await tile.locator(".cm-content", { hasText: "const greeting = 'hello'" }).waitFor({ timeout: 20_000 });
  assert.equal(await tile.locator('[data-testid="editor-tile"]').getAttribute("data-file"), FILE);
  // Language support is a lazily loaded chunk of the plugin: TypeScript is recognised.
  await tile.getByText("TypeScript").waitFor({ timeout: 10_000 });
  await shot("editor-open");

  // Read-only until "Edit"; then type and save with Ctrl+S.
  await tile.locator('[data-testid="editor-toggle-edit"]').click();
  await tile.getByText("Editing").waitFor();
  await tile.locator(".cm-content").click();
  await s.press("Control+End");
  await s.typeKeys("export const saved = 42");
  await tile.locator('[data-testid="editor-dirty"]').waitFor({ timeout: 10_000 });
  await s.press("Control+s");
  await waitUntil(async () => fileOnDisk().includes("export const saved = 42"), { msg: "the saved file on disk" });
  await tile.locator('[data-testid="editor-dirty"]').waitFor({ state: "detached", timeout: 10_000 });
  assert.match(fileOnDisk(), /^const greeting = 'hello'\n/);
  await shot("editor-saved");
});

test("opening the same file again focuses the existing tile (relative and absolute path)", async () => {
  await runCommand("Open File in Editor…");
  await answerPrompt(FILE);
  await runCommand("Open File in Editor…");
  await answerPrompt(path.join(s.projectDir, FILE));
  // A second tile would appear shortly after the answer; give it time, then there is still one.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await editorTiles().count(), 1);
  assert.equal(await editorTiles().first().locator('[data-testid="editor-tile"]').getAttribute("data-file"), FILE);
});

test("an empty editor tile offers a path field", async () => {
  await runCommand("Open Editor");
  await waitUntil(async () => (await editorTiles().count()) === 2, { msg: "a second (empty) editor tile" });
  const empty = editorTiles().last();
  await empty.locator('[data-testid="editor-path-input"]').fill("missing-qf-e2e.txt");
  await empty.getByRole("button", { name: "Open", exact: true }).click();
  await empty.locator('[data-testid="editor-error"]').waitFor({ timeout: 15_000 });
  await shot("editor-missing");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e.message ?? e)), []);
});
