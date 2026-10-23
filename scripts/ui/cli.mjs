#!/usr/bin/env node
// Step-by-step CLI over the QuadFlow GUI harness, for agents driving the UI
// from separate Bash calls. Session state (PID, CDP port, log paths) lives in
// <os tmp>/quadflow-ui-harness/session.json. See scripts/ui/README.md.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  HARNESS_TMP, STATE_FILE, spawnApp, connect, makeSession, killTree, isAlive,
} from "./harness.mjs";
import { readTerminalLines, terminalCount } from "./xterm.mjs";

const __filename = fileURLToPath(import.meta.url);
const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage: node scripts/ui/cli.mjs <command> [args]

  launch [--mode exe|dev] [--project <dir>] [--timeout <sec>] [--onboarding]
                         start the isolated dev app and wait until it is drivable
                         (--onboarding: show the first-run welcome flow, normally skipped)
  status                 show the session (pid, port, log paths, alive?)
  shot <file.png>        screenshot of the main window (view it with the Read tool)
  click <selector>       click (Playwright selector: css, text=Foo, role=button[name="X"])
  clicktext <text>       click first element containing <text>
  type <selector> <text> fill an input, or click the element and type keys
  keys <text>            type raw keystrokes into the focused element
  press <key>            press a key / chord, e.g. Enter, Control+Shift+T
  text [selector]        print innerText (default: body)
  html <selector>        print outerHTML
  wait <selector> [sec]  wait until visible
  js <code>              evaluate JS in the page; prints JSON result (alias: eval)
                         an expression, or a body containing \`return\`
  term [index]           print the xterm buffer of terminal #index (default: last)
  logs [--tail N]        print the app's captured Rust stdout/stderr
  console [--tail N]     print captured console messages + page errors (JSONL)
  close                  kill the launched app (by PID only) and clear the session
`;

