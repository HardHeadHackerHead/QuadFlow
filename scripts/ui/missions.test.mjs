// E2E test of the migrated Missions plugin (MIG-missions): the one Missions UI opens from the
// palette in a pane and in a flyout; a mission is created from a built-in template in the UI; a
// member is added WITHOUT launching an agent (stays "pending"); `quadflow missions send` and
// `quadflow missions claim-next` (another process) show up live; a message sent in the UI is
// visible to the CLI; a built-in agent definition and a built-in template are customized and an
// own template edited, all read back with the CLI; the palette provider finds the mission and
// offers "New mission from template"; `quadflow docs missions` is served by the plugin.
//
// Against a build that bundles plugins/missions the bundled plugin is used. Against an older app
// (e.g. a frozen dev exe built before the migration: QF_UI_EXE=…) the checkout's plugins/missions
// is loaded as a trusted dev plugin first (built if needed). QF_UI_MISSIONS_DEV=1 forces that.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "missions");
const BUILD_CLI = path.join(ROOT, "packages", "plugin-build", "bin", "quadflow-plugin.mjs");
const SHOTS = process.env.QF_UI_SHOTS_DIR;

let s;
let missionId;

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

/** The app's CLI against its isolated data dir and scratch project. */
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
const items = (v) => (Array.isArray(v) ? v : v.items ?? []);

const invoke = (cmd, args) => s.eval(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/** Use the bundled plugin, or load the checkout's plugins/missions as a trusted dev plugin. */
async function ensurePlugin() {
  const find = async () => (await invoke("plugins_list", { includeUnsupported: true })).find((p) => p.id === "missions");
  const current = await find();
  if (current?.origin === "bundled" && process.env.QF_UI_MISSIONS_DEV !== "1") return;
  if (!fs.existsSync(path.join(PLUGIN_DIR, "dist", "index.js"))) {
    execFileSync(process.execPath, [BUILD_CLI, "build", PLUGIN_DIR, "--no-sidecar"], { stdio: "pipe" });
  }
  // First-party dev plugins inside a checkout run trusted when plugins.devTrusted is on (§8.1).
  await invoke("settings_set", { namespace: "plugins", key: "devTrusted", value: true });
  await invoke("plugins_dev_add", { path: PLUGIN_DIR });
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "quadflow-plugin.json"), "utf8"));
  await invoke("plugins_grant", { id: "missions", permissions: manifest.permissions });
  const p = await waitUntil(async () => {
    const x = await find();
    return x?.origin === "dev" && x.status.kind === "active" ? x : null;
  }, { timeout: 30_000, msg: "the dev missions plugin to be active" });
  assert.equal(p.isolation, "trusted", JSON.stringify(p));
  // Reload so the shell registers the dev plugin's contributions from scratch.
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
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

const tiles = () => s.page.locator('[data-plugin-id="missions"][data-plugin-tile="control"]');
const tid = (t) => `[data-testid="${t}"]`;

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await ensurePlugin();
});

after(async () => {
  await shot("missions-final");
  if (s) await s.close();
});

test("pane: create a mission from a built-in template", async () => {
  await runFromPalette("Open Missions", "Missions");
  const tile = tiles().first();
  await tile.waitFor({ state: "visible", timeout: 30_000 });
  await tile.locator(tid("missions-tab-templates")).click();
  const card = tile.locator('[data-testid="template-card"][data-template-name="Bug Bash"]');
  await card.waitFor({ timeout: 20_000 });
  await card.locator(tid("template-launch")).click();

  const name = s.page.locator(tid("new-mission-name"));
  await name.waitFor({ timeout: 10_000 });
  // Prefilled from the template (set by the dialog's open effect).
  await waitUntil(async () => (await name.inputValue()) === "Bug Bash", { timeout: 10_000, msg: "the prefilled mission name" });
  assert.equal(await s.page.locator(tid("new-mission-template")).inputValue(), "builtin-bug-bash");
  await name.fill("Mission qf-e2e");
  await s.page.locator(tid("new-mission-create")).click();

  await tile.locator(tid("mission-title"), { hasText: "Mission qf-e2e" }).waitFor({ timeout: 20_000 });
  const m = items(qf(["missions", "list"])).find((x) => x.name === "Mission qf-e2e");
  assert.ok(m, "the UI mission in `quadflow missions list`");
  assert.equal(m.templateId, "builtin-bug-bash");
  assert.ok((m.config.successCriteria ?? []).length > 0, "the template's playbook was copied");
  missionId = m.id;
  await shot("missions-created");
});

