// E2E test of the Web Preview plugin (plugins/web-preview, MIG-web-preview): a local page
// served by the test opens in the tile's child webview (`ctx.native.createChildWebview`), it
// can be bookmarked (per-project `ctx.storage`, shared by pane and flyout), and the webview is
// hidden while an overlay covers the tile (the bookmark panel, the command palette) and shown
// again after. The child webview is its own DevTools target; its `document.visibilityState`
// tells whether the host shows it.
//
// Run: node --test scripts/ui/web-preview.test.mjs   (dev exe: npm run build:dev-exe, or
// QF_UI_EXE; the plugin must be built: npm run build in plugins/web-preview)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { launch } from "./harness.mjs";
import { connectFrame } from "./frames.mjs";
import { useFirstPartyPlugins } from "./dev-plugins.mjs";

let s;
let server;
let pageUrl;
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

const previewTiles = () => s.page.locator('[data-plugin-id="web-preview"][data-plugin-tile="preview"]');

/** DevTools targets showing the test page (the child webviews). */
async function pageTargets(match = pageUrl) {
  const list = await (await fetch(`http://127.0.0.1:${s.port}/json/list`)).json();
  return list.filter((t) => t.url.startsWith(match) && t.webSocketDebuggerUrl);
}

async function visibility(target) {
  const f = await connectFrame(target);
  try {
    return await f.evaluate(() => ({ state: document.visibilityState, title: document.title }));
  } finally {
    f.close();
  }
}

const waitVisibility = (target, state, msg) =>
  waitUntil(async () => (await visibility(target)).state === state, { timeout: 15_000, msg: `${msg} (${state})` });

/** The host's show/hide decision for the tile's native view (what `native.webviewSetBounds` gets). */
const waitShown = (tile, shown, msg) =>
  waitUntil(async () => (await tile.locator('[data-testid="web-preview-tile"]').getAttribute("data-webview-shown")) === String(shown), {
    timeout: 15_000,
    msg: `${msg} (shown=${shown})`,
  });

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>QF Preview Test</title><h1>qf-preview-ok ${req.url}</h1>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  pageUrl = `http://127.0.0.1:${server.address().port}/`;

  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await useFirstPartyPlugins(s, ["web-preview"]);
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("web-preview-final");
  if (s) await s.close();
  server?.close();
});

test("open a local page from the palette; it renders in the child webview", async () => {
  await runFromPalette("Open URL in Web Preview…", "Web Preview");
  const input = s.page.locator('[data-testid="plugin-prompt-input"]');
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.fill(pageUrl);
  await s.page.locator('[data-testid="plugin-prompt-ok"]').click();

  const tile = previewTiles().first();
  await tile.locator('[data-testid="web-preview-tile"]').waitFor({ timeout: 30_000 });
  assert.equal(await tile.locator('[data-testid="web-preview-url"]').inputValue(), pageUrl);
  const [target] = await waitUntil(async () => {
    const t = await pageTargets();
    return t.length ? t : null;
  }, { timeout: 30_000, msg: "the child webview target" });
  await waitUntil(async () => (await visibility(target)).title === "QF Preview Test", { msg: "the test page" });
  await waitVisibility(target, "visible", "the webview on screen");
  await waitShown(tile, true, "the webview on screen");
  await shot("web-preview-pane");
});

test("bookmark the page; the bookmark panel hides the webview while open", async () => {
  const tile = previewTiles().first();
  const [target] = await pageTargets();
  const star = tile.locator('[data-testid="web-preview-bookmark"]');
  await star.click();
  await waitUntil(async () => (await star.getAttribute("data-bookmarked")) === "true", { msg: "the bookmark star" });

  await tile.locator('[data-testid="web-preview-bookmarks"]').click();
  const panel = tile.locator('[data-testid="web-preview-bookmarks-panel"]');
  await panel.locator('[data-testid="web-preview-bookmark-row"]', { hasText: pageUrl }).waitFor({ timeout: 10_000 });
  await waitShown(tile, false, "the webview under the bookmark panel");
  await shot("web-preview-bookmarks");

  await s.press("Escape");
  await panel.waitFor({ state: "detached", timeout: 10_000 });
  await waitShown(tile, true, "the webview after the panel closed");
  assert.equal((await visibility(target)).state, "visible");
});

test("the command palette (an overlay) hides the webview", async () => {
  const tile = previewTiles().first();
  await openPalette();
  await waitShown(tile, false, "the webview under the palette");
  await s.press("Escape");
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
  await waitShown(tile, true, "the webview after the palette closed");
});

test("in a flyout: same bookmarks, navigation from a bookmark", async () => {
  await runFromPalette("Open Web Preview in Flyout", "Web Preview");
  await waitUntil(async () => (await previewTiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  // The flyout is the tile whose address bar is still empty.
  const fly = await waitUntil(async () => {
    for (let i = 0; i < (await previewTiles().count()); i++) {
      const t = previewTiles().nth(i);
      if ((await t.locator('[data-testid="web-preview-url"]').inputValue()) === "") return t;
    }
    return null;
  }, { msg: "the empty flyout tile" });
  await fly.locator('[data-testid="web-preview-bookmarks"]').click();
  const row = fly.locator('[data-testid="web-preview-bookmark-row"]', { hasText: pageUrl });
  await row.waitFor({ timeout: 10_000 });
  await row.locator("button").first().click();
  await waitUntil(async () => (await fly.locator('[data-testid="web-preview-url"]').inputValue()) === pageUrl, { msg: "the flyout address bar" });
  await waitUntil(async () => (await pageTargets()).length >= 2, { timeout: 30_000, msg: "the flyout's child webview" });
  await shot("web-preview-flyout");
  await s.eval(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await s.press("Escape");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e.message ?? e)), []);
});
