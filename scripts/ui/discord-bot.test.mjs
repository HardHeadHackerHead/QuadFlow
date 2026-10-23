// Render-only E2E test of the Discord Bot plugin (plugins/discord-bot, on hold / experimental,
// not bundled): loaded unpacked from this checkout, its tile opens from the palette in a pane,
// shows the experimental notice and "Disconnected", saves the server / channel ids into the
// plugin's settings, and refuses to start without a bot token. No Discord token, no network.
// On hosts whose terminal ⋯ menu renders `contextMenus` (location "terminal") it also checks that
// "Share to / stop sharing on Discord" is offered there.
//
// Run: node --test scripts/ui/discord-bot.test.mjs   (dev exe: npm run build:dev-exe, or QF_UI_EXE;
// the plugin must be built: npm run build in plugins/discord-bot)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { useFirstPartyPlugins } from "./dev-plugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;

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

const botTile = () => s.page.locator('[data-plugin-id="discord-bot"][data-plugin-tile="bot"]').first();
const errors = [];

before(async () => {
  s = await launch();
  s.page.on("pageerror", (e) => errors.push(String(e)));
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await useFirstPartyPlugins(s, ["discord-bot"]);
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("discord-bot-final");
  if (s) await s.close();
});

test("the Discord Bot tile renders in a pane", async () => {
  await runFromPalette("Open Discord Bot", "Discord Bot");
  const tile = botTile();
  await tile.locator('[data-testid="discord-bot"]').waitFor({ timeout: 30_000 });
  assert.match(await tile.innerText(), /Experimental/);
  assert.equal((await tile.locator('[data-testid="discord-status"]').innerText()).trim(), "Disconnected");
  assert.match(await tile.innerText(), /Mirrored Terminals \(0\)/);
  await shot("discord-bot-pane");
});

test("ids are saved in the plugin settings; starting without a token is refused", async () => {
  const tile = botTile();
  await tile.getByPlaceholder("Discord server ID").fill("111111111111111111");
  await tile.getByPlaceholder("Text channel for threads").fill("222222222222222222");
  await tile.getByRole("button", { name: "Save Changes" }).click();
  // While saving, the button reads "Saving..." (no longer "Save Changes"): wait until it is gone in
  // both forms, i.e. the settings writes have finished, before reloading.
  await tile.getByRole("button", { name: /^(Save Changes|Saving\.\.\.)$/ }).waitFor({ state: "detached", timeout: 10_000 });

  // The ids live in the plugin's settings (`ctx.settings`): they survive a reload.
  await s.page.reload();
  await s.page.waitForLoadState("domcontentloaded");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // The restored workspace brings the tile back; open it only if it does not.
  const restored = await waitUntil(() => botTile().isVisible(), { timeout: 10_000, msg: "the restored tile" }).catch(() => false);
  if (!restored) await runFromPalette("Open Discord Bot", "Discord Bot");
  const reopened = botTile();
  await reopened.locator('[data-testid="discord-bot"]').waitFor({ timeout: 30_000 });
  await waitUntil(async () => {
    const values = await reopened.locator('input[type="text"]').evaluateAll((els) => els.map((el) => el.value));
    return values.includes("111111111111111111") && values.includes("222222222222222222");
  }, { msg: "the saved ids after a reload" });

  await reopened.getByRole("button", { name: "Start Bot" }).click();
  await waitUntil(async () => /Set the bot token first/.test(await reopened.innerText()), { msg: "the missing-token error" });
  assert.equal((await reopened.locator('[data-testid="discord-status"]').innerText()).trim(), "Disconnected");
  await shot("discord-bot-no-token");
});

test("a terminal's ⋯ menu offers sharing to Discord (hosts that render terminal context menus)", async (t) => {
  await s.page.locator('button[title^="Terminal"]').first().click();
  const more = s.page.locator('button[title="More actions"]').first();
  await more.waitFor({ timeout: 30_000 });
  await more.click();
  const item = s.page.getByRole("button", { name: "Share to / stop sharing on Discord" });
  if (!(await item.isVisible().catch(() => false))) {
    await s.press("Escape");
    t.skip("this host does not render contextMenus with location \"terminal\" yet");
    return;
  }
  await item.click();
  // The bot is stopped: the command explains instead of mirroring.
  await waitUntil(async () => /Discord share failed|Start the bot/.test(await s.page.innerText("body")), { msg: "the not-running toast" });
  await shot("discord-bot-share-menu");
});

test("no page errors", () => {
  assert.deepEqual(errors, []);
});
