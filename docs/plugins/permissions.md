# Permissions

A plugin lists what it needs in `permissions` (manifest). The user approves the list when
installing (or, for an unpacked plugin, with **Approve** in Settings → Plugins); an update that adds
permissions waits for approval while the old version keeps running. Every privileged host call —
from the UI module (trusted or sandboxed), from the sidecar (`host/call`) and from CLI-mode
sidecars — is checked **in Rust** against the granted list. A call without the permission rejects
with `HostError { code: 'permission_denied', permission }`. Spec:
[plugin-system.md §11](../architecture/plugin-system.md#11-permissions).

Ask for the least you need: fewer and lower-risk permissions make the consent dialog shorter, and
the user can revoke any of them later (the plugin then shows **Needs approval** until re-approved).

| Permission | Grants | Risk |
|---|---|---|
| `data:<domain>:read` (`ideas issues plans discovery scripts ship chat missions`) | read that domain in any registered project | low |
| `data:<domain>:write` | read + write that domain | medium |
| `project:config:write` | edit `.quadflow/config.json` | medium |
| `terminal:spawn` | create terminals it owns (read/write/kill them) | high |
| `terminal:io` | read/write **any** terminal, including agent sessions | high |
| `agents:read` | list providers, models, detection | low |
| `agents:launch` | start agent CLIs in terminals | high |
| `fs:read:project` / `fs:write:project` | files under the current project root (not its `.quadflow/` data) | medium / high |
| `fs:read:home` / `fs:write:home` | files under the user's home | high |
| `fs:read:any` / `fs:write:any` | any path | critical |
| `shell:exec:<program>` | run `<program>` (bare name, resolved from PATH, argv, no shell) | high |
| `shell:open-external` | open http(s)/mailto URLs in the browser | low |
| `network:<host>[:port]` / `network:*` | `ctx.http.fetch` to that host (exact match; list each host) / any host | medium / high |
| `notifications` | OS notifications | low |
| `clipboard:read` / `clipboard:write` | the clipboard | medium / low |
| `secrets` | OS keychain entries namespaced to the plugin | medium |
| `native:windows` | main window handle, tile geometry (embedding native windows) | critical |
| `native:webview` | child webviews in tiles | high |
| `native:screen-capture` | capture screen regions | high |
| `sidecar:runtime:node` | run its sidecar with the system `node` | medium |

Always allowed, no permission: the plugin's own `storage`, `settings`, data folders (`fs` scopes
`pluginData`, `projectPluginData`, `projectPluginLocal`), its own sidecar, `log`, the UI APIs and
`events`.

## Sandboxed plugins

Third-party plugins (installed from a source, or loaded unpacked) run sandboxed: tiles live in
iframes with no network (`connect-src 'none'`), no access to the app's IPC and no other plugin's
files. `native:*`, `terminal:io` and `fs:*:any` are not allowed for sandboxed plugins — installing
one that asks for them is refused. Network access goes through `ctx.http.fetch` (with
`network:<host>`), not `fetch()`.

## In the manifest

```json
{
  "permissions": ["data:issues:read", "network:api.github.com", "shell:exec:git"]
}
```

`quadflow plugins info <id>` and Settings → Plugins (expand a row) show what is granted.
