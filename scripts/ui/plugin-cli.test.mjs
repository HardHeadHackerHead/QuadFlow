// Plugin CLI contributions against the BUILT binary (plugin-system.md §9, PL-8):
// `quadflow hello ping --json` through the sidecar handler and through the exec
// handler, `quadflow --help` / `quadflow docs` listing plugin contributions, and
// reserved names rejected.
//
// Run: npm run test:e2e (builds the dev exe, which stages the `hello` plugin with its
// sidecar binary into src-tauri/resources/plugins/hello). Everything runs isolated:
// QUADFLOW_PROFILE=dev, a temp QUADFLOW_DATA_DIR, a temp resource dir holding only
// `hello`, a temp project, the memory secrets backend.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_EXE, REPO_ROOT } from "./harness.mjs";

const EXE = process.env.QF_UI_EXE || DEFAULT_EXE;
const STAGED_HELLO = path.join(REPO_ROOT, "src-tauri", "resources", "plugins", "hello");

let tmp;
let project;

/** A resource dir with only `hello`, optionally with its manifest edited. */
function resources(name, edit = (m) => m) {
  const res = path.join(tmp, name);
  const dir = path.join(res, "plugins", "hello");
  cpSync(STAGED_HELLO, dir, { recursive: true });
  const file = path.join(dir, "quadflow-plugin.json");
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8"))), null, 2));
  return res;
}

function qf(res, args, { cwd = project, data = path.join(tmp, "data") } = {}) {
  const r = spawnSync(EXE, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      QUADFLOW_PROFILE: "dev",
      QUADFLOW_DATA_DIR: data,
      QUADFLOW_RESOURCE_DIR: res,
      QUADFLOW_SECRETS_BACKEND: "memory",
      QUADFLOW_PROJECT_DIR: "",
    },
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function okJson({ code, out, err }) {
  assert.equal(code, 0, `exit ${code}\nstdout: ${out}\nstderr: ${err}`);
  const v = JSON.parse(out);
  assert.equal(v.ok, true, out);
  return v.data;
}

let res;

before(() => {
  assert.ok(existsSync(EXE), `debug exe not found at ${EXE}; build it with: npm run build:dev-exe`);
  assert.ok(existsSync(path.join(STAGED_HELLO, "quadflow-plugin.json")), "hello is not staged; run: npm run build:dev-exe");
  tmp = realpathSync(mkdtempSync(path.join(process.env.QF_UI_TMP || os.tmpdir(), "qf-plugin-cli-")));
  project = path.join(tmp, "project");
  mkdirSync(project);
  res = resources("res");
  okJson(qf(res, ["init", "--json"]));
});

after(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("hello ping --json via the sidecar handler", () => {
  const d1 = okJson(qf(res, ["hello", "ping", "--json"]));
  assert.equal(d1.via, "sidecar");
  assert.equal(d1.pong, "pong");
  assert.equal(d1.pluginId, "hello");
  assert.equal(d1.mode, "cli");
  assert.equal(d1.terminals, "unsupported", "terminal methods are unavailable in CLI mode");
  assert.equal(realpathSync(d1.projectRoot), project);
  const d2 = okJson(qf(res, ["--json", "hello", "ping", "again"]));
  assert.equal(d2.pong, "again");
  assert.equal(d2.count, d1.count + 1, "host/call storage persists through the dispatch table");

  const human = qf(res, ["hello", "ping"]);
  assert.equal(human.code, 0);
  assert.equal(human.out, "pong (via sidecar)\n");

  const fail = qf(res, ["hello", "fail", "--json"]);
  assert.equal(fail.code, 3);
  assert.equal(JSON.parse(fail.out).error.code, "not_found");
  const usage = qf(res, ["hello", "bogus"]);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: quadflow hello/);
});

test("hello ping --json via the exec handler", () => {
  // The shipped `hello-exec` command …
  const d = okJson(qf(res, ["hello-exec", "ping", "--json", "--roundtrip"]));
  assert.equal(d.via, "exec");
  assert.equal(d.pluginId, "hello");
  assert.equal(realpathSync(d.projectRoot), project);
  assert.ok(d.modules.includes("hello"), `exec binary reads data via $QUADFLOW_CLI: ${JSON.stringify(d.modules)}`);
  // … and `hello` itself switched to the exec handler.
  const execRes = resources("res-exec", (m) => {
    const exec = m.contributes.cliCommands.find((c) => c.name === "hello-exec");
    m.contributes.cliCommands = [{ ...exec, name: "hello" }];
    return m;
  });
  const d2 = okJson(qf(execRes, ["hello", "ping", "--json"], { data: path.join(tmp, "data-exec") }));
  assert.equal(d2.via, "exec");
  assert.equal(d2.pong, "pong");
  const fail = qf(execRes, ["hello", "fail"], { data: path.join(tmp, "data-exec") });
  assert.equal(fail.code, 3);
  assert.match(fail.err, /nothing to see here/);
});

test("help and docs list plugin contributions", () => {
  const help = qf(res, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /hello\s+Hello example: ping the plugin's sidecar.*\[plugin: hello\]/);
  assert.match(help.out, /hello-exec\s+Hello example/);

  const mods = okJson(qf(res, ["docs", "--list", "--json"]));
  const hello = mods.find((m) => m.id === "hello");
  assert.ok(hello, JSON.stringify(mods));
  assert.equal(hello.source, "hello");
  const list = qf(res, ["docs", "--list"]);
  assert.match(list.out, /Plugin commands:/);
  const doc = qf(res, ["docs", "hello"]);
  assert.equal(doc.code, 0);
  assert.match(doc.out, /# Hello \(example plugin\)/);

  const unknown = qf(res, ["helo"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unrecognized subcommand 'helo'/);
  assert.match(unknown.err, /tip: a similar subcommand exists: 'hello'/);
});

test("reserved CLI names are rejected", () => {
  const bad = resources("res-reserved", (m) => {
    m.contributes.cliCommands[0].name = "issues";
    return m;
  });
  const data = path.join(tmp, "data-reserved");
  const info = okJson(qf(bad, ["plugins", "info", "hello", "--json"], { data }));
  assert.equal(info.status.kind, "failed");
  assert.match(info.status.reason, /"issues" is a reserved core command name/);
  const val = qf(bad, ["plugins", "validate", path.join(bad, "plugins", "hello"), "--json", "--origin", "bundled"], { data });
  assert.equal(val.code, 2, val.out);
  const v = JSON.parse(val.out);
  assert.equal(v.ok, false);
  assert.match(JSON.stringify(v.error), /reserved core command name/);
  // `issues` stays the core command; `hello-exec` is gone with the failed plugin.
  okJson(qf(bad, ["issues", "list", "--json"], { data }));
  assert.equal(qf(bad, ["hello-exec", "ping"], { data }).code, 2);
});
