// E2E test of the migrated Issues plugin (MIG-issues): the tile opens from the palette in a
// pane and in a flyout, issues created / closed with the CLI (a separate process) appear live
// (including the cascade unblock of a dependent issue), dragging a card on the Kanban board to
// another column persists the status (read back with the CLI), an issue created in the UI is
// visible to the CLI, the palette finds issues through the plugin's palette provider (title and
// `CODE-n` ref), and `quadflow docs issues` serves the plugin's doc.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

/** The project's issue code (`CODE` of `CODE-n`) from its config file. */
function projectCode() {
  const dir = readdirSync(s.projectDir).find((d) => d.startsWith(".quadflow"));
  return JSON.parse(readFileSync(path.join(s.projectDir, dir, "config.json"), "utf8")).code;
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run the palette row "<title> <subtitle>" (tool rows: "Open Issues" + the tile title "Issues"). */
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

const issuesTiles = () => s.page.locator('[data-plugin-id="issues"][data-plugin-tile="board"]');
const card = (tile, id) => tile.locator(`[data-issue-id="${id}"]`);
/** The Kanban column (`IssueStatus`) a card is rendered in, or null. */
const columnOf = (tile, id) =>
  card(tile, id).first().evaluate((el) => el.closest("[data-kanban-column]")?.getAttribute("data-kanban-column") ?? null);

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("issues-final");
  if (s) await s.close();
});

let blocker, blocked;

test("issues tile: pane, live CLI create, UI create visible to the CLI", async () => {
  await runFromPalette("Open Issues", "Issues");
  const tile = issuesTiles().first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  await tile.getByText("No issues found").waitFor({ timeout: 30_000 });

  // CLI (another process) → appears without a reload (watcher → data.onDidChange).
  blocker = qf(["issues", "create", "Blocker qf-e2e", "--priority", "high"]);
  blocked = qf(["issues", "create", "Blocked qf-e2e", "--blocked-by", `#${blocker.number}`, "--status", "blocked"]);
  await tile.getByText("Blocker qf-e2e").waitFor({ timeout: 20_000 });
  await tile.getByText("Blocked qf-e2e").waitFor({ timeout: 20_000 });
  await tile.getByText(`${projectCode()}-${blocked.number}`).first().waitFor({ timeout: 20_000 });

  // UI → core → visible to the CLI.
  await tile.getByRole("button", { name: "New Issue", exact: true }).click();
  await tile.locator('input[placeholder="Issue title..."]').fill("Typed in the UI qf-e2e");
  await tile.getByRole("button", { name: "Create Issue" }).click();
  await waitUntil(async () => qf(["issues", "list", "--include-done"]).some((i) => i.title === "Typed in the UI qf-e2e"), {
    msg: "the UI issue in `quadflow issues list`",
  });
  await tile.getByText("Typed in the UI qf-e2e").waitFor({ timeout: 20_000 });
  await shot("issues-pane");

  // Detail view: blockers / dependents resolved from the live list; a CLI comment shows up live.
  await tile.getByText("Blocked qf-e2e").first().click();
  await tile.getByText("Change Status").waitFor({ timeout: 20_000 });
  await tile.getByText("Blocked By").waitFor({ timeout: 20_000 });
  qf(["issues", "comment", `#${blocked.number}`, "--body", "Comment from the CLI qf-e2e"]);
  await tile.getByText("Comment from the CLI qf-e2e").waitFor({ timeout: 20_000 });
  await shot("issues-detail");
  await tile.getByRole("button", { name: "Back to issue list" }).click();
  await tile.getByText("Typed in the UI qf-e2e").waitFor({ timeout: 20_000 });
});

test("kanban: CLI close cascades the unblock live; dragging a card persists its status", async () => {
  const tile = issuesTiles().first();
  await tile.getByRole("button", { name: "Switch to board view" }).click();
  // Done issues are filtered out by default; the Done column should show the closed blocker.
  await tile.getByLabel("Show completed").check();
  await waitUntil(async () => (await columnOf(tile, blocked.id)) === "blocked", { msg: "the blocked card in Blocked" });

  // Close the blocker from the CLI: it moves to Done, the blocked issue to To Do (cascade).
  qf(["issues", "close", `#${blocker.number}`]);
  await waitUntil(async () => (await columnOf(tile, blocker.id)) === "done", { msg: "the closed card in Done" });
  await waitUntil(async () => (await columnOf(tile, blocked.id)) === "todo", { msg: "the unblocked card in To Do" });
  assert.equal(qf(["issues", "get", `#${blocked.number}`]).status, "todo");
  await shot("issues-board-cascade");

  // Drag the unblocked card into "In Progress" (dnd-kit pointer sensor: press, move in steps).
  const from = await card(tile, blocked.id).first().boundingBox();
  const to = await tile.locator('[data-kanban-column="in_progress"]').boundingBox();
  assert.ok(from && to, "card and column are on screen");
  const m = s.page.mouse;
  await m.move(from.x + from.width / 2, from.y + 12);
  await m.down();
  await m.move(from.x + from.width / 2 + 10, from.y + 20, { steps: 4 });
  await m.move(to.x + to.width / 2, to.y + 80, { steps: 12 });
  await m.up();
  await waitUntil(async () => qf(["issues", "get", `#${blocked.number}`]).status === "in_progress", {
    msg: "the dragged issue in_progress in the CLI",
  });
  await waitUntil(async () => (await columnOf(tile, blocked.id)) === "in_progress", { msg: "the dragged card in In Progress" });
  await shot("issues-board-drag");
});

test("issues tile in a flyout shares the live data", async () => {
  await runFromPalette("Open Issues in Flyout", "Issues");
  await waitUntil(async () => (await issuesTiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  const flyout = issuesTiles().last();
  await flyout.getByText("Typed in the UI qf-e2e").first().waitFor({ timeout: 20_000 });
  qf(["issues", "create", "Second CLI issue qf-e2e"]);
  await flyout.getByText("Second CLI issue qf-e2e").first().waitFor({ timeout: 20_000 });
  await issuesTiles().first().getByText("Second CLI issue qf-e2e").first().waitFor({ timeout: 20_000 });
  await shot("issues-flyout");
  await s.press("Escape");
});

test("palette finds issues through the plugin's palette provider (title and ref)", async () => {
  await openPalette();
  await paletteInput().fill("Second CLI issue");
  await s.page.locator("div.cursor-pointer", { hasText: "Second CLI issue qf-e2e" }).first().waitFor({ timeout: 20_000 });
  const ref = `${projectCode()}-${blocked.number}`;
  await paletteInput().fill(ref);
  await s.page.locator("div.cursor-pointer", { hasText: `${ref} Blocked qf-e2e` }).first().waitFor({ timeout: 20_000 });
  await shot("issues-palette");
  await s.press("Escape");
});

test("`quadflow docs issues` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  assert.equal(list.find((m) => m.id === "issues")?.source, "issues", JSON.stringify(list));
  assert.match(qf(["docs", "issues"]), /quadflow issues/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
