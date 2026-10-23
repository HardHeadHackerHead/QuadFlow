// E2E test of the OBS Tracker plugin (MIG-streamer): the tile renders from the plugin, its
// sidecar connects to a *mock* obs-websocket server started by this test (no OBS needed, no
// network beyond 127.0.0.1), the status and canvas size come back through the sidecar, the
// scene list fills the picker, the chosen scene (per-tracker settings, plugin storage) and the
// host/port (sidecar data dir) survive a window reload, and disconnect works.
//
// Windows only (the plugin's `platforms`). Run: node --test scripts/ui/obs-tracker.test.mjs
// (needs the dev exe, or QF_UI_EXE; the plugin is not bundled, so plugins/obs-tracker must be
// built with its sidecar — `npm run build` in plugins/obs-tracker — see devplugins.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { launch } from "./harness.mjs";
import { ensureFirstPartyPlugin, ensurePluginBuilt } from "./devplugins.mjs";

const SKIP = process.platform !== "win32" ? "obs-tracker is a Windows-only plugin" : false;

let s;
let obs;
const SHOTS = process.env.QF_UI_SHOTS_DIR;

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

// ---------------------------------------------------------------------------
// A minimal obs-websocket v5 server: handshake (Hello → Identify → Identified) and canned
// answers for the requests the sidecar makes. Hand-rolled RFC 6455 framing (text frames only).
// ---------------------------------------------------------------------------

const SCENES = ["QF Scene A", "QF Scene B"];

