// E2E test of the migrated GitHub plugin (MIG-github): the tile renders from its own
// commands, shows the local git status of the scratch project (a `git init`ed repo made by the
// test), creates a checkpoint (git tag + record in the plugin's project storage) that is still
// listed after a reload, and the palette provider finds it. No request reaches github.com:
// the data dir has no token, so the GitHub tabs show the token form.
//
// Run: node --test scripts/ui/github.test.mjs   (needs the dev exe, or QF_UI_EXE; on an exe
// without the bundled plugin, plugins/github must be built — see devplugins.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { launch } from "./harness.mjs";
import { ensureFirstPartyPlugin } from "./devplugins.mjs";

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

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=QF Test", "-c", "user.email=qf-test@example.invalid", ...args], { cwd: s.projectDir, encoding: "utf8" }).trim();

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

/** Run the first palette row whose text contains `title`. */
async function runFromPalette(title) {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const tiles = () => s.page.locator('[data-plugin-id="github"][data-plugin-tile="git"]');

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // A real git repo as the scratch project: one commit on `main`, one untracked file.
  git("init", "-b", "main");
  writeFileSync(path.join(s.projectDir, "README.md"), "# scratch\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  // Identity for commits the plugin makes (checkpoint auto-commit).
  git("config", "user.name", "QF Test");
  git("config", "user.email", "qf-test@example.invalid");
  mkdirSync(path.join(s.projectDir, "src"), { recursive: true });
  writeFileSync(path.join(s.projectDir, "src", "new.ts"), "export const x = 1\n");
  await ensureFirstPartyPlugin(s, "github");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("github-final");
  if (s) await s.close();
});

test("tile renders and shows the scratch repo's local git status", async () => {
  await runFromPalette("Refresh Git Status"); // loads the plugin (command, no tile)
  await runFromPalette("Show Checkpoints");
  await tiles().first().waitFor({ state: "visible", timeout: 30_000 });
  const tile = tiles().first();
  await tile.locator('[data-testid="github-tab-status"]').click();
  await tile.locator('[data-testid="git-branch"]').waitFor({ timeout: 30_000 });
  await waitUntil(async () => (await tile.locator('[data-testid="git-branch"]').innerText()).trim() === "main", { msg: "branch main" });
  await waitUntil(async () => /Untracked\s*[1-9]/.test(await tile.locator('[data-testid="git-status-untracked"]').innerText()), { msg: "untracked files (src/, the project data dir)" });
  await shot("github-status");
});

test("GitHub tabs ask for a token (no network without one)", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="github-tab-prs"]').click();
  await tile.locator('[data-testid="github-token-setup"]').waitFor({ timeout: 20_000 });
  await tile.locator('[data-testid="github-tab-settings"]').click();
  await tile.locator('[data-testid="github-token-setup"]').waitFor({ timeout: 20_000 });
  await shot("github-token");
});

test("checkpoint: create → git tag + plugin storage, listed after a reload", async () => {
  const tile = tiles().first();
  await tile.locator('[data-testid="github-tab-checkpoints"]').click();
  await tile.locator('input[placeholder^="Checkpoint name"]').fill("before e2e");
  await tile.getByRole("button", { name: "Create Checkpoint" }).click();
  await tile.locator('[data-testid="checkpoint-name"]', { hasText: "before e2e" }).waitFor({ timeout: 30_000 });

  // The tag exists, and the untracked file was auto-committed first.
  assert.equal(git("tag", "-l", "qf-cp/*"), "qf-cp/before-e2e");
  assert.equal(git("status", "--porcelain"), "");
  assert.match(git("log", "-1", "--format=%s"), /\[QuadFlow Checkpoint\] before e2e/);
  await shot("github-checkpoint");

  // Reload the window: the list comes back from the plugin's storage.
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // (The restored workspace may already show the tile; the command focuses its Checkpoints
  // tab. Retry while the plugin registry is still loading after the reload.)
  const listed = tiles().first().locator('[data-testid="checkpoint-name"]', { hasText: "before e2e" });
  await waitUntil(async () => {
    if (await listed.isVisible()) return true;
    await runFromPalette("Show Checkpoints");
    await listed.waitFor({ timeout: 10_000 });
    return true;
  }, { timeout: 60_000, interval: 1000, msg: "the checkpoint listed after the reload" });
});

test("palette provider finds the checkpoint", async () => {
  await openPalette();
  await paletteInput().fill("before e2e");
  await s.page.locator("div.cursor-pointer", { hasText: "Checkpoint: before e2e" }).first().waitFor({ timeout: 20_000 });
  await shot("github-palette");
  await s.press("Escape");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
