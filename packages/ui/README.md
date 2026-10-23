# @quadflow/ui

Design tokens, a Tailwind preset and themed React components shared by QuadFlow and its plugins.

The QuadFlow shell is built with this kit, so a plugin that uses it looks native and follows the
user's theme (dark, light, accent color, UI scale) without extra work. The host shares one copy of
`@quadflow/ui` with every plugin, trusted or sandboxed.

## Install

The package is not published to npm yet (`"private": true`). Plugins scaffolded from a QuadFlow
checkout with `npm create quadflow-plugin` link it with a `file:` dependency; inside the
repository it is an npm workspace package. Like React, it is a shared module: the
`@quadflow/plugin-build` preset keeps it external, so it is never bundled into a plugin.

Peer dependencies: `react`, `react-dom`, `react-markdown`, `remark-gfm` and `@dnd-kit/*` (the host
provides them at runtime).

## Example

```tsx
import { useState } from 'react'
import { Button, Card, Field, Input, toast } from '@quadflow/ui'

export function Greeter() {
  const [name, setName] = useState('')
  return (
    <Card padding="md">
      <Field label="Name" htmlFor="name">
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Button variant="primary" onClick={() => toast({ kind: 'success', message: `Hello, ${name}!` })}>
        Greet
      </Button>
    </Card>
  )
}
```

## API overview

| Area | Exports |
|---|---|
| Buttons | `Button` (`primary`, `secondary`, `ghost`, `danger`, `outline`; sizes `xs`–`lg`), `IconButton`, `ButtonGroup` |
| Inputs | `Field`, `Input`, `Textarea`, `SearchInput`, `Checkbox`, `Switch`, `Radio`, `Slider`, `Select`, `Combobox` |
| Layout | `Tabs`, `SplitPane`, `Card`, `Panel`, `PanelHeader`, `Toolbar`, `ScrollArea`, `Table` |
| Display | `Badge`, `LabelBadge`, `Tag`, `Avatar`, `Kbd`, `Icon`, `ICONS`, `registerIcons` |
| Feedback | `Spinner`, `Skeleton`, `ProgressBar`, `EmptyState`, `toast`, `Toaster`, `ToastView` |
| Overlays | `Modal`, `Dialog`, `ConfirmDialog`, `Drawer`, `Popover`, `Tooltip`, `Menu`, `DropdownMenu`, `ContextMenu`, `Portal`, `FloatingLayer` |
| Content | `Markdown`, `MarkdownEditor`, `CodeBlock` |
| Drag and drop | `SortableList`, `KanbanBoard` |
| Forms | `FormFromSchema`, `validateSchema`, `schemaDefaults` (render a form from a JSON Schema) |
| Theme | `useTheme`, `getThemeSnapshot`, `onThemeChange`, `applyTheme`, `resolveThemeMode`, `COLOR_TOKENS`, `TERMINAL_TOKENS`, `SCALAR_TOKENS` |
| Utilities | `cx`, `computePosition`, `configureUi`, `useOverlay` |

Menus, modals and toasts from the kit are wired to the host (the host and the sandbox runtime
call `configureUi` for you), so native views hide under open overlays and a sandboxed plugin's
toasts appear in the main window. Overlays you build yourself must call
`ctx.overlay.register(id, open)`.

### Subpath exports

| Path | Contents |
|---|---|
| `@quadflow/ui/tokens.css` | The `--qf-*` CSS variables (the host already loads them) |
| `@quadflow/ui/tailwind-preset` | Tailwind preset mapping the theme tokens to `qf-*` color names |

## Tailwind

For your own styles, prefer plain CSS with the tokens (`color: rgb(var(--qf-text))`). To write
Tailwind classes instead, let the build preset compile them, scoped under a class:

```ts
// vite.config.ts
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({
  root: fileURLToPath(new URL('.', import.meta.url)),
  tailwind: { scope: '.qfp-my-plugin' },
})
```

Put `@tailwind components; @tailwind utilities;` in your CSS and wrap each tile (and portal
content such as modal bodies) in `<div className="qfp-my-plugin">`. When you configure Tailwind
yourself, add the preset with
`presets: [require('@quadflow/ui/tailwind-preset')]` and list `@quadflow/ui` sources in `content`
(presets replace, not merge, `content`).

## Documentation

- [Host API → UI building blocks](../../docs/plugins/host-api.md)
- [Getting started](../../docs/plugins/getting-started.md)
- [Plugin system design](../../docs/architecture/plugin-system.md)

## License

AGPL-3.0-only, part of QuadFlow.
