// E2E: bring the project list over from QuadFlow 1.x (core `import_v1`).
//
// Uses a FAKE 1.x installation (QUADFLOW_V1_DATA_DIR → a temp dir with a 1.x-shaped
// quadflow.db and two project folders); the real 1.x data is never read — dev builds
// ignore it without the override. Covers: the first-run offer with its preview,
// "Not now" being remembered across a restart, Settings → Advanced → "Import from
// QuadFlow 1.x…", the import result, the projects list, and that a dev build only
// reports a 1.x `.quadflow/` (never moves it).
//
// Run: npm run test:e2e   (or: node --test scripts/ui/import-v1.test.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, HARNESS_TMP } from "./harness.mjs";

let s;
let runDir;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const fake = path.join(HARNESS_TMP, `import-v1-${Date.now()}-${process.pid}`);
const v1Dir = path.join(fake, "v1-data");
const oldApp = path.join(fake, "old-app");
const plain = path.join(fake, "plain");
const env = { QUADFLOW_V1_DATA_DIR: v1Dir };

async function shot(name) {
  if (!s) return;
  try { await s.screenshot(path.join(SHOTS || s.runDir, `import-v1-${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 20_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg}`);
}

const invoke = (cmd, args) => s.eval(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const dialog = () => s.page.locator("[data-import-v1]");
const stage = () => dialog().getAttribute("data-import-v1-stage").catch(() => null);
const outcomeOf = (attr, root) =>
  s.page.locator(`[${attr}]`).evaluateAll((els, r) => {
    const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
    const el = els.find((e) => norm(e.getAttribute(e.hasAttribute("data-import-v1-project") ? "data-import-v1-project" : "data-import-v1-result-project")) === norm(r));
    return el ? el.getAttribute("data-import-v1-outcome") : null;
  }, root);

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');
async function runFromPalette(query) {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
  await paletteInput().fill(query);
  await new Promise((r) => setTimeout(r, 500));
  await s.press("Enter");
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

before(async () => {
  // A 1.x project folder (config.json without formatVersion, 16-hex file names) and a plain one.
  fs.mkdirSync(path.join(oldApp, ".quadflow", "issues"), { recursive: true });
  fs.writeFileSync(path.join(oldApp, ".quadflow", "config.json"), JSON.stringify({ settings: { project_code: "QC", next_issue_number: "2" } }));
  fs.writeFileSync(path.join(oldApp, ".quadflow", "issues", "a1a1a1a1a1a1a1a1.json"), JSON.stringify({ id: "a1a1a1a1a1a1a1a1", title: "old", status: "todo" }));
  fs.mkdirSync(plain, { recursive: true });
  fs.mkdirSync(v1Dir, { recursive: true });
  const db = new DatabaseSync(path.join(v1Dir, "quadflow.db"));
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, working_directory TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, default_workspace_config TEXT)`);
  const ins = db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, 1, ?, NULL)");
  ins.run("p1", "Old App", oldApp, 1, 2);
  ins.run("p2", "Plain", plain, 0, 1);
  ins.run("p3", "Gone", path.join(fake, "gone"), 0, 0);
  db.close();

  s = await launch({ env });
  runDir = s.runDir;
});

after(async () => {
  if (s) {
    if (s.pageErrors.length) console.log("page errors:", JSON.stringify(s.pageErrors, null, 2));
    console.log(`artifacts: ${runDir}`);
    await s.close();
  }
  fs.rmSync(fake, { recursive: true, force: true });
});

test("first run offers the 1.x projects with a preview; Not now is remembered", async () => {
  await s.waitFor("[data-import-v1]", { timeout: 60_000 });
  await waitUntil(async () => (await stage()) === "select" && (await s.page.locator("[data-import-v1-project]").count()) === 3, { msg: "the project list" });
  assert.equal(await outcomeOf("data-import-v1-project", oldApp), "v1_data_kept", "dev build: 1.x data is only reported");
  assert.equal(await outcomeOf("data-import-v1-project", plain), "would_register");
  assert.equal(await outcomeOf("data-import-v1-project", path.join(fake, "gone")), "missing_dir");
  assert.match(await dialog().innerText(), /start at the defaults/);
  await shot("offer");
  await s.click("[data-import-v1-dismiss]");
  await dialog().waitFor({ state: "hidden", timeout: 10_000 });
  const det = await invoke("import_v1_detect");
  assert.equal(det.state?.status, "dismissed");
  const names = (await invoke("projects_list")).map((p) => p.name)
  assert.ok(!names.includes("Old App") && !names.includes("Plain"), "dismissing adds nothing");
});

test("a restart does not offer it again", async () => {
  await s.close();
  s = await launch({ env, runDir });
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(await dialog().count(), 0);
});

test("Settings → Advanced imports the list", async () => {
  const before = snapshot(path.join(oldApp, ".quadflow"));
  await runFromPalette("Open Settings");
  await s.page.locator('button:has-text("Advanced")').first().click();
  await s.click("[data-import-v1-open]");
  await waitUntil(async () => (await stage()) === "select", { msg: "the dialog" });
  await s.click("[data-import-v1-run]");
  await waitUntil(async () => (await stage()) === "result", { timeout: 30_000, msg: "the result" });
  await shot("result");
  assert.equal(await outcomeOf("data-import-v1-result-project", oldApp), "v1_data_kept");
  assert.equal(await outcomeOf("data-import-v1-result-project", plain), "registered");
  await s.click("[data-import-v1-done]");
  await dialog().waitFor({ state: "hidden", timeout: 10_000 });

  const projects = await invoke("projects_list");
  const names = projects.map((p) => p.name);
  assert.ok(names.includes("Old App") && names.includes("Plain"), JSON.stringify(names));
  assert.equal((await invoke("import_v1_detect")).state?.status, "completed");

  // Opening the 1.x project in a dev build reports it and changes nothing.
  const notice = await invoke("import_v1_check_project", { projectRoot: oldApp });
  assert.equal(notice?.moved, false);
  assert.match(notice.message, /QuadFlow 1\.x/);
  assert.deepEqual(snapshot(path.join(oldApp, ".quadflow")), before, ".quadflow/ is untouched in dev");
  assert.ok(!fs.existsSync(path.join(oldApp, ".quadflow-v1-backup")));
  assert.equal(await invoke("import_v1_check_project", { projectRoot: plain }), null);
  assert.deepEqual(s.pageErrors, []);
});
