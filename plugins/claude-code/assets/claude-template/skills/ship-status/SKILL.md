---
name: ship-status
description: Pretty-print the project's ship status — current version, version-file sync, last run, branch, dirty tree.
allowed-tools: Bash, Read
user-invocable: true
---

# Ship Status Skill

Concise human-readable summary of the ship state, built from
`quadflow ship status --json`.

## Process

1. **Fetch**

   ```bash
   quadflow ship status --json
   quadflow ship readiness --json   # optional: failing checks
   ```

   - `data`: `inSync`, `canonicalVersion`, `versionFiles[] {file, current, error}`,
     `lastRun`, `branch`, `gitClean` (`branch` / `gitClean` are absent outside
     a git repo).
   - `{"ok":false,"error":{"code":"not_found"}}` → no config; tell the user to
     run `/setup-ship`.

2. **Format** — three sections:

   **Versions**
   - One line if `inSync` (the canonical version).
   - Otherwise each file with its `current` value or `error`.

   **Repository**
   - Branch, tree state (clean / DIRTY).

   **Last run** (`lastRun`)
   - `version`, `mode`, `status`, phase count, `releaseUrl`, duration
     (`completedAt - startedAt`, epoch ms).
   - Failed: the phase with `status: "failed"` and the first line of its `error`.
   - `in_progress` for more than 30 minutes: suggest `quadflow ship abort`.

3. **Action items**
   - Tree dirty → "Commit or stash before `/cut-ship`"
   - Out of sync → "Reconcile the version files by hand (`quadflow ship config validate` lists them)"
   - Failing readiness check → its `hint`, and `quadflow ship fix <check-id>` if it has a `fixCommand`
   - Last run failed → "Inspect: `quadflow ship get <run-id>`"
   - In-progress run → "Wait for it, or `quadflow ship abort`"
   - No runs → "Ready: `quadflow ship run patch --dry-run`"

## Notes

- History: `quadflow ship list`. One run's stdout/stderr:
  `quadflow ship get <run-id | version>`.
- Don't recommend a bump kind — that's the user's call.
