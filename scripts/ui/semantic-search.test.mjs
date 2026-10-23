// E2E test of the optional Semantic Search plugin (plugins/semantic-search, MIG-semantic-search):
// the plugin loads (unpacked: it is never bundled), its Rust sidecar indexes a fixture session
// folder (fake provider-format transcripts written by this test into the run dir — no real agent
// data is read: provider session roots are switched off), the tile's search returns the fixture
// session (sessions and excerpts), the flyout shares the index, the palette provider answers
// `semantic search: <query>`, and the settings panel shows the folder.
//
// The test uses the built-in "hashing" model, so nothing is downloaded.
//
// Run: node --test scripts/ui/semantic-search.test.mjs   (dev exe: npm run build:dev-exe, or
// QF_UI_EXE; build the plugin first: `npm run build:sidecar` in plugins/semantic-search, which
// builds the UI and the sidecar binary)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./harness.mjs";
import { tauriInvoke, useFirstPartyPlugins } from "./dev-plugins.mjs";

let s;
let fixtureDir;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const PLUGIN = "semantic-search";

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
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

async function runFromPalette(title, subtitle) {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc(title)}\\s*${esc(subtitle)}\\s*$`) }).first();
  await item.waitFor({ state: "visible", timeout: 30_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const tiles = () => s.page.locator(`[data-plugin-id="${PLUGIN}"][data-plugin-tile="search"]`);

/** Fake session transcripts in the two JSONL shapes the indexer reads. */
function writeFixtures(dir) {
  const a = path.join(dir, "proj-alpha");
  const b = path.join(dir, "proj-beta");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const line = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(
    path.join(a, "sess-fixture-websocket.jsonl"),
    line({ type: "user", message: { role: "user", content: "qf-semantic-fixture: how do we make the websocket reconnect with exponential backoff?" } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I added exponential backoff to the websocket reconnect loop in src/net/socket.ts. That worked." }] } }),
  );
  fs.writeFileSync(
    path.join(b, "sess-fixture-readme.jsonl"),
    line({ type: "session_meta", payload: { id: "x" } }) +
      line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Update the README installation steps for Linux packages." }] } }) +
      line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Updated the README: apt and dnf install instructions." }] } }),
  );
}

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  fixtureDir = path.join(s.runDir, "fixture-sessions");
  writeFixtures(fixtureDir);
  // Settings before the sidecar starts: offline model, only the fixture folder.
  const set = (key, value) => tauriInvoke(s, "settings_set", { namespace: `plugin:${PLUGIN}`, key, value });
  await set("model", "hashing");
  await set("useProviderSessions", false);
  await set("sessionDirs", [{ path: fixtureDir.replace(/\\/g, "/"), glob: "**/*.jsonl", providerId: "fixture-agent" }]);
  await useFirstPartyPlugins(s, [PLUGIN]);
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("semantic-search-final");
  if (s) await s.close();
});

test("the plugin loads; its tile opens from the palette", async () => {
  await runFromPalette("Open Semantic Search", "Semantic Search");
  const tile = tiles().first();
  await tile.locator('[data-testid="semantic-tile"]').waitFor({ timeout: 30_000 });
  // The sidecar answered `status` (model + stats shown).
  await tile.locator('[data-testid="semantic-status"]', { hasText: "sessions indexed" }).waitFor({ timeout: 60_000 });
  assert.match(await tile.locator('[data-testid="semantic-status"]').innerText(), /Keyword hashing/);
});

test("indexes the fixture session folder", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="semantic-index"]').click();
  await tile.locator('[data-testid="semantic-status"]', { hasText: /\b2 sessions indexed/ }).waitFor({ timeout: 90_000 });
  await shot("semantic-search-indexed");
});

test("search returns the fixture session (sessions and excerpts)", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="semantic-query"]').fill("websocket reconnect backoff");
  const first = tile.locator('[data-testid="semantic-hit"]').first();
  await first.waitFor({ timeout: 60_000 });
  await waitUntil(async () => /qf-semantic-fixture/.test(await first.innerText()), { msg: "the fixture session as the top hit" });
  assert.match(await first.innerText(), /alpha/);
  await shot("semantic-search-results");

  await tile.getByRole("tab", { name: "Excerpts", exact: true }).click();
  await waitUntil(async () => /exponential backoff/.test(await tile.locator('[data-testid="semantic-hit"]').first().innerText()), {
    timeout: 30_000,
    msg: "an excerpt of the fixture session",
  });
  await tile.getByRole("tab", { name: "Sessions", exact: true }).click();
});

test("the flyout shares the index", async () => {
  await runFromPalette("Open Semantic Search in Flyout", "Semantic Search");
  const flyout = s.page.locator('[data-testid="semantic-tile"][data-mode="flyout"]');
  await flyout.waitFor({ timeout: 30_000 });
  // Shares the model with the pane: the status (index stats) is there without indexing again.
  await flyout.locator('[data-testid="semantic-status"]', { hasText: /\b2 sessions indexed/ }).waitFor({ timeout: 30_000 });
  await flyout.locator('[data-testid="semantic-query"]').fill("README installation Linux");
  await waitUntil(async () => /README/.test(await flyout.locator('[data-testid="semantic-hit"]').first().innerText()), {
    timeout: 60_000,
    msg: "the readme fixture in the flyout",
  });
  await shot("semantic-search-flyout");
  // Escape in a search input only clears it: leave the input first, then close the flyout.
  await flyout.locator('[data-testid="semantic-query"]').blur();
  await s.press("Escape");
  await flyout.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => s.page.mouse.click(5, 880));
});

test("palette provider answers `semantic search: <query>`", async () => {
  await openPalette();
  await paletteInput().fill("semantic search: websocket reconnect");
  await s.page.locator("div.cursor-pointer", { hasText: "Semantic search: “websocket reconnect”" }).first().waitFor({ timeout: 30_000 });
  await s.page.locator("div.cursor-pointer", { hasText: "qf-semantic-fixture" }).first().waitFor({ timeout: 30_000 });
  await shot("semantic-search-palette");
  await s.press("Escape");
});

test("settings panel lists the session folder", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="semantic-settings-toggle"]').click();
  const panel = tile.locator('[data-testid="semantic-settings"]');
  await panel.waitFor({ timeout: 15_000 });
  await panel.locator('[data-testid="semantic-dir"]', { hasText: "fixture-sessions" }).waitFor({ timeout: 15_000 });
  await shot("semantic-search-settings");
  await tile.locator('[data-testid="semantic-settings-toggle"]').click();
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
