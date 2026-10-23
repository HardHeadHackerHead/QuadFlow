# Writing QuadFlow plugins

**Build tiles, commands, CLI subcommands and agent providers for QuadFlow.**

Every QuadFlow tool is a plugin: a folder with a `quadflow-plugin.json` manifest, a UI module (React
tiles, commands, settings pages) and, optionally, a sidecar process, CLI subcommands, agent context
docs or an agent provider. These pages are for plugin authors; the binding design is
[docs/architecture/plugin-system.md](../architecture/plugin-system.md).

## Quick start

From a QuadFlow checkout:

```bash
npm create quadflow-plugin -- ../my-plugin --template tile --id acme.my-plugin
cd ../my-plugin && npm run dev
```

Then in QuadFlow: **Settings → Plugins → Load unpacked…** and pick `../my-plugin`. Edits hot-reload.
[Getting started](getting-started.md) walks through it step by step.

## How plugins run

- **Trusted or sandboxed.** First-party bundled plugins run trusted in the host document and share
  its React. Everything else runs in a sandboxed iframe and reaches the host over RPC, with the same
  API.
- **Permissions.** A plugin declares the permissions it needs in its manifest; the user consents,
  and one Rust dispatch table enforces them for UI, sidecars and CLI alike.
- **Imports.** A plugin imports only `@quadflow/plugin-api`, `@quadflow/ui`, `react`, `zustand` and
  what it bundles itself.

## Guides

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Templates, building, "Load unpacked" + hot reload, releasing |
| [Manifest reference](manifest-reference.md) | Every manifest field (generated from the JSON Schema) |
| [Host API](host-api.md) | `ctx.*` by area with examples, errors, shared modules, UI building blocks |
| API reference | Generated with TypeDoc from `@quadflow/plugin-api`: `npm run docs:api` → `docs/plugins/api/index.html` |
| [Permissions](permissions.md) | What each permission grants, consent, sandbox limits |
| [Sidecars](sidecars.md) | Background processes in Rust or Node, the JSON-RPC protocol |
| [CLI commands](cli-commands.md) | `quadflow <command>` contributions and agent context docs |
| [Agent providers](agent-providers.md) | Adding a coding-agent CLI to the launch toolbar |
| [Testing](testing.md) | Build checks, dev mode, the GUI harness |
| [Publishing](publishing.md) | Release zips, hosting, a plugin source repository with `index.json` |
| [Porting a tool into a plugin](migrating-a-tool.md) | For QuadFlow contributors: turning shell UI into its own first-party plugin |

## Tooling

| Package | Use |
|---|---|
| [`create-quadflow-plugin`](../../packages/create-quadflow-plugin) | `npm create quadflow-plugin`; templates `tile`, `tile-sidecar-rust`, `tile-sidecar-node`, `cli-command`, `agent-provider` |
| [`@quadflow/plugin-build`](../../packages/plugin-build) | `defineQuadflowPlugin({ root })` Vite preset and the `quadflow-plugin build \| dev \| validate \| pack \| check-shared` CLI |
| [`@quadflow/plugin-api`](../../packages/plugin-api) | `definePlugin`, the `PluginContext` types, JSON Schemas |
| [`@quadflow/ui`](../../packages/ui) | Themed React components shared with the host |
| [`@quadflow/plugin-kit`](../../packages/plugin-kit) | Optional helpers bundled into a plugin (live collections, agent launch) |
| [`quadflow-sidecar`](../../packages/sidecar-sdk-rust) / [`@quadflow/sidecar-sdk-node`](../../packages/sidecar-sdk-node) | Sidecar SDKs |
| `quadflow plugins …` | `list`, `info`, `validate <dir>`, `dev add\|remove\|list`, `grant <id>`, `install`, `sources …` |

The packages are not on npm or crates.io yet: run the scaffolder from a QuadFlow checkout and the
plugin links them from there (`file:` / `path` dependencies).

## Examples

- [`plugins/hello`](../../plugins/hello/) is a trusted tile that exercises every host-API group;
  [`plugins/hello-sandboxed`](../../plugins/hello-sandboxed/) runs the same bundle sandboxed. Both
  are staged only by dev builds.
- Every first-party plugin in [`plugins/`](../../plugins/) is a working reference, from a small
  tile ([Code Quality](../../plugins/code-quality/)) to a sidecar plugin
  ([External Apps](../../plugins/external-apps/)) and an agent provider
  ([Codex](../../plugins/codex/)).

## Generated docs

The API reference is generated, not committed (`docs/plugins/api/` is gitignored). The manifest
reference is generated **and** committed: run `npm run docs:manifest` after changing the manifest
schemas; `npm run check` fails when it is stale.
