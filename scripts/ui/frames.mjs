// Out-of-process iframes (OOPIFs) over raw CDP.
//
// Sandboxed plugin frames (`/_frame/<id>`, plugin-system.md §8.4) have an opaque origin on a
// different site than the app, so WebView2 runs them out of process. Playwright's
// `connectOverCDP` does not expose such frames of an existing page in `page.frames()`, so this
// module talks to the frame's own DevTools target (`/json/list`, type "iframe") directly:
// `Runtime.evaluate` in the frame's main world.

/** DevTools targets of type "iframe" whose URL includes `match`. */
export async function frameTargets(port, match) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === "iframe" && t.url.includes(match));
}

/** Wait for a frame target whose URL includes `match`. */
export async function waitForFrameTarget(port, match, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [t] = await frameTargets(port, match).catch(() => []);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no iframe target matching ${match}`);
}

/**
 * A CDP connection to one frame target. `evaluate(fnOrExpr, arg)` runs in the frame
 * (functions are serialized; `arg` must be JSON) and returns the JSON result; a thrown
 * exception rejects.
 */
export async function connectFrame(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${target.url}`)), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return {
    url: target.url,
    async evaluate(fnOrExpr, arg) {
      const expression = typeof fnOrExpr === "function" ? `(${fnOrExpr.toString()})(${JSON.stringify(arg ?? null)})` : fnOrExpr;
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) {
        throw new Error(`frame evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      }
      return r.result.value;
    },
    close: () => ws.close(),
  };
}
