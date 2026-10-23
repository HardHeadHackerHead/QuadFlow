// QuadFlow agent-driven GUI harness (QA-1).
//
// Launches an ISOLATED dev build of QuadFlow with WebView2 remote debugging
// enabled *only through this process's launch environment*, connects
// Playwright over CDP, and exposes small helpers for driving the UI.
//
// Safety rules baked in:
//   - We only ever kill the process tree we spawned, by PID. Never by name.
//   - App data goes to a temp dir (QUADFLOW_PROFILE=dev + QUADFLOW_DATA_DIR),
//     the WebView2 profile goes to a temp dir, and the working directory is a
//     scratch project under the OS temp dir. The installed QuadFlow
//     (com.quadflow.app) is never touched.
//   - Remote debugging is NOT configured anywhere in tauri.conf.json / Rust;
//     it exists only in the env this file builds.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const HARNESS_TMP = process.env.QF_UI_TMP || path.join(os.tmpdir(), "quadflow-ui-harness");
export const STATE_FILE = path.join(HARNESS_TMP, "session.json");

const EXE_NAME = process.platform === "win32" ? "quadflow-tauri.exe" : "quadflow-tauri";
// Cargo workspace root is the repo root (plugin-system.md §2), so builds land in ./target.
export const DEFAULT_EXE = path.join(
  process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(REPO_ROOT, "target"),
  "debug",
  EXE_NAME,
);
const DEV_CONF = path.join("src-tauri", "tauri.dev.conf.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`app process exited early (code ${child.exitCode}); see log`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`CDP endpoint on port ${port} not reachable after ${timeoutMs}ms (${lastErr?.message ?? "no response"})`);
}

/** Kill a process tree by PID (only PIDs we spawned). Never by name. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* not a group leader / gone */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p; }

/**
 * Build the isolated launch environment. Exported so tests/docs can inspect it.
 */
