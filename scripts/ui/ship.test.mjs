// E2E test of the Ship plugin (MIG-ship): the tile opens from the palette (pane and flyout),
// a config saved with the CLI (another process) replaces the "not configured" view live, a
// dry run in the UI shows the resolved phase plan without touching the version files, a run
// started with the CLI shows in the history live (in progress → completed), a run started in
// the UI streams its phase output into the output pane, a stored run replays its output, the
// palette provider finds runs, and `quadflow docs ship` comes from the plugin.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)
// Against an app that does not bundle the plugin yet (e.g. a frozen dev exe), set
// QF_UI_DEV_PLUGINS=1: the test then loads plugins/ship as an unpacked (dev) plugin.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const WIN = process.platform === "win32";
let s;

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

function cliEnv() {
  return {
    ...process.env,
    QUADFLOW_PROFILE: "dev",
    QUADFLOW_DATA_DIR: path.join(s.runDir, "data"),
    QUADFLOW_PROJECT_DIR: s.projectDir,
    QUADFLOW_SECRETS_BACKEND: "memory",
  };
}

/** The built CLI against the app's isolated data dir and scratch project. */
function qf(args) {
  const r = spawnSync(s.exe, [...args, "--json"], { cwd: s.projectDir, encoding: "utf8", timeout: 60_000, env: cliEnv() });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `quadflow ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, true, r.stdout);
  return v.data;
}

/**
 * Load `plugins/<id>` unpacked through Settings → Plugins → "Load unpacked…" (trusted: first-party
 * checkout layout + `plugins.devTrusted`) and approve its permissions.
 */
async function loadDevPlugin(id) {
  const dir = path.join(ROOT, "plugins", id);
  await s.eval((d) => {
    window.__QF_TEST_PICK_FOLDER__ = () => d;
    return window.__TAURI_INTERNALS__.invoke("settings_set", { namespace: "plugins", key: "devTrusted", value: true });
  }, dir);
  await s.click('button[title="Settings"]');
  await s.clickText("Open Settings");
  await s.clickText("Plugins");
  await s.waitFor('[data-testid="plugins-settings"]', { timeout: 15_000 });
  await s.click('[data-testid="plugins-load-unpacked"]');
  const row = `[data-testid="plugin-row-${id}"]`;
  await s.page.locator(`${row} >> text=Approve`).click({ timeout: 15_000 });
  await s.click('[data-testid="plugin-consent-confirm"]');
  const info = await waitUntil(async () => {
    const p = await s.eval((pid) => window.__TAURI_INTERNALS__.invoke("plugins_list", { includeUnsupported: true }).then((l) => l.find((x) => x.id === pid && x.origin === "dev")), id);
    return p?.status.kind === "active" ? p : null;
  }, { msg: `the dev copy of ${id} to become active` });
  assert.equal(info.isolation, "trusted", JSON.stringify(info));
  await s.click(".fixed.inset-0 button >> nth=0"); // close Settings
}

/** `quadflow ship list` (an array or a `{ items }` page). */
function shipRuns() {
  const r = qf(["ship", "list"]);
  return Array.isArray(r) ? r : r.items;
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Run the palette row "<title> <subtitle>" that opens a tile of `tiles()`. With an unpacked
 * copy loaded next to the old built-in tool, two rows share the title: try them in order.
 */
async function openTileFromPalette(title, subtitle, tiles) {
  for (let i = 0; i < 4; i++) {
    const before = await tiles().count();
    await openPalette();
    await paletteInput().fill(title);
    // A tile without a tool config yet is listed as "plugin <id>".
    const rows = s.page.locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc(title)}\\s*(?:${esc(subtitle)}|plugin ${PLUGIN})\\s*$`) });
    await rows.first().waitFor({ state: "visible", timeout: 60_000 });
    if (i >= (await rows.count())) break;
    await rows.nth(i).click();
    await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
    const opened = await waitUntil(async () => (await tiles().count()) > before, { timeout: 8_000 }).catch(() => false);
    if (opened) return;
    await s.press("Escape"); // a flyout of the other tool
  }
  throw new Error(`no palette row "${title}" opened the plugin tile`);
}

const PLUGIN = "ship";
const tiles = () => s.page.locator(`[data-plugin-id="${PLUGIN}"][data-plugin-tile="ship"]`);
const runRow = (tile, status) => tile.locator(`[data-ship-run]${status ? `[data-ship-run-status="${status}"]` : ""}`);

const CONFIG = {
  formatVersion: 1,
  productName: "Scratch",
  versionFiles: [{ path: "package.json", kind: "json", key: "version" }],
  phases: [
    { type: "version_bump", name: "bump" },
    // ~3 s, so the history can be seen "in progress".
    { type: "shell", name: "slow-step", command: WIN ? "ping -n 4 127.0.0.1 > nul" : "sleep 3" },
    { type: "shell", name: "say-hello", command: "echo qf-ship-hello" },
  ],
  changelog: { source: "git_log", since: "last_tag" },
};

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  if (process.env.QF_UI_DEV_PLUGINS === "1") await loadDevPlugin("ship");
  writeFileSync(path.join(s.projectDir, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }, null, 2));
});

after(async () => {
  await shot("ship-final");
  if (s) await s.close();
});

