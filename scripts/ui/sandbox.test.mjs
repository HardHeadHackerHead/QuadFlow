// E2E test of the sandboxed plugin runtime (plugin-system.md §8.4, PL-6), driven through the
// scripts/ui harness. Opens `hello` (trusted) and `hello-sandboxed` (the same bundle in a
// sandboxed iframe) side by side, runs the host-API test panel in both, and attacks the
// sandbox from inside the frame: Tauri IPC, host DOM, top navigation, spoofed / oversized /
// flooding RPC messages.
//
// The frame is an out-of-process iframe (opaque origin on another site), which Playwright's
// connectOverCDP does not expose; ./frames.mjs drives it through its own DevTools target.
//
// Run: npm run test:e2e   (needs a dev exe that bundles the dev plugins: npm run build:dev-exe)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { launch } from "./harness.mjs";
import { connectFrame, frameTargets, waitForFrameTarget } from "./frames.mjs";

/** Checks of the hello panel that plugin-system.md reserves for trusted plugins (native.*). */
const TRUSTED_ONLY_CHECKS = 3;

let s;
let frame; // the hello-sandboxed tile frame (CDP)
const SHOTS = process.env.QF_UI_SHOTS_DIR;

async function shot(name) {
  if (!s) return;
  const dir = SHOTS || s.runDir;
  try { await s.screenshot(path.join(dir, `${name}.png`)); } catch { /* best effort */ }
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

/** Open a tile through the command palette (the row whose title is `title`). */
async function openFromPalette(title) {
  const input = s.page.locator('input[placeholder="Type a command or search..."]');
  await waitUntil(async () => {
    if (!(await input.isVisible())) await s.press("Control+k");
    return input.isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
  // Palette rows: "<title>" (with match highlights) followed by the subtitle "plugin <id>".
  // On a cold start the plugin registry may still be loading; the row appears once it is.
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const item = s.page.locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc}\\s*plugin `) }).first();
  await input.fill(title);
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await input.waitFor({ state: "hidden", timeout: 10_000 });
}

/** Run a hello checks panel (`hello-api` / `hello-sandbox`) inside the frame and read its summary. */
async function runPanelInFrame(testId) {
  await frame.evaluate((id) => document.querySelector(`[data-testid="${id}-run"]`).click(), testId);
  await waitUntil(
    () => frame.evaluate((id) => document.querySelector(`[data-testid="${id}-summary"]`)?.getAttribute("data-done") === "true", testId),
    { timeout: 180_000, interval: 500, msg: `${testId} (sandboxed) to finish` },
  );
  return frame.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}-summary"]`);
    const failed = [...document.querySelectorAll(`[data-testid="${id}-row"][data-pass="false"]`)].map((r) => r.innerText);
    return { passed: Number(el.dataset.passed), total: Number(el.dataset.total), failed };
  }, testId);
}

async function runPanelTrusted(testId) {
  const tile = s.page.locator('[data-plugin-id="hello"]').first();
  await tile.locator(`[data-testid="${testId}-run"]`).click();
  const summary = tile.locator(`[data-testid="${testId}-summary"][data-done="true"]`);
  await summary.waitFor({ state: "visible", timeout: 180_000 });
  return {
    passed: Number(await summary.getAttribute("data-passed")),
    total: Number(await summary.getAttribute("data-total")),
    failed: await tile.locator(`[data-testid="${testId}-row"][data-pass="false"]`).allInnerTexts(),
  };
}

const pluginStates = () =>
  s.eval(() =>
    window.__TAURI_INTERNALS__
      .invoke("plugins_list", { includeUnsupported: true })
      .then((l) => Object.fromEntries(l.map((p) => [p.id, `${p.status.kind}:${p.enabled}`]))),
  );

before(async () => {
  s = await launch();
  await s.waitFor("#root > *", { timeout: 60_000 });
  await s.waitForText("QuadFlow", { timeout: 60_000 });
});

after(async () => {
  frame?.close();
  if (!s) return;
  await shot("sandbox-final");
  console.log(`artifacts: ${s.runDir}`);
  await s.close();
});