export function buildEnv({ port, runDir, projectDir, onboarding = false, extraEnv = {} }) {
  const env = { ...process.env };
  // Strip anything that could point the dev build at real data.
  for (const k of Object.keys(env)) {
    if (/^QUADFLOW_/i.test(k)) delete env[k];
  }
  Object.assign(env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=*`,
    WEBVIEW2_USER_DATA_FOLDER: mkdirp(path.join(runDir, "webview2")),
    // Dev-profile isolation (DL-1). Harmless until DL-1 lands; afterwards the
    // core puts app data under QUADFLOW_DATA_DIR and uses .quadflow-dev/.
    QUADFLOW_PROFILE: "dev",
    QUADFLOW_DATA_DIR: mkdirp(path.join(runDir, "data")),
    QUADFLOW_PROJECT_DIR: projectDir,
    // Secrets stay in the app process (never the OS keystore), so tests may store keys.
    QUADFLOW_SECRETS_BACKEND: "memory",
    RUST_BACKTRACE: "1",
    RUST_LOG: env.RUST_LOG || "info",
  });
  // A fresh data dir would show the first-run welcome flow over the workspace;
  // tests start in the workspace unless they opt in (onboarding.test.mjs).
  if (!onboarding) env.QUADFLOW_SKIP_ONBOARDING = "1";
  // Test-only additions (e.g. QUADFLOW_V1_DATA_DIR pointing at a fake 1.x install).
  // Never the data/profile vars above: those stay isolated.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (["QUADFLOW_PROFILE", "QUADFLOW_DATA_DIR", "WEBVIEW2_USER_DATA_FOLDER"].includes(k)) {
      throw new Error(`launch({ env }) may not override ${k}`);
    }
    env[k] = v;
  }
  return env;
}

/**
 * Does the Rust side honor QUADFLOW_DATA_DIR (dev-profile isolation, DL-1)?
 * Without it, a dev build still opens/creates databases under the REAL
 * %APPDATA%\com.quadflow.app (core config.rs, db_watcher, discord/obs/
 * ai_provider/youtube DBs, logs), i.e. the installed app's data.
 * Source-based check: scans src-tauri/**\/*.rs (excluding target/).
 */
export function isolationSupported() {
  const root = path.join(REPO_ROOT, "src-tauri");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === "target" || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".rs") && fs.readFileSync(p, "utf8").includes("QUADFLOW_DATA_DIR")) return true;
    }
  }
  return false;
}

function assertIsolated() {
  if (isolationSupported()) return;
  if (process.env.QF_UI_ALLOW_SHARED_DATA === "1") {
    console.warn("[ui-harness] WARNING: dev-profile isolation (QUADFLOW_DATA_DIR) not implemented in this "
      + "checkout; the app will use the default com.quadflow.app data dir. Allowed by QF_UI_ALLOW_SHARED_DATA=1.");
    return;
  }
  throw new Error(
    "Refusing to launch: this checkout's Rust code does not honor QUADFLOW_DATA_DIR yet, so a dev build "
    + "would read/write the installed QuadFlow's data (%APPDATA%\\com.quadflow.app). "
    + "Only on a throwaway machine (CI runner, VM) set QF_UI_ALLOW_SHARED_DATA=1 to override.");
}

/**
 * Spawn the app process (does not connect). Returns run metadata.
 * mode: "exe" (prebuilt debug exe, default when it exists) or "dev"
 * (`npm run tauri dev -- --config src-tauri/tauri.dev.conf.json`, which also
 * starts Vite on 5174 and compiles the Rust side).
 */
export async function spawnApp(opts = {}) {
  assertIsolated();
  const exe = opts.exe ?? process.env.QF_UI_EXE ?? DEFAULT_EXE;
  const mode = opts.mode ?? process.env.QF_UI_MODE ?? (fs.existsSync(exe) ? "exe" : "dev");
  const port = opts.port ?? (await freePort());
  // `runDir` reuses an earlier run's data, WebView2 profile and scratch project
  // (restart tests: "close, then launch the same app again").
  if (opts.runDir && !path.resolve(opts.runDir).startsWith(path.resolve(HARNESS_TMP))) {
    throw new Error(`--run-dir must be inside ${HARNESS_TMP}`);
  }
  const runDir = mkdirp(opts.runDir ? path.resolve(opts.runDir) : path.join(HARNESS_TMP, `run-${Date.now()}-${process.pid}`));
  const projectDir = opts.projectDir ?? mkdirp(path.join(runDir, "scratch-project"));
  const logFile = path.join(runDir, "app.log");
  const env = buildEnv({ port, runDir, projectDir, onboarding: !!opts.onboarding, extraEnv: opts.env ?? {} });

  const out = fs.openSync(logFile, "a");
  let child;
  if (mode === "exe") {
    if (!fs.existsSync(exe)) {
      throw new Error(`debug exe not found at ${exe}. Build it with: npm run build:dev-exe`);
    }
    child = spawn(exe, [], {
      cwd: projectDir, env, stdio: ["ignore", out, out],
      detached: process.platform !== "win32" || !!opts.detached,
      windowsHide: false,
    });
  } else if (mode === "dev") {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    child = spawn(npm, ["run", "tauri", "--", "dev", "--config", DEV_CONF], {
      cwd: REPO_ROOT, env, stdio: ["ignore", out, out],
      detached: process.platform !== "win32" || !!opts.detached,
      shell: process.platform === "win32",
      windowsHide: true,
    });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  fs.closeSync(out);
  if (opts.detached) child.unref();
  return { pid: child.pid, port, mode, exe, runDir, projectDir, logFile, child };
}

/** Connect Playwright to an already-running app over CDP and pick the main window page. */
export async function connect(port, { timeoutMs = 60_000 } = {}) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await pickMainPage(browser, timeoutMs);
  return { browser, page };
}

async function pickMainPage(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((c) => c.pages())
      .filter((p) => !p.url().startsWith("devtools://") && p.url() !== "about:blank");
    // Secondary windows (e.g. YouTube settings) load with a query/hash; the
    // main window is the root document.
    const main = pages.find((p) => !/[?#]window=/.test(p.url())) ?? pages[0];
    if (main) {
      await main.waitForLoadState("domcontentloaded").catch(() => {});
      return main;
    }
    await sleep(300);
  }
  throw new Error("no app page found over CDP");
}

/**
 * Launch the isolated app and return a session with helpers.
 * Options: { mode, exe, port, projectDir, runDir, timeoutMs, detached, onboarding, env }
 * (`onboarding: true` shows the first-run welcome flow; skipped by default.)
 */
export async function launch(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? (opts.mode === "dev" ? 15 * 60_000 : 90_000);
  const run = await spawnApp(opts);
  try {
    await waitForCdp(run.port, timeoutMs, run.child);
    const { browser, page } = await connect(run.port);
    return makeSession({ ...run, browser, page, owned: true });
  } catch (e) {
    killTree(run.pid);
    e.message += `\n(app log: ${run.logFile})`;
    throw e;
  }
}

/** Wrap a connected page in helpers. `owned` sessions kill the app on close(). */
export function makeSession(s) {
  const { page, browser } = s;
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (m) => consoleMessages.push({ type: m.type(), text: m.text(), at: Date.now() }));
  page.on("pageerror", (e) => pageErrors.push({ message: e.message, stack: e.stack, at: Date.now() }));

  const loc = (sel) => page.locator(sel).first();
  return {
    ...s,
    consoleMessages,
    pageErrors,
    /** Click by Playwright selector (css, `text=…`, `role=button[name="…"]`, …). */
    click: (sel, o) => loc(sel).click(o),
    /** Click the first element whose visible text contains `text`. */
    clickText: (text, o) => page.getByText(text, { exact: false }).first().click(o),
    /** Fill an input/textarea; for non-inputs (e.g. xterm) use typeKeys. */
    type: async (sel, text) => {
      const l = loc(sel);
      const editable = await l.evaluate((el) => el.matches("input,textarea,[contenteditable],select")).catch(() => false);
      if (editable) await l.fill(text);
      else { await l.click(); await page.keyboard.type(text); }
    },
    /** Type raw keystrokes into whatever has focus. */
    typeKeys: (text) => page.keyboard.type(text),
    press: (key) => page.keyboard.press(key),
    text: (sel) => loc(sel).innerText(),
    allText: () => page.locator("body").innerText(),
    waitFor: (sel, o) => loc(sel).waitFor({ state: "visible", ...o }),
    waitForText: (text, o) => page.getByText(text, { exact: false }).first().waitFor({ state: "visible", ...o }),
    eval: (fnOrExpr, arg) => page.evaluate(fnOrExpr, arg),
    screenshot: async (file, o) => {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      await page.screenshot({ path: file, ...o });
      return path.resolve(file);
    },
    /** Rust/stdout+stderr output of the app captured so far. */
    readLogs: () => (s.logFile && fs.existsSync(s.logFile) ? fs.readFileSync(s.logFile, "utf8") : ""),
    /** Disconnect; if this session launched the app, kill its process tree by PID. */
    close: async () => {
      await browser.close().catch(() => {}); // CDP connect: disconnects only
      if (s.owned) killTree(s.pid);
    },
  };
}

// ---------------------------------------------------------------------------
// xterm helpers. The app keeps xterm Terminal objects in React state, not on
// window; we reach them via the React fiber attached to the `.xterm` element.
// ---------------------------------------------------------------------------

/** Page-side function: find xterm Terminal instances (by walking React fibers). */
export function findTerminalsInPage() {
  const found = [];
  const seen = new Set();
  const looksLikeTerm = (v) => v && typeof v === "object" && v.buffer && v.buffer.active
    && typeof v.buffer.active.getLine === "function" && typeof v.cols === "number";
  const scan = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 3 || seen.has(v)) return null;
    seen.add(v);
    if (looksLikeTerm(v)) return v;
    if (v.current && looksLikeTerm(v.current)) return v.current;
    for (const k of Object.keys(v)) {
      if (k === "_owner" || k === "return" || k === "child" || k === "sibling" || k === "stateNode") continue;
      let r = null;
      try { r = scan(v[k], depth + 1); } catch { /* getter threw */ }
      if (r) return r;
    }
    return null;
  };
  for (const el of document.querySelectorAll(".xterm")) {
    let host = el.parentElement;
    let term = null;
    for (let up = 0; host && up < 6 && !term; up++, host = host.parentElement) {
      const key = Object.keys(host).find((k) => k.startsWith("__reactFiber$"));
      let fiber = key ? host[key] : null;
      for (let i = 0; fiber && i < 40 && !term; i++, fiber = fiber.return) {
        let hook = fiber.memoizedState;
        for (let h = 0; hook && h < 60 && !term; h++, hook = hook.next) {
          term = scan(hook.memoizedState, 0);
        }
        if (!term && fiber.memoizedProps) term = scan(fiber.memoizedProps, 0);
      }
    }
    if (term && !found.includes(term)) found.push(term);
  }
  window.__qfHarnessTerms = found;
  return found.length;
}
