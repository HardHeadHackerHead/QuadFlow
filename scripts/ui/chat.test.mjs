// E2E test of the Chat plugin (MIG-chat), against a fake OpenAI-compatible SSE server started by
// the test (no real endpoint, no API key): a reply streams into the tile (the partial answer is
// visible before it completes) and is stored (the CLI reads it back); a conversation created
// with the CLI appears live; an unreachable endpoint shows a clean error and the tile stays
// usable; the API key field is write-only; the flyout shares the data; the palette provider
// finds conversations; `quadflow docs chat` comes from the plugin.
//
// Run: npm run test:e2e   (needs the dev exe: npm run build:dev-exe)
// Against an app that does not bundle the plugin yet (e.g. a frozen dev exe), set
// QF_UI_DEV_PLUGINS=1: the test then loads plugins/chat as an unpacked (dev) plugin.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const PLUGIN = "chat";
const REPLY = ["Streaming ", "works ", "through ", "the ", "plugin."];
let s;
let server;
let requests = [];

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

/** A fake OpenAI-compatible endpoint: `/models` and a slowly streamed chat completion. */
function startFakeLlm() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        requests.push({ method: req.method, url: req.url, auth: !!req.headers.authorization, body });
        if (req.url.endsWith("/models")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const t of REPLY) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
          await new Promise((r) => setTimeout(r, 400));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** A local port nothing listens on. */
function closedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Load `plugins/<id>` unpacked through Settings → Plugins → "Load unpacked…" (trusted: first-party
 * checkout layout + `plugins.devTrusted`) and approve its permissions.
 */
async function loadDevPlugin(id) {
  const dir = path.join(ROOT, "plugins", id);
  await s.eval((d) => {
    window.__QF_TEST_PICK_FOLDER__ = () => d;
    return window.__TAURI_INTERNALS__.invoke("settings_set", { namespace: "plugins", key: "devTrusted", value: true });
  }, dir);
  await s.click('button[title="Settings"]');
  await s.clickText("Open Settings");
  await s.clickText("Plugins");
  await s.waitFor('[data-testid="plugins-settings"]', { timeout: 15_000 });
  await s.click('[data-testid="plugins-load-unpacked"]');
  const row = `[data-testid="plugin-row-${id}"]`;
  await s.page.locator(`${row} >> text=Approve`).click({ timeout: 15_000 });
  await s.click('[data-testid="plugin-consent-confirm"]');
  const info = await waitUntil(async () => {
    const p = await s.eval((pid) => window.__TAURI_INTERNALS__.invoke("plugins_list", { includeUnsupported: true }).then((l) => l.find((x) => x.id === pid && x.origin === "dev")), id);
    return p?.status.kind === "active" ? p : null;
  }, { msg: `the dev copy of ${id} to become active` });
  assert.equal(info.isolation, "trusted", JSON.stringify(info));
  await s.click(".fixed.inset-0 button >> nth=0"); // close Settings
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Run the palette row "<title> <subtitle>" that opens a tile of `tiles()`. With an unpacked
 * copy loaded next to the old built-in tool, two rows share the title: try them in order.
 */
async function openTileFromPalette(title, subtitle, tiles) {
  for (let i = 0; i < 4; i++) {
    const before = await tiles().count();
    await openPalette();
    await paletteInput().fill(title);
    // A tile without a tool config yet is listed as "plugin <id>".
    const rows = s.page.locator("div.cursor-pointer", { hasText: new RegExp(`^\\s*${esc(title)}\\s*(?:${esc(subtitle)}|plugin ${PLUGIN})\\s*$`) });
    await rows.first().waitFor({ state: "visible", timeout: 60_000 });
    if (i >= (await rows.count())) break;
    await rows.nth(i).click();
    await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
    const opened = await waitUntil(async () => (await tiles().count()) > before, { timeout: 8_000 }).catch(() => false);
    if (opened) return;
    await s.press("Escape"); // a flyout of the other tool
  }
  throw new Error(`no palette row "${title}" opened the plugin tile`);
}

const tiles = () => s.page.locator(`[data-plugin-id="${PLUGIN}"][data-plugin-tile="chat"]`);

before(async () => {
  server = await startFakeLlm();
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  if (process.env.QF_UI_DEV_PLUGINS === "1") await loadDevPlugin(PLUGIN);
  const { port } = server.address();
  qf(["chat", "settings", "--endpoint", `http://127.0.0.1:${port}/v1`, "--model", "fake-model", "--timeout-seconds", "20"]);
});

after(async () => {
  await shot("chat-final");
  if (s) await s.close();
  server?.close();
});

test("pane: a reply streams in and is stored", async () => {
  await openTileFromPalette("Open Chat", "Chat", tiles);
  const tile = tiles().first();
  await tile.locator('[data-testid="chat-tool"]').waitFor({ timeout: 30_000 });
  await tile.locator('[data-testid="chat-input"]').fill("Hello from the e2e test");
  await tile.locator('[data-testid="chat-input"]').press("Enter");

  // Partial answer while the server is still streaming.
  const streaming = tile.locator('[data-chat-message="streaming"]');
  await streaming.getByText("Streaming works", { exact: false }).waitFor({ timeout: 20_000 });
  await tile.locator('[data-testid="chat-streaming"]').waitFor({ timeout: 5_000 });
  await shot("chat-streaming");
  const done = tile.locator('[data-chat-message="assistant"]', { hasText: REPLY.join("") });
  await done.waitFor({ timeout: 20_000 });
  await streaming.waitFor({ state: "detached", timeout: 10_000 });
  await tile.locator('[data-chat-conversation="Hello from the e2e test"]').waitFor({ timeout: 10_000 });

  const conv = qf(["chat", "list"]).find((c) => c.title === "Hello from the e2e test");
  assert.ok(conv, "the conversation is in `quadflow chat list`");
  const msgs = qf(["chat", "messages", conv.id]);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[1].content, REPLY.join(""));
  assert.ok(requests.some((r) => r.method === "POST" && r.body.includes("Hello from the e2e test")), JSON.stringify(requests));
  await shot("chat-reply");
});

