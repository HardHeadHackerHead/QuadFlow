---
name: cut-ship
description: Run the project's full ship pipeline (preflight → bump → build → sign → bundle → upload/deploy) end-to-end with a chosen patch/minor/major bump, or re-deploy the current version.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [patch|minor|major|deploy] [--reuse-build] [--skip-build] [--draft]
---

# Cut Ship Skill

Execute the pipeline declared in `.quadflow/ship/config.json`. Every run gets
its own record under `.quadflow/local/ship/runs/<run-id>.json` (two runs of the
same version keep two records). Full reference: `quadflow docs ship`.

## Process

1. **Preflight summary**

   ```bash
   quadflow ship status --json      # version, inSync, branch, gitClean, lastRun
   quadflow ship readiness --json   # [{id, label, level, hint, fixCommand, fromConfig}]
   ```

   - No config (`error.code == "not_found"`) → run `/setup-ship` first.
   - A check with `"level": "fail"` that the config uses (`fromConfig: true`)
     stops the `checks` phase. Surface fails with their `hint` / `fixCommand`
     before running. Offer `quadflow ship fix <check-id>` when a
     `fixCommand` exists; ask whether to proceed.
   - Tree dirty (`gitClean: false`) or versions out of sync → point it out.

2. **Pick the mode**
   - `$ARGUMENTS` may include `patch`, `minor`, `major` or `deploy`.
   - Otherwise ask: `patch` for fixes, `minor` for additive features,
     `major` for breaking changes, `deploy` to re-ship the current version
     without bumping (web deploys, retries). Don't pick for the user.

3. **Always dry-run first**

   ```bash
   quadflow ship run <mode> --dry-run [--reuse-build] [--skip-build] [--draft]
   ```

   Prints every phase with resolved tokens (`{version}`, `{staging_dir}`,
   `{productName}`, …) and commands; nothing runs, nothing is persisted.
   Walk the user through it and confirm before executing.

4. **Execute**

   ```bash
   quadflow ship run <mode> [--reuse-build] [--skip-build] [--draft]
   ```

   Phase output streams as it runs. Add `--json` when you need the record:
   success prints `{"ok":true,"data":<run>}`; a failed or aborted run exits
   **1** with `{"ok":false,"error":{"code":"external","details":{"run":<run>}}}`.

5. **Report**
   - Success: new `version`, `artifacts`, `releaseUrl`.
   - Failure: the phase with `status: "failed"`, its `error`, `exitCode` and
     the tail of `stderr`. Suggest:
     - `quadflow ship get <run-id>` for the full record (stdout/stderr per phase)
     - `quadflow ship abort` if a run is stuck `in_progress`
     - `--reuse-build` to retry without rebuilding when only a later phase failed

## Flag cheatsheet

- `--dry-run` — resolve and print the plan only
- `--reuse-build` — skip `build` phases; reuse existing artifacts
- `--skip-build` — skip `build` phases and `shell` phases with `skipFlag: "skip-build"`
- `--draft` — force `--draft` on every `gh_release` phase
- `deploy` mode (or `--no-bump` with any mode) — keep the current version

## Crash safety

`patch_tauri_conf` snapshots `<file>.ship-bak` before editing; backups are
restored at the end of every run and at the start of the next one. Manual
cleanup: `quadflow ship restore-backups`.

## When NOT to use

- No ship config → `/setup-ship`.
- Only the version bump → `quadflow ship bump <patch|minor|major> [--dry-run]`.
