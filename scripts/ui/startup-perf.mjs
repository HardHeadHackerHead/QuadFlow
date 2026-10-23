#!/usr/bin/env node
// Startup performance probe for the isolated dev app.
//
//   node scripts/ui/startup-perf.mjs [--runs N] [--json]
//
// Launches the app through the harness (same isolation as `cli.mjs launch`),
// waits until the shell is interactive, then reads the WebView's resource
// timing entries. On Windows every Tauri IPC call is a fetch to
// `http://ipc.localhost/<command>`, so each entry is one command with its
// start time and duration relative to the page's navigation start.
//
// Reports per run:
//   - spawnToNav:   process spawn -> webview navigation start (Rust setup + window)
//   - firstIpc:     navigation start -> first IPC response end
//   - slowest IPC calls (command, start, duration)
//   - interactive:  navigation start -> toolbar rendered
//   - probe:        a fresh `core_info` round trip after interactive
//
// Kills only the PID tree it launched.

import { launch } from "./harness.mjs";

const args = process.argv.slice(2);
const runsIdx = args.indexOf("--runs");
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) || 1 : 1;
const asJson = args.includes("--json");

async function once() {
  const spawnedAt = Date.now();
  const s = await launch();
  try {
    // Interactive = the toolbar (or empty state) is rendered.
    await s.page.waitForFunction(
      () => !!document.querySelector('button[title^="Terminal"]') || document.body.innerText.includes("No terminals"),
      null,
      { timeout: 60_000, polling: 50 },
    );
    const interactiveAbs = Date.now();
    // Let trailing startup work settle so the entries cover it.
    await s.page.waitForTimeout(1500);
    const data = await s.page.evaluate(async () => {
      const nav = performance.timeOrigin;
      const ipc = performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("ipc.localhost"))
        .map((e) => ({
          cmd: decodeURIComponent(new URL(e.name).pathname.slice(1)),
          start: Math.round(e.startTime),
          dur: Math.round(e.duration),
          end: Math.round(e.responseEnd || e.startTime + e.duration),
        }));
      const t0 = performance.now();
      await window.__TAURI_INTERNALS__.invoke("core_info");
      const probe = performance.now() - t0;
      return { nav, ipc, probe: Math.round(probe) };
    });
    const ipc = data.ipc;
    const firstIpc = ipc.length ? Math.min(...ipc.map((e) => e.end)) : null;
    const lastStartupIpc = ipc.length ? Math.max(...ipc.map((e) => e.end)) : null;
    return {
      spawnToNav: Math.round(data.nav - spawnedAt),
      firstIpc,
      lastStartupIpc,
      interactive: Math.round(interactiveAbs - data.nav),
      probe: data.probe,
      ipcCount: ipc.length,
      slowest: [...ipc].sort((a, b) => b.dur - a.dur).slice(0, 12),
      firstCalls: [...ipc].sort((a, b) => a.start - b.start).slice(0, 12),
    };
  } finally {
    await s.close();
  }
}

const results = [];
for (let i = 0; i < runs; i++) {
  const r = await once();
  results.push(r);
  if (!asJson) {
    console.log(`run ${i + 1}: spawn->nav ${r.spawnToNav} ms | first IPC ${r.firstIpc} ms | interactive ${r.interactive} ms | `
      + `last startup IPC ${r.lastStartupIpc} ms | core_info probe ${r.probe} ms | ${r.ipcCount} IPC calls`);
    console.log("  slowest:", r.slowest.map((e) => `${e.cmd}@${e.start}+${e.dur}`).join(", "));
    console.log("  first:  ", r.firstCalls.map((e) => `${e.cmd}@${e.start}+${e.dur}`).join(", "));
  }
}
if (asJson) console.log(JSON.stringify(results, null, 2));
