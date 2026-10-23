---
name: organize-issues
description: Categorize, label, and prioritize all issues in QuadFlow. Use this when the user wants to clean up, organize, or prioritize their issues.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [priority|status|labels|blocked]
---

# Organize Issues Skill

Categorize, label and prioritize every open issue.

## Process

1. **Retrieve the issues and the label catalog**:

   ```bash
   quadflow issues list --json
   quadflow labels list --json
   quadflow epics list --json
   ```

2. **For each issue**, decide and apply:

   **Priority**:
   - `critical` - blocking work, security problems, data loss
   - `high` - important bugs, major features needed soon
   - `medium` - standard features, moderate bugs
   - `low` - nice-to-have, minor improvements

   **Status**:
   - `backlog` - not yet planned
   - `todo` - planned for upcoming work
   - `in_progress` - being worked on
   - `blocked` - waiting on something (comment what)
   - `needs_human` - needs a human decision or action
   - `qa` - implemented, awaiting human review
   - `done` - completed (leave closing to humans unless the user asks)

   **Labels** (reuse existing catalog labels before inventing new ones):
   - `bug`, `feature`, `enhancement`, `docs`, `ui`, `performance`, `security`

   ```bash
   quadflow issues update WEB-12 --priority high
   quadflow issues status WEB-12 todo
   quadflow issues label WEB-12 bug
   quadflow issues unlabel WEB-12 misc
   quadflow issues update WEB-12 --epic <epicId>      # group under an epic where one fits
   ```

   Adding a label that is not in the catalog creates it. To give a new label a color or description, or to rename a messy one (issues follow the rename):
   ```bash
   quadflow labels upsert performance --color "#f97316" --description "Speed and resource use"
   quadflow labels upsert bug --rename-from Bug
   ```

3. **Report a summary**:
   - Total issues organized and what changed
   - Count by priority and by status
   - Issues still needing attention (no labels, unclear priority, unexplained `blocked`)

## Optional Focus

$ARGUMENTS narrows the pass:
- `priority` - only set correct priorities
- `status` - only fix workflow status accuracy
- `labels` - only labeling (and label catalog cleanup)
- `blocked` - only identify and explain blocked issues (`quadflow issues blocking <ref> --json`)
