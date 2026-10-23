# @quadflow/plugin-build

Build preset and CLI for QuadFlow plugins.

`@quadflow/plugin-build` turns a plugin folder into something QuadFlow can load: a Vite library
build of the UI module with the host's shared modules kept external, sidecar builds (Rust or
Node), post-build checks, an integrity file and release zips. Every plugin scaffolded with
`npm create quadflow-plugin` uses it.

## Install

The package is not published to npm yet (`"private": true`). Plugins scaffolded from a QuadFlow
checkout get it as a `file:` dev dependency; inside the repository it is an npm workspace package.

```json
"devDependencies": { "@quadflow/plugin-build": "file:<checkout>/packages/plugin-build" }
```

## Usage

```ts
// vite.config.ts
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)) })
```

```json
"scripts": {
  "build": "tsc --noEmit && quadflow-plugin build",
  "dev": "quadflow-plugin dev",
  "validate": "quadflow-plugin validate",
  "pack": "quadflow-plugin pack"
}
```

## CLI

`quadflow-plugin <command> [dir]` — `dir` defaults to the current directory.

| Command | What it does |
|---|---|
| `build [dir] [--no-sidecar]` | Build the UI module and the sidecar for this machine, then run the checks |
| `dev [dir] [--no-sidecar]` | Rebuild on every change (pair with **Settings → Plugins → Load unpacked…** for hot reload) |
| `validate [dir]` | Check the manifest schema, referenced files and shared-module imports |
| `pack [dir] [--out <dir>]` | Write `<id>-<version>[-<os>-<arch>].zip` and a `.sha256` file (default `./release`) |
| `check-shared <file.js…>` | Check that built modules import only names the host actually shares |

## Preset options

`defineQuadflowPlugin(options)` returns a Vite `UserConfig`.

| Option | Default | Description |
|---|---|---|
| `root` | — | The plugin directory (the one holding `quadflow-plugin.json`). Required. |
| `entry` | `src/index.tsx`, `.ts`, `.jsx` or `.js` | UI source entry |
| `react` | `true` | Add `@vitejs/plugin-react` for `.tsx` / `.jsx` entries |
| `check` | `true` | Run the post-build checks and write `dist/.integrity.json` |
| `tailwind` | off | `{ scope, content? }`: compile Tailwind with the `@quadflow/ui` preset, no preflight, every rule scoped under `scope` (e.g. `'.qfp-my-plugin'`). Needs `tailwindcss`. |
| `vite` | — | Extra Vite config, merged with `mergeConfig` |

Shared modules (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `zustand`,
`@quadflow/plugin-api`, `@quadflow/ui`) resolve to the host's instances at runtime, so the preset
never bundles them, and the build fails when you import a name
the host does not export (`dev` prints the errors and keeps watching).

## Programmatic API

| Export | Purpose |
|---|---|
| `buildPlugin(root, { sidecar? })`, `watchPlugin(root, { sidecar? })` | What `build` and `dev` run |
| `buildUi`, `buildRustSidecar`, `buildNodeSidecar` | Individual build steps |
| `readManifest(root)`, `validateManifest(root, manifest?)` | Read and schema-check `quadflow-plugin.json` |
| `checkBuiltPlugin(root, options?)`, `missingFiles`, `referencedFiles` | Post-build checks |
| `checkSharedImports(files)`, `sharedExports()`, `sharedSpecifiers()` | The shared-module import check |
| `packPlugin(root, { outDir? })`, `archiveName(manifest, target?)`, `createZip(entries)` | Release archives |
| `writeIntegrity(root, outDir?)`, `INTEGRITY_FILE` | `dist/.integrity.json`: the sha256 of every build output file |
| `currentTarget()`, `isNative(manifest)`, `findUiSource(root)` | Helpers |

Types are in `src/index.d.ts`.

## Development

```bash
npm test          # node --test test/plugin-build.test.mjs
npm run build     # snapshot the host's shared export list into dist/shared-exports.json
                  # (used when the package runs outside a QuadFlow checkout)
```

## Documentation

- [Getting started](../../docs/plugins/getting-started.md) — build, load unpacked, hot reload
- [Testing](../../docs/plugins/testing.md)
- [Publishing](../../docs/plugins/publishing.md) — release zips and plugin sources
- [Sidecars](../../docs/plugins/sidecars.md)

## License

AGPL-3.0-only, part of QuadFlow.