test("trusted and sandboxed hello open side by side", async () => {
  await openFromPalette("Open Hello");
  await s.waitFor('[data-plugin-id="hello"] [data-testid="hello-tile"]', { timeout: 30_000 });
  await openFromPalette("Open Hello (sandboxed)");
  await s.waitFor('[data-plugin-id="hello-sandboxed"][data-plugin-isolation="sandboxed"] iframe', { timeout: 30_000 });
  frame = await connectFrame(await waitForFrameTarget(s.port, "/_frame/hello-sandboxed?role=tile"));
  await waitUntil(() => frame.evaluate(() => !!document.querySelector('[data-testid="hello-tile"]')), { timeout: 30_000, msg: "the sandboxed tile" });

  // Same component, RPC context.
  const trustedCtx = await s.text('[data-plugin-id="hello"] [data-testid="hello-context"]');
  const sandboxCtx = await frame.evaluate(() => document.querySelector('[data-testid="hello-context"]').innerText);
  assert.match(trustedCtx, /hello v0\.1\.0 \(trusted\)/);
  assert.match(sandboxCtx, /hello-sandboxed v0\.1\.0 \(sandboxed\)/);
  assert.equal(
    await frame.evaluate(() => document.querySelector('[data-testid="hello-theme"]').innerText),
    await s.text('[data-plugin-id="hello"] [data-testid="hello-theme"]'),
    "theme propagated to the frame",
  );
  assert.equal(
    await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--qf-primary").trim()),
    await s.eval(() => getComputedStyle(document.documentElement).getPropertyValue("--qf-primary").trim()),
    "theme tokens match the host",
  );
  // Tile callbacks cross the boundary: setTitle → the host's tile title.
  await frame.evaluate(() => document.querySelector('[data-testid="hello-click"]').click());
  await s.waitForText("Hello (1)", { timeout: 10_000 });

  // The iframe: scripts only, no same-origin; plus one background frame for activate()/commands.
  const iframe = s.page.locator('[data-plugin-id="hello-sandboxed"] iframe').first();
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
  const bg = s.page.locator('iframe[data-qf-role="background"][data-qf-sandbox="hello-sandboxed"]');
  assert.equal(await bg.count(), 1, "one background frame");
  assert.equal(await bg.getAttribute("sandbox"), "allow-scripts");
  assert.equal((await frameTargets(s.port, "/_frame/hello-sandboxed?role=background")).length, 1);
  await shot("sandbox-01-side-by-side");
});

test("the host-API test panel passes identically (minus trusted-only checks)", async () => {
  const trusted = await runPanelTrusted("hello-api");
  const sandboxed = await runPanelInFrame("hello-api");
  console.log(`host API: trusted ${trusted.passed}/${trusted.total}, sandboxed ${sandboxed.passed}/${sandboxed.total}`);
  assert.deepEqual(trusted.failed, [], "trusted failures");
  assert.deepEqual(sandboxed.failed, [], "sandboxed failures");
  assert.equal(trusted.passed, trusted.total);
  assert.equal(sandboxed.total, trusted.total - TRUSTED_ONLY_CHECKS);
  assert.equal(sandboxed.passed, trusted.passed - TRUSTED_ONLY_CHECKS);
  await shot("sandbox-02-api-tests");
});

test("sandbox isolation checks pass inside the frame", async () => {
  const r = await runPanelInFrame("hello-sandbox");
  console.log(`isolation: ${r.passed}/${r.total}`);
  assert.deepEqual(r.failed, []);
  assert.equal(r.passed, r.total);
  assert.ok(r.total >= 10);
  await shot("sandbox-03-isolation");
});

test("frame cannot reach Tauri IPC or the host DOM (direct probes)", async () => {
  const before = await pluginStates();
  const probe = await frame.evaluate(async () => {
    const out = {};
    const attempt = async (name, f) => {
      try {
        const v = await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error("no answer")), 4000))]);
        out[name] = { escaped: true, value: String(v).slice(0, 80) };
      } catch (e) {
        out[name] = { escaped: false, error: String(e && (e.name || e)).slice(0, 80) };
      }
    };
    out.tauriGlobal = "__TAURI__" in window;
    out.origin = String(self.origin);
    await attempt("parentDocument", () => window.parent.document.body.innerHTML.length);
    await attempt("topLocation", () => window.top.location.href);
    await attempt("topNavigate", () => { window.top.location.href = "about:blank"; return "navigated"; });
    await attempt("fetchIpc", () => fetch("http://ipc.localhost/plugins_list", { method: "POST", body: "{}" }).then((r) => r.status));
    await attempt("fetchIpcScheme", () => fetch("ipc://localhost/plugins_list", { method: "POST" }).then((r) => r.status));
    await attempt("fetchHostApp", () => fetch("http://tauri.localhost/").then((r) => r.status));
    await attempt("localStorage", () => window.localStorage.length);
    await attempt("openWindow", () => { const w = window.open("about:blank"); if (!w) throw new Error("blocked"); return "opened"; });
    // WebView2 runs Tauri's init scripts in every frame (wry ignores "main frame only" on
    // Windows), so its internals may exist here; they must be inert. Try a command with a
    // visible side effect through both IPC paths.
    const internals = window.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") {
      await attempt("internalsInvoke", () => internals.invoke("plugins_disable", { id: "hello" }));
    } else out.internalsInvoke = { escaped: false, error: "absent" };
    if (window.ipc && typeof window.ipc.postMessage === "function") {
      window.ipc.postMessage(JSON.stringify({ cmd: "plugins_disable", callback: 1, error: 2, payload: { id: "hello" } }));
    }
    if (window.chrome && window.chrome.webview) {
      try { window.chrome.webview.postMessage(JSON.stringify({ cmd: "plugins_disable", payload: { id: "hello" } })); } catch { /* blocked */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
    return out;
  });
  console.log("frame probes:", JSON.stringify(probe));
  assert.equal(probe.tauriGlobal, false, "no window.__TAURI__ in the frame");
  assert.equal(probe.origin, "null", "opaque origin");
  for (const k of ["parentDocument", "topLocation", "topNavigate", "fetchIpc", "fetchIpcScheme", "fetchHostApp", "localStorage", "openWindow", "internalsInvoke"]) {
    assert.equal(probe[k].escaped, false, `${k} must fail: ${JSON.stringify(probe[k])}`);
  }
  // No IPC reached the Rust side: `hello` is still enabled, and the host document is still the app.
  assert.deepEqual(await pluginStates(), before);
  assert.equal(before.hello, "active:true");
  assert.ok(await s.page.locator('[data-plugin-id="hello"] [data-testid="hello-tile"]').count());
});

