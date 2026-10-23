// Helpers for GUI tests of first-party plugins: make sure a plugin from this checkout is
// built, loaded and trusted in the launched app.
//
// - Full build (the plugin is bundled): nothing to do.
// - Plugins that no app build stages (`quadflow.bundle: "none"`) or an older / frozen exe without
//   the plugin: build `plugins/<id>` when its output is missing or older than its sources
//   (`ensurePluginBuilt`), then load it unpacked (dev beats bundled for the same id), as trusted
//   first-party dev plugin (`plugins.devTrusted = true`, the dev path is inside this checkout),
//   and approve its permissions.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const pluginDir = (id) => path.join(ROOT, "plugins", id);

const listPlugins = (s) => s.eval(() => window.__TAURI_INTERNALS__.invoke("plugins_list", { includeUnsupported: true }));

/** Ensure the checkout's plugin `id` is active and trusted. Returns its plugins_list entry. */
export async function ensureFirstPartyPlugin(s, id, buildOptions) {
  let info = (await listPlugins(s)).find((p) => p.id === id);
  if (info && info.origin === "bundled") return info;

  const dir = pluginDir(id);
  ensurePluginBuilt(id, buildOptions);
  const manifest = JSON.parse(readFileSync(path.join(dir, "quadflow-plugin.json"), "utf8"));
  await s.eval(
    async ({ dir, id, permissions }) => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      await inv("settings_set", { namespace: "plugins", key: "devTrusted", value: true });
      const list = await inv("plugins_list", { includeUnsupported: true });
      if (!list.some((p) => p.id === id && p.origin === "dev")) await inv("plugins_dev_add", { path: dir });
      if (permissions.length) await inv("plugins_grant", { id, permissions });
    },
    { dir: dir.replace(/\\/g, "/"), id, permissions: manifest.permissions ?? [] },
  );
  // The shell's plugin registry store reads the new state on the next load.
  await s.page.reload();
  await s.waitFor("#root > *", { timeout: 60_000 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    info = (await listPlugins(s)).find((p) => p.id === id);
    if (info && info.status?.kind === "active" && info.isolation === "trusted") return info;
    if (Date.now() > deadline) throw new Error(`plugin ${id} did not become active+trusted: ${JSON.stringify(info)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const EXE = process.platform === "win32" ? ".exe" : "";
const TARGET_KEY = `${{ win32: "windows", darwin: "macos", linux: "linux" }[process.platform]}-${{ x64: "x86_64", arm64: "aarch64" }[process.arch]}`;
const SKIP_DIRS = new Set(["target", "node_modules", "dist", "bin"]);

/** Newest mtime (ms) of the given files / directory trees (0 when none exist). */
function newestMtime(paths) {
  let newest = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) if (!SKIP_DIRS.has(e)) walk(path.join(p, e));
    } else newest = Math.max(newest, st.mtimeMs);
  };
  paths.forEach(walk);
  return newest;
}

/** True when `output` is missing or older than any of `sources`. */
const stale = (output, sources) => !existsSync(output) || statSync(output).mtimeMs < newestMtime(sources);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npm" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} in ${cwd} failed (exit ${r.status ?? r.error})`);
}

/**
 * Build `plugins/<id>` for an e2e test unless its build output is current — for plugins that no
 * app build stages (`quadflow.bundle: "none"`), and for dev-loaded copies of bundled ones.
 *
 * Reads the manifest, so it covers every plugin generically:
 * - UI module (`ui.entry`): stale when missing or older than `src/`, the manifest or the Vite config;
 * - sidecar: a Rust crate in `sidecar/` (`sidecar.binaries[<this target>]`, also stale when
 *   `packages/sidecar-sdk-rust` changed) or a Node sidecar (`sidecar.entry`, bundled from
 *   `sidecar/`). A stale binary is exactly what makes a test run old sidecar code.
 *
 * Anything stale → `npm run build` in the plugin (`quadflow-plugin build`: UI + sidecar). With
 * `cargoArgs` the Rust sidecar is built here instead (`cargo build --release <cargoArgs>`, e.g.
 * `["--no-default-features"]` for a stub sidecar without a native C++ dependency), for plugins
 * whose `build` script skips the sidecar. An up-to-date binary (e.g. from a full release build
 * of the plugin) is kept.
 */
export function ensurePluginBuilt(id, { cargoArgs } = {}) {
  const dir = pluginDir(id);
  const manifestFile = path.join(dir, "quadflow-plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const uiEntry = manifest.ui?.entry && path.join(dir, manifest.ui.entry);
  const uiStale = !!uiEntry && stale(uiEntry, [path.join(dir, "src"), manifestFile, path.join(dir, "vite.config.ts")]);

  const cargoToml = path.join(dir, "sidecar", "Cargo.toml");
  const rust = existsSync(cargoToml);
  const binRel = rust ? manifest.sidecar?.binaries?.[TARGET_KEY] : manifest.sidecar?.runtime === "node" ? manifest.sidecar.entry : null;
  const bin = binRel && path.join(dir, binRel);
  const sidecarSources = [path.join(dir, "sidecar"), manifestFile];
  if (rust) sidecarSources.push(path.join(ROOT, "packages", "sidecar-sdk-rust", "src"), path.join(ROOT, "packages", "sidecar-sdk-rust", "Cargo.toml"));
  const sidecarStale = !!bin && stale(bin, sidecarSources);

  if (uiStale || (sidecarStale && !(rust && cargoArgs))) run("npm", ["run", "build"], dir);
  if (sidecarStale && rust && cargoArgs) {
    run("cargo", ["build", "--release", "--manifest-path", cargoToml, ...cargoArgs], dir);
    const meta = JSON.parse(spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", cargoToml], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout);
    const crate = meta.packages.find((p) => path.resolve(p.manifest_path) === path.resolve(cargoToml))?.name ?? meta.packages[0].name;
    mkdirSync(path.dirname(bin), { recursive: true });
    copyFileSync(path.join(meta.target_directory, "release", crate + EXE), bin);
  }
  if (uiEntry && !existsSync(uiEntry)) throw new Error(`plugins/${id}: ${manifest.ui.entry} was not built`);
  if (bin && !existsSync(bin)) throw new Error(`plugins/${id}: sidecar ${binRel} was not built`);
}
