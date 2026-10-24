// E2E test of live plugin changes (plugin-system.md §12.4): installing, updating, rolling back
// and uninstalling a plugin take effect in the running app — no restart — whether done through
// the app (Tauri commands, as Settings → Plugins does) or through `quadflow plugins …` in another
// process (the CLI writes the app DB; the change reaches the GUI as DataChanged).
//
// Fixture plugin source: two plugins scaffolded with create-quadflow-plugin, built with
// @quadflow/plugin-build in two versions (0.2.0 changes the tile heading), packed into zips and
// listed in a local `index.json` that the app uses as its built-in source
// (QUADFLOW_PLUGIN_INDEX_URL=file://…; file URLs are allowed in the dev profile only):
//   - `updtrusted`: a bare id from the built-in source → installed, runs trusted (host document);
//   - `acme.upd-sandboxed`: a publisher id → installed, runs sandboxed (iframe, ./frames.mjs).
// Each test opens the plugin's tile, bumps its counter (saved in the tile instance state),
// changes the plugin while the tile stays open, and checks the new code runs, the tile kept its
// state, and the page was never reloaded.
//
// Run: node --test scripts/ui/plugin-update.test.mjs   (needs a dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_EXE, HARNESS_TMP, REPO_ROOT, launch } from "./harness.mjs";
import { connectFrame, frameTargets } from "./frames.mjs";

const CREATE = path.join(REPO_ROOT, "packages", "create-quadflow-plugin", "index.mjs");
const BUILD_CLI = path.join(REPO_ROOT, "packages", "plugin-build", "bin", "quadflow-plugin.mjs");
const EXE = process.env.QF_UI_EXE || DEFAULT_EXE;
const SHOTS = process.env.QF_UI_SHOTS_DIR;

const TRUSTED = "updtrusted";
const SANDBOXED = "acme.upd-sandboxed";

let s;
let fixtures; // fixture plugins + the source folder
let indexUrl;
/** Add the trusted fixture's broken 0.3.0 to the source (and refresh it in the app). */
let publishBroken;

async function shot(name) {
  if (!s) return;
  try { await s.screenshot(path.join(SHOTS || s.runDir, `${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 30_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg} (last: ${JSON.stringify(last)})`);
}

// ---- fixture source ----

/** Scaffold a tile plugin without npm (junctions to the checkout's packages). */
function scaffold(dir, scaffoldId, name) {
  execFileSync(process.execPath, [CREATE, dir, "--template", "tile", "--id", scaffoldId, "--name", name, "--yes", "--no-install"], { stdio: "pipe" });
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.devDependencies).filter((d) => d.startsWith("@quadflow/"))) {
    mkdirSync(path.join(dir, "node_modules", "@quadflow"), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, "node_modules", ...dep.split("/")), path.join(dir, "node_modules", ...dep.split("/")), "junction");
  }
}

const editJson = (file, f) => writeFileSync(file, JSON.stringify(f(JSON.parse(readFileSync(file, "utf8"))), null, 2));

/** Build + pack the plugin in `dir` as `version`; returns its index `versions[]` entry. */
function release(dir, version, archives) {
  editJson(path.join(dir, "quadflow-plugin.json"), (m) => ({ ...m, version }));
  editJson(path.join(dir, "package.json"), (p) => ({ ...p, version }));
  execFileSync(process.execPath, [BUILD_CLI, "build", dir], { stdio: "pipe" });
  execFileSync(process.execPath, [BUILD_CLI, "pack", dir, "--out", archives], { stdio: "pipe" });
  const m = JSON.parse(readFileSync(path.join(dir, "quadflow-plugin.json"), "utf8"));
  const zip = path.join(archives, `${m.id}-${version}.zip`);
  const sha256 = readFileSync(`${zip}.sha256`, "utf8").split(/\s+/)[0];
  return {
    version,
    apiVersion: m.apiVersion,
    platforms: m.platforms,
    url: pathToFileURL(zip).href,
    sha256,
    size: readFileSync(zip).length,
    permissions: m.permissions ?? [],
  };
}

