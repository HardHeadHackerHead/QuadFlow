// E2E test of the External Apps plugin (MIG-external-apps, Windows only): a small test window
// (a WinForms form this test spawns) shows up in the tile's window list; embedding makes it a
// child of QuadFlow's main window, shown on the tile; an overlay (the command palette) hides it
// and closing the overlay shows it again; Pop Out gives it back as a normal top-level window;
// Reattach embeds it again and closing the tile detaches it. Only the process this test
// spawned is killed, by PID.
//
// Run: node --test scripts/ui/external-apps.test.mjs   (needs the dev exe, or QF_UI_EXE; on an
// exe without the bundled plugin, plugins/external-apps must be built including its sidecar
// binary in plugins/external-apps/bin — see devplugins.mjs)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { launch } from "./harness.mjs";
import { ensureFirstPartyPlugin } from "./devplugins.mjs";

const WIN = process.platform === "win32";
const SHOTS = process.env.QF_UI_SHOTS_DIR;
const TITLE = `qf-extapps-${process.pid}-${Date.now() % 100000}`;

let s;
let testWindow; // the ChildProcess of our test window
let hwnd;

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

const ps = (script) => {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60_000 });
  if (r.error) throw r.error;
  return r.stdout.trim();
};

/** Native state of `h`: visible, whether its parent is the desktop (top-level), root window's pid. */
function nativeState(h) {
  const out = ps(`
$sig = @'
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
[DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
Add-Type -MemberDefinition $sig -Name U -Namespace QfExtApps
$h = [IntPtr]${Number(h)}
$root = [QfExtApps.U]::GetAncestor($h, 2)
[uint32]$pid2 = 0
[void][QfExtApps.U]::GetWindowThreadProcessId($root, [ref]$pid2)
"{0}|{1}|{2}|{3}" -f [QfExtApps.U]::IsWindow($h), [QfExtApps.U]::IsWindowVisible($h), ([QfExtApps.U]::GetAncestor($h, 1) -eq [QfExtApps.U]::GetDesktopWindow()), $pid2
`);
  const [exists, visible, topLevel, rootPid] = out.split(/\r?\n/).pop().split("|");
  return { exists: exists === "True", visible: visible === "True", topLevel: topLevel === "True", rootPid: Number(rootPid) };
}

/**
 * Is the embedded window really drawn on screen (not just "visible")? Samples a grid of points
 * of its rect where it is the topmost window (WindowFromPoint) and reads the screen pixel there:
 * the form is lime. Returns "painted", "not-painted", or "covered" (another app's window is in
 * front of QuadFlow at every sample point, so there is nothing to check). Nothing is saved.
 */
function paintState(h) {
  return ps(`
Add-Type -AssemblyName System.Drawing
$sig = @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
public struct RECT { public int L; public int T; public int R; public int B; }
public struct POINT { public int X; public int Y; }
'@
Add-Type -MemberDefinition $sig -Name P -Namespace QfExtAppsPaint
$h = [IntPtr]${Number(h)}
$r = New-Object QfExtAppsPaint.P+RECT
[void][QfExtAppsPaint.P]::GetWindowRect($h, [ref]$r)
$bmp = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$state = 'covered'
foreach ($fx in 0.1, 0.5, 0.9) { foreach ($fy in 0.1, 0.5, 0.9) {
  $p = New-Object QfExtAppsPaint.P+POINT
  $p.X = [int]($r.L + ($r.R - $r.L) * $fx); $p.Y = [int]($r.T + ($r.B - $r.T) * $fy)
  if ([QfExtAppsPaint.P]::WindowFromPoint($p) -ne $h) { continue }
  $g.CopyFromScreen($p.X, $p.Y, 0, 0, $bmp.Size)
  $c = $bmp.GetPixel(0, 0)
  if ($c.G -gt 200 -and $c.R -lt 60 -and $c.B -lt 60) { $state = 'painted'; break } else { $state = 'not-painted' }
} ; if ($state -eq 'painted') { break } }
$state
`).split(/\r?\n/).pop();
}

const paletteInput = () => s.page.locator('input[placeholder="Type a command or search..."]');

async function openPalette() {
  await waitUntil(async () => {
    if (!(await paletteInput().isVisible())) await s.press("Control+k");
    return paletteInput().isVisible();
  }, { timeout: 30_000, interval: 1000, msg: "the command palette" });
}

async function runFromPalette(title) {
  await openPalette();
  await paletteInput().fill(title);
  const item = s.page.locator("div.cursor-pointer", { hasText: title }).first();
  await item.waitFor({ state: "visible", timeout: 60_000 });
  await item.click();
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
}

const tile = () => s.page.locator('[data-plugin-id="external-apps"][data-plugin-tile="app"]').first();
const container = () => tile().locator("[data-embed-container]");

