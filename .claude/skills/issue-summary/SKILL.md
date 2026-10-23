---
name: issue-summary
description: Get a quick summary of all issues organized by status, priority, and labels. Perfect for a quick overview of the issues backlog.
allowed-tools: Bash, Read
user-invocable: true
---

# Issue Summary Skill

Give a quick, scannable overview of the project's issues. Read-only: change nothing.

## Process

1. **Get all issues**, including finished ones, plus the epics for grouping:

   ```bash
   quadflow issues list --include-done --json
   quadflow epics list --json
   ```

   Each issue has `number, title, status, priority, labels, epicId, blockedBy, assignment, createdAt, updatedAt` (timestamps are Unix milliseconds). Statuses: `backlog, todo, in_progress, qa, blocked, needs_human, done`. Priorities: `critical, high, medium, low`.

2. **Count and group**:
   - By status (open = everything except `done`)
   - By priority (open issues only; list titles of critical ones)
   - By label (top labels by count)
   - By epic (open/total per epic)

3. **Flag what needs attention**:
   - `blocked` and `needs_human` issues (especially critical/high)
   - Issues waiting in `qa` for human review
   - Open issues with no labels
   - Backlog issues not updated in 30+ days
   - Claimed issues (`assignment` set) whose claim looks stale

## Output Format

```
## Issues Summary

**Open:** X | **Done:** X

### By Status
- In Progress: X
- QA (awaiting review): X
- Blocked: X (!)
- Needs Human: X (!)
- Todo: X
- Backlog: X

### By Priority (open)
- Critical: X  [WEB-3 title, ...]
- High: X
- Medium: X
- Low: X

### Top Labels
- bug: X | feature: X | ...

### By Epic
- [Epic title]: X open / Y total

### Attention Needed
- [Urgent items, with refs]
```