test("pane: not configured → a CLI-saved config appears live", async () => {
  await openTileFromPalette("Open Ship", "Ship", tiles);
  const tile = tiles().first();
  await tile.locator('[data-testid="ship-init"]').waitFor({ timeout: 30_000 });
  // `data.ship.templates` (API 1.4) fills the template picker.
  await tile.getByText("— or pick a template —").waitFor({ timeout: 20_000 });
  await shot("ship-init");

  const file = path.join(s.runDir, "ship-config.json");
  writeFileSync(file, JSON.stringify(CONFIG));
  await waitUntil(async () => qf(["ship", "config", "save", "--file", file]), { msg: "ship config save" });
  await tile.locator('[data-testid="ship-tool"]').waitFor({ timeout: 20_000 });
  await tile.locator('[data-testid="ship-status"]').getByText("1.0.0").first().waitFor({ timeout: 20_000 });
  await tile.locator('[data-testid="ship-history"]').getByText("No ship runs yet").waitFor({ timeout: 20_000 });
});

test("pane: a dry run shows the resolved plan and changes nothing", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="ship-dry-run-button"]').click();
  const plan = tile.locator('[data-testid="ship-dry-run"]');
  await plan.waitFor({ timeout: 30_000 });
  await plan.getByText("Dry-run plan · v1.0.1").waitFor({ timeout: 10_000 });
  for (const name of ["bump", "slow-step", "say-hello"]) await plan.locator(`[data-ship-phase="${name}"]`).waitFor({ timeout: 10_000 });
  assert.equal(JSON.parse(readFileSync(path.join(s.projectDir, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(shipRuns().length, 0, "a dry run is not recorded");
  await shot("ship-dry-run");
});

test("pane: a CLI-started run shows in the history live", async () => {
  const tile = tiles().first();
  const child = spawn(s.exe, ["ship", "run", "deploy", "--json"], { cwd: s.projectDir, env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", r));
  await runRow(tile, "in_progress").first().waitFor({ timeout: 20_000 });
  await shot("ship-cli-run-live");
  await runRow(tile, "completed").first().waitFor({ timeout: 60_000 });
  assert.equal(await exited, 0, out);
  await tile.locator('[data-testid="ship-status"]').getByText("completed").waitFor({ timeout: 20_000 });
});

test("pane: a stored run replays its output", async () => {
  const tile = tiles().first();
  await runRow(tile, "completed").first().getByRole("button", { name: "view output", exact: true }).click();
  await tile.getByText("Replay: v1.0.0").waitFor({ timeout: 10_000 });
  await tile.locator('[data-testid="ship-output"]').getByText("qf-ship-hello").first().waitFor({ timeout: 10_000 });
  await tile.getByRole("button", { name: "← back to live" }).click();
});

test("pane: a run started in the UI streams its output", async () => {
  const tile = tiles().first();
  await tile.getByRole("button", { name: /^Deploy/ }).click();
  await s.page.locator('[data-testid="ship-confirm-run"]').click();
  await tile.locator('[data-testid="ship-running"]').waitFor({ timeout: 10_000 });
  await tile.locator('[data-testid="ship-output"]').getByText("slow-step — passed").first().waitFor({ timeout: 60_000 });
  await tile.locator('[data-testid="ship-output"]').getByText("qf-ship-hello").first().waitFor({ timeout: 30_000 });
  await tile.locator('[data-testid="ship-running"]').waitFor({ state: "detached", timeout: 30_000 });
  await waitUntil(async () => (await runRow(tile, "completed").count()) >= 2, { msg: "two completed runs" });
  assert.equal(shipRuns().length, 2);
  await shot("ship-ui-run");
});

test("flyout shares the history", async () => {
  await openTileFromPalette("Open Ship in Flyout", "Ship", tiles);
  const flyout = tiles().last();
  await waitUntil(async () => (await runRow(flyout, "completed").count()) >= 2, { timeout: 20_000, msg: "runs in the flyout" });
  await shot("ship-flyout");
  await s.press("Escape");
});

test("palette finds runs through the plugin's palette provider", async () => {
  await openPalette();
  await paletteInput().fill("deploy");
  const row = s.page.locator("div.cursor-pointer", { hasText: "Ship run v1.0.0" }).first();
  await row.waitFor({ timeout: 20_000 });
  await shot("ship-palette");
  await row.click();
  await tiles().first().getByText("Replay: v1.0.0").waitFor({ timeout: 10_000 });
});

// API 1.4 `data.ship.configDelete` + `templates`: Reset returns to the template picker.
test("pane: Reset deletes the config and shows the template picker", async () => {
  await s.press("Escape");
  const tile = tiles().first();
  if (await tile.getByText("Replay: v1.0.0").isVisible().catch(() => false)) {
    await tile.getByRole("button", { name: /exit|back|live/i }).first().click().catch(() => {});
  }
  await tile.getByRole("button", { name: "Reset", exact: true }).click();
  await s.page.locator('[role="dialog"], .fixed').getByRole("button", { name: "Reset", exact: true }).last().click();
  await tile.locator('[data-testid="ship-init"]').waitFor({ timeout: 20_000 });
  await tile.getByText("— or pick a template —").waitFor({ timeout: 20_000 });
  await shot("ship-reset");
  // The config is gone for the CLI too (`show` prints null or fails with not_found).
  const r = spawnSync(s.exe, ["ship", "config", "show", "--json"], { cwd: s.projectDir, encoding: "utf8", timeout: 60_000, env: cliEnv() });
  const v = JSON.parse(r.stdout);
  assert.ok(v.ok ? v.data == null : v.error.code === "not_found", r.stdout);
});

test("`quadflow docs ship` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  assert.equal(list.find((m) => m.id === "ship")?.source, "ship", JSON.stringify(list));
  assert.match(qf(["docs", "ship"]), /quadflow ship run/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
