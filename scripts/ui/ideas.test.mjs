// E2E test of the migrated Ideas and Projects (discovery) plugins (MIG-ideas, MIG-discovery):
// both tiles open from the palette in a pane and in a flyout, edits made with the CLI (a
// separate process) appear live, an idea added in the UI is visible to the CLI, the
// ideas <-> discovery link shows in the Projects "Linked" tab, the palette finds ideas
// through the plugin's palette provider, and `quadflow docs ideas` serves the plugin's doc.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

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

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run the palette row "<title> <subtitle>" (tool rows: "Open Ideas" + the tile title "Ideas"). */
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

const ideasTiles = () => s.page.locator('[data-plugin-id="ideas"][data-plugin-tile="board"]');
const projectsTiles = () => s.page.locator('[data-plugin-id="discovery"][data-plugin-tile="projects"]');

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("ideas-final");
  if (s) await s.close();
});

test("ideas tile: pane, live CLI edits, UI edits visible to the CLI", async () => {
  await runFromPalette("Open Ideas", "Ideas");
  await ideasTiles().first().waitFor({ state: "visible", timeout: 30_000 });
  await ideasTiles().first().getByText("No ideas yet").waitFor({ timeout: 30_000 });

  // CLI (another process) → appears without a reload (watcher → data.onDidChange).
  const created = qf(["ideas", "create", "Idea from the CLI qf-e2e", "--tag", "e2e"]);
  await ideasTiles().first().getByText("Idea from the CLI qf-e2e").waitFor({ timeout: 20_000 });
  qf(["ideas", "add-tag", created.id, "live"]);
  await ideasTiles().first().getByText("#live").first().waitFor({ timeout: 20_000 });

  // UI → core → visible to the CLI.
  const tile = ideasTiles().first();
  await tile.locator('textarea[placeholder="What\'s on your mind?"]').fill("Idea typed in the UI qf-e2e");
  await tile.getByRole("button", { name: "Add", exact: true }).click();
  await waitUntil(async () => {
    const list = qf(["ideas", "list"]);
    return (list.items ?? list).some((i) => i.content === "Idea typed in the UI qf-e2e");
  }, { msg: "the UI idea in `quadflow ideas list`" });

  // CLI delete → disappears.
  qf(["ideas", "delete", created.id]);
  await tile.getByText("Idea from the CLI qf-e2e").waitFor({ state: "detached", timeout: 20_000 });
  await shot("ideas-pane");
});

test("ideas tile in a flyout shares the live data", async () => {
  await runFromPalette("Open Ideas in Flyout", "Ideas");
  await waitUntil(async () => (await ideasTiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  const flyout = ideasTiles().last();
  await flyout.getByText("Idea typed in the UI qf-e2e").waitFor({ timeout: 20_000 });
  qf(["ideas", "create", "Second CLI idea qf-e2e"]);
  await flyout.getByText("Second CLI idea qf-e2e").waitFor({ timeout: 20_000 });
  await ideasTiles().first().getByText("Second CLI idea qf-e2e").waitFor({ timeout: 20_000 });
  await shot("ideas-flyout");
  await s.press("Escape");
});

test("palette finds ideas through the plugin's palette provider", async () => {
  await openPalette();
  await paletteInput().fill("Second CLI idea");
  await s.page.locator("div.cursor-pointer", { hasText: "Second CLI idea qf-e2e" }).first().waitFor({ timeout: 20_000 });
  await shot("ideas-palette");
  await s.press("Escape");
});

test("projects (discovery) tile: live CLI edits and the ideas link", async () => {
  await runFromPalette("Open Projects", "Projects");
  await projectsTiles().first().waitFor({ state: "visible", timeout: 30_000 });
  const project = qf(["discovery", "create", "Discovery qf-e2e"]);
  const tile = projectsTiles().first();
  await tile.getByText("Discovery qf-e2e").first().waitFor({ timeout: 20_000 });
  await tile.getByText("Discovery qf-e2e").first().click();

  // An idea linked from the CLI shows in the Linked tab, live.
  await tile.getByRole("button", { name: /^Linked/ }).click();
  qf(["ideas", "create", "Linked idea qf-e2e", "--discovery", project.id]);
  await tile.getByText("Linked idea qf-e2e").waitFor({ timeout: 20_000 });
  const linked = qf(["discovery", "linked", project.id]);
  assert.ok(linked.ideas.some((i) => i.content === "Linked idea qf-e2e"));
  await shot("projects-linked");

  await runFromPalette("Open Projects in Flyout", "Projects");
  await waitUntil(async () => (await projectsTiles().count()) >= 2, { timeout: 30_000, msg: "the projects flyout" });
  await projectsTiles().last().getByText("Discovery qf-e2e").first().waitFor({ timeout: 20_000 });
  await shot("projects-flyout");
  await s.press("Escape");
});

test("`quadflow docs ideas` / `docs discovery` come from the plugins", () => {
  const list = qf(["docs", "--list"]);
  const ideas = list.find((m) => m.id === "ideas");
  const discovery = list.find((m) => m.id === "discovery");
  assert.equal(ideas?.source, "ideas", JSON.stringify(list));
  assert.equal(discovery?.source, "discovery", JSON.stringify(list));
  assert.match(qf(["docs", "ideas"]), /quadflow ideas/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
