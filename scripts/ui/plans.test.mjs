// E2E test of the migrated Plans plugin (MIG-plans): the tile opens from the palette in a pane
// and in a flyout, a plan made in the UI is visible to the CLI, plans and steps made with the CLI
// (a separate process) appear live, a step promoted in the UI becomes an issue the CLI sees, the
// step's status follows its issue's status set with the CLI, the palette finds plans through the
// plugin's palette provider, and `quadflow docs plans` serves the plugin's doc.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)
//
// Against an app build that does not bundle the plugin yet (e.g. a frozen dev exe while the
// plugin is being migrated), set QF_UI_DEV_PLUGINS=<plugin dir>[;<plugin dir>…]: the test turns
// on `plugins.devTrusted`, loads each dir as a dev plugin (dev beats bundled for the same id),
// grants its permissions and reloads the window. The bundled copy's rows may then still be
// listed too; the helpers below always pick a row that opens the `plans` plugin's tile.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { launch } from "./harness.mjs";

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
const items = (v) => v.items ?? v;

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

async function closePalette() {
  if (await paletteInput().isVisible()) await s.press("Escape");
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const plansTiles = () => s.page.locator('[data-plugin-id="plans"][data-plugin-tile="board"]');

/**
 * Run the palette row "<title> <subtitle>" that opens a *new* `plans` tile. With a dev plugin
 * loaded next to the bundled copy there can be two identical rows; try each.
 */
async function openPlansTile(title) {
  const rowRe = new RegExp(`^\\s*${esc(title)}\\s*Plans\\s*$`);
  for (let i = 0; i < 3; i++) {
    const before = await plansTiles().count();
    await openPalette();
    await paletteInput().fill(title);
    const rows = s.page.locator("div.cursor-pointer", { hasText: rowRe });
    await rows.first().waitFor({ state: "visible", timeout: 60_000 });
    const n = await rows.count();
    if (i >= n) break;
    await rows.nth(i).click();
    await paletteInput().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    const opened = await waitUntil(async () => (await plansTiles().count()) > before, { timeout: 8_000, msg: "a plans tile" }).catch(() => false);
    if (opened) return plansTiles().last();
    await s.press("Escape").catch(() => {}); // another row's flyout may have opened
  }
  throw new Error(`no palette row "${title}" opened the plans plugin's tile`);
}

/** Load QF_UI_DEV_PLUGINS as trusted dev plugins with every permission granted. */
async function loadDevPlugins() {
  const dirs = (process.env.QF_UI_DEV_PLUGINS || "").split(";").map((d) => d.trim()).filter(Boolean);
  if (!dirs.length) return;
  await s.eval(async (list) => {
    const I = window.__TAURI_INTERNALS__.invoke;
    await I("settings_set", { namespace: "plugins", key: "devTrusted", value: true });
    for (const dir of list) {
      const p = await I("plugins_dev_add", { path: dir });
      if (p.missingPermissions?.length) await I("plugins_grant", { id: p.id, permissions: p.missingPermissions });
    }
  }, dirs);
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
}

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await loadDevPlugins();
});

after(async () => {
  await shot("plans-final");
  if (s) await s.close();
});

let cliPlan;

