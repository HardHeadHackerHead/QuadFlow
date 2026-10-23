# create-quadflow-plugin

Scaffold a new QuadFlow plugin in one command.

Pick a template and get a working plugin folder: manifest, UI module or sidecar, build scripts
and a README. Load it into QuadFlow with **Settings → Plugins → Load unpacked…** and edits
hot-reload.

## Usage

The package is not published to npm yet (`"private": true`), so run it from a QuadFlow checkout:

```bash
npm create quadflow-plugin -- ../my-plugin --template tile --id acme.my-plugin
# or, equivalently:
node packages/create-quadflow-plugin/index.mjs ../my-plugin --template tile --id acme.my-plugin
```

Without arguments it asks for the folder, template, id and display name. Then:

```bash
cd ../my-plugin
npm run dev        # rebuild on every change
```

In QuadFlow open **Settings → Plugins → Load unpacked…** and pick the folder.

## Templates

| Template | What you get |
|---|---|
| `tile` (default) | A React tile with settings and a command. Runs sandboxed, needs no permissions. |
| `tile-sidecar-rust` | A tile that talks to a Rust sidecar process (`quadflow-sidecar` crate) |
| `tile-sidecar-node` | A tile that talks to a Node.js sidecar process (`@quadflow/sidecar-sdk-node`) |
| `cli-command` | A `quadflow <command>` CLI subcommand served by a Node sidecar, plus an agent context doc |
| `agent-provider` | An agent provider (a coding-agent CLI in the launch toolbar) with a `usage` hook served by a Node sidecar |

## Options

| Option | Description |
|---|---|
| `[dir]` | Target directory (default `my-quadflow-plugin`) |
| `--template <name>`, `-t` | One of the templates above (default `tile`) |
| `--id <id>` | `publisher.name`, e.g. `acme.word-count` (default `example.<dir name>`). Ids without a dot are reserved for official plugins. |
| `--name <name>` | Display name (default: derived from the id) |
| `--description <text>` | One-line description |
| `--author <name>` | Author name (default: `git config user.name`) |
| `--cli-name <name>` | `cli-command`: the subcommand (default: the id's name part; core command names are rejected) |
| `--agent-command <cmd>` | `agent-provider`: the agent CLI program (default: the id's name part) |
| `--local <checkout>` | Link packages from this QuadFlow checkout (default: the checkout the script runs from) |
| `--registry` | Use published package version ranges instead of a checkout |
| `--no-install` | Skip `npm install` |
| `--force` | Write into a non-empty directory |
| `-y`, `--yes` | No questions; defaults for everything not given |
| `-h`, `--help` | Print usage |

## Dependencies

Run from a checkout, the generated `package.json` points `@quadflow/plugin-api`,
`@quadflow/plugin-build`, `@quadflow/ui` and `@quadflow/sidecar-sdk-node` at that checkout with
`file:` specs, and a Rust sidecar depends on `packages/sidecar-sdk-rust` by path. Nothing needs
to be published. A Rust sidecar created inside the checkout joins its Cargo workspace; anywhere
else it is a standalone crate.

## Programmatic use

`index.mjs` also exports `create(argv, { log?, interactive? })` and `TEMPLATES`; the tests use
them directly:

```js
import { create } from './packages/create-quadflow-plugin/index.mjs'

const r = await create(['../my-plugin', '--template', 'tile', '--id', 'acme.my-plugin', '--no-install'], {
  interactive: false,
  log: () => {},
})
// r = { dest, id, template, files }
```

## Development

```bash
npm test           # node --test test/create.test.mjs: every template scaffolds a schema-valid plugin
```

Templates live in `templates/<part>/`; each template combines several parts (for example `tile`
is `common` + `ui` + `tile`). Text files are copied with `{{token}}` placeholders replaced;
`_gitignore` becomes `.gitignore`. The manifest and `package.json` are generated in `index.mjs`.

## Documentation

- [Getting started](../../docs/plugins/getting-started.md) — templates, building, hot reload, releasing
- [Manifest reference](../../docs/plugins/manifest-reference.md)
- [Writing QuadFlow plugins](../../docs/plugins/README.md)

## License

AGPL-3.0-only, part of QuadFlow. Generated plugins start with an MIT license field; choose your own.
