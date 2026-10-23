// Shared setup for e2e tests of first-party plugins (plugins/<id>):
//
//  - against a full build the plugin is bundled (trusted, auto-granted): nothing to do;
//  - against an older app (e.g. a frozen dev exe built before the plugin existed) it is loaded
//    unpacked from this checkout's plugins/<id> (dev beats bundled for the same id), trusted
//    (`plugins.devTrusted`, first-party checkout folder) and granted its declared permissions.
//
// A dev-loaded plugin is (re)built first when its output is older than its sources
// (devplugins.mjs `ensurePluginBuilt`).

import path from "node:path";
import { REPO_ROOT } from "./harness.mjs";
import { ensurePluginBuilt } from "./devplugins.mjs";

const invoke = (s, cmd, args) => s.eval(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

export const pluginInfo = (s, id) =>
  invoke(s, "plugins_list", { includeUnsupported: true }).then((l) => l.find((p) => p.id === id) ?? null);

/**
 * Make `ids` active and trusted in the running app. Returns true when the page was reloaded
 * (call your own "app ready" wait after it). `beforeReload(s)` runs after the plugins are
 * registered in Rust and before the UI reloads (e.g. to create tool configs).
 */
export async function useFirstPartyPlugins(s, ids, { beforeReload } = {}) {
  let changed = false;
  for (const id of ids) {
    const info = await pluginInfo(s, id);
    if (info && info.origin === "bundled" && info.status.kind === "active" && info.isolation === "trusted") continue;
    const dir = path.join(REPO_ROOT, "plugins", id);
    ensurePluginBuilt(id);
    if (!changed) await invoke(s, "settings_set", { namespace: "plugins", key: "devTrusted", value: true });
    const added = await invoke(s, "plugins_dev_add", { path: dir });
    const declared = added.manifest?.permissions ?? [];
    if (declared.length) await invoke(s, "plugins_grant", { id, permissions: declared });
    const now = await pluginInfo(s, id);
    if (now?.status.kind !== "active" || now.isolation !== "trusted") {
      throw new Error(`${id}: ${JSON.stringify({ status: now?.status, isolation: now?.isolation, origin: now?.origin, errors: now?.errors })}`);
    }
    changed = true;
  }
  if (beforeReload) {
    await beforeReload(s);
    changed = true;
  }
  if (changed) {
    await s.page.reload();
    await s.page.waitForLoadState("domcontentloaded");
  }
  return changed;
}

export const tauriInvoke = invoke;
