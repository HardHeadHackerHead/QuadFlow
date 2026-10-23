---
name: plan-summary
description: Generate a comprehensive summary of all plans and their progress
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [plan-id or status]
---

# Plan Summary Skill

Summarize the project's implementation plans and their progress.

## Process

1. **Fetch plans**:
   - A plan id in $ARGUMENTS: `quadflow plans get <plan-id> --json` and report on that plan only
   - A status in $ARGUMENTS: `quadflow plans list --status <status> --json`
     (statuses: `spec_draft`, `spec_review`, `decomposing`, `review_steps`, `promoting`, `executing`, `completed`; comma-separate several)
   - Otherwise: `quadflow plans list --json` (`data` is an array of full plans, steps included)

2. **For each plan**, gather:
   - Title, description, status
   - Linked idea (`ideaId`): `quadflow ideas get <ideaId> --json` for a one-line summary
   - Step counts by status (`pending` / `in_progress` / `completed` / `skipped`) and completion % (completed / non-skipped)
   - Steps promoted to issues (steps with `issueId`)
   - Last update (`updatedAt`, epoch ms)

3. **Write the report**:

### Overall Statistics
- Plans per status
- Overall completion rate
- Plans linked to ideas vs standalone

### Detailed Plan Reports
For each plan:
- Title and status
- Text progress bar, e.g. `[######----] 60%`
- Step checklist (`[x]` completed, `[~]` in progress, `[ ]` pending, `[-]` skipped), epics with their children indented
- Linked idea summary, if any
- Time since last update

### Recommendations
- Plans to focus on next
- Stalled plans (no progress in a while, or blocked promoted issues)
- Plans ready to complete or promote

## Output Format

Markdown with section headers, tables for statistics, checkboxes for steps, and progress indicators.