test("add a member without launching an agent", async () => {
  const tile = tiles().first();
  await tile.locator(tid("mission-tab-team")).click();
  await tile.locator(tid("add-member")).click();
  await s.page.locator(tid("add-member-definition")).selectOption("builtin-fullstack-dev");
  await s.page.locator(tid("add-member-name")).fill("Dev qf-e2e");
  await s.page.locator(tid("add-member-submit")).click();

  const card = tile.locator('[data-testid="member-card"][data-member-name="Dev qf-e2e"]');
  await card.waitFor({ timeout: 20_000 });
  await card.locator(tid("member-status"), { hasText: "Pending" }).waitFor({ timeout: 10_000 });
  const members = items(qf(["missions", "members", missionId]));
  const dev = members.find((x) => x.name === "Dev qf-e2e");
  assert.ok(dev, JSON.stringify(members));
  assert.equal(dev.status, "pending");
  assert.ok(!dev.terminalId, "no agent terminal was started");
  await shot("missions-member");
});

test("CLI send / claim-next appear live; a UI message reaches the CLI", async () => {
  const tile = tiles().first();
  const issue = qf(["issues", "create", "Task qf-e2e", "--mission", missionId, "--priority", "high"]);
  await tile.locator(tid("mission-tab-issues")).click();
  await tile.locator(tid("mission-issues")).getByText("Task qf-e2e").waitFor({ timeout: 20_000 });

  await tile.locator(tid("mission-tab-messages")).click();
  qf(["missions", "send", missionId, "Hello from the CLI qf-e2e", "--kind", "finding"]);
  await tile.locator(tid("mission-messages")).getByText("Hello from the CLI qf-e2e").waitFor({ timeout: 20_000 });

  await tile.locator(tid("mission-message-input")).fill("Hello from the UI qf-e2e");
  await tile.locator(tid("mission-message-input")).press("Enter");
  await waitUntil(async () => items(qf(["missions", "messages", missionId])).some((m) => m.content === "Hello from the UI qf-e2e"), {
    msg: "the UI message in `quadflow missions messages`",
  });

  const claimed = qf(["missions", "claim-next", missionId, "Dev qf-e2e"]);
  assert.equal(claimed?.id, issue.id);
  await tile.locator(tid("mission-tab-team")).click();
  await tile
    .locator('[data-testid="member-card"][data-member-name="Dev qf-e2e"]')
    .locator(tid("member-assignment"), { hasText: "Task qf-e2e" })
    .waitFor({ timeout: 20_000 });
  await tile.locator(tid("mission-tab-activity")).click();
  await tile.locator(tid("mission-activity")).getByText("Issue Claimed").first().waitFor({ timeout: 20_000 });
  await shot("missions-live");
});

// API 1.4 `data.missions.proposalSetStatus`: the decision is recorded in the mission.
test("a CLI proposal rejected in the UI is recorded", async () => {
  const tile = tiles().first();
  const p = qf(["missions", "propose", missionId, "--goal", "Proposal qf-e2e"]);
  await tile.locator(tid("mission-tab-proposals")).click();
  const card = tile.locator('[data-testid="proposal-card"], [data-testid="proposal-banner"]', { hasText: "Proposal qf-e2e" }).first();
  await card.waitFor({ timeout: 20_000 });
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await waitUntil(async () => items(qf(["missions", "proposals", missionId])).find((x) => x.id === p.id)?.status === "rejected", {
    msg: "the rejection in `quadflow missions proposals`",
  });
  await tile.locator(tid("proposal-card"), { hasText: "Proposal qf-e2e" }).getByText("rejected").waitFor({ timeout: 20_000 });
  await shot("missions-proposal-rejected");
});

