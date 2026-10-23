## {{name}} (`quadflow {{cliName}}`)

Coding agents read this when the `{{name}}` context module is enabled for a project
(`quadflow context enable <module>`); `quadflow docs --list` shows the module id.

- `quadflow {{cliName}} hello <name> --json` — greet someone; prints `{ "ok": true, "data": { "message" } }`.
- `quadflow {{cliName}} last --json` — the last greeted name.

Always pass `--json` when parsing the output.
