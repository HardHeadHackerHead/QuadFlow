// E2E test of the Usage Monitor plugin with FIXTURE data only: the host's usage seam
// (`window.__QF_TEST_AGENT_USAGE__`, src/agents/providerRegistry.ts) answers every provider's
// `usage` hook, so no real `claude` is started and no real ~/.codex is read. The shapes are what
// the hooks produce from the sanitized real captures in plugins/claude-code/test/fixtures and
// plugins/codex/test/fixtures.
//
// Covers: the tile lists every window of both providers; the toolbar mini widget (pinned as
// "mini") shows all five windows without overflow or overlap in the dark and the light theme and
// in each style; the widget's gear opens Settings → Usage Monitor, where hiding a window and
// choosing a style take effect in the widget and persist (plugin settings).
//
// Run: node --test scripts/ui/usage-monitor.test.mjs (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { tauriInvoke } from "./dev-plugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const shot = async (n, locator) => {
  if (!s) return;
  const file = path.join(SHOTS || s.runDir, `usage-monitor-${n}.png`);
  try {
    if (locator) await locator.screenshot({ path: file });
    else await s.screenshot(file);
  } catch { /* best effort */ }
};
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

/** Installed in every document (survives reloads) before any plugin code runs. */
function installUsageSeam() {
  const H = 3_600_000;
  const now = Date.now();
  const snaps = {
    "claude-code": {
      providerId: "claude-code",
      fetchedAt: now,
      plan: "Max",
      windows: [
        { id: "session", label: "Current session", usedPercent: 11, resetsAt: now + 5.6 * H, resetsText: "Resets 10:19pm (America/New_York)" },
        { id: "week", label: "Current week (all models)", usedPercent: 82, resetsAt: now + 87 * H, resetsText: "Resets Oct 27, 7:59am (America/New_York)" },
        { id: "week-fable", label: "Current week (Fable)", usedPercent: 0, resetsAt: now + 87 * H, resetsText: "Resets Oct 27, 8am (America/New_York)" },
      ],
    },
    codex: {
      providerId: "codex",
      fetchedAt: now,
      plan: "plus",
      windows: [
        { id: "primary", label: "5h", usedPercent: 99, resetsAt: now + 0.75 * H },
        { id: "secondary", label: "Weekly", usedPercent: 16, resetsAt: now + 150 * H },
      ],
    },
  };
  window.__QF_TEST_USAGE_CALLS__ = [];
  window.__QF_TEST_AGENT_USAGE__ = (providerId) => {
    window.__QF_TEST_USAGE_CALLS__.push(providerId);
    return snaps[providerId] ?? null;
  };
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
async function setTheme(label) {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
  await paletteInput().fill("Open Settings");
  // Click the exact command (Enter would take whatever the palette ranks first).
  await s.page.getByText("Open Settings", { exact: true }).first().click();
  await settingsModal().waitFor({ timeout: 10_000 });
  // Settings reopens on the last page (e.g. Usage Monitor): the theme switch is on General.
  await settingsModal().locator('button:has-text("General")').first().click();
  await settingsModal().locator(`button:has-text("${label}")`).first().click();
  await waitUntil(async () => (await theme()) === label.toLowerCase(), { msg: `${label} theme` });
  await s.press("Escape");
  await settingsModal().waitFor({ state: "hidden", timeout: 5_000 });
}

const toolButton = () => s.page.locator('button[data-tool-ref="usage-monitor/usage-monitor"]').first();
const widget = () => s.page.locator('[data-testid="usage-mini-widget"]').first();
const tile = () => s.page.locator('[data-testid="usage-monitor"]').first();

/** Every visible window chip is inside the widget, the widget inside its button, none overlap. */
async function layoutProblems() {
  return widget().evaluate((el) => {
    const problems = [];
    const btn = el.closest("button");
    const b = btn.getBoundingClientRect();
    const w = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1) problems.push(`widget overflows: ${el.scrollWidth} > ${el.clientWidth}`);
    if (w.left < b.left - 1 || w.right > b.right + 1 || w.top < b.top - 1 || w.bottom > b.bottom + 1) problems.push("widget outside its button");
    const chips = [...el.querySelectorAll(".qf-um-mini__win")].map((c) => ({ id: c.dataset.window, r: c.getBoundingClientRect() }));
    for (let i = 0; i < chips.length; i++) {
      const a = chips[i].r;
      if (a.width === 0 || a.height === 0) problems.push(`${chips[i].id} has no size`);
      if (a.top < b.top - 1 || a.bottom > b.bottom + 1) problems.push(`${chips[i].id} taller than the toolbar button`);
      for (let j = i + 1; j < chips.length; j++) {
        const c = chips[j].r;
        if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) problems.push(`${chips[i].id} overlaps ${chips[j].id}`);
      }
    }
    return problems;
  });
}

before(async () => {
  s = await launch();
  await s.page.addInitScript(installUsageSeam);
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // Pin Usage Monitor to the toolbar as a mini widget, then reload so the seam is in place
  // from the first line of plugin code.
  const configs = await tauriInvoke(s, "tool_configs_list", {});
  let cfg = configs.find((c) => c.pluginId === "usage-monitor" && c.contributionId === "usage-monitor");
  if (!cfg) cfg = await tauriInvoke(s, "tool_configs_create", { input: { pluginId: "usage-monitor", contributionId: "usage-monitor", name: "Usage Monitor" } });
  await tauriInvoke(s, "tool_configs_update", { id: cfg.id, patch: { pinned: true, enabled: true, pinDisplay: "mini" } });
  await s.page.reload();
  await s.page.waitForLoadState("domcontentloaded");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  assert.equal(await s.eval(() => typeof window.__QF_TEST_AGENT_USAGE__), "function", "the usage seam is installed");
});

