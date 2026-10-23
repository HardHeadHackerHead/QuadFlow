---
name: find-duplicates
description: Analyze all ideas for similarity, group duplicate or related ideas, and suggest merging them.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [strict|moderate|loose]
---

# Find Duplicates Skill

Find duplicate and overlapping QuadFlow ideas, then merge or link them with the user's approval.

## Process

1. **Get all ideas**:
   ```bash
   quadflow ideas list --json
   ```
   Add `--include-archived` if the user wants archived ideas considered too.

2. **Compare ideas** on keywords and phrasing, tags, underlying goal, and technical scope.

3. **Group them**:
   - **Exact duplicates**: the same idea worded differently.
   - **Related**: could be combined into one fuller idea.
   - **Overlapping**: partial overlap; better linked than merged.

4. **For each group decide**: which idea is the primary (clearest or most complete), what unique detail each other idea adds, and the action (merge, link, keep separate).

5. **Report**:

```
## Duplicate Analysis Report

### Summary
- Ideas analyzed: X
- Duplicate groups: X
- Ideas that could be merged: X

### Duplicate Groups

#### Group 1: [Theme]
- **Primary**: [id] - "[content]"
- **Duplicates**:
  - [id] - "[content]" (similarity: high)
  - [id] - "[content]" (similarity: medium)
- **Recommendation**: merge into [primary id]
- **Combined content**: [proposed merged text]

### Unique Ideas
[Ideas with no significant duplicates]
```

6. **Ask the user to approve** each merge before changing anything.

7. **Merge approved groups**. `merge` concatenates content, unions tags and notes, keeps `<keep-id>` and deletes the others:
   ```bash
   quadflow ideas merge <id1,id2,id3> <keep-id> --json
   ```
   The concatenated text is usually rough. Propose the cleaned-up combined content as a suggestion so the user can accept it in the Ideas tool:
   ```bash
   quadflow ideas add-suggestion <keep-id> --kind summarize "<combined content>"
   ```

8. **Link overlapping ideas** instead of merging them, with a shared tag on each:
   ```bash
   quadflow ideas bulk-tag <id1,id2> related-to-<primary-id>
   ```

## Similarity threshold (`$ARGUMENTS`)

- `strict` — only exact or near-exact duplicates
- `moderate` — also clearly related ideas (default)
- `loose` — any topically similar ideas

## Notes

- Merging deletes the non-kept ideas; never merge without approval.
- Preserve unique information in the combined content.
- Differently worded ideas may serve different use cases; when in doubt, link rather than merge.
