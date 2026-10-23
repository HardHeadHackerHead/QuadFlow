---
name: weekly-digest
description: Generate a weekly summary of idea activity including new ideas, completed ideas, aging ideas, and priority suggestions.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [weeks-back|month|quarter|all]
---

# Weekly Digest Skill

Summarize recent QuadFlow idea activity. This skill only reads; it changes nothing.

## Process

1. **Get every idea, archived included**:
   ```bash
   quadflow ideas list --include-archived --json
   quadflow ideas stats --json
   ```
   To fetch only a window, pass epoch-millisecond bounds: `quadflow ideas list --from <ms> [--to <ms>] --json` (e.g. `date +%s` x 1000 minus 7 days).

2. **Set the period**: last 7 days by default; see Options.

3. **Classify by activity**, using the timestamps on each idea (all epoch ms):
   - `createdAt` — when the idea was captured
   - `updatedAt` — last change of any kind (content, tags, archive flag, notes, suggestions)
   - `notes[].createdAt`, `suggestions[].createdAt` — when each note or suggestion was added
   - `createdBy` — who created it (`{kind, name}`)

   Buckets:
   - **New**: `createdAt` inside the period, grouped by category tag.
   - **Completed / archived**: tagged `implemented` or `archived: true`, with `updatedAt` inside the period. There is no separate completion timestamp, so treat this date as approximate.
   - **In progress**: tagged `in-progress`; include the latest note as status or blocker.
   - **Aging**: no activity (`updatedAt`) for 30+ days; **stale**: 90+ days. Suggest archive, prioritize, or clarify.
   - **Hot**: most notes and suggestions added in the period.

4. **Recommend priorities**:
   - Quick wins: `complexity-low` with high value
   - Blockers: ideas others depend on (from notes and `related-to-*` tags)
   - Overdue: old `priority-high` ideas
   - Trending: tags with several new ideas

5. **Write the digest**:

```
## Ideas Weekly Digest
**Period**: [start date] - [end date]

### Summary
| Metric | Count | vs previous period |
|--------|-------|--------------------|
| Total ideas | X | +/-Y |
| New | X | |
| Completed / archived | X | |
| In progress | X | |
| Aging (30+ days) | X | |
| Stale (90+ days) | X | |

### New Ideas
#### [Category]
- **[id]**: [brief content] `tags`

### Completed / Archived
| ID | Idea | Date (approx.) |
|----|------|----------------|

### In Progress
| ID | Idea | Created | Latest note |
|----|------|---------|-------------|

### Needs Attention
#### Aging (30+ days, no activity)
- **[id]**: [content] - *Consider: [action]*
#### Stale (90+ days)
- **[id]**: [content] - *Recommend: archive or revive*

### Recommended Priorities
#### This week's focus
1. **[id]**: [content] - [reason]
#### Quick wins
- [id], [id]
#### Blockers
- [id] blocks [id]

### Trends
- Most active tag: [tag]
- Fastest-growing tag: [tag]
- Velocity: X new vs Y completed

*Generated: [timestamp]*
```

The "vs previous period" column compares counts for the same-length window just before this one, computed from `createdAt`.

## Options (`$ARGUMENTS`)

- a number, e.g. `2`: look back that many weeks
- `month`: last 30 days
- `quarter`: last 90 days
- `all`: full history

## Notes

- Tagging touches `updatedAt`, so an idea that was only re-tagged looks active. Prefer note and suggestion timestamps when judging real activity.
- Point out stale ideas that recently got suggestions, and ideas that look obsolete given the current codebase.