test("flyout shows the same live mission", async () => {
  await tiles().first().locator(tid("mission-tab-messages")).click();
  await runFromPalette("Open Missions in Flyout", "Missions");
  await waitUntil(async () => (await tiles().count()) >= 2, { timeout: 30_000, msg: "the flyout tile" });
  const flyout = tiles().last();
  // Pane and flyout share one model: the flyout opens on the selected mission and detail tab.
  await flyout.locator('[data-testid="mission-row"][data-mission-name="Mission qf-e2e"]').waitFor({ timeout: 20_000 });
  await flyout.locator(tid("mission-title"), { hasText: "Mission qf-e2e" }).waitFor({ timeout: 20_000 });
  await flyout.locator(tid("mission-messages")).waitFor({ timeout: 20_000 });
  qf(["missions", "send", missionId, "Second CLI message qf-e2e", "--kind", "status"]);
  await flyout.locator(tid("mission-messages")).getByText("Second CLI message qf-e2e").waitFor({ timeout: 20_000 });
  await shot("missions-flyout");
  await s.press("Escape");
});

test("customize a built-in agent definition", async () => {
  const tile = tiles().first();
  await tile.locator(tid("missions-tab-agents")).click();
  const card = tile.locator('[data-testid="agent-card"][data-agent-name="QA Engineer"]').first();
  await card.waitFor({ timeout: 20_000 });
  await card.locator(tid("agent-edit")).click();
  await s.page.locator(tid("agent-name")).fill("QA Engineer qf-e2e");
  await s.page.locator(tid("agent-description")).fill("Edited in the UI");
  await s.page.locator(tid("agent-save")).click();
  await tile.locator('[data-testid="agent-card"][data-agent-name="QA Engineer qf-e2e"]').waitFor({ timeout: 20_000 });
  const custom = items(qf(["missions", "agents"])).find((a) => a.name === "QA Engineer qf-e2e");
  assert.ok(custom && !custom.builtin, "a custom copy of the built-in");
  assert.equal(custom.description, "Edited in the UI");
  assert.equal(custom.role, "qa");
});

test("customize a built-in template, then edit the custom one", async () => {
  const tile = tiles().first();
  await tile.locator(tid("missions-tab-templates")).click();
  await tile.locator('[data-testid="template-card"][data-template-name="Bug Bash"]').locator(tid("template-edit")).click();
  await s.page.locator(tid("template-name")).fill("Bug Bash qf-e2e");
  await s.page.locator(tid("template-criteria")).fill("All bugs fixed\nNo new warnings");
  await s.page.locator(tid("template-save")).click();
  const card = tile.locator('[data-testid="template-card"][data-template-name="Bug Bash qf-e2e"]');
  await card.waitFor({ timeout: 20_000 });
  let custom = items(qf(["missions", "templates"])).find((t) => t.name === "Bug Bash qf-e2e");
  assert.ok(custom && !custom.builtIn, "a custom template");
  assert.deepEqual(custom.successCriteria, ["All bugs fixed", "No new warnings"]);

  await card.locator(tid("template-edit")).click();
  await s.page.locator(tid("template-description")).fill("Edited twice");
  await s.page.locator(tid("template-save")).click();
  await waitUntil(async () => {
    const t = items(qf(["missions", "templates"])).find((x) => x.id === custom.id);
    return t?.description === "Edited twice";
  }, { msg: "the edited template in `quadflow missions templates`" });
  assert.equal(items(qf(["missions", "templates"])).filter((t) => t.name === "Bug Bash qf-e2e").length, 1, "edited in place, not copied");
  await shot("missions-templates");
});

test("palette: missions and 'New mission from template'", async () => {
  await openPalette();
  await paletteInput().fill("Mission qf-e2e");
  await s.page.locator("div.cursor-pointer", { hasText: "Mission qf-e2e" }).first().waitFor({ timeout: 20_000 });
  await paletteInput().fill("Security Audit");
  await s.page.locator("div.cursor-pointer", { hasText: "New mission from template: Security Audit" }).first().waitFor({ timeout: 20_000 });
  await shot("missions-palette");
  await s.press("Escape");
});

test("`quadflow docs missions` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  const missions = list.find((m) => m.id === "missions");
  assert.equal(missions?.source, "missions", JSON.stringify(list));
  assert.match(qf(["docs", "missions"]), /quadflow missions/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
