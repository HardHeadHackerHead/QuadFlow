# @quadflow/plugin-kit

Reusable building blocks for QuadFlow plugins: live entity collections, agent launch helpers,
tile state hand-off and one-off chat questions.

The first-party plugins (Ideas, Issues, Plans, Discovery, GitHub, Chat, …) share these helpers.
They use only the public `@quadflow/plugin-api`, so third-party plugins can use them too. Unlike
`@quadflow/plugin-api` and `@quadflow/ui`, this package is **not** a host-shared module: it is
bundled into each plugin that imports it.

## Install

The package is not published to npm yet (`"private": true`). Inside the QuadFlow repository add
it as a workspace dependency:

```json
"dependencies": { "@quadflow/plugin-kit": "*" }
```

Outside the repository, point a `file:` dependency at `packages/plugin-kit` in a QuadFlow
checkout. Peer dependencies: `@quadflow/plugin-api` and `zustand` (both provided by the host).

## Example

A live, project-scoped list of ideas that stays in sync with changes from the GUI, the CLI and
other plugins (needs the `data:ideas:read` permission):

```tsx
import { useEffect } from 'react'
import type { Idea_Serialize, PluginContext } from '@quadflow/plugin-api'
import { createCollection, launchAgent } from '@quadflow/plugin-kit'

export function ideasModel(ctx: PluginContext) {
  return createCollection<Idea_Serialize>(ctx, {
    domain: 'ideas',
    list: async (c, root) => {
      const r = await c.data.ideas.list({ includeArchived: true }, { projectRoot: root })
      return { items: r.items, errors: r.errors }
    },
    get: (c, id, root) => c.data.ideas.get(id, { projectRoot: root }),
    normalize: (i) => i,
  })
}

// In a tile: subscribe while mounted, read the store.
function IdeaList({ ideas, ctx }: { ideas: ReturnType<typeof ideasModel>; ctx: PluginContext }) {
  useEffect(() => ideas.retain(), [ideas])
  const items = ideas.use((s) => s.items)
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id} onClick={() => launchAgent(ctx, `Implement this idea: ${i.content}`)}>
          {i.content}
        </li>
      ))}
    </ul>
  )
}
```

## API overview

| Export | What it does |
|---|---|
| `createCollection(ctx, spec)` | A zustand store (`use`) of one domain's entities for the current project. `retain()` starts syncing (reference-counted), change events are coalesced, results from a previous project are dropped. Also `reload`, `root`, `apply`, `remove`, `replaceAll`. |
| `launchAgent(ctx, prompt, options?)` | Launch a coding agent with a prompt through `ctx.agents`; picks the provider, shows a toast on failure, resolves with the handle or `null` |
| `pickProvider(ctx, options?)` | The provider to use: an explicit id, a preferred one, the user's default, or the first installed |
| `agentProviders(ctx)` | Installed agent providers, cached for the session |
| `unattendedApprovalMode(provider)` | The least restrictive approval mode short of bypass (`auto`, else `accept-edits`, else `default`) |
| `openTileWithState(ctx, contributionId, state, options?)` | Open a tile with an initial state, with a fallback for hosts that drop it |
| `claimTileState(ctx, contributionId, instanceState)` | The state a newly mounted tile should start from (pair with `openTileWithState`) |
| `isEmptyTileState(state)` | True for `null`, `{}` and `[]` |
| `chatAsk(ctx, question, options?)` | Ask the configured Chat endpoint once and return the answer (needs `data:chat:write`) |
| `errorMessage(e)` | A readable message for anything a host call throws |

## Documentation

- [Host API](../../docs/plugins/host-api.md) — the `ctx` calls these helpers wrap
- [Porting a tool into a plugin](../../docs/plugins/migrating-a-tool.md) — the collection pattern in context
- [Permissions](../../docs/plugins/permissions.md)

## License

AGPL-3.0-only, part of QuadFlow.
