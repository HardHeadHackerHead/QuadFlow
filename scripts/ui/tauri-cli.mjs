#!/usr/bin/env node
// `npm run tauri ...` entry point. Forwards to the Tauri CLI unchanged, except
// that `tauri dev` gets `--config src-tauri/tauri.dev.conf.json` merged in, so
// dev runs use the isolated `io.quadslab.quadflow.dev` identifier and "QuadFlow Dev"
// window title and can run side by side with an installed QuadFlow.
// `tauri build` (release) is never modified.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const args = process.argv.slice(2);

if (args[0] === "dev" && !args.some((a) => a === "--config" || a === "-c" || a.startsWith("--config="))) {
  args.splice(1, 0, "--config", "src-tauri/tauri.dev.conf.json");
}

const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
