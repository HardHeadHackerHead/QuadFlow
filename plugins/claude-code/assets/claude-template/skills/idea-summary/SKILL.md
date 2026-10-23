---
name: idea-summary
description: Get a quick summary of all ideas organized by category, priority, and status. Perfect for a quick overview of the ideas backlog.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [compact|detailed|kanban]
---

# Idea Summary Skill

Summarize the project's QuadFlow ideas. This skill only reads; it changes nothing.

## Process

1. **Get the data**:
   ```bash
   quadflow ideas stats --json   # total, active, archived, count per tag
   quadflow ideas list --json    # active ideas, newest first
   ```

2. **Group the ideas**. Ideas have no dedicated category, status or priority fields; all three come from tags:
   - **Category**: topical tags (anything that isn't a status, priority or complexity tag)
   - **Status**: `implemented`, `in-progress`, `not-started`; untagged ideas count as pending
   - **Priority**: `priority-high`, `priority-medium`, `priority-low`

3. **Write the summary** in the requested format.

### Default format
```
## Ideas Summary

Total: X (active X, archived X)

### By Category
- [tag]: X ideas
...

### By Status
- Implemented: X
- In Progress: X
- Pending: X

### Recent Ideas (last 5)
1. [id] [content...]
...

### High Priority
- [id] [content]
```

### Compact (`$ARGUMENTS` = `compact`)
One line of category counts.

### Detailed (`$ARGUMENTS` = `detailed`)
Full content of each idea, grouped by category.

### Kanban (`$ARGUMENTS` = `kanban`)
Ideas in status columns: Pending | In Progress | Done.

## Notes

- If most ideas are untagged, say so and suggest running `/organize-ideas`.
