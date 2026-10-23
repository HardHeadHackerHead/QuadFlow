// E2E test of the Scripts plugin (MIG-scripts): one UI in a pane and in a flyout. Scripts
// and a group created with the CLI (another process) appear live; running a script shows
// its output in the embedded terminal and finishes; a parallel group runs every member to
// completion (the old pane killed the other members when one started); the flyout shares
// the runs and the live data; a script created in the UI is visible to the CLI; the palette
// provider runs scripts; `quadflow docs scripts` comes from the plugin.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { launch } from "./harness.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const WIN = process.platform === "win32";
// The typed command differs from its output (cmd `^` / sh `''` vanish), so seeing the
// output proves the script ran, not just that the command line was echoed.
const SHELL = WIN ? ["--shell", "cmd"] : ["--shell", "sh"];
const echo = (word) => (WIN ? `echo qf-${word.slice(0, 2)}^${word.slice(2)}-ok` : `echo qf-${word.slice(0, 2)}''${word.slice(2)}-ok`);

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

/** The built CLI against the app's isolated data dir and scratch project. */
function qf(args) {
  const r = spawnSync(s.exe, [...args, "--json"], {
    cwd: s.projectDir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      QUADFLOW_PROFILE: "dev",
      QUADFLOW_DATA_DIR: path.join(s.runDir, "data"),
      QUADFLOW_PROJECT_DIR: s.projectDir,
      QUADFLOW_SECRETS_BACKEND: "memory",
    },
  });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `quadflow ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, true, r.stdout);
  return v.data;
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function runFromPalette(title, subtitle) {
  await openPalette();
  const item = s.page
    .locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc(title)}\\s*${esc(subtitle)}\\s*$`) })
    .first();
  await paletteInput().fill(title);
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const tiles = () => s.page.locator('[data-plugin-id="scripts"][data-plugin-tile="scripts"]');
const runTabs = (tile, label, status) =>
  tile.locator(`[data-run-label="${label}"]${status ? `[data-run-status="${status}"]` : ""}`);

/** Text of the run's embedded terminal (xterm DOM renderer) or of its kept output. */
async function runText(tile, label) {
  const term = tile.locator(`[data-run-terminal="${label}"] .xterm-rows`);
  if (await term.count()) return term.first().innerText();
  const kept = tile.locator(`[data-run-output="${label}"]`);
  return (await kept.count()) ? kept.first().innerText() : "";
}

let alpha, beta;

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("scripts-final");
  if (s) await s.close();
});

test("pane: scripts and groups from the CLI appear live", async () => {
  await runFromPalette("Open Scripts", "Scripts");
  const tile = tiles().first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  await tile.getByText("No saved scripts yet").waitFor({ timeout: 30_000 });

  alpha = qf(["scripts", "create", "Alpha qf", "--command", echo("alpha"), ...SHELL]);
  beta = qf(["scripts", "create", "Beta qf", "--command", echo("beta"), ...SHELL]);
  await tile.locator('[data-script-row="Alpha qf"]').waitFor({ timeout: 20_000 });
  await tile.locator('[data-script-row="Beta qf"]').waitFor({ timeout: 20_000 });
  qf(["scripts", "groups", "create", "Both qf", "--mode", "parallel", "--script", alpha.id, "--script", beta.id]);
  await tile.locator('[data-scripts-tab="groups"]').click();
  await tile.locator('[data-script-group="Both qf"]').waitFor({ timeout: 20_000 });
  await shot("scripts-pane-groups");
});

test("pane: running a script shows its output and finishes", async () => {
  const tile = tiles().first();
  await tile.locator('[data-scripts-tab="saved"]').click();
  await tile.locator('[data-script-row="Alpha qf"]').getByRole("button", { name: "Run", exact: true }).click();
  await runTabs(tile, "Alpha qf", "completed").first().waitFor({ timeout: 60_000 });
  await waitUntil(async () => (await runText(tile, "Alpha qf")).includes("qf-alpha-ok"), { timeout: 20_000, msg: "the script output" });
  await shot("scripts-pane-run");
});