function startMockObs() {
  const requests = [];
  const sockets = new Set();
  const answer = (type, data) => {
    switch (type) {
      case "GetVersion":
        return { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0", rpcVersion: 1, availableRequests: [], supportedImageFormats: [], platform: "windows", platformDescription: "Mock OBS" };
      case "GetVideoSettings":
        return { fpsNumerator: 60, fpsDenominator: 1, baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080 };
      case "GetSceneList":
        return {
          currentProgramSceneName: SCENES[0], currentProgramSceneUuid: randomUUID(),
          scenes: SCENES.map((n, i) => ({ sceneName: n, sceneUuid: randomUUID(), sceneIndex: i })),
        };
      default:
        return data ?? {};
    }
  };
  const send = (sock, obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : null;
    if (!head) throw new Error("mock obs: frame too large");
    sock.write(Buffer.concat([head, payload]));
  };
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  server.on("upgrade", (req, sock) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = (buf[1] & 0x80) !== 0;
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const data = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) data[i] ^= buf[maskOff + (i % 4)];
        buf = buf.subarray(off + len);
        if (opcode === 0x8) { sock.end(); return; }
        if (opcode === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
        if (opcode !== 0x1) continue;
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.op === 1) send(sock, { op: 2, d: { negotiatedRpcVersion: 1 } });
        else if (msg.op === 6) {
          requests.push(msg.d.requestType);
          send(sock, { op: 7, d: { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: true, code: 100 }, responseData: answer(msg.d.requestType, msg.d.requestData) } });
        }
      }
    });
    send(sock, { op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => { for (const so of sockets) so.destroy(); server.close(() => r()); }),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tiles = () => s.page.locator('[data-plugin-id="obs-tracker"][data-plugin-tile="tracker"]');

/** The plugin's tracker tile, opened from the palette ("Open OBS Tracker") when none is open. */
async function openTrackerTile() {
  if ((await tiles().count()) > 0) return tiles().first();
  const rowRe = new RegExp(`^\\s*${esc("Open OBS Tracker")}\\s*OBS Tracker\\s*$`);
  await openPalette();
  await paletteInput().fill("Open OBS Tracker");
  const rows = s.page.locator("div.cursor-pointer", { hasText: rowRe });
  await rows.first().waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(await rows.count(), 1, "exactly one palette row opens the OBS Tracker");
  await rows.first().click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
  await waitUntil(async () => (await tiles().count()) > 0, { timeout: 30_000, msg: "the obs-tracker tile" });
  return tiles().first();
}

const sidecar = (method, params = {}) =>
  s.eval(({ method, params }) => window.__TAURI_INTERNALS__.invoke("plugin_sidecar_request", { pluginId: "obs-tracker", method, params, timeoutMs: 20_000 }), { method, params });

before(async () => {
  if (SKIP) return;
  obs = await startMockObs();
  ensurePluginBuilt("obs-tracker");
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await ensureFirstPartyPlugin(s, "obs-tracker");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  if (SKIP) return;
  await shot("obs-tracker-final");
  if (s) {
    await sidecar("disconnect").catch(() => {});
    await s.close();
  }
  if (obs) await obs.close();
});

test("tile renders disconnected, with the connection form", { skip: SKIP }, async () => {
  const tile = await openTrackerTile();
  await tile.getByText("Connect to OBS to begin").waitFor({ timeout: 30_000 });
  await tile.getByText("Disconnected").waitFor();
  await tile.locator('input[placeholder="127.0.0.1"]').waitFor();
  await shot("obs-tracker-disconnected");
});

test("connects to a mock obs-websocket through the sidecar and lists scenes", { skip: SKIP }, async () => {
  const tile = tiles().first();
  await tile.locator('input[placeholder="127.0.0.1"]').fill("127.0.0.1");
  await tile.locator('input[placeholder="4455"]').fill(String(obs.port));
  await tile.getByRole("button", { name: "Connect", exact: true }).click();
  await tile.getByText("Connected to OBS v31.0.0").waitFor({ timeout: 30_000 });
  await tile.getByText("1920x1080").waitFor();
  const status = await sidecar("get_status");
  assert.equal(status.connected, true);
  assert.deepEqual([status.canvas_width, status.canvas_height], [1920, 1080]);
  for (const r of ["GetVersion", "GetVideoSettings", "GetSceneList"]) assert.ok(obs.requests.includes(r), `${r} in ${obs.requests}`);

  // Host/port are saved by the sidecar (password is a secret, none set here).
  const conn = await sidecar("get_connection_settings");
  assert.equal(conn.port, obs.port);
  assert.equal(conn.password, null);

  // Scenes from the mock fill the picker; picking one shows the device list.
  const select = tile.locator("select");
  await waitUntil(async () => (await select.locator("option").allInnerTexts()).includes(SCENES[1]), { msg: "the mock scenes in the picker" });
  await select.selectOption(SCENES[1]);
  await tile.getByText("Devices", { exact: true }).waitFor({ timeout: 10_000 });
  await shot("obs-tracker-connected");
});

test("per-tracker scene and connection settings survive a reload", { skip: SKIP }, async () => {
  // Plugin storage is written asynchronously after the pick.
  await new Promise((r) => setTimeout(r, 1000));
  await s.page.reload();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  const tile = await openTrackerTile();
  // The sidecar kept the connection; the tile shows it and the saved scene.
  await tile.getByText("Connected to OBS v31.0.0").waitFor({ timeout: 30_000 });
  await waitUntil(async () => (await tile.locator("select").inputValue()) === SCENES[1], { timeout: 20_000, msg: "the saved scene" }).catch(async (e) => {
    console.log("select value:", await tile.locator("select").inputValue().catch(() => "?"), "tiles:", await tiles().count());
    throw e;
  });
  await tile.getByText("Connection Settings").click();
  assert.equal(await tile.locator('input[placeholder="4455"]').inputValue(), String(obs.port));
  await shot("obs-tracker-reloaded");
});

test("disconnect", { skip: SKIP }, async () => {
  const tile = tiles().first();
  await tile.getByRole("button", { name: "Disconnect", exact: true }).click();
  await tile.getByText("Connect to OBS to begin").waitFor({ timeout: 20_000 });
  assert.equal((await sidecar("get_status")).connected, false);
});

test("no uncaught page errors", { skip: SKIP }, () => {
  assert.deepEqual(s.pageErrors.map((e) => String(e)), []);
});