/** A plugin with versions 0.1.0 and 0.2.0 (heading "… v2"); `id` may differ from the scaffold id. */
function fixturePlugin(id, scaffoldId, name, archives) {
  const dir = path.join(fixtures, id);
  scaffold(dir, scaffoldId, name);
  editJson(path.join(dir, "quadflow-plugin.json"), (m) => ({ ...m, id }));
  const v1 = release(dir, "0.1.0", archives);
  const src = path.join(dir, "src", "index.tsx");
  writeFileSync(src, readFileSync(src, "utf8").replace(`{greeting} from ${name}`, `{greeting} from ${name} v2`));
  const v2 = release(dir, "0.2.0", archives);
  // 0.3.0 fails to activate; published only by the test that needs it (see `publishBroken`).
  writeFileSync(src, readFileSync(src, "utf8").replace("activate(ctx) {", "activate(ctx) {\n    throw new Error('broken on purpose')"));
  const v3 = release(dir, "0.3.0", archives);
  return { entry: { id, name, description: `${name} (live update fixture)`, versions: [v2, v1] }, broken: v3 };
}

// ---- app helpers ----

const invoke = (cmd, args) =>
  s.eval(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/** Install / update through the app's own commands (what Settings → Plugins does). */
async function appInstall(id, version) {
  const plan = await invoke("plugins_install", { sourceId: null, pluginId: id, version });
  return invoke("plugins_install_confirm", { planId: plan.planId, grantedPermissions: [] });
}
async function appUpdate(id) {
  const plan = await invoke("plugins_update", { id });
  return invoke("plugins_install_confirm", { planId: plan.planId, grantedPermissions: [] });
}

/** `quadflow plugins …` in another process, on the app's (temp) data dir. */
function cli(args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^QUADFLOW_/i.test(k)) delete env[k];
  Object.assign(env, {
    QUADFLOW_PROFILE: "dev",
    QUADFLOW_DATA_DIR: path.join(s.runDir, "data"),
    QUADFLOW_SECRETS_BACKEND: "memory",
    QUADFLOW_PLUGIN_INDEX_URL: indexUrl,
    QUADFLOW_PROJECT_DIR: "",
  });
  const r = spawnSync(EXE, ["plugins", ...args, "--json"], { cwd: s.projectDir, env, encoding: "utf8", timeout: 120_000 });
  if (r.error) throw r.error;
  assert.equal(r.status, 0, `quadflow plugins ${args.join(" ")}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, true, r.stdout);
  return v.data;
}

const pluginInfo = (id) => invoke("plugins_list", { includeUnsupported: true }).then((l) => l.find((p) => p.id === id) ?? null);

/** The trusted tile, read from the host document. */
const trustedTile = () =>
  s.eval((id) => {
    const root = document.querySelector(`[data-plugin-id="${id}"][data-plugin-tile="main"]`);
    if (!root) return null;
    return {
      heading: root.querySelector("h2")?.textContent ?? "",
      text: root.textContent ?? "",
      count: root.querySelector('[data-testid="qfp-upd-trusted-count"]')?.textContent ?? null,
    };
  }, TRUSTED);

/** Evaluate `fn` in each live tile frame of the sandboxed plugin; the first value `ok` accepts. */
async function sandboxTile(fn, ok, o = {}) {
  return waitUntil(async () => {
    for (const t of await frameTargets(s.port, `/_frame/${SANDBOXED}?role=tile`)) {
      const f = await connectFrame(t).catch(() => null);
      if (!f) continue;
      try {
        const v = await Promise.race([f.evaluate(fn), new Promise((_, no) => setTimeout(() => no(new Error("frame timeout")), 5000))]);
        if (ok(v)) return { url: t.url, value: v };
      } catch {
        // replaced mid-call
      } finally {
        f.close();
      }
    }
    return null;
  }, o);
}
const sandboxRead = () => ({
  heading: document.querySelector("h2")?.textContent ?? "",
  text: document.body.textContent ?? "",
  count: document.querySelector('[data-testid="qfp-upd-sandboxed-count"]')?.textContent ?? null,
});

/** Mark the page: a reload (or a restarted app) would lose it. */
const markPage = () => s.eval(() => (window.__qfLiveMarker = `m-${Date.now()}`));
const pageMark = () => s.eval(() => window.__qfLiveMarker ?? null);

before(async () => {
  mkdirSync(HARNESS_TMP, { recursive: true });
  fixtures = mkdtempSync(path.join(HARNESS_TMP, "plugin-update-"));
  const archives = path.join(fixtures, "source", "archives");
  mkdirSync(archives, { recursive: true });
  const trusted = fixturePlugin(TRUSTED, "acme.upd-trusted", "Upd Trusted", archives);
  const sandboxed = fixturePlugin(SANDBOXED, "acme.upd-sandboxed", "Upd Sandboxed", archives);
  const index = { formatVersion: 1, name: "Live update fixtures", plugins: [trusted.entry, sandboxed.entry] };
  const indexFile = path.join(fixtures, "source", "index.json");
  writeFileSync(indexFile, JSON.stringify(index, null, 2));
  publishBroken = async () => {
    trusted.entry.versions.unshift(trusted.broken);
    writeFileSync(indexFile, JSON.stringify(index, null, 2));
    await invoke("plugin_sources_refresh", { id: null });
  };
  indexUrl = pathToFileURL(indexFile).href;

  s = await launch({ env: { QUADFLOW_PLUGIN_INDEX_URL: indexUrl } });
  await s.waitFor("#root > *", { timeout: 60_000 });
  await s.waitForText("QuadFlow", { timeout: 60_000 });
  await invoke("plugin_sources_refresh", { id: null });
});

after(async () => {
  if (s) {
    await shot("plugin-update-final");
    console.log(`artifacts: ${s.runDir}`);
    await s.close();
  }
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
});

test("trusted: install → update from the CLI → rollback → uninstall, live, tile keeps its state", { timeout: 300_000 }, async () => {
  // Install from the app: the tool appears without a restart.
  const info = await appInstall(TRUSTED, "0.1.0");
  assert.equal(info.version, "0.1.0");
  assert.equal(info.isolation, "trusted");
  await s.waitForText("Installed Upd Trusted 0.1.0", { timeout: 15_000 });
  await waitUntil(() => s.page.locator('button[title^="Upd Trusted"]').isVisible(), { msg: "the new tool's toolbar button" });
  await s.click('button[title^="Upd Trusted"]');
  await waitUntil(async () => (await trustedTile())?.count === "0", { msg: "the tile to render" });
  for (let i = 1; i <= 3; i++) {
    await s.click(`[data-plugin-id="${TRUSTED}"] button >> text="+1"`);
    await waitUntil(async () => (await trustedTile())?.count === String(i), { msg: `count ${i}` });
  }
  const v1 = await trustedTile();
  assert.equal(v1.heading, "Hello from Upd Trusted");
  assert.match(v1.text, /0\.1\.0/);
  const mark = await markPage();
  await shot("plugin-update-1-trusted-v1");

  // Update from the CLI (another process): the open tile switches to 0.2.0 code, count kept.
  const upd = cli(["update", TRUSTED, "--yes"]);
  assert.ok(JSON.stringify(upd).includes("0.2.0"), JSON.stringify(upd));
  const v2 = await waitUntil(async () => {
    const t = await trustedTile();
    return t?.heading === "Hello from Upd Trusted v2" ? t : null;
  }, { msg: "the updated tile" });
  assert.equal(v2.count, "3", "the tile state survived the update");
  assert.match(v2.text, /0\.2\.0/, "ctx.plugin.version is the new one");
  await s.waitForText("Updated Upd Trusted to 0.2.0", { timeout: 15_000 });
  assert.equal(await pageMark(), mark, "no page reload");
  // The new module is served from the new version's URL.
  const entries = await s.eval((id) => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes(`/${id}/dist/index.js`)), TRUSTED);
  assert.ok(entries.some((u) => u.includes("v=0.2.0.")), `entry URL with the new version: ${entries.join(", ")}`);
  await shot("plugin-update-2-trusted-v2");

  // Rollback from the app.
  await invoke("plugins_rollback", { id: TRUSTED });
  const back = await waitUntil(async () => {
    const t = await trustedTile();
    return t?.heading === "Hello from Upd Trusted" ? t : null;
  }, { msg: "the rolled back tile" });
  assert.equal(back.count, "3");
  await s.waitForText("Rolled back Upd Trusted to 0.1.0", { timeout: 15_000 });

  // An update whose code fails to start: the user is offered a restart, the tile shows the error.
  await publishBroken();
  assert.equal((await appUpdate(TRUSTED)).version, "0.3.0");
  await s.waitForText("Upd Trusted could not be reloaded", { timeout: 15_000 });
  assert.ok(await s.page.locator('button:has-text("Restart QuadFlow")').first().isVisible(), "a Restart QuadFlow action");
  await waitUntil(() => s.page.getByText("broken on purpose").first().isVisible(), { msg: "the tile to show the load error" });
  assert.equal(await pageMark(), mark, "no page reload");
  await shot("plugin-update-3-trusted-broken");

  // Uninstall from the app: the tile shows the "not installed" placeholder.
  await invoke("plugins_uninstall", { id: TRUSTED, deleteData: false });
  await s.waitFor(`[data-missing-plugin="${TRUSTED}"]`, { timeout: 15_000 });
  assert.match(await s.text(`[data-missing-plugin="${TRUSTED}"]`), /not installed/);
  await s.waitForText("Uninstalled Upd Trusted", { timeout: 15_000 });
  assert.equal(await trustedTile(), null, "the module's tile is gone");
  assert.equal(await pageMark(), mark, "no page reload");
  await waitUntil(async () => !(await s.page.locator('button[title^="Upd Trusted"]').isVisible()), { msg: "the toolbar button to go" });
  await shot("plugin-update-4-trusted-uninstalled");
});

test("sandboxed: install from the CLI → update from the app → uninstall from the CLI, live", { timeout: 300_000 }, async () => {
  const mark = await markPage();
  cli(["install", SANDBOXED, "--version", "0.1.0", "--yes"]);
  await waitUntil(async () => (await pluginInfo(SANDBOXED))?.status.kind === "active", { msg: "the plugin to be active" });
  await waitUntil(() => s.page.locator('button[title^="Upd Sandboxed"]').isVisible(), { msg: "the new tool's toolbar button" });
  await s.click('button[title^="Upd Sandboxed"]');
  await sandboxTile(sandboxRead, (v) => v.count === "0", { msg: "the tile frame" });
  for (let i = 1; i <= 2; i++) {
    await sandboxTile(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+1").click() ?? true, Boolean);
    await sandboxTile(sandboxRead, (v) => v.count === String(i), { msg: `count ${i}` });
  }
  await shot("plugin-update-5-sandboxed-v1");

  const info = await appUpdate(SANDBOXED);
  assert.equal(info.version, "0.2.0");
  assert.equal(info.isolation, "sandboxed");
  const v2 = await sandboxTile(sandboxRead, (v) => v.heading === "Hello from Upd Sandboxed v2", { msg: "the updated tile frame" });
  assert.equal(v2.value.count, "2", "the tile state survived the update");
  assert.match(v2.value.text, /0\.2\.0/);
  assert.match(v2.url, /[?&]v=0\.2\.0\./, "the frame loads the new version's URL");
  await s.waitForText("Updated Upd Sandboxed to 0.2.0", { timeout: 15_000 });
  assert.equal(await pageMark(), mark, "no page reload");
  await shot("plugin-update-6-sandboxed-v2");

  cli(["uninstall", SANDBOXED]);
  await s.waitFor(`[data-missing-plugin="${SANDBOXED}"]`, { timeout: 20_000 });
  await waitUntil(async () => (await frameTargets(s.port, `/_frame/${SANDBOXED}`)).length === 0, { msg: "the plugin's frames to go" });
  assert.equal(await pageMark(), mark, "no page reload");
  await shot("plugin-update-7-sandboxed-uninstalled");
});
