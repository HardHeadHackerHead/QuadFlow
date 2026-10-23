# Scripts

Saved build/test/run recipes (`.quadflow/scripts/<id>.json`, shared through
git) with environment variables, setup commands, a working directory inside
the project, platform restrictions and an optional terminal environment.
Script groups (`.quadflow/script-groups/`) run several scripts together.
Terminal environments (shells, Visual Studio developer prompts, custom
setups) are per machine: a script names its environment by **name**, and each
machine resolves that name against its own environments.

## Commands

Run `quadflow scripts --help` for the authoritative list. With `--json` every
command prints one envelope: `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":…,"message":…}}`.

- `quadflow scripts list [--text Q] [--tag T] [--pinned] [--include-archived] [--platform windows|macos|linux]`
- `quadflow scripts get <id>`
- `quadflow scripts create "<name>" --command "<cmd>" [--description D] [--setup CMD]… [--env K=V]… [--platform P]… [--shell cmd|powershell|pwsh|bash|zsh|sh] [--working-directory rel/path] [--environment "<env name>"] [--kind command|server|build] [--preview-url URL] [--tag T]…`
- `quadflow scripts update <id> [same flags] [--clear description|shell|working-directory|environment|preview-url|setup|env|platform|tag]…`
- `quadflow scripts delete <id>` (also removes it from every group)
- `quadflow scripts tag|untag <id> <tag>`, `pin|unpin <id>`, `archive|unarchive <id>`
- `quadflow scripts get-command <id> [--platform P] [--default-environment NAME]` —
  resolve for this machine and print the full command line (JSON: shell,
  shellPath, environment, cwd, setup, env, fullCommand)
- `quadflow scripts groups list|get <id>|create "<name>" [--mode parallel|sequential] [--script <id>]…|update <id>|delete <id>`
- `quadflow scripts groups add <group-id> <script-id> [--order N] [--delay-ms MS]` / `remove <group-id> <script-id>`
- `quadflow scripts env-list` / `env-get <id|name>` / `env-delete <id|name>`
- `quadflow scripts env-add "<name>" --shell bash [--init CMD]… [--env K=V]… [--shell-path /abs/path]`
- `quadflow scripts env-detect` — find shells and toolchains on this machine
  (Windows: cmd, Windows PowerShell, pwsh, Git Bash, Visual Studio via
  vswhere; macOS/Linux: zsh, bash, sh, pwsh)

## JSON shapes (camelCase)

Script: `{id, name, description?, command, setupCommands?, env?, platforms?,
shell?, workingDirectory?, environment?, kind, previewUrl?, autoOpenPreview,
tags?, pinned, archived, createdAt, createdBy, updatedAt}`.

Group: `{id, name, description?, members?: [{scriptId, order, delayMs,
autoOpenPreview}], mode: "parallel"|"sequential", …}`.

## Exit codes

0 ok · 1 error (e.g. `unsupported`: script not for this platform) · 2 invalid
argument · 3 not found (also: the named environment is not configured on this
machine) · 4 conflict · 5 not inside a QuadFlow project.
