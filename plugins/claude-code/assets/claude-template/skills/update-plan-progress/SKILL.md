---
name: update-plan-progress
description: Review work done and update plan step statuses accordingly
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
argument-hint: <plan-id or plan-title>
---

# Update Plan Progress Skill

Check the codebase against a plan's steps and update step statuses to reflect actual progress.

## Process

1. **Find the plan**:
   - An id: `quadflow plans get <plan-id> --json`
   - A title: `quadflow plans list --search "<title>" --json` and pick the match
   - Nothing: `quadflow plans list --json` and ask the user to choose

2. **For each `pending` / `in_progress` step** in `data.steps`:

   a. **What does it require?** Read `title`, `description`, `acceptanceCriteria` (what "done" means), `targetFiles` (where to look) and `codeContext`.

   b. **Is the work done?** If the step has `verification`, use it first:
      - `build`: run `verification.command` if set, otherwise look for build artifacts
      - `test`: run `verification.command` if set, otherwise look for passing tests
      - `grep_check`: `Grep` for `verification.pattern` (or the code described in the step)
      - `file_exists`: `Glob` for the `targetFiles`
      - `manual_review`: `Read` the `targetFiles` and judge against the criteria

      Without verification data, fall back to `Glob` / `Read` / `Grep` on the relevant files.

   c. **Acceptance criteria**: check each one. A step is `completed` only if ALL are met; note which pass and which fail.

   d. **Dependencies**: a step whose `dependsOn` steps are not completed stays `pending` unless work on it has clearly started.

   e. **New status**:
      - `completed`: fully done, all criteria met, verification passes
      - `in_progress`: partially done
      - `pending`: not started, or blocked by dependencies
      - `skipped`: no longer needed (confirm with the user)

3. **Update the steps** that changed:

   ```bash
   quadflow plans step-update <step-id> --status in_progress \
     --notes "Verified 2/3 criteria: X done, Y done; Z missing (no test in tests/foo.test.ts)"
   ```

   Steps promoted to issues (`issueId` set) are kept in sync: changing the step moves the issue too (`completed` → `done`, `in_progress` → `in_progress`, `pending` → `todo`). Because `done` normally needs a human sign-off, for promoted steps confirm with the user before marking `completed`, or move the issue to review instead: `quadflow issues status <ref> qa`.

4. **Plan status** follows automatically: the plan becomes `executing` when a step starts during `review_steps`/`promoting`, and `completed` when every non-skipped step is completed. Only correct it by hand if it is clearly wrong: `quadflow plans update <plan-id> --status executing`.

5. **Report**:
   - Steps updated (with kind and effort)
   - Progress: completed / non-skipped steps, as a percentage
   - Acceptance criteria per step (X of Y met)
   - Remaining work grouped by kind
   - Next steps, respecting dependencies

## Fallback checks (no enrichment data)

- Implementation steps: relevant files exist, functions/types defined, no TODOs marking unfinished work
- Testing steps: test files and test functions exist; tests pass if cheap to run
- Documentation steps: docs exist and cover the content
