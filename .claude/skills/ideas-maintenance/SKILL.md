---
name: ideas-maintenance
description: Complete ideas maintenance - organize, tag, check implementation status, and suggest improvements. One button to do everything.
allowed-tools: Read, Grep, Glob, Bash
user-invocable: true
---

# Complete Ideas Maintenance Skill

Run a full maintenance pass over the project's QuadFlow ideas: tag, check implementation status, suggest wording improvements, and report.

## Phase 1: Gather data

```bash
quadflow ideas list --json    # every active idea with tags, notes, suggestions
quadflow ideas stats --json   # tags already in use (byTag)
```

Note each idea's current tags, pending suggestions and notes so you don't repeat work.

## Phase 2: Categorize and tag

Give every untagged idea a category tag. Build the category set from this project, not a fixed list: reuse tags already in `byTag`, and otherwise derive a small set (roughly 5-10) from the codebase's main areas, e.g. `ui`, `backend`, `api`, `cli`, `docs`, `dev-tools`, `performance`, `misc`.

```bash
quadflow ideas add-tag <id> <category>
quadflow ideas bulk-tag <id,id,…> <category>   # many ideas, one tag
```

## Phase 3: Check implementation status

For each idea:
1. `Grep` for keywords from the idea, `Glob` for related files, `Read` to confirm.
2. Tag the result: `implemented`, `in-progress`, or `not-started` (remove a stale status tag with `quadflow ideas remove-tag <id> <tag>`).
3. Add a note with the code locations, prefixed `[ideas-maintenance]`:
   ```bash
   quadflow ideas add-note <id> "[ideas-maintenance] Implemented in src/components/Settings.tsx:40-95."
   ```

## Phase 4: Suggest text improvements

For ideas whose **wording** needs work (not implementation status):
- vague -> `expand`
- ambiguous -> `clarify`
- verbose -> `summarize`
- casual or fragmentary -> `reword`

```bash
quadflow ideas add-suggestion <id> --kind expand "<improved idea text>"
```

Skip ideas that already have a pending suggestion (an entry in `suggestions` without an `accepted` field). Suggestions are only for text; status goes in notes.

## Phase 5: Report

```markdown
# Ideas Maintenance Report

## Summary
- Total ideas: X
- Newly tagged: X
- Implementation checked: X
- Suggestions added: X
- Notes added: X

## By Category
| Category | Count | Implemented | Pending |
|----------|-------|-------------|---------|

## By Status
- Implemented: X (list)
- In Progress: X (list)
- Not Started: X (list)

## Text Suggestions Added
- Reword: X
- Expand: X
- Clarify: X
- Summarize: X

## Action Items
1. [high-priority items]
2. [quick wins]
3. [needs clarification from the user]
```

## Notes

- This pass can take a while on a large backlog.
- Safe to rerun: adding an existing tag changes nothing, and earlier notes and suggestions are kept.
- Suggestions can be accepted or rejected in the Ideas tool or with `quadflow ideas resolve-suggestion <id> <suggestion-id> --accept|--reject`.
