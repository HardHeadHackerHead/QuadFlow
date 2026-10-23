// E2E test of plugin dev mode (plugin-system.md §15.3, PL-10), driven through the scripts/ui
// harness: scaffold plugins with create-quadflow-plugin, build them with @quadflow/plugin-build,
// load them with Settings → Plugins → "Load unpacked…", edit the source while `quadflow-plugin
// dev` watches, and check the tile hot-reloads without losing its state; rebuild a Node
// sidecar and check the running sidecar is restarted.
//
// The plugins are third-party (publisher ids, outside the checkout), so they run sandboxed: the
// tile lives in an out-of-process iframe, driven through ./frames.mjs.
//
// No network: instead of `npm install`, the scaffolded plugins get junctions to the checkout's
// packages in node_modules/ (what the `file:` dependencies would install).
//
// Run: npm run test:e2e   (needs a dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./harness.mjs";
import { connectFrame, frameTargets } from "./frames.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREATE = path.join(ROOT, "packages", "create-quadflow-plugin", "index.mjs");
const BUILD_CLI = path.join(ROOT, "packages", "plugin-build", "bin", "quadflow-plugin.mjs");
const SHOTS = process.env.QF_UI_SHOTS_DIR;

let s;
let work; // scaffolded plugins live here (inside the harness run dir)
const children = [];

async function shot(name) {
  if (!s) return;
  try { await s.screenshot(path.join(SHOTS || s.runDir, `${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 30_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg}`);
}

/** Scaffold a plugin without npm: link the checkout packages it depends on. */
function scaffold(dir, template, id, name) {
  execFileSync(process.execPath, [CREATE, dir, "--template", template, "--id", id, "--name", name, "--yes", "--no-install"], { stdio: "pipe" });
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.devDependencies).filter((d) => d.startsWith("@quadflow/"))) {
    const target = path.join(ROOT, "node_modules", ...dep.split("/"));
    mkdirSync(path.join(dir, "node_modules", "@quadflow"), { recursive: true });
    symlinkSync(target, path.join(dir, "node_modules", ...dep.split("/")), "junction");
  }
}

const build = (dir) => execFileSync(process.execPath, [BUILD_CLI, "build", dir], { stdio: "pipe", encoding: "utf8" });

/**
 * Evaluate `fn(arg)` in the newest tile frame of a plugin (highest `v=` cache-buster: a reload
 * replaces the frame). Each call connects afresh and gives up after 5 s, because a frame that
 * is replaced mid-call never answers. Resolves `{ url, value }`, or null when no frame answered.
 */
async function inTile(pluginId, fn, arg) {
  const list = await frameTargets(s.port, `/_frame/${pluginId}?role=tile`);
  if (!list.length) return null;
  const v = (t) => Number(new URL(t.url).searchParams.get("v") || 0);
  const t = list.reduce((a, b) => (v(b) > v(a) ? b : a));
  const f = await connectFrame(t);
  try {
    const value = await Promise.race([f.evaluate(fn, arg), new Promise((_, no) => setTimeout(() => no(new Error("frame timeout")), 5000))]);
    return { url: t.url, value };
  } finally {
    f.close();
  }
}

/** Poll `inTile` until `ok(value)`; returns `{ url, value }`. */
const untilTile = (pluginId, fn, ok, o = {}) =>
  waitUntil(async () => {
    const r = await inTile(pluginId, fn, o.arg);
    return r && ok(r.value) ? r : null;
  }, o);

async function openSettingsPlugins() {
  await s.click('button[title="Settings"]');
  await s.clickText("Open Settings");
  await s.clickText("Plugins");
  await s.waitFor('[data-testid="plugins-settings"]', { timeout: 15_000 });
}

async function closeSettings() {
  await s.click(".fixed.inset-0 button >> nth=0");
}

/** "Load unpacked…" with the native folder picker stubbed (window.__QF_TEST_PICK_FOLDER__). */
async function loadUnpacked(dir) {
  await s.eval((d) => {
    window.__QF_TEST_PICK_FOLDER__ = () => d;
  }, dir);
  await s.click('[data-testid="plugins-load-unpacked"]');
}

const pluginInfo = (id) =>
  s.eval((pid) => window.__TAURI_INTERNALS__.invoke("plugins_list", { includeUnsupported: true }).then((l) => l.find((p) => p.id === pid) ?? null), id);

before(async () => {
  s = await launch();
  await s.waitFor("#root > *", { timeout: 60_000 });
  await s.waitForText("QuadFlow", { timeout: 60_000 });
  work = path.join(s.runDir, "plugins");
  mkdirSync(work, { recursive: true });
});

after(async () => {
  for (const c of children) {
    try { c.kill(); } catch { /* gone */ }
  }
  if (!s) return;
  await shot("devmode-final");
  console.log(`artifacts: ${s.runDir}`);
  await s.close();
});

