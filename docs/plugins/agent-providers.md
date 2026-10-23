# Agent providers

An agent provider teaches QuadFlow about a coding-agent CLI (Claude Code and Codex are
first-party providers in `plugins/claude-code` and `plugins/codex`): how to detect it, build its
command line (model, effort, approval mode, resume), find its sessions, which context file it
reads, and optional procedural hooks such as account usage. Providers appear in the agent-launch
toolbar and onboarding. Spec: [agent-providers.md](../architecture/agent-providers.md); template:
`agent-provider`.

## The declarative part

`contributes.agentProvider` (schema `packages/plugin-api/schema/agent-provider.schema.json`):

```json
"activation": ["onAgentProvider"],
"contributes": {
  "agentProvider": {
    "id": "mycli",
    "displayName": "My CLI",
    "icon": "assets/icon.svg",
    "color": "#7c5cff",
    "installHint": { "default": "npm install -g mycli" },
    "detect": { "command": "mycli", "versionArgs": ["--version"], "minVersion": "1.2.0" },
    "launch": {
      "args": [],
      "model": ["--model", "{model}"],
      "resume": ["--resume", "{sessionId}"],
      "approvalModes": { "default": [], "plan": ["--read-only"], "bypass": ["--yolo"] },
      "exitCommand": "/exit"
    },
    "models": { "catalogKey": "mycli", "allowCustom": true },
    "sessions": { "strategy": "discover", "dir": "{home}/.mycli/sessions", "glob": "*.jsonl", "idFrom": { "fileStem": true } },
    "contextFile": "AGENTS.md",
    "hooks": ["usage"]
  }
}
```

- `detect.command` is looked up on PATH (plus `extraPaths` per OS); `versionArgs` +
  `versionRegex` read the version.
- `launch` lists argv *templates* (`{model}`, `{sessionId}`, `{effort}`, `{cwd}`); every final
  argument must match a safe character set, and QuadFlow quotes them per shell. Missing
  `approvalModes` keys mean "not supported".
- `models`: the model picker shows the provider's entries from the remote model catalog
  (`catalog/models.json`, key `catalogKey`) plus user-added custom ids when `allowCustom`.
- `sessions.strategy`: `preassign` (QuadFlow passes a new session id), `discover` (QuadFlow finds
  the new session file after launch) or `none`.
- `contextFile`: the project-root instructions file the agent reads; QuadFlow writes enabled
  context modules into it.
- `scaffold`: copy a directory from the plugin into the project (e.g. a `.claude/` template).
- `attention.patterns`: regexes on terminal output that mean "the agent waits for you".

## Hooks

Optional; list the ones you implement in `hooks` and export them from the UI module:

```ts
export default definePlugin({
  agentProvider: {
    async usage(ctx) {
      return { providerId: 'mycli', fetchedAt: Date.now(), windows: [{ id: 'week', label: 'This week', usedPercent: 42 }] }
    },
    async contextUsage(ctx, { sessionPath, model }) { return null },
    async sessionTitle(ctx, session) { return null },
    async prepareWorktree(ctx, { worktreePath, scope, contextMarkdown }) {},
  },
})
```

Errors are logged and treated as "no data"; the host rate-limits `usage` (≥ 60 s). Hooks can also
be served by the sidecar as `agentProvider/usage`, `agentProvider/contextUsage {sessionId,
sessionPath, model}`, `agentProvider/sessionTitle {session}`, `agentProvider/prepareWorktree
{worktreePath, scope, contextMarkdown}` requests (report `capabilities.agentProvider = true` from
`initialize`); a UI hook wins over a sidecar one.

```js
createServer()
  .onInitialize(() => ({ capabilities: { agentProvider: true } }))
  .onRequest('agentProvider/usage', async () => ({ providerId: 'mycli', fetchedAt: Date.now(), windows: [] }))
  .run()
```

Reading the agent's files from the UI module needs permissions (`fs:read:home` for `~/.mycli`, or
`shell:exec:mycli` to run it); `ctx.agents.detect/models` need `agents:read`. A sidecar is a normal
process and reads files or runs the CLI itself.

## Third-party (sandboxed) providers

The declarative spec works for any active provider plugin. For hooks, the shell loads the
plugin's UI module and calls `agentProvider.<hook>`; a **sandboxed** plugin's module lives in an
iframe, and its UI-module hooks are not called yet (plugin-system.md §17, PL-6 "not covered yet"),
so the shell falls through to the sidecar (`agentProvider/<hook>`, sent by the host — plugin UIs
cannot send `agentProvider/*` themselves). Third-party providers should therefore serve their hooks
from a sidecar — the `agent-provider` template does exactly that — and still ship a (minimal) UI
module (`ui.entry`), because the shell reaches the sidecar through the loaded plugin. Try it: scaffold
with `--agent-command node` (so detection succeeds), load it unpacked, approve it, and open the
Usage Monitor tool — the provider shows its "Current session" window.
