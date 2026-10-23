// E2E regression test for the light theme (final QA): the real Settings → General theme switch,
// Escape closing Settings, the light remap of the dark-tuned palette classes plugins and the
// shell use (`text-green-400`, `bg-white/10`), terminal tiles and a plugin's attached run
// terminal (Scripts) following the terminal palette — before the fix they kept a hard-coded
// #1e1e1e frame / the dark theme after a switch.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { launch } from "./harness.mjs";
import { terminalCount } from "./xterm.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const shot = async (n) => { try { await s.screenshot(path.join(SHOTS || s.runDir, `theme-${n}.png`)); } catch { /* best effort */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 20_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

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
  assert.equal(r.status, 0, `quadflow ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout).data;
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');
async function runFromPalette(query) {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
  await paletteInput().fill(query);
  await sleep(500);
  await s.press("Enter");
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const settingsModal = () => s.page.locator(".max-w-2xl", { has: s.page.locator('h2:has-text("Settings")') });
const theme = () => s.eval(() => document.documentElement.dataset.theme ?? null);
/** Computed color of a probe element with `cls`, inside a plugin-like scoped wrapper. */
const probe = (cls, prop) =>
  s.eval(([c, p]) => {
    const wrap = document.createElement("div");
    wrap.className = "qf-issues";
    const el = document.createElement("span");
    el.className = c;
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    const v = getComputedStyle(el)[p];
    wrap.remove();
    return v;
  }, [cls, prop]);

async function setThemeInSettings(label) {
  await runFromPalette("Open Settings");
  await settingsModal().waitFor({ timeout: 10_000 });
  await settingsModal().locator(`button:has-text("${label}")`).first().click();
  await waitUntil(async () => (await theme()) === label.toLowerCase(), { msg: `${label} theme` });
}

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  qf(["scripts", "create", "Theme probe", "--command", "echo theme-probe"]);
});

after(async () => {
  await shot("final");
  if (s) await s.close();
});

test("Settings → Light switches the theme; Escape closes Settings", async () => {
  await setThemeInSettings("Light");
  await s.press("Escape");
  await settingsModal().waitFor({ state: "hidden", timeout: 5_000 });
  assert.equal(await theme(), "light");
});

test("dark-tuned palette classes are remapped in light (also inside plugin-scoped CSS)", async () => {
  // green-700 / yellow-700 instead of the unreadable 400 shades on a light surface.
  assert.equal(await probe("text-green-400", "color"), "rgb(21, 128, 61)");
  assert.equal(await probe("text-yellow-300", "color"), "rgb(161, 98, 7)");
  // translucent white fills (progress tracks, chips) become a dark tint, not invisible.
  assert.notEqual(await probe("bg-white/10", "backgroundColor"), "rgba(255, 255, 255, 0.1)");
});

test("a terminal tile uses the light terminal palette (no dark #1e1e1e frame)", async () => {
  const before = await terminalCount(s.page);
  await s.click('button[title^="Terminal"]');
  await waitUntil(async () => (await terminalCount(s.page)) > before, { msg: "a terminal" });
  const bg = await s.eval(() => {
    const host = document.querySelector(".mosaic-tile .terminal-container");
    return host && getComputedStyle(host.parentElement.parentElement).backgroundColor;
  });
  assert.equal(bg, "rgb(255, 255, 255)");
  await shot("terminal-light");
});

test("a plugin's attached run terminal follows a theme switch", async () => {
  await runFromPalette("Open Scripts");
  const tile = s.page.locator('[data-plugin-id="scripts"][data-plugin-tile="scripts"]').first();
  await tile.waitFor({ timeout: 30_000 });
  await tile.locator('button:has-text("Run")').first().click();
  const viewport = tile.locator(".xterm-viewport").first();
  await viewport.waitFor({ timeout: 30_000 });
  const vpBg = () => viewport.evaluate((e) => getComputedStyle(e).backgroundColor);
  await waitUntil(async () => (await vpBg()) === "rgb(255, 255, 255)", { msg: "light run terminal" });
  await setThemeInSettings("Dark");
  await s.press("Escape");
  await waitUntil(async () => (await vpBg()) === "rgb(30, 30, 30)", { msg: "dark run terminal after the switch" });
  await shot("run-terminal-dark");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => e.message), []);
});
