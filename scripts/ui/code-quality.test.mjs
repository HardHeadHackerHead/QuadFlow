// E2E test of the migrated Code Quality plugin (MIG-code-quality): the tile opens from its
// command, scans the scratch project through ctx.fs and shows a grade, and the AI insight
// (a one-off Chat request through ctx.data.chat) fails cleanly when no chat endpoint is set.
//
// Run: node --test scripts/ui/code-quality.test.mjs   (needs the dev exe, or QF_UI_EXE; on an
// exe without the bundled plugin, plugins/code-quality must be built — see devplugins.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { launch } from "./harness.mjs";
import { ensureFirstPartyPlugin } from "./devplugins.mjs";

let s;
const SHOTS = process.env.QF_UI_SHOTS_DIR;

async function shot(name) {
  if (!s) return;
  try { await s.screenshot(path.join(SHOTS || s.runDir, `${name}.png`)); } catch { /* best effort */ }
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function runFromPalette(title) {
  for (let i = 0; i < 30 && !(await paletteInput().isVisible()); i++) {
    await s.press("Control+k");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

/** The built CLI against the app's isolated data dir and scratch project. */
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

const tile = () => s.page.locator('[data-plugin-id="code-quality"][data-plugin-tile="report"]').first();

before(async () => {
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  // A small project: a marker file, sources, comments and a test.
  writeFileSync(path.join(s.projectDir, "package.json"), '{ "name": "scratch" }\n');
  mkdirSync(path.join(s.projectDir, "src"), { recursive: true });
  writeFileSync(
    path.join(s.projectDir, "src", "math.ts"),
    "// Adds numbers\nexport function add(a: number, b: number) {\n  if (a > b) return a + b\n  return b + a\n}\n",
  );
  writeFileSync(path.join(s.projectDir, "src", "math.test.ts"), "import { add } from './math'\nif (add(1, 2) !== 3) throw new Error('bad')\n");
  await ensureFirstPartyPlugin(s, "code-quality");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("code-quality-final");
  if (s) await s.close();
});

test("tile renders and scans the scratch project", async () => {
  await runFromPalette("Rescan Code Quality");
  await tile().waitFor({ state: "visible", timeout: 30_000 });
  const grade = tile().locator('[data-testid="cq-grade"]');
  await grade.waitFor({ timeout: 60_000 });
  // package.json + math.ts + math.test.ts (+ whatever the harness put in the project)
  const text = await grade.innerText();
  const files = Number(/(\d+) files/.exec(text)?.[1] ?? 0);
  assert.ok(files >= 3, text);
  assert.match(text, /^[A-F] /);
  await shot("code-quality-overview");
});

test("AI insight without a chat endpoint shows a clean error", async () => {
  await tile().locator('[data-testid="cq-insight-button"]').click();
  const err = tile().locator('[data-testid="cq-insight-error"]');
  await err.waitFor({ timeout: 60_000 });
  const text = await err.innerText();
  assert.match(text, /AI insight unavailable/);
  assert.doesNotMatch(text, /\[object Object\]|undefined/);
  await shot("code-quality-insight-error");
});

// API 1.4 `data.chat.ask`: a one-off question, nothing stored as a conversation.
test("AI insight through data.chat.ask against a fake endpoint", async () => {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Healthy little project qf-e2e." } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    qf(["chat", "settings", "--endpoint", `http://127.0.0.1:${srv.address().port}/v1`, "--model", "fake-model"]);
    await tile().locator('[data-testid="cq-insight-button"]').click();
    await tile().locator('[data-testid="cq-insight"]').getByText("Healthy little project qf-e2e.").waitFor({ timeout: 30_000 });
    assert.ok(bodies.some((b) => b.includes("code quality metrics")), bodies.join("\n"));
    assert.deepEqual(qf(["chat", "list"]), [], "no conversation is stored");
    await shot("code-quality-insight");
  } finally {
    srv.close();
  }
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
