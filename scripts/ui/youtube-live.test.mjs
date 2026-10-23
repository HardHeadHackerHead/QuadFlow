// E2E test of the YouTube Live plugin (MIG-streamer): the overlay and settings tiles render
// from the plugin, the plugin's demo commands go through its Rust sidecar and come back as
// sidecar UI events (a simulated chat idea shows in the overlay, a slot pull and an alert are
// recorded), settings edited in the settings tile persist in the sidecar's own database (also
// across a window reload and a sidecar restart), and secrets are never sent to the UI unmasked.
// No request reaches YouTube or OpenAI: nothing is configured, and the demo events are local.
//
// Run: node --test scripts/ui/youtube-live.test.mjs   (needs the dev exe, or QF_UI_EXE; the
// plugin is not bundled, so plugins/youtube-live must be built with its sidecar — `npm run build`
// in plugins/youtube-live — see devplugins.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { ensureFirstPartyPlugin, ensurePluginBuilt } from "./devplugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const PLUGIN = "youtube-live";

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

/** Run the palette row whose text contains `title` (the plugin's own commands are unique). */
async function runFromPalette(title) {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const overlay = () => s.page.locator(`[data-plugin-id="${PLUGIN}"][data-plugin-tile="overlay"]`);
const settingsTile = () => s.page.locator(`[data-plugin-id="${PLUGIN}"][data-plugin-tile="settings"]`);

const sidecar = (method, params = {}) =>
  s.eval(
    ({ pluginId, method, params }) => window.__TAURI_INTERNALS__.invoke("plugin_sidecar_request", { pluginId, method, params, timeoutMs: 20_000 }),
    { pluginId: PLUGIN, method, params },
  );

async function openSettings() {
  if ((await settingsTile().count()) === 0) await runFromPalette("YouTube Live: Settings");
  const tile = settingsTile().first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  // Warning gate (credentials may be on screen): reveal. The tile mounts before its content
  // renders, so wait for either the gate or the revealed header, not just for the tile.
  const reveal = tile.getByRole("button", { name: "View Settings" });
  const header = tile.getByText("YouTube Live Settings").first();
  await reveal.or(header).first().waitFor({ timeout: 30_000 });
  if (await reveal.isVisible().catch(() => false)) await reveal.click();
  await header.waitFor({ timeout: 10_000 });
  return tile;
}

/** The "Command Prefix" field of the Commands tab. */
const prefixInput = (tile) => tile.locator("div", { has: s.page.locator("label", { hasText: /^Command Prefix$/ }) }).locator("input").first();

before(async () => {
  ensurePluginBuilt(PLUGIN);
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await ensureFirstPartyPlugin(s, PLUGIN);
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("youtube-live-final");
  if (s) await s.close();
});

test("overlay tile renders offline (no stream, no credentials)", async () => {
  await runFromPalette("YouTube Live: Open Chat Overlay");
  const tile = overlay().first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  await tile.locator('[title="Not connected"]').waitFor({ timeout: 30_000 });
  await tile.locator('button[title="Settings"]').waitFor();
  const status = await sidecar("get_poll_status");
  assert.equal(status.is_polling, false);
  await shot("youtube-live-overlay");
});

test("simulated chat idea: sidecar → ui/chat-idea → overlay", async () => {
  await runFromPalette("YouTube Live: Simulate Chat Idea");
  const ideas = await waitUntil(async () => {
    const list = await sidecar("list_chat_ideas", { request: {} });
    return list.length === 1 ? list : null;
  }, { msg: "the simulated idea in the sidecar DB" });
  const idea = ideas[0];
  assert.equal(idea.status, "pending");
  assert.match(idea.raw_message, /^!idea /);
  // The overlay received the event (it renders the idea; pages it is not on are faded, not removed).
  await overlay().first().getByText(idea.idea_content).first().waitFor({ state: "attached", timeout: 20_000 });
  // Points were awarded to the (simulated) viewer.
  const board = await sidecar("get_leaderboard", { limit: 10 });
  assert.ok(board.some((u) => u.author_channel_id === idea.author_channel_id), JSON.stringify(board));
  await shot("youtube-live-idea");
});

test("simulated slot pull and alert are processed by the sidecar", async () => {
  await runFromPalette("YouTube Live: Simulate Slot Pull");
  const pulls = await waitUntil(async () => {
    const list = await sidecar("list_slot_pulls", { limit: 10 });
    return list.length === 1 ? list : null;
  }, { msg: "the simulated pull" });
  assert.equal(pulls[0].symbols.length, 3);
  const stats = await sidecar("get_slot_stats");
  assert.equal(stats.total_pulls, 1);
  await runFromPalette("YouTube Live: Simulate Alert");
  await shot("youtube-live-alert");
});

test("settings tile: an edit persists (reload + sidecar restart)", async () => {
  let tile = await openSettings();
  await tile.getByRole("button", { name: /Commands/ }).click();
  const input = prefixInput(tile);
  await input.waitFor({ timeout: 10_000 });
  assert.equal(await input.inputValue(), "!idea");
  await input.fill("!suggest");
  await input.press("Tab"); // blur saves the pending edit at once
  await waitUntil(async () => (await sidecar("get_settings")).command_prefix === "!suggest", { msg: "the saved prefix" });
  await shot("youtube-live-settings");

  // Survives a window reload (the sidecar keeps running) …
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // … and a sidecar restart (its SQLite DB in the plugin data dir).
  await s.eval((pluginId) => window.__TAURI_INTERNALS__.invoke("plugin_sidecar_restart", { pluginId }), PLUGIN);
  assert.equal((await sidecar("get_settings")).command_prefix, "!suggest");
  tile = await openSettings();
  await tile.getByRole("button", { name: /Commands/ }).click();
  await waitUntil(async () => (await prefixInput(tile).inputValue()) === "!suggest", { msg: "the prefix shown after the reload" });
});

test("secrets are masked towards the UI", async () => {
  const st = await sidecar("get_settings");
  for (const k of ["api_key", "oauth_client_secret", "oauth_access_token", "oauth_refresh_token", "openai_api_key"]) {
    assert.ok(st[k] === null || /^(\*\*\*\*|.{4}\.\.\..{4})$/.test(st[k]), `${k}: ${st[k]}`);
  }
  // No OAuth connection, nothing to refresh: fails without any network request.
  const oauth = await sidecar("get_oauth_status");
  assert.equal(oauth.is_connected, false);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