test("create → build → Load unpacked → edit → hot reload keeps the tile state", { timeout: 300_000 }, async () => {
  const dir = path.join(work, "devmode-tile");
  scaffold(dir, "tile", "acme.devmode-tile", "Devmode Tile");
  assert.match(build(dir), /built acme\.devmode-tile@0\.1\.0/);

  await openSettingsPlugins();
  await loadUnpacked(dir);
  const row = '[data-testid="plugin-row-acme.devmode-tile"]';
  await s.waitFor(row, { timeout: 15_000 });
  const rowText = await s.text(row);
  assert.match(rowText, /dev/);
  assert.match(rowText, /sandboxed/);
  assert.match(rowText, /Active/);
  await shot("devmode-1-loaded");
  await closeSettings();

  // defaultToolConfig.pinned → a toolbar button.
  await waitUntil(() => s.page.locator('button[title^="Devmode Tile"]').isVisible(), { msg: "the tile's toolbar button" });
  await s.click('button[title^="Devmode Tile"]');
  const TILE = "acme.devmode-tile";
  const count = () => document.querySelector('[data-testid="qfp-devmode-tile-count"]')?.textContent ?? null;
  await untilTile(TILE, count, (c) => c === "0", { msg: "the tile to render" });
  for (let i = 0; i < 3; i++) {
    await inTile(TILE, () => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+1").click());
    await untilTile(TILE, count, (c) => c === String(i + 1), { msg: `count ${i + 1}` });
  }
  await shot("devmode-2-count-3");

  // Watch + edit the source.
  const dev = spawn(process.execPath, [BUILD_CLI, "dev", dir], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(dev);
  let devOut = "";
  dev.stdout.on("data", (d) => (devOut += d));
  dev.stderr.on("data", (d) => (devOut += d));
  await waitUntil(async () => devOut.includes("watching for changes"), { timeout: 60_000, msg: `quadflow-plugin dev to start:\n${devOut}` });

  const src = path.join(dir, "src", "index.tsx");
  writeFileSync(src, readFileSync(src, "utf8").replace("{greeting} from Devmode Tile", "{greeting} from Devmode Tile, edited live"));
  const after = await untilTile(
    TILE,
    () => ({ heading: document.querySelector("h2")?.textContent ?? "", count: document.querySelector('[data-testid="qfp-devmode-tile-count"]')?.textContent ?? null }),
    (r) => r.heading.includes("edited live") && r.count !== null,
    { timeout: 60_000, msg: `the edited heading (watcher output:\n${devOut})` },
  );
  assert.equal(after.value.heading, "Hello from Devmode Tile, edited live");
  assert.equal(after.value.count, "3", "the tile state survived the reload");
  await shot("devmode-3-hot-reloaded");
  dev.kill();
});

test("a rebuilt Node sidecar is restarted", { timeout: 300_000 }, async () => {
  const PLUGIN = "acme.devmode-sidecar";
  const dir = path.join(work, "devmode-sidecar");
  scaffold(dir, "tile-sidecar-node", PLUGIN, "Devmode Sidecar");
  build(dir);

  await openSettingsPlugins();
  await loadUnpacked(dir);
  const row = `[data-testid="plugin-row-${PLUGIN}"]`;
  await s.waitFor(row, { timeout: 15_000 });
  // sidecar:runtime:node needs consent.
  await s.page.locator(`${row} >> text=Approve`).click();
  await s.click('[data-testid="plugin-consent-confirm"]');
  await waitUntil(async () => (await pluginInfo(PLUGIN))?.status.kind === "active", { msg: "the plugin to become active" });
  await closeSettings();

  await waitUntil(() => s.page.locator('button[title^="Devmode Sidecar"]').isVisible(), { msg: "the tile's toolbar button" });
  await s.click('button[title^="Devmode Sidecar"]');
  const reply = () => document.querySelector('[data-testid="qfp-devmode-sidecar-reply"]')?.textContent ?? null;
  const greet = async (want) => {
    await untilTile(PLUGIN, () => !!document.querySelector("button"), Boolean, { msg: "the tile" });
    return waitUntil(async () => {
      await inTile(PLUGIN, () => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Greet").click());
      const r = await untilTile(PLUGIN, reply, (t) => t !== null, { timeout: 10_000, msg: "a sidecar reply" }).catch(() => null);
      return r && want.test(r.value) ? r.value : null;
    }, { timeout: 60_000, interval: 1000, msg: `a reply matching ${want}` });
  };
  const first = await greet(/^Hello, world!/);
  const pid1 = Number(/pid (\d+)/.exec(first)[1]);

  const side = path.join(dir, "sidecar", "index.mjs");
  writeFileSync(side, readFileSync(side, "utf8").replace("message: `Hello, ${name}!`", "message: `Howdy, ${name}!`"));
  build(dir); // bin/sidecar.mjs (and dist/) change → sidecar restart + UI reload
  const second = await greet(/^Howdy, world!/);
  const pid2 = Number(/pid (\d+)/.exec(second)[1]);
  assert.notEqual(pid2, pid1, "a new sidecar process");
  await shot("devmode-4-sidecar-restarted");
});