test("pane: a conversation created with the CLI appears live", async () => {
  const tile = tiles().first();
  qf(["chat", "create", "--title", "CLI chat qf-e2e"]);
  await tile.locator('[data-chat-conversation="CLI chat qf-e2e"]').waitFor({ timeout: 20_000 });
});

test("pane: an unreachable endpoint shows a clean error", async () => {
  const port = await closedPort();
  qf(["chat", "settings", "--endpoint", `http://127.0.0.1:${port}/v1`, "--timeout-seconds", "5"]);
  const tile = tiles().first();
  await tile.locator('[data-chat-conversation="CLI chat qf-e2e"]').click();
  await tile.locator('[data-testid="chat-input"]').fill("Is anybody there?");
  await tile.locator('[data-testid="chat-input"]').press("Enter");
  const err = tile.locator('[data-testid="chat-error"]');
  await err.waitFor({ timeout: 30_000 });
  const text = (await err.innerText()).trim();
  assert.ok(text.length > 0 && text.length < 400, `a short message: ${text}`);
  assert.doesNotMatch(text, /\bat \w+ \(|\[object Object\]|undefined/, text);
  // The tile stays usable: the input is enabled again, the user message was kept.
  assert.equal(await tile.locator('[data-testid="chat-input"]').isDisabled(), false);
  await tile.locator('[data-chat-message="user"]', { hasText: "Is anybody there?" }).waitFor({ timeout: 5_000 });
  await shot("chat-unreachable");
  await err.getByTitle("Dismiss").click();
  await err.waitFor({ state: "detached", timeout: 5_000 });
});

test("settings: the endpoint is editable and the stored key is used, write-only", async () => {
  const tile = tiles().first();
  // The CLI pointed the endpoint at a closed port (previous test): the change reached the plugin
  // as a `settings` event (API 1.4), so the dialog shows it.
  await tile.locator('[data-testid="chat-open-settings"]').click();
  const endpoint = s.page.locator('[data-testid="chat-endpoint-input"]');
  await endpoint.waitFor({ timeout: 10_000 });
  assert.doesNotMatch(await endpoint.inputValue(), new RegExp(`:${server.address().port}/`));
  await endpoint.fill(`http://127.0.0.1:${server.address().port}/v1`);
  const key = s.page.locator('[data-testid="chat-api-key-input"]');
  await key.waitFor({ timeout: 10_000 });
  assert.equal(await key.inputValue(), "");
  await key.fill("sk-qf-e2e-not-a-real-key");
  await s.page.locator('[data-testid="chat-settings-save"]').click();
  await key.waitFor({ state: "detached", timeout: 10_000 });
  // Saved through data.chat.settingsUpdate (the CLI reads it back) …
  assert.match(qf(["chat", "settings"]).endpoint, new RegExp(`:${server.address().port}/v1$`));
  // … and core chat sends the plugin's secret as the bearer token.
  const before = requests.length;
  await tile.locator('[data-testid="chat-input"]').fill("With a key");
  await tile.locator('[data-testid="chat-input"]').press("Enter");
  await tile.locator('[data-chat-message="assistant"]', { hasText: REPLY.join("") }).last().waitFor({ timeout: 30_000 });
  const posted = requests.slice(before).filter((r) => r.method === "POST");
  assert.ok(posted.length > 0 && posted.every((r) => r.auth), JSON.stringify(posted.map((r) => r.auth)));

  await tile.locator('[data-testid="chat-open-settings"]').click();
  await key.waitFor({ timeout: 10_000 });
  assert.equal(await key.inputValue(), "", "the stored key is never shown again");
  assert.match(await key.getAttribute("placeholder"), /A key is stored/);
  assert.doesNotMatch(await s.page.locator('[data-testid="chat-settings"]').innerText(), /sk-qf-e2e/);
  await shot("chat-settings");
  // Remove it again (the dev profile's keystore entry).
  await s.page.getByRole("button", { name: "Clear", exact: true }).click();
  await waitUntil(async () => /Not required/.test(await key.getAttribute("placeholder")), { msg: "the key to be cleared" });
  await s.press("Escape");
});

test("flyout shares the conversations", async () => {
  await openTileFromPalette("Open Chat in Flyout", "Chat", tiles);
  const flyout = tiles().last();
  await flyout.locator('[data-chat-conversation="Hello from the e2e test"]').waitFor({ timeout: 20_000 });
  await flyout.locator('[data-chat-conversation="CLI chat qf-e2e"]').waitFor({ timeout: 20_000 });
  await shot("chat-flyout");
  await s.press("Escape");
});

test("palette finds conversations through the plugin's palette provider", async () => {
  await openPalette();
  await paletteInput().fill("CLI chat qf");
  const row = s.page.locator("div.cursor-pointer", { hasText: "CLI chat qf-e2e" }).first();
  await row.waitFor({ timeout: 20_000 });
  await shot("chat-palette");
  await s.press("Escape");
});

test("`quadflow docs chat` comes from the plugin", () => {
  const list = qf(["docs", "--list"]);
  assert.equal(list.find((m) => m.id === "chat")?.source, "chat", JSON.stringify(list));
  assert.match(qf(["docs", "chat"]), /quadflow chat send/);
});

test("no uncaught page errors", () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
