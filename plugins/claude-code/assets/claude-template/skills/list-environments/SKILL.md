---
name: list-environments
description: List and review all terminal environments configured in QuadFlow.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [detail|cleanup]
---

# List Environments

Show this machine's terminal environments.

## Process

1. **Get all environments**:
   ```bash
   quadflow scripts env-list --json
   ```
   Fields: `id, name, description, kind` (`system_shell` | `vs_dev` | `custom`), `shell`,
   `shellPath`, `initCommands`, `env`, `vs`, `builtIn`, `available`.

2. **Display grouped by kind**: system shells, Visual Studio developer prompts, custom.
   Show availability and the number of init commands.

3. **If $ARGUMENTS contains "detail"**: for each environment list every init command and
   environment variable (`quadflow scripts env-get "<name>" --json` for one).

4. **If $ARGUMENTS contains "cleanup"**:
   - Find unavailable environments, and custom environments no script uses
     (compare against the `environment` field of `quadflow scripts list --include-archived --json`)
   - Offer to delete them; only after the user confirms:
     ```bash
     quadflow scripts env-delete "<name or id>" --json
     ```

## Output Format

```
## System Shells
- Command Prompt (cmd) ✓
- Windows PowerShell (powershell) ✓
- Git Bash (bash) ✓

## Visual Studio Developer Prompts
- VS 2022 Community x64 ✓
  └ Init: call "...\vcvarsall.bat" x64
- VS 2022 Community x86 ✓
  └ Init: call "...\vcvarsall.bat" x86

## Custom Environments
- Rust Nightly (powershell) ✓
  └ Init: rustup default nightly
  └ Env: RUSTFLAGS=-C target-cpu=native

Legend: ✓ Available  ✗ Unavailable
```

## Next Actions

Remind the user they can:
- `/detect-environments` — re-scan for shells and Visual Studio installations
- `/setup-environment` — create a custom environment
- `/assign-environment <script>` — assign an environment to a script