test("RPC: unknown/trusted-only methods refused; size and in-flight limits enforced", async () => {
  const r = await frame.evaluate(async () => {
    const pending = new Map();
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (e.source === window.parent && m && m.qf === 1 && m.kind === "res" && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    let id = 9_000_000;
    const send = (msg) => new Promise((resolve) => {
      const my = ++id;
      pending.set(my, resolve);
      window.parent.postMessage({ qf: 1, id: my, ...msg }, "*");
      setTimeout(() => { if (pending.delete(my)) resolve({ timeout: true }); }, 15_000);
    });
    const code = (m) => (m.error ? `${m.error.code}${m.error.details && m.error.details.limit ? ":" + m.error.details.limit : ""}` : m.timeout ? "timeout" : "ok");
    const out = {};
    out.native = code(await send({ kind: "req", method: "native.mainWindowHandle", params: [] }));
    out.attach = code(await send({ kind: "req", method: "terminals.attach", params: ["x", null] }));
    out.proto = code(await send({ kind: "req", method: "constructor", params: [] }));
    out.protoPath = code(await send({ kind: "req", method: "data.__proto__.constructor", params: [] }));
    out.foreignTile = code(await send({ kind: "req", method: "ui.closeTile", params: ["not-mine"] }));
    out.allowed = code(await send({ kind: "req", method: "storage.keys", params: ["probe."] }));
    // A permission this plugin lacks is still refused in Rust.
    out.denied = code(await send({ kind: "req", method: "clipboard.readText", params: [] }));
    out.big = code(await send({ kind: "req", method: "storage.get", params: ["x".repeat(2_200_000)] }));
    out.bigBinary = code(await send({ kind: "req", method: "storage.get", params: [new Uint8Array(5 * 1024 * 1024)] }));
    const flood = await Promise.all(Array.from({ length: 300 }, () => send({ kind: "req", method: "storage.keys", params: ["flood."] })));
    out.flood = { ok: flood.filter((m) => code(m) === "ok").length, inFlight: flood.filter((m) => code(m) === "invalid_input:inFlight").length };
    out.after = code(await send({ kind: "req", method: "storage.keys", params: ["probe."] }));
    return out;
  });
  console.log("rpc probes:", JSON.stringify(r));
  assert.equal(r.native, "unsupported");
  assert.equal(r.attach, "unsupported");
  assert.equal(r.proto, "invalid_input");
  assert.equal(r.protoPath, "invalid_input");
  assert.equal(r.foreignTile, "permission_denied");
  assert.equal(r.allowed, "ok");
  assert.equal(r.denied, "permission_denied");
  assert.equal(r.big, "invalid_input:messageSize");
  assert.equal(r.bigBinary, "invalid_input:messageSize");
  assert.equal(r.flood.ok + r.flood.inFlight, 300);
  assert.ok(r.flood.inFlight > 0, "in-flight limit hit");
  assert.ok(r.flood.ok >= 200, "the first 200 are served");
  assert.equal(r.after, "ok", "frame recovers after the flood");
});

test("no uncaught page errors (besides Tauri's init scripts failing inside sandbox frames)", () => {
  // WebView2 also injects Tauri's initialization scripts into sandboxed frames, where some of
  // them throw (no IPC internals there). Those come from `<anonymous>` init scripts, not app code.
  const tauriInFrame = (e) => /reading 'plugins'/.test(e.message) && /^\s*at <anonymous>:\d+:\d+/m.test(e.stack ?? "");
  const errors = s.pageErrors.filter((e) => !tauriInFrame(e));
  if (s.pageErrors.length !== errors.length) console.log(`ignored ${s.pageErrors.length - errors.length} Tauri init-script error(s) from frames`);
  assert.deepEqual(errors.map((e) => e.message), []);
});
