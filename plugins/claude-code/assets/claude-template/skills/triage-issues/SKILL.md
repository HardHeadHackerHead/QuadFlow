---
name: triage-issues
description: Help prioritize and triage issues - set priorities, update statuses, identify blockers, and prepare issues for work.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [critical|blocked|backlog|stale]
---

# Triage Issues Skill

Prioritize open issues, surface blockers, and get the board ready for work.

## Process

1. **Get the issues** (narrowed by the filter, if any):

   ```bash
   quadflow issues list --json                         # all open issues
   quadflow issues list --priority critical --json     # filter: critical
   quadflow issues list --status blocked,needs_human --json   # filter: blocked
   quadflow issues list --status backlog --json        # filter: backlog
   ```

   For `stale`, list all open issues and pick those whose `updatedAt` (Unix ms) is older than ~30 days.

2. **Triage each open issue**:

   **Priority**:
   - Blocking other work? -> `critical`
   - Affects core functionality? -> `high`
   - Standard improvement? -> `medium`
   - Minor or cosmetic? -> `low`

   **Status**:
   - Ready to work on? -> `todo`
   - Waiting on another issue or something external? -> `blocked` (comment what)
   - Needs a decision from a person? -> `needs_human`
   - Should wait? -> `backlog`
   - Being worked on? -> `in_progress`

   ```bash
   quadflow issues update WEB-12 --priority high
   quadflow issues status WEB-12 todo
   ```

3. **Blocked issues**:
   - Check what blocks them: `quadflow issues blocking WEB-12 --json`
   - Record real dependencies as blockers (replaces the list; closing a blocker unblocks it automatically):
     ```bash
     quadflow issues update WEB-12 --blocked-by WEB-3,WEB-7
     quadflow issues comment WEB-12 --body "Blocked on WEB-3 (schema) and the vendor API key."
     ```
   - If the blocker is already done, clear it and move the issue to `todo`.

4. **Quick wins** — low effort, high value:
   ```bash
   quadflow issues label WEB-12 quick-win
   ```

5. **Report the triage summary**:
   - Ready for work (`todo`), in priority order
   - Blocked issues and their blockers
   - Recommended next issue to tackle, and why
   - Issues that could be closed (duplicates, won't fix) — propose, don't close without the user's OK

## Optional Filter

$ARGUMENTS:
- `critical` - only critical issues
- `blocked` - focus on unblocking `blocked` / `needs_human` issues
- `backlog` - review the backlog for promotion to `todo`
- `stale` - issues not updated recently
