// E2E: first-run onboarding (ROADMAP §3 "App shell → First-run onboarding").
// Every other e2e test launches with QUADFLOW_SKIP_ONBOARDING=1 (harness default);
// this one launches a fresh data dir WITH onboarding and walks all six steps.
//
// Never touches the user's PATH: the CLI step only reads `cli_install_status`;
// "Install on PATH" is routed to window.__QF_TEST_CLI_INSTALL__ (a stub).
// The native folder picker is replaced by window.__QF_TEST_PICK_FOLDER__.
//
// Run: npm run test:e2e   (or: node --test scripts/ui/onboarding.test.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./harness.mjs";

let s;
let runDir;
let projectDir;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const STEPS = ["welcome", "agents", "project", "cli", "plugins", "done"];

async function shot(name) {
  if (!s) return;
  const dir = SHOTS || s.runDir;
  try { await s.screenshot(path.join(dir, `onboarding-${name}.png`)); } catch { /* best effort */ }
}

async function waitUntil(fn, { timeout = 20_000, interval = 250, msg = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${msg}`);
}

const invoke = (cmd, args) => s.eval(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const stepId = () => s.page.locator("[data-onboarding-step]").first().getAttribute("data-onboarding-step").catch(() => null);
const onboardingVisible = () => s.page.locator("[data-onboarding]").count().then((n) => n > 0);
const themeOf = () => s.eval(() => document.documentElement.dataset.theme ?? null);

async function waitStep(id) {
  await waitUntil(async () => (await stepId()) === id, { timeout: 15_000, msg: `onboarding step ${id}` });
}

async function installHooks(dir) {
  await s.eval((d) => {
    window.__qfCliInstallCalls = 0;
    window.__QF_TEST_PICK_FOLDER__ = () => d;
    window.__QF_TEST_CLI_INSTALL__ = async () => {
      window.__qfCliInstallCalls++;
      const real = await window.__TAURI_INTERNALS__.invoke("cli_install_status");
      return { ...real, installed: true, bin_on_path: true, shim_present: true, on_path: true, version_match: true,
        version_on_path: real.app_version, message: "test stub: PATH not modified" };
    };
  }, dir);
}

before(async () => {
  s = await launch({ onboarding: true });
  runDir = s.runDir;
  // The folder the user "picks" (a fresh scratch dir inside this run).
  projectDir = path.join(runDir, "first-project");
  fs.mkdirSync(projectDir, { recursive: true });
});

after(async () => {
  if (!s) return;
  if (s.pageErrors.length) console.log("page errors:", JSON.stringify(s.pageErrors, null, 2));
  console.log(`artifacts: ${runDir}`);
  await s.close();
});

test("a fresh data dir opens the welcome flow over the workspace", async () => {
  await s.waitFor("#root > *", { timeout: 60_000 });
  await waitStep("welcome");
  const info = await invoke("core_info");
  assert.equal(info.skipOnboarding, false, "harness must not set QUADFLOW_SKIP_ONBOARDING for this test");
  const record = (await invoke("settings_get", { namespace: "shell" })).onboarding;
  assert.equal(record ?? null, null, "nothing persisted before the user acts");
  assert.match(await s.text("[data-onboarding-intro]"), /desktop workspace/i);
  await installHooks(projectDir);
});

test("dark pass: every step, with real detection / project open / CLI status", async () => {
  await s.click('[data-onboarding-theme="dark"]');
  await waitUntil(async () => (await themeOf()) === "dark", { msg: "dark theme" });
  await shot("dark-1-welcome");

  // 2. Agents: providers from the registry, each with a detection result.
  await s.click("[data-onboarding-next]");
  await waitStep("agents");
  await s.waitFor("[data-onboarding-providers]", { timeout: 30_000 });
  const providers = await s.page.locator("[data-onboarding-provider]").evaluateAll((els) =>
    els.map((e) => ({ id: e.getAttribute("data-onboarding-provider"), installed: e.getAttribute("data-installed"), text: e.innerText })));
  const expected = (await invoke("agents_providers")).map((p) => p.id).sort();
  assert.deepEqual(providers.map((p) => p.id).sort(), expected, "one row per provider plugin");
  assert.ok(expected.includes("claude-code"), "bundled claude-code provider listed");
  for (const p of providers) {
    if (p.installed === "true") assert.match(p.text, /v\d|installed/, `${p.id}: version shown`);
    else assert.match(p.text, /not installed/, `${p.id}: not-installed state shown`);
  }
  await s.click("[data-onboarding-recheck]");
  await waitUntil(async () => !(await s.page.locator("[data-onboarding-recheck][disabled]").count()), { msg: "re-check done" });
  await shot("dark-2-agents");

  // 3. Project: pick (stubbed picker) → core projects_open → workspace switches.
  await s.click("[data-onboarding-next]");
  await waitStep("project");
  await shot("dark-3-project-before");
  await s.click("[data-onboarding-pick-project]");
  await s.waitFor("[data-onboarding-project-opened]", { timeout: 30_000 });
  const active = await invoke("projects_active");
  assert.equal(path.resolve(active.root.replace(/^\\\\\?\\/, "")).toLowerCase(), path.resolve(projectDir).toLowerCase(), "chosen folder is the active project");
  assert.ok(fs.existsSync(path.join(projectDir, ".quadflow-dev", "config.json")), "project folder initialized (dev profile)");
  assert.match(await s.text("[data-onboarding-current-project]"), /first-project/);
  await shot("dark-3-project");

  // 4. CLI: real status only; the install button goes to the test stub.
  await s.click("[data-onboarding-next]");
  await waitStep("cli");
  await waitUntil(async () => {
    const st = await s.page.locator("[data-onboarding-cli-status]").getAttribute("data-onboarding-cli-status").catch(() => "loading");
    return st && st !== "loading" ? st : null;
  }, { timeout: 30_000, msg: "CLI status" });
  await shot("dark-4-cli");
  if (await s.page.locator("[data-onboarding-cli-install]").count()) {
    await s.click("[data-onboarding-cli-install]");
    await waitUntil(async () => (await s.page.locator("[data-onboarding-cli-status]").getAttribute("data-onboarding-cli-status")) === "installed",
      { msg: "stubbed install reflected" });
    assert.equal(await s.eval(() => window.__qfCliInstallCalls), 1, "install went to the stub, not cli_install_to_path");
    await shot("dark-4-cli-after-stub-install");
  }

  // 5. Plugins: bundled + enabled first-party plugins, optional kits.
  await s.click("[data-onboarding-next]");
  await waitStep("plugins");
  await s.waitFor("[data-onboarding-bundled]", { timeout: 15_000 });
  const bundled = await s.page.locator("[data-onboarding-plugin]").evaluateAll((els) => els.map((e) => e.getAttribute("data-onboarding-plugin")));
  for (const id of ["ideas", "issues", "plans", "claude-code"]) assert.ok(bundled.includes(id), `bundled plugin ${id} listed`);
  const optional = await s.page.locator("[data-onboarding-optional-plugin]").evaluateAll((els) => els.map((e) => e.getAttribute("data-onboarding-optional-plugin")));
  assert.deepEqual(optional, ["streamer-kit", "semantic-search", "local-titles", "discord-bot"]);
  await shot("dark-5-plugins");

  // 6. Done.
  await s.click("[data-onboarding-next]");
  await waitStep("done");
  await s.waitFor("[data-onboarding-finish]");
  await shot("dark-6-done");
});

test("light pass: every step renders in the light theme", async () => {
  // Jump back to Welcome through the step indicator, switch theme.
  await s.click('ol[aria-label="Onboarding steps"] button >> nth=0');
  await waitStep("welcome");
  await s.click('[data-onboarding-theme="light"]');
  await waitUntil(async () => (await themeOf()) === "light", { msg: "light theme" });
  for (let i = 0; i < STEPS.length; i++) {
    if (i > 0) await s.click("[data-onboarding-next]");
    await waitStep(STEPS[i]);
    if (STEPS[i] === "agents") await s.waitFor("[data-onboarding-providers]", { timeout: 30_000 });
    if (STEPS[i] === "plugins") await s.waitFor("[data-onboarding-bundled]", { timeout: 15_000 });
    await shot(`light-${i + 1}-${STEPS[i]}`);
  }
  // Leave the user's theme as dark for the rest of the run.
  await s.click('ol[aria-label="Onboarding steps"] button >> nth=0');
  await s.click('[data-onboarding-theme="dark"]');
  await waitUntil(async () => (await themeOf()) === "dark", { msg: "dark theme" });
  await s.click('ol[aria-label="Onboarding steps"] button >> nth=5');
  await waitStep("done");
});

test("finishing persists `completed` and lands in the chosen project's workspace", async () => {
  await s.click("[data-onboarding-finish]");
  await waitUntil(async () => !(await onboardingVisible()), { msg: "onboarding closed" });
  const record = (await invoke("settings_get", { namespace: "shell" })).onboarding;
  assert.equal(record?.status, "completed");
  const active = await invoke("projects_active");
  assert.equal(path.basename(active.root), "first-project");
  // Fresh workspace: guidance instead of a blank screen.
  await s.waitFor('[data-empty-workspace="project"]', { timeout: 15_000 });
  const empty = await s.text('[data-empty-workspace="project"]');
  assert.match(empty, /No terminals or tools open/);
  assert.match(empty, /first-project/);
  await shot("dark-7-workspace");
  await shot("workspace-empty-state");
});

test("not shown again after a restart; re-openable from the palette and the gear menu", async () => {
  await s.close();
  s = await launch({ runDir, onboarding: true });
  await s.waitFor('[data-empty-workspace="project"]', { timeout: 60_000 });
  // Give a would-be first-run check time to fire.
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await onboardingVisible(), false, "completed onboarding stays closed on restart");

  // Command palette → "Show Welcome".
  await s.page.locator("[data-empty-workspace]").click({ position: { x: 5, y: 5 } });
  await s.press("Control+Shift+P");
  await s.typeKeys("Show Welcome");
  await s.click("text=Show Welcome >> nth=-1");
  await waitStep("welcome");
  // Closing (Esc) records the latest outcome; either way it never auto-opens again.
  await s.press("Escape");
  await waitUntil(async () => !(await onboardingVisible()), { msg: "closed with Escape" });
  assert.equal((await invoke("settings_get", { namespace: "shell" })).onboarding?.status, "skipped");

  // Gear menu → "Show Welcome".
  await s.click('button[title="Settings"]');
  await s.click("[data-settings-show-welcome]");
  await waitStep("welcome");
  await s.click("[data-onboarding-skip]");
  await waitUntil(async () => !(await onboardingVisible()), { msg: "closed with Skip setup" });
  assert.equal(s.pageErrors.length, 0, `no page errors: ${JSON.stringify(s.pageErrors)}`);
});
