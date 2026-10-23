// E2E test of the optional Local Titles plugin (plugins/local-titles, not bundled): loaded
// unpacked from this checkout, its settings page (Settings → Local Titles) renders the sidecar's
// backend and the model list, and Settings → Integrations → Auto Titles lists its title
// generator. No model is downloaded.
//
// The plugin needs plugin API 1.3 (`contributes.titleGenerators`); on older hosts every test is
// skipped. `QF_LT_PLUGIN_DIR` loads the plugin from another folder instead (e.g. a copy without
// `titleGenerators` to look at the settings page on an older host).
//
// Run: node --test scripts/ui/local-titles.test.mjs   (dev exe: npm run build:dev-exe, or QF_UI_EXE).
// The plugin is not bundled, so the test builds it (scripts/ui/devplugins.mjs): the UI module and
// — unless an up-to-date sidecar is already in plugins/local-titles/bin (e.g. from
// `npm run build:release` there, the real llama.cpp backend, needs a C++ toolchain) — the stub
// sidecar (`--no-default-features`: answers every request, backend "none", cannot generate).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { launch, REPO_ROOT } from "./harness.mjs";
import { pluginInfo, tauriInvoke } from "./dev-plugins.mjs";
import { ensurePluginBuilt } from "./devplugins.mjs";

let s;
let skipReason = null;
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const PLUGIN_DIR = process.env.QF_LT_PLUGIN_DIR || path.join(REPO_ROOT, "plugins", "local-titles");
const errors = [];

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

async function openSettingsTab(label) {
  if (!(await s.page.locator('[data-testid="plugins-settings"], [data-testid="local-titles-settings"], [data-testid="title-generators"]').first().isVisible().catch(() => false))) {
    await s.click('button[title="Settings"]');
    await s.clickText("Open Settings");
  }
  await s.page.locator("button", { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click();
}

before(async () => {
  if (!process.env.QF_LT_PLUGIN_DIR) ensurePluginBuilt("local-titles", { cargoArgs: ["--no-default-features"] });
  s = await launch();
  s.page.on("pageerror", (e) => errors.push(String(e)));
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  if (!existsSync(path.join(PLUGIN_DIR, "dist", "index.js"))) throw new Error(`${PLUGIN_DIR} is not built (npm run build in it)`);
  const info = await pluginInfo(s, "local-titles");
  if (!(info && info.status.kind === "active" && info.isolation === "trusted")) {
    await tauriInvoke(s, "settings_set", { namespace: "plugins", key: "devTrusted", value: true });
    const added = await tauriInvoke(s, "plugins_dev_add", { path: PLUGIN_DIR }).catch((e) => ({ error: String(e?.message ?? JSON.stringify(e)) }));
    const now = await pluginInfo(s, "local-titles");
    if (added.error || now?.status.kind !== "active") {
      const why = added.error ?? JSON.stringify(now?.status ?? null);
      if (/titleGenerators|apiVersion|incompatible|additional/i.test(why)) {
        skipReason = `host lacks plugin API 1.3 / contributes.titleGenerators: ${why}`;
        return;
      }
      throw new Error(`local-titles did not load: ${why}`);
    }
    const declared = added.manifest?.permissions ?? [];
    if (declared.length) await tauriInvoke(s, "plugins_grant", { id: "local-titles", permissions: declared });
    await s.page.reload();
    await s.page.waitForLoadState("domcontentloaded");
    await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  }
});

after(async () => {
  await shot("local-titles-final");
  if (s) await s.close();
});

test("Settings → Local Titles shows the sidecar backend and the models", async (t) => {
  if (skipReason) return t.skip(skipReason);
  await openSettingsTab("Local Titles");
  const page = s.page.locator('[data-testid="local-titles-settings"]');
  await page.waitFor({ timeout: 15_000 });
  const backend = s.page.locator('[data-testid="local-titles-backend"]');
  // Real sidecar: "llama.cpp (CPU)" / "+ CUDA"…; stub sidecar: "none (…no inference engine…)".
  const text = await waitUntil(async () => {
    const t = await backend.innerText();
    return /llama\.cpp|none/.test(t) ? t : null;
  }, { timeout: 30_000, msg: "the sidecar backend" });
  // The model list comes from the sidecar (`titles/models`), not the settings schema fallback.
  const options = await waitUntil(async () => {
    const o = await s.page.locator('[data-testid="local-titles-model"] option').allInnerTexts();
    return o.length >= 3 ? o : null;
  }, { msg: "the sidecar's model list" });
  assert.ok(options.some((o) => /TinyLlama/.test(o)), options.join(", "));
  assert.match(await s.page.locator('[data-testid="local-titles-status"]').innerText(), /Download required|Ready to use/);
  if (/^Backend: none/.test(text)) {
    assert.match(text, /no inference engine/);
    // Nothing to download a model for.
    assert.equal(await s.page.locator('[data-testid="local-titles-download"]').isDisabled(), true);
  }
  await shot("local-titles-settings");
});

test("Settings → Integrations lists the plugin's title generator", async (t) => {
  if (skipReason) return t.skip(skipReason);
  if (process.env.QF_LT_PLUGIN_DIR) return t.skip("compat copy without titleGenerators");
  await openSettingsTab("Integrations");
  const gens = s.page.locator('[data-testid="title-generators"]');
  await gens.waitFor({ timeout: 15_000 });
  await waitUntil(async () => /Local model \(llama\.cpp\)/.test(await gens.innerText()), { msg: "the local-titles title generator" });
  await shot("local-titles-integrations");
});

test("no page errors", (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.deepEqual(errors, []);
});
