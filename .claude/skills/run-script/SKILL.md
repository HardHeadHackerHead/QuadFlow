---
name: run-script
description: Run a build script from QuadFlow by name or ID.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: <script-name>
---

# Run Script

Run a saved QuadFlow script by name or ID.

## Process

1. **If no argument was given**, list the scripts that run on this platform and ask which
   one to run:
   ```bash
   quadflow scripts list --json
   ```

2. **Find the script**: case-insensitive partial match on the name (or an exact ID):
   ```bash
   quadflow scripts list --text "<name>" --json
   ```
   If several match, show them and ask the user to pick.

3. **Resolve it for this machine**:
   ```bash
   quadflow scripts get-command <id> --json
   ```
   The result has `shell`, `shellPath`, `environment`, `cwd`, `setup`, `env` and
   `fullCommand` (environment init, setup commands, env vars and the main command combined).
   Exit 1 `unsupported` means the script is not for this platform; exit 3 means its
   environment is not configured on this machine (suggest `/detect-environments` or
   `/assign-environment`).

4. **Execute** `fullCommand` with the Bash tool from `cwd`. For a long-running dev server
   (script `kind` = `server`), run it in the background.

5. **Report**: the command that ran, its output, and suggested fixes if it failed.

## Examples

```
/run-script build     -> runs the script with "build" in its name
/run-script dev       -> runs the script with "dev" in its name
/run-script test      -> runs the script with "test" in its name
```
