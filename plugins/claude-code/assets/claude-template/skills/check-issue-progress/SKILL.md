---
name: check-issue-progress
description: Check the codebase to see which issues have been resolved, partially implemented, or are still pending. Use this to audit issue completion status.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [issue-ref]
---

# Check Issue Progress Skill

Audit open issues against the codebase and record what is done, in progress, or not started.

## Process

1. **Get the issues to check**:
   - If an issue ref is given ($ARGUMENTS, e.g. `WEB-12` or `12`), check only that one.
   - Otherwise list every open issue (everything except `done`):

   ```bash
   quadflow issues list --json
   quadflow issues get WEB-12 --json   # full detail: body, acceptanceCriteria, comments
   ```

2. **For each issue**, search the codebase for evidence:
   - `Grep` for keywords, function names, error messages, UI strings from the issue
   - `Glob` to find relevant files
   - `Read` to confirm the implementation actually meets the issue and its acceptance criteria

3. **Evaluate and record each issue**:

   **Completed** — fully implemented. Tick the criteria that are met, say where, and move it to QA (a human closes issues):
   ```bash
   quadflow issues criterion WEB-12 <criterionId> --checked true
   quadflow issues comment WEB-12 --body "Implemented in src/auth/refresh.ts:40-88 (token refresh) and src/api/routes.ts:12."
   quadflow issues status WEB-12 qa
   ```

   **In Progress** — partially implemented:
   ```bash
   quadflow issues comment WEB-12 --body "Done: ... Remaining: ..."
   quadflow issues status WEB-12 in_progress
   ```

   **Not Started** — nothing found. Leave the status as `todo`/`backlog`; optionally comment with existing code that would help.

   Do not change issues already in `qa` or `in_progress` that an agent has claimed (`assignment` set) unless the evidence clearly contradicts the status.

4. **Generate the progress report** (below).

## Search Strategies

- Bugs: the error message, the failing code path, fix commits or comments, added error handling
- Features: feature keywords, UI components, routes/endpoints, CLI commands
- Enhancements: the feature being enhanced and the specific change requested

## Output

```
## Issue Progress Report

### Completed -> moved to QA (X issues)
- WEB-12 [title] - Implemented in [file(s)]

### In Progress (X issues)
- WEB-14 [title] - [what's done] / [what remains]

### Not Started (X issues)
- WEB-20 [title] - [relevant existing code]

**Completion Rate:** X%
```
