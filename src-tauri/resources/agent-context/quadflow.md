This project is managed by QuadFlow. Its data (ideas, issues, plans, scripts, …) lives in
`.quadflow/` and is read and changed with the `quadflow` CLI — never edit `.quadflow/` files by
hand.

- `quadflow --help`, `quadflow <command> --help` — the authoritative command list. Commands marked
  `[plugin: <id>]` come from enabled plugins and follow the same `--json` and exit-code rules.
- `quadflow docs --list` — available reference modules; `quadflow docs <module>` prints one.
  Modules enabled for this project are included below.
- The CLI finds the project by walking up from the current directory (or `--project <path>`).
- `--json` prints one document: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code":…,"message":…}}`.
- Exit codes: 0 ok, 1 error, 2 invalid argument, 3 not found, 4 conflict, 5 not in a project.