test("pane: a parallel group runs every member to completion", async () => {
  const tile = tiles().first();
  // Close the earlier run so the counts below are this group's.
  await tile.locator('[data-run-label="Alpha qf"] button[title="Close"]').first().click();
  await runTabs(tile, "Alpha qf").first().waitFor({ state: "detached", timeout: 10_000 });

  await tile.locator('[data-scripts-tab="groups"]').click();
  await tile.locator('[data-script-group="Both qf"]').getByRole("button", { name: "Run", exact: true }).click();
  await runTabs(tile, "Alpha qf", "completed").first().waitFor({ timeout: 60_000 });
  await runTabs(tile, "Beta qf", "completed").first().waitFor({ timeout: 60_000 });
  // Neither member was stopped or killed by the other starting / finishing.
  assert.equal(await tile.locator('[data-run-status="stopped"]').count(), 0);
  assert.equal(await tile.locator('[data-run-status="failed"]').count(), 0);
  await tile.locator('[data-run-label="Beta qf"]').first().click();
  await waitUntil(async () => (await runText(tile, "Beta qf")).includes("qf-beta-ok"), { timeout: 20_000, msg: "Beta's output" });
  await shot("scripts-pane-group-run");
});

test("flyout: same runs and live data, compact layout", async () => {
  await runFromPalette("Open Scripts in Flyout", "Scripts");
  await waitUntil(async () => (await tiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  // The tile rendered in flyout mode (compact layout), wherever the flyout sits in the DOM.
  const flyout = tiles().filter({ has: s.page.locator('[data-scripts-tile="flyout"]') }).first();
  await flyout.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await tiles().filter({ has: s.page.locator('[data-scripts-tile="pane"]') }).count(), 1);
  // The runs of the pane are visible here too (one model per plugin context).
  await runTabs(flyout, "Beta qf", "completed").first().waitFor({ timeout: 20_000 });

  // CLI edit → visible live in the flyout and in the pane.
  qf(["scripts", "update", alpha.id, "--name", "Alpha renamed qf"]);
  await flyout.locator('[data-scripts-tab="saved"]').click();
  await flyout.locator('[data-script-row="Alpha renamed qf"]').waitFor({ timeout: 20_000 });

  // Run from the flyout.
  await flyout.locator('[data-script-row="Beta qf"]').getByRole("button", { name: "Run", exact: true }).click();
  await waitUntil(async () => (await runTabs(flyout, "Beta qf", "completed").count()) >= 2, { timeout: 60_000, msg: "a second Beta run" });
  await shot("scripts-flyout");
  await s.press("Escape");
});

test("a script created in the UI is visible to the CLI", async () => {
  const tile = tiles().first();
  await tile.locator('[data-scripts-tab="saved"]').click();
  await tile.getByRole("button", { name: "New Script" }).click();
  const dialog = s.page.getByRole("dialog");
  await dialog.locator('[data-field="name"]').fill("UI script qf");
  await dialog.locator('[data-field="command"]').fill("echo from-the-ui");
  await dialog.getByRole("button", { name: "Create Script" }).click();
  await dialog.waitFor({ state: "detached", timeout: 10_000 });
  await waitUntil(async () => {
    const list = qf(["scripts", "list"]);
    return (list.items ?? list).some((x) => x.name === "UI script qf");
  }, { msg: "the UI script in `quadflow scripts list`" });
  await tile.locator('[data-script-row="UI script qf"]').waitFor({ timeout: 20_000 });
});

test("palette provider runs a script by name", async () => {
  const tile = tiles().first();
  const before = await runTabs(tile, "Beta qf").count();
  await openPalette();
  await paletteInput().fill("Beta qf");
  const item = s.page.locator("div.cursor-pointer", { hasText: "Run Beta qf" }).first();
  await item.waitFor({ timeout: 20_000 });
  await item.click();
  await waitUntil(async () => (await runTabs(tile, "Beta qf").count()) > before, { timeout: 30_000, msg: "a palette-started run" });
  await waitUntil(async () => (await runTabs(tile, "Beta qf", "completed").count()) > before, { timeout: 60_000, msg: "the palette run to finish" });
  await shot("scripts-palette");
});

test("`quadflow docs scripts` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  assert.equal(list.find((m) => m.id === "scripts")?.source, "scripts", JSON.stringify(list));
  assert.match(qf(["docs", "scripts"]), /quadflow scripts/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
