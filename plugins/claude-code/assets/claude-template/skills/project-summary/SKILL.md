---
name: project-summary
description: Generate an overview of all projects with status, items, and linked plan progress
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [project-id or status]
---

# Project Summary Skill

Generate a detailed summary of discovery projects (shown as "Projects" in
QuadFlow) and their progress. All data goes through the `quadflow discovery`
CLI via the Bash tool; run `quadflow docs discovery` for the full reference.

## Process

1. **Fetch projects**: `quadflow discovery list --json` (each record includes
   its `items[]` with `kind`, `title`, `status`)
   - If $ARGUMENTS contains a project id, focus on it: `quadflow discovery get <id> --json`
   - If $ARGUMENTS contains a status (`discovery`/`planning`/`in_progress`/`completed`/`archived`),
     filter: `quadflow discovery list --status <status> --json`

2. **For each project**, gather:
   - Title, overview, status
   - Goals and success criteria (`goals`, `successCriteria`)
   - Item counts by kind (research, requirement, question, reference, decision, note)
   - Open vs resolved questions (`status` `answered` = resolved)
   - Must-have vs nice-to-have requirements (`status` `must_have` / `nice_to_have`)
   - Linked plans and ideas: `quadflow discovery linked <id> --json` —
     `data.plans[]` carries `status`, `stepsTotal`, `stepsCompleted` for progress;
     `data.ideas[]` are full idea records

3. **Generate summary report**:

### Overall Statistics
- Total projects by status
- Projects with linked plans vs discovery-only
- Items across all projects

### Per-Project Reports
For each project:
- Status badge and overview
- Goals progress
- Item breakdown with counts
- Linked plan progress bars
- Key open questions
- Time since last update (`updatedAt` is epoch milliseconds)

### Recommendations
- Projects ready to move to planning phase
- Stalled projects needing attention
- Projects with unanswered questions

## Output Format

Use clear markdown formatting with headers, tables, and progress indicators.
