# @quadflow/plugin-api

Types, `definePlugin()` and JSON Schemas for writing QuadFlow plugins.

This is the one import every plugin builds against. It describes the plugin module contract, the
`PluginContext` (`ctx`) the host passes to your code, and the manifest schema. The package holds
almost no runtime code: QuadFlow provides the implementation of `ctx` in both isolation modes
(trusted and sandboxed), and every privileged call is permission-checked by the host.

Plugin API version: **1.4.0** (`PLUGIN_API_VERSION`).

## Install

The package is not published to npm yet (`"private": true`). Scaffold a plugin from a QuadFlow
checkout and it is linked for you with a `file:` dependency:

```bash
npm create quadflow-plugin -- ../my-plugin --template tile --id acme.my-plugin
```

Inside the QuadFlow repository it is an npm workspace package (`"@quadflow/plugin-api": "*"`).
At runtime the host shares a single copy with every plugin, so `@quadflow/plugin-build` keeps it
external — never bundle it.

## Example

```tsx
import { useEffect } from 'react'
import { definePlugin, HostError, type TileProps } from '@quadflow/plugin-api'

function MainTile({ ctx, instance, setTitle }: TileProps) {
  const project = ctx.project.current()
  useEffect(() => setTitle(project ? `Hello, ${project.name}` : 'Hello'), [project?.name])
  return <p>Tile {instance.id} of {ctx.plugin.id}</p>
}

export default definePlugin({
  activate(ctx) {
    ctx.log.info('activated')
  },
  tiles: { main: MainTile },
  commands: {
    count: async (ctx) => {
      try {
        const { items } = await ctx.data.ideas.list() // needs `data:ideas:read`
        ctx.notifications.toast({ title: `${items.length} ideas`, kind: 'info' })
      } catch (e) {
        if (e instanceof HostError && e.code === 'permission_denied') ctx.log.warn(e.permission)
        else throw e
      }
    },
  },
})
```

The keys of `tiles` and `commands` are the contribution ids declared in `quadflow-plugin.json`.
Feature-detect host methods with `ctx.api.has('agents.launch')`.

## API overview

| Export | What it is |
|---|---|
| `definePlugin(module)` | Identity helper that types the default export of a UI module |
| `PluginModule` | `activate`, `deactivate`, `tiles`, `miniWidgets`, `settingsPages`, `commands`, `paletteProviders`, `titleGenerators`, `agentProvider` |
| `PluginContext` | `ctx`: `project`, `workspace`, `data`, `terminals`, `agents`, `events`, `storage`, `settings`, `secrets`, `notifications`, `fs`, `shell`, `http`, `clipboard`, `sidecar`, `commands`, `ui`, `overlay`, `native`, `log`, `api` |
| `TileProps`, `MiniWidgetProps`, `SettingsPageProps` | Props the host passes to your components |
| `usePluginContext()` / `PluginContextProvider` | Reach `ctx` from deep components without prop drilling |
| `HostError` | What every rejected host call rejects with (`code`, `details`, `permission`) |
| `PLUGIN_API_VERSION` | The API version this package describes |
| Domain types | `Idea_Serialize`, `Issue_Serialize`, `ChangeEvent`, `JsonValue`, … generated from the Rust core |

### Subpath exports

| Path | Contents |
|---|---|
| `@quadflow/plugin-api/schema/quadflow-plugin.schema.json` | JSON Schema of `quadflow-plugin.json` (use it as the manifest's `$schema`) |
| `@quadflow/plugin-api/schema/plugin-index.schema.json` | JSON Schema of a plugin source's `index.json` |
| `@quadflow/plugin-api/rpc` | The sandbox transport used by the host and the sandbox runtime. Not for plugin code. |

The domain types in `src/generated/types.ts` are generated from `quadflow-core` with tauri-specta;
do not edit them by hand.

## Documentation

- [Getting started](../../docs/plugins/getting-started.md)
- [Host API](../../docs/plugins/host-api.md) — `ctx.*` by area, with examples
- [Manifest reference](../../docs/plugins/manifest-reference.md)
- [Permissions](../../docs/plugins/permissions.md)
- Full API reference: `npm run docs:api` at the repository root writes `docs/plugins/api/index.html`

## License

AGPL-3.0-only, part of QuadFlow.
