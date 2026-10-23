---
name: organize-projects
description: Review projects, update statuses, identify stalled projects, and suggest next actions
allowed-tools: Bash, Read
user-invocable: true
argument-hint:
---

# Organize Projects Skill

Review and organize all discovery projects (shown as "Projects" in QuadFlow) -
update statuses, identify issues, and suggest next actions. All data goes
through the `quadflow discovery` CLI via the Bash tool; run
`quadflow docs discovery` for the full reference.

## Process

1. **Fetch all projects**: `quadflow discovery list --json` (each record includes its items).
   For each project, fetch links: `quadflow discovery linked <id> --json`
   (`data.ideas`, `data.plans` with `status`, `stepsTotal`, `stepsCompleted`).

2. **Analyze each project**:
   - Check if status matches actual progress:
     - Has linked plans? Maybe should be `planning` or `in_progress`
     - All questions answered + requirements defined? Ready for planning
     - All linked plans completed? Project may be `completed`
     - No activity (`updatedAt`, epoch ms) in 2+ weeks? Flag as potentially stalled
   - Check item completeness:
     - Unanswered questions (`kind: question`, `status` not `answered`) blocking progress
     - Research items still `pending`
     - Missing requirements (`kind: requirement`) or decisions (`kind: decision`)

3. **Suggest status updates** - present changes and ask before applying:
   - Projects that should advance (`discovery` -> `planning` -> `in_progress`)
   - Projects that appear stalled
   - Projects ready for completion or archival

4. **Apply approved changes**: `quadflow discovery update <id> --status <status> --json`
   (statuses: `discovery`, `planning`, `in_progress`, `completed`, `archived`).
   Mark answered questions with `quadflow discovery item-update <id> <item-id> --status answered`.
   Link orphaned ideas/plans that clearly belong to a project with
   `quadflow ideas update <idea-id> --discovery <id>` /
   `quadflow plans update <plan-id> --discovery <id>`.

5. **Generate organization report**:

### Status Changes Made
- List of projects with old -> new status

### Attention Needed
- Projects with unresolved blockers
- Projects missing key sections (no requirements, no research)
- Stalled projects with no recent updates

### Next Actions
- Per-project recommended next steps
- Projects ready for plan creation
- Projects that need more discovery work

## Output Format

Present findings clearly with actionable recommendations. Always confirm status changes before applying them.
