---
name: find-duplicate-issues
description: Analyze all issues for similarity, find duplicates or related issues, and suggest consolidation.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [strict|moderate|loose]
---

# Find Duplicate Issues Skill

Find duplicate and overlapping issues, propose consolidation, and apply it once the user approves.

## Process

1. **Retrieve all issues** (open ones by default; add `--include-done` to catch re-reports of closed work):

   ```bash
   quadflow issues list --json
   quadflow issues list --include-done --json
   ```

   Use `quadflow issues get <ref> --json` when you need an issue's full body, criteria and comments.

2. **Compare issues** on:
   - Title keywords and phrasing
   - Body, user story and acceptance criteria
   - Labels and epic
   - Underlying intent and technical scope

3. **Group them**:
   - **Exact duplicates**: the same problem reported twice
   - **Related**: could be combined or linked
   - **Overlapping scope**: partial overlap; should reference each other

4. **For each group decide**:
   - The primary issue (most complete, most progressed, or oldest)
   - What unique information each duplicate adds
   - The action: close as duplicate, merge content, or just link

5. **Report** in this format and **ask the user for approval** before changing anything:

```
## Duplicate Issues Analysis

### Summary
- Total issues analyzed: X
- Duplicate groups found: X
- Issues that could be consolidated: X

### Duplicate Groups

#### Group 1: [Theme/Topic]
**Primary Issue**: WEB-12 - "[title]"
- Status: [status] | Priority: [priority]

**Potential Duplicates**:
- WEB-31 - "[title]" (similarity: high)
  - Unique info: [details this adds]
- WEB-40 - "[title]" (similarity: medium)
  - Unique info: [details]

**Recommendation**: Close WEB-31, WEB-40 as duplicates of WEB-12

### Related But Distinct
[Issues that should stay separate, and how they differ]
```

6. **Consolidate** (only with approval):

   ```bash
   # Merge unique details into the primary (update replaces the body, so include the existing text)
   quadflow issues update WEB-12 --body "<existing body + merged details>"
   quadflow issues comment WEB-12 --body "Merged details from WEB-31 and WEB-40."

   # Mark and close each duplicate
   quadflow issues comment WEB-31 --body "Duplicate of WEB-12; details merged there."
   quadflow issues label WEB-31 duplicate
   quadflow issues close WEB-31

   # Related but distinct: link instead of closing
   quadflow issues update WEB-40 --depends-on WEB-12
   ```

   `--depends-on` replaces the existing list, so pass the current refs plus the new one.

## Similarity Threshold

$ARGUMENTS sets how wide to cast:
- `strict` - only exact or near-exact duplicates
- `moderate` - also clearly related issues (default)
- `loose` - any topically similar issues

## Notes

- Never lose unique information when consolidating
- Every closed duplicate gets a comment pointing at the primary
- Similar symptoms can have different root causes; when in doubt, link rather than close
- Prefer keeping the issue that already has progress, claims or comments as the primary
