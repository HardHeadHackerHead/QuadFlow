---
name: assign-environment
description: Assign a terminal environment to a build script for proper shell and init commands.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: <script-name> [environment-name|none]
---

# Assign Environment to Script

Give a saved script a terminal environment so it runs with the right shell, init commands
and environment variables. A script stores the environment by **name**; each machine
resolves that name against its own environments, so the same script works for everyone
who has an environment of that name.

## When to Use

- The script needs Visual Studio native tools (cl.exe, link.exe)
- The script needs specific environment variables or init commands
- The script must run in a particular shell (bash, cmd, PowerShell)

## Process

1. **Parse arguments**: first the script name, then (optionally) the environment name or
   `none`.

2. **Find the script** (case-insensitive match on name; ask if several match):
   ```bash
   quadflow scripts list --text "<script-name>" --json
   ```

3. **If no environment was given**, list this machine's environments and ask which one to
   use (or whether to clear the assignment):
   ```bash
   quadflow scripts env-list --json
   ```
   If the list is empty or lacks what the script needs, suggest `/detect-environments` or
   `/setup-environment` first.

4. **Assign or clear**:
   ```bash
   quadflow scripts update <script-id> --environment "<environment name>" --json
   quadflow scripts update <script-id> --clear environment --json   # for "none"
   ```

5. **Confirm**: resolve the script for this machine and show the result:
   ```bash
   quadflow scripts get-command <script-id> --json
   ```
   Report the shell, environment, setup commands and `fullCommand`. If it fails with
   `not_found` (exit 3), the environment name is not configured on this machine.

## Examples

```
/assign-environment "Tauri Build" "VS 2022 Community x64"
-> Assigns the VS 2022 x64 environment to the "Tauri Build" script

/assign-environment dev
-> Lists environments and asks which to assign to the "dev" script

/assign-environment "Build" none
-> Clears the environment from the "Build" script
```

## What Happens When the Script Runs

1. A terminal opens with the environment's shell
2. The environment's init commands run (e.g. `vcvarsall.bat`)
3. Environment variables are set
4. The script's setup commands, then its main command, run

## Common Assignments

| Script type | Environment |
|-------------|-------------|
| Rust/Tauri builds on Windows | VS developer prompt (x64) |
| Node.js builds | none (default shell) |
| Python scripts | custom environment that activates the venv |
| Cross-compilation | VS developer prompt for the target arch |
