// E2E test of projects' workspaces (DL-10, final QA): two workspaces with different layouts,
// back-and-forth and rapid switching, rename, and both layouts + the name surviving a full app
// restart (close the process, launch the same data dir again).
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { terminalCount, readTerminalLines, typeInTerminal } from "./xterm.mjs";

let s;
let runDir;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const shot = async (n) => { try { await s.screenshot(path.join(SHOTS || s.runDir, `workspaces-${n}.png`)); } catch { /* best effort */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, { timeout = 30_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

// Terminal tiles in the project mosaic.
const tileCount = () => s.page.evaluate(() => document.querySelectorAll(".mosaic-tile [data-terminal-id]").length);
const tileIds = () => s.page.evaluate(() => [...document.querySelectorAll(".mosaic-tile [data-terminal-id]")].map((e) => e.getAttribute("data-terminal-id")).sort());
const item = (name) => s.page.locator(`text="${name}"`).first();

async function openTerminal() {
  const before = await terminalCount(s.page);
  await s.page.locator('button[title^="Terminal"]').first().click();
  await waitUntil(async () => (await terminalCount(s.page)) > before, { msg: "new terminal" });
}

async function showSidebar() {
  await waitUntil(async () => {
    if (await s.page.locator('button[title="New workspace"]').first().isVisible().catch(() => false)) return true;
    await s.press("Control+Shift+B");
    await sleep(500);
    return false;
  }, { msg: "the project sidebar", interval: 300 });
}

async function switchTo(name, expectedTiles) {
  await item(name).click();
  await waitUntil(async () => (await tileCount()) === expectedTiles, { msg: `${name} with ${expectedTiles} tiles` });
}

before(async () => {
  s = await launch();
  runDir = s.runDir;
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("final");
  if (s) await s.close();
});

let idsA, idsB;

test("workspace A: one terminal", async () => {
  await openTerminal();
  await waitUntil(async () => (await readTerminalLines(s.page)).some((l) => l.trim().length > 0), { msg: "prompt" });
  await typeInTerminal(s.page, "echo marker-A\r");
  idsA = await tileIds();
  assert.equal(idsA.length, 1);
});

test("workspace B: blank + two terminals", async () => {
  await showSidebar();
  await s.page.locator('button[title="New workspace"]').first().click();
  await s.page.getByText("Blank Workspace", { exact: true }).click();
  await waitUntil(async () => (await tileCount()) === 0, { msg: "blank workspace" });
  await openTerminal();
  await openTerminal();
  await waitUntil(async () => (await tileCount()) === 2, { msg: "two terminals in B" });
  idsB = await tileIds();
  await sleep(2500); // let auto-save run
  await shot("b");
});

test("switching back and forth (also rapidly) keeps each layout", async () => {
  await switchTo("Default Workspace", 1);
  assert.deepEqual(await tileIds(), idsA);
  await switchTo("Workspace 2", 2);
  assert.deepEqual(await tileIds(), idsB);
  for (let i = 0; i < 6; i++) {
    await item(i % 2 === 0 ? "Default Workspace" : "Workspace 2").click();
    await sleep(40);
  }
  await switchTo("Workspace 2", 2);
  await sleep(3000); // a stray debounced save would fire here
  assert.deepEqual(await tileIds(), idsB);
  await switchTo("Default Workspace", 1);
  assert.deepEqual(await tileIds(), idsA);
});

test("rename a workspace", async () => {
  const row = s.page.locator("div.group", { hasText: "Workspace 2" }).filter({ has: s.page.locator('button[title="Rename"]') }).first();
  await row.hover();
  await row.locator('button[title="Rename"]').click();
  const input = s.page.locator('div.group input[type="text"]').first();
  await input.waitFor({ timeout: 10_000 });
  await input.fill("QA Workspace");
  await input.press("Enter");
  await item("QA Workspace").waitFor({ timeout: 10_000 });
  await switchTo("QA Workspace", 2);
  assert.deepEqual(await tileIds(), idsB);
  await sleep(2500);
});

test("both layouts and the new name survive an app restart", async () => {
  await s.close();
  s = await launch({ runDir });
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // The last active workspace (the renamed one, two terminals) comes back.
  await waitUntil(async () => (await tileCount()) === 2, { timeout: 60_000, msg: "the renamed workspace restored" });
  await showSidebar();
  await item("QA Workspace").waitFor({ timeout: 20_000 });
  await switchTo("Default Workspace", 1);
  await switchTo("QA Workspace", 2);
  await shot("after-restart");
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => e.message), []);
});