after(async () => {
  await shot("final");
  if (s) await s.close();
});

test("the tile shows every window of both providers (fixture data, no real CLI)", async () => {
  await widget().waitFor({ timeout: 30_000 });
  assert.equal((await widget().innerText()).trim(), "--", "no data before the first check");
  await runFromPalette("Open Usage Monitor");
  await tile().waitFor({ timeout: 30_000 });
  await waitUntil(async () => (await tile().locator('[data-testid="usage-window"]').count()) === 5, { msg: "five usage windows" });
  const claude = tile().locator('[data-provider="claude-code"]');
  for (const t of ["Current session", "11% used", "Current week (all models)", "82% used", "Current week (Fable)", "Resets Oct 27, 7:59am (America/New_York)", "Max"]) {
    await claude.getByText(t, { exact: false }).first().waitFor({ timeout: 5_000 });
  }
  const codex = tile().locator('[data-provider="codex"]');
  for (const t of ["5h", "99% used", "Weekly", "16% used"]) await codex.getByText(t, { exact: false }).first().waitFor({ timeout: 5_000 });
  const calls = await s.eval(() => window.__QF_TEST_USAGE_CALLS__);
  assert.ok(calls.includes("claude-code") && calls.includes("codex"), `usage answered by the seam: ${calls}`);
  await shot("tile-dark");
});

test("the mini widget shows all windows compactly, readable in dark and light", async () => {
  await waitUntil(async () => (await widget().locator(".qf-um-mini__win").count()) === 5, { msg: "five windows in the mini widget" });
  assert.equal(await widget().getAttribute("data-style"), "percent");
  const text = (await widget().innerText()).replace(/\s+/g, " ").trim();
  for (const t of ["5h 11%", "Wk 82%", "Fable 0%", "5h 99%", "Wk 16%"]) assert.ok(text.includes(t), `"${t}" in "${text}"`);
  const title = await widget().getAttribute("title");
  assert.match(title, /Current week \(all models\): 82% used · Resets Oct 27/);
  assert.match(title, /Codex \(plus\)/);
  assert.deepEqual(await layoutProblems(), []);
  await shot("mini-dark", toolButton());

  await setTheme("Light");
  // The level colours resolve to the light palette (not the dark one) and differ from the label.
  const colors = await widget().evaluate((el) => ({
    critical: getComputedStyle(el.querySelector('[data-window="primary"] .qf-um-mini__pct')).color,
    label: getComputedStyle(el.querySelector(".qf-um-mini__label")).color,
    bg: getComputedStyle(el.closest("button")).backgroundColor,
  }));
  assert.notEqual(colors.critical, colors.label);
  assert.notEqual(colors.label, colors.bg);
  assert.deepEqual(await layoutProblems(), []);
  await shot("mini-light", toolButton());
  await setTheme("Dark");
});

test("the gear opens Settings → Usage Monitor; hide a window and change the style", async () => {
  await toolButton().hover();
  await widget().locator('[data-testid="usage-mini-settings"]').click();
  const page = s.page.locator('[data-testid="usage-settings-page"]');
  await page.waitFor({ timeout: 15_000 });
  await page.locator('[data-testid="usage-settings-provider"][data-provider="claude-code"]').getByText("Current week (Fable)").click();
  await waitUntil(async () => (await widget().locator(".qf-um-mini__win").count()) === 4, { msg: "Fable hidden in the widget" });
  assert.equal(await widget().locator('[data-window="week-fable"]').count(), 0);

  // Style: bars.
  await page.locator('button[aria-label="Mini widget style"]').click();
  await s.page.getByRole("option", { name: /^Bars/ }).first().click();
  await waitUntil(async () => (await widget().getAttribute("data-style")) === "bars", { msg: "bars style" });
  assert.equal(await widget().locator(".qf-um-mini__track").count(), 4);
  await page.locator('[data-testid="usage-mini-preview"]').waitFor();
  await shot("settings-page");
  await s.press("Escape");
  await settingsModal().waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  assert.deepEqual(await layoutProblems(), []);
  await shot("mini-bars-dark", toolButton());

  // Style: countdown (percent + time to reset).
  await toolButton().hover();
  await widget().locator('[data-testid="usage-mini-settings"]').click();
  await page.waitFor({ timeout: 15_000 });
  await page.locator('button[aria-label="Mini widget style"]').click();
  await s.page.getByRole("option", { name: /^Percent \+ reset/ }).first().click();
  await waitUntil(async () => (await widget().getAttribute("data-style")) === "countdown", { msg: "countdown style" });
  await s.press("Escape");
  const cds = await widget().locator(".qf-um-mini__cd").allInnerTexts();
  assert.deepEqual(cds.length, 4);
  assert.ok(cds.includes("45m"), `codex 5h resets in 45m: ${cds}`);
  assert.deepEqual(await layoutProblems(), []);
  await shot("mini-countdown-dark", toolButton());
  await setTheme("Light");
  await shot("mini-countdown-light", toolButton());
  await setTheme("Dark");
});

test("mini widget settings persist across a reload", async () => {
  await s.page.reload();
  await s.page.waitForLoadState("domcontentloaded");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await widget().waitFor({ timeout: 30_000 });
  await waitUntil(async () => (await widget().getAttribute("data-style")) === "countdown", { msg: "the saved style" });
  // The widget never runs a hook itself: the restored tile (or a newly opened one) checks.
  await sleep(2000);
  if ((await s.page.locator('[data-testid="usage-monitor"]').count()) === 0) await runFromPalette("Open Usage Monitor");
  await waitUntil(async () => (await widget().locator(".qf-um-mini__win").count()) === 4, { timeout: 30_000, msg: "four windows (Fable still hidden)" });
});
