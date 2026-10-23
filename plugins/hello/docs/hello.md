# Hello (example plugin)

The `hello` plugin is QuadFlow's plugin-system smoke test. It contributes two
CLI commands that do the same thing through the two CLI handler types:

| Command | Handler | Runs |
|---|---|---|
| `quadflow hello …` | `sidecar` | the plugin's sidecar in CLI mode (`cli/run`) |
| `quadflow hello-exec …` | `exec` | the plugin's binary directly |

## Subcommands (both commands)

- `ping [MESSAGE…]` — answers `pong`. With `--json` prints one envelope:
  `{"ok":true,"data":{"pong":"<message>","via":"sidecar"|"exec","pluginId":"hello","projectRoot":<root or null>,…}}`.
  The sidecar variant also counts its runs in the plugin's own storage
  (`data.count`), served through the host dispatch table.
- `ping --roundtrip` (exec only) — additionally calls `$QUADFLOW_CLI --json docs --list`
  and reports the number of context modules (`data.modules`), showing how an
  exec binary reads QuadFlow data without a library.
- `fail` — exits with code 3 and a `not_found` error envelope (exit codes match the core CLI).

Anything else prints usage and exits with code 2.