function readState() {
  if (!fs.existsSync(STATE_FILE)) die("no session. Run: node scripts/ui/cli.mjs launch");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
function die(msg, code = 1) { console.error(msg); process.exit(code); }
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function tail(text, n) {
  if (!n) return text;
  return text.split(/\r?\n/).slice(-Number(n)).join("\n");
}

async function withSession(fn) {
  const st = readState();
  if (!isAlive(st.pid)) die(`app (pid ${st.pid}) is not running. Run close, then launch again. Log: ${st.logFile}`);
  const { browser, page } = await connect(st.port, { timeoutMs: 15_000 });
  const s = makeSession({ ...st, browser, page, owned: false });
  try { return await fn(s, page); } finally { await browser.close().catch(() => {}); }
}

async function main() {
  switch (cmd) {
    case "launch": {
      if (fs.existsSync(STATE_FILE)) {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (isAlive(st.pid)) die(`session already running (pid ${st.pid}, port ${st.port}). Run close first.`);
        fs.rmSync(STATE_FILE, { force: true });
      }
      const mode = flag("mode");
      const projectDir = flag("project");
      const runDir = flag("run-dir");
      const oi = args.indexOf("--onboarding");
      const onboarding = oi !== -1;
      if (onboarding) args.splice(oi, 1);
      const timeoutSec = Number(flag("timeout", mode === "dev" ? 900 : 90));
      const run = await spawnApp({ mode, projectDir, runDir, onboarding, detached: true });
      const state = {
        pid: run.pid, port: run.port, mode: run.mode, runDir: run.runDir,
        projectDir: run.projectDir, logFile: run.logFile,
        consoleFile: path.join(run.runDir, "console.jsonl"), startedAt: new Date().toISOString(),
      };
      fs.mkdirSync(HARNESS_TMP, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      const deadline = Date.now() + timeoutSec * 1000;
      let ok = false;
      while (Date.now() < deadline) {
        if (!isAlive(run.pid)) break;
        try { const r = await fetch(`http://127.0.0.1:${run.port}/json/version`); if (r.ok) { ok = true; break; } } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ok) {
        killTree(run.pid);
        fs.rmSync(STATE_FILE, { force: true });
        die(`app did not expose CDP in ${timeoutSec}s. Last log lines:\n${tail(fs.existsSync(run.logFile) ? fs.readFileSync(run.logFile, "utf8") : "", 30)}`);
      }
      // Background console collector (keeps a CDP connection open, appends JSONL).
      const col = spawn(process.execPath, [__filename, "__collect", String(run.port), state.consoleFile], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      col.unref();
      state.collectorPid = col.pid;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      await withSession(async (s, page) => {
        await page.waitForSelector("#root > *", { timeout: 60_000 });
        console.log(JSON.stringify({ ok: true, ...state, url: page.url(), title: await page.title() }, null, 2));
      });
      return;
    }
    case "__collect": {
      const [port, file] = args;
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const write = (o) => fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
      const hook = (p) => {
        p.on("console", (m) => write({ kind: "console", type: m.type(), text: m.text(), url: p.url() }));
        p.on("pageerror", (e) => write({ kind: "pageerror", text: e.message, stack: e.stack, url: p.url() }));
      };
      for (const c of browser.contexts()) { c.pages().forEach(hook); c.on("page", hook); }
      browser.on("disconnected", () => process.exit(0));
      return; // stay alive on the open connection
    }
    case "status": {
      const st = readState();
      console.log(JSON.stringify({ ...st, alive: isAlive(st.pid) }, null, 2));
      return;
    }
    case "shot": {
      const file = args[0] ?? path.join(readState().runDir, `shot-${Date.now()}.png`);
      await withSession(async (s) => console.log(await s.screenshot(file)));
      return;
    }
    case "click": return withSession(async (s) => { await s.click(args[0], { timeout: 10_000 }); console.log("ok"); });
    case "clicktext": return withSession(async (s) => { await s.clickText(args.join(" "), { timeout: 10_000 }); console.log("ok"); });
    case "type": return withSession(async (s) => { await s.type(args[0], args.slice(1).join(" ")); console.log("ok"); });
    case "keys": return withSession(async (s) => { await s.typeKeys(args.join(" ")); console.log("ok"); });
    case "press": return withSession(async (s) => { await s.press(args[0]); console.log("ok"); });
    case "text": return withSession(async (s) => console.log(args[0] ? await s.text(args[0]) : await s.allText()));
    case "html": return withSession(async (_s, page) => console.log(await page.locator(args[0]).first().evaluate((e) => e.outerHTML)));
    case "wait": return withSession(async (s) => { await s.waitFor(args[0], { timeout: Number(args[1] ?? 15) * 1000 }); console.log("ok"); });
    case "js":
    case "eval": return withSession(async (s) => {
      const src = args.join(" ");
      // An expression (`document.title`) or, if it contains `return`, a function body.
      const body = /\breturn\b/.test(src) ? src : `return (${src});`;
      const res = await s.eval(`(async () => { ${body} })()`);
      console.log(JSON.stringify(res, null, 2));
    });
    case "term": return withSession(async (_s, page) => {
      const n = await terminalCount(page);
      if (!n) die("no xterm terminals found");
      const idx = args[0] !== undefined ? Number(args[0]) : n - 1;
      const lines = await readTerminalLines(page, idx);
      console.log(lines.join("\n"));
    });
    case "logs": {
      const st = readState();
      const n = flag("tail");
      console.log(tail(fs.existsSync(st.logFile) ? fs.readFileSync(st.logFile, "utf8") : "", n));
      return;
    }
    case "console": {
      const st = readState();
      const n = flag("tail");
      console.log(tail(fs.existsSync(st.consoleFile) ? fs.readFileSync(st.consoleFile, "utf8") : "", n));
      return;
    }
    case "close": {
      if (!fs.existsSync(STATE_FILE)) { console.log("no session"); return; }
      const st = readState();
      killTree(st.pid);
      if (st.collectorPid) killTree(st.collectorPid);
      fs.rmSync(STATE_FILE, { force: true });
      console.log(`closed pid ${st.pid}. Artifacts kept in ${st.runDir}`);
      return;
    }
    default:
      console.log(usage);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => die(e.stack || String(e)));