test("plans tile: pane, UI plan visible to the CLI, live CLI plans and steps", async () => {
  const tile = await openPlansTile("Open Plans");
  await tile.getByText("No plans yet").waitFor({ timeout: 30_000 });

  // UI → core → visible to the CLI (the wizard, "I Have a Spec").
  await tile.getByRole("button", { name: "New Plan", exact: true }).click();
  const modal = s.page.locator('[data-testid="plans-create-modal"]');
  await modal.waitFor({ timeout: 10_000 });
  await modal.locator('input[placeholder="e.g., User Authentication System"]').fill("UI plan qf-e2e");
  await modal.getByRole("button", { name: /I Have a Spec/ }).click();
  await s.page.locator('[data-testid="plans-create-submit"]').click();
  await modal.waitFor({ state: "detached", timeout: 10_000 });
  await waitUntil(async () => items(qf(["plans", "list"])).some((p) => p.title === "UI plan qf-e2e"), {
    msg: "the UI plan in `quadflow plans list`",
  });

  // CLI (another process) → appears without a reload (watcher → data.onDidChange).
  cliPlan = qf(["plans", "create", "CLI plan qf-e2e", "--status", "executing"]);
  const row = tile.locator(`[data-plan-id="${cliPlan.id}"]`);
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await tile.getByText("No steps yet. Add one to get started.").waitFor({ timeout: 10_000 });

  // A step added in the UI is visible to the CLI.
  await tile.getByRole("button", { name: "Add Step", exact: true }).click();
  await tile.locator('input[placeholder="Step title"]').fill("UI step qf-e2e");
  await tile.locator('input[placeholder="Step title"]').press("Enter");
  await tile.getByText("UI step qf-e2e").first().waitFor({ timeout: 10_000 });
  await waitUntil(async () => (qf(["plans", "get", cliPlan.id]).steps ?? []).some((st) => st.title === "UI step qf-e2e"), {
    msg: "the UI step in `quadflow plans get`",
  });

  // A step added with the CLI appears live.
  qf(["plans", "step-add", cliPlan.id, "CLI step qf-e2e"]);
  await tile.getByText("CLI step qf-e2e").first().waitFor({ timeout: 20_000 });
  await shot("plans-pane");
});

test("promote a step: the issue exists for the CLI and the step follows its status", async () => {
  const tile = plansTiles().first();
  const step = (qf(["plans", "get", cliPlan.id]).steps ?? []).find((st) => st.title === "CLI step qf-e2e");
  assert.ok(step, "CLI step");
  const card = tile.locator(`[data-step-id="${step.id}"]`);
  await card.hover();
  await card.locator('button[title="Promote to issue"]').click();

  const issue = await waitUntil(
    async () => items(qf(["issues", "list", "--include-done"])).find((i) => i.title === "CLI step qf-e2e"),
    { msg: "the promoted issue in `quadflow issues list`" },
  );
  await waitUntil(async () => qf(["plans", "get", cliPlan.id]).steps.find((st) => st.id === step.id)?.issueId === issue.id, {
    msg: "the step's issueId",
  });
  await card.getByText("Issue", { exact: true }).waitFor({ timeout: 10_000 });
  // Coordination view lists the promoted issue by its ref.
  await tile.getByText(/Multi-Agent Coordination \(1 issues?\)/).waitFor({ timeout: 10_000 });

  // Issue status set with the CLI → the step's status (core sync) → live in the tile.
  qf(["issues", "status", issue.id, "in_progress"]);
  await waitUntil(async () => (await card.getAttribute("data-step-status")) === "in_progress", { msg: "step in_progress" });
  qf(["issues", "status", issue.id, "done"]);
  await waitUntil(async () => (await card.getAttribute("data-step-status")) === "completed", { msg: "step completed" });
  // The coordination row shows the issue's ref (done issues included).
  await tile.locator('[data-testid="coord-issue-ref"]').filter({ hasText: /^[A-Z0-9]+-\d+$/ }).waitFor({ timeout: 10_000 });
  await shot("plans-promoted");
});

test("plans tile in a flyout shares the live data", async () => {
  const flyout = await openPlansTile("Open Plans in Flyout");
  await flyout.locator(`[data-plan-id="${cliPlan.id}"]`).waitFor({ timeout: 20_000 });
  qf(["plans", "create", "Second CLI plan qf-e2e"]);
  await flyout.getByText("Second CLI plan qf-e2e").waitFor({ timeout: 20_000 });
  await plansTiles().first().getByText("Second CLI plan qf-e2e").waitFor({ timeout: 20_000 });
  await shot("plans-flyout");
  await s.press("Escape");
});

test("palette finds plans through the plugin's palette provider", async () => {
  await openPalette();
  await paletteInput().fill("Second CLI plan");
  await s.page.locator("div.cursor-pointer", { hasText: "Second CLI plan qf-e2e" }).first().waitFor({ timeout: 20_000 });
  await shot("plans-palette");
  await closePalette();
});

test("`quadflow docs plans` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  const plans = list.find((m) => m.id === "plans");
  assert.equal(plans?.source, "plans", JSON.stringify(list));
  assert.match(qf(["docs", "plans"]), /quadflow plans/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