before(async () => {
  if (!WIN) return;
  // The test window: a WinForms form in a PowerShell process we own.
  testWindow = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '${TITLE}'; $f.Width = 520; $f.Height = 320; $f.BackColor = [System.Drawing.Color]::Lime; ` +
        `$l = New-Object System.Windows.Forms.Label; $l.Text = 'External Apps test window'; $l.AutoSize = $true; $f.Controls.Add($l); [System.Windows.Forms.Application]::Run($f)`,
    ],
    { stdio: "ignore", windowsHide: false },
  );
  s = await launch();
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
  await ensureFirstPartyPlugin(s, "external-apps");
  await s.waitFor('button[title^="Terminal"]', { timeout: 60_000 });
});

after(async () => {
  await shot("external-apps-final");
  if (s) await s.close();
  // Only the process this test started, by PID (its tree: the form runs in it).
  if (testWindow?.pid) spawnSync("taskkill", ["/PID", String(testWindow.pid), "/T", "/F"], { stdio: "ignore" });
});

test("the window list shows the test window", { skip: !WIN }, async () => {
  await runFromPalette("Embed a Window");
  await tile().waitFor({ state: "visible", timeout: 30_000 });
  await tile().locator('[data-ext-mode="picker"]').waitFor({ timeout: 30_000 });
  const row = tile().locator(`[data-window-row][data-title="${TITLE}"]`);
  await waitUntil(async () => {
    if (await row.count()) return true;
    await tile().getByRole("button", { name: "Refresh window list" }).click();
    return false;
  }, { timeout: 60_000, interval: 1500, msg: "the test window in the list" });
  hwnd = Number(await row.getAttribute("data-hwnd"));
  assert.ok(hwnd > 0);
  assert.equal(Number(await row.getAttribute("data-pid")), testWindow.pid);
  // QuadFlow's own windows are never offered.
  const own = await tile().locator(`[data-window-row][data-pid="${s.pid}"]`).count();
  assert.equal(own, 0);
  await shot("external-apps-picker");
});

test("embed: the window becomes a visible child of QuadFlow on the tile", { skip: !WIN }, async () => {
  await tile().locator(`[data-window-row][data-hwnd="${hwnd}"] [data-action="embed"]`).click();
  await tile().locator('[data-ext-mode="embedded"]').waitFor({ timeout: 30_000 });
  await container().and(s.page.locator('[data-embed-visible="true"]')).waitFor({ timeout: 20_000 });
  const n = await waitUntil(async () => {
    const st = nativeState(hwnd);
    return st.exists && st.visible && !st.topLevel ? st : null;
  }, { timeout: 20_000, interval: 1000, msg: "the embedded window to be a visible child" });
  assert.notEqual(n.rootPid, testWindow.pid, "root window should be QuadFlow's main window");
  // Drawn above QuadFlow's webview (not merely visible but painted over by it).
  const paint = await waitUntil(async () => {
    const st = paintState(hwnd);
    return st === "not-painted" ? null : st;
  }, { timeout: 10_000, interval: 1000, msg: "the embedded window to be drawn" }).catch(() => "not-painted");
  assert.notEqual(paint, "not-painted", "the embedded window is hidden behind QuadFlow's webview");
  if (paint === "covered") console.log("# paint check skipped: QuadFlow is covered by another window");
  await shot("external-apps-embedded");
});

test("an overlay hides the embedded window; closing it shows it again", { skip: !WIN }, async () => {
  await openPalette();
  await container().and(s.page.locator('[data-embed-visible="false"]')).waitFor({ timeout: 10_000 });
  await waitUntil(async () => !nativeState(hwnd).visible, { timeout: 15_000, interval: 750, msg: "the window to hide under the palette" });
  await shot("external-apps-under-overlay");
  await s.press("Escape");
  await paletteInput().waitFor({ state: "hidden", timeout: 10_000 });
  await container().and(s.page.locator('[data-embed-visible="true"]')).waitFor({ timeout: 10_000 });
  await waitUntil(async () => nativeState(hwnd).visible, { timeout: 15_000, interval: 750, msg: "the window to show again" });
});

test("pop out gives the window back as a top-level window", { skip: !WIN }, async () => {
  await tile().locator('[data-action="pop-out"]').click();
  await tile().locator('[data-ext-mode="picker"]').waitFor({ timeout: 20_000 });
  await waitUntil(async () => {
    const st = nativeState(hwnd);
    return st.exists && st.visible && st.topLevel;
  }, { timeout: 20_000, interval: 1000, msg: "the window to be top-level again" });
  await tile().locator('[data-action="reattach"]').waitFor({ timeout: 20_000 });
  await shot("external-apps-popped-out");
});

test("reattach, then closing the tile detaches the window", { skip: !WIN }, async () => {
  await tile().locator('[data-action="reattach"]').click();
  await tile().locator('[data-ext-mode="embedded"]').waitFor({ timeout: 30_000 });
  await waitUntil(async () => !nativeState(hwnd).topLevel, { timeout: 20_000, interval: 1000, msg: "re-embedded" });
  await s.page.locator('.mosaic-tile button[title="Close tool"]').first().click();
  await tile().waitFor({ state: "detached", timeout: 20_000 });
  await waitUntil(async () => {
    const st = nativeState(hwnd);
    return st.exists && st.visible && st.topLevel;
  }, { timeout: 20_000, interval: 1000, msg: "the window to be detached after the tile closed" });
});

test("no page errors", { skip: !WIN }, async () => {
  assert.deepEqual(s.pageErrors, []);
});
