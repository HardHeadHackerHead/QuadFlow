---
name: plan-to-issues
description: Promote plan steps to issues for multi-agent coordination. Each step becomes a trackable issue with full context.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [plan ID or leave blank to select]
---

# Plan to Issues Skill

Promote plan steps into issues so several agents can work on different parts of a plan at once. Each issue carries the step's context, and issue status and step status stay in sync from then on.

## Process

1. **Select a plan**:
   - $ARGUMENTS given: `quadflow plans get <plan-id> --json`
   - Otherwise: `quadflow plans list --json`, show plans that have steps without an `issueId` (and, for epic steps, without an `epicId`), and let the user pick

2. **Show the plan overview**:
   - Title, description, status
   - Steps with status; mark which are already promoted (`issueId` / `epicId` set) and which are not
   - The dependency graph (`dependsOn` step ids)
   - The promotion profile (`promotionProfile`; when absent the defaults apply: parent steps become epics, step dependencies become issue blockers, labels `plan` + step kind, priority from effort). `/preview-promotion` gives the full dry run.

3. **Confirm with the user**, then move the plan to `promoting` and promote every non-skipped step:

   ```bash
   quadflow plans update <plan-id> --status promoting
   quadflow plans promote <plan-id> --json
   ```

   To promote a single step (plus its unpromoted ancestors): `quadflow plans promote <plan-id> --step <step-id> --json`.

   Promotion is idempotent: already-promoted steps return their existing issue and nothing is duplicated. Each issue gets:
   - A body with the plan/step source, description, target files, code context, the plan's architectural decisions and the verification method
   - The step's acceptance criteria as issue criteria
   - Status from the step (`pending` → `todo`, `in_progress` → `in_progress`, `completed` → `done`)
   - `blockedBy` = the issues of unfinished dependency steps
   - The epic of its parent step (or a parent issue when epics are off)

4. **Report**. The `--json` result is `data = {plan, issues, epics, created}`:
   - How many issues and epics were created (`created`)
   - Each issue with its ref and status, grouped by epic
   - Which issues are ready (status `todo`, empty `blockedBy`) and which are blocked; `quadflow issues blocking <ref>` shows what blocks one

5. **Suggest next steps**:
   - The ready issues agents can pick up now
   - Optionally group the work in a mission for coordinated agents:

     ```bash
     quadflow missions create "<plan title>" --plan <plan-id> --issues <ref>,<ref>
     ```

     or `/dispatch` to have a coordinator propose a team
   - As issues are closed, the issues they were blocking become unblocked

## Multi-Agent Workflow

The issue board is the coordination layer:
- An agent finds work with `quadflow issues list --status todo --json` (issues with an empty `blockedBy`), or `quadflow missions claim-next <mission> <member>` inside a mission
- It claims the issue: `quadflow issues claim <ref> --agent-label "<name>"`
- When done it sets `quadflow issues status <ref> qa` for human review (only humans set `done`)
- Closing an issue unblocks its dependents and completes the plan step
- Agents don't need to talk to each other directly

## Guidelines

- Always show what will be promoted before doing it
- Warn if the plan has no steps
- Warn if the plan is still at `spec_draft` / `spec_review` (suggest decomposing and `/verify-plan` first)
- After promotion, verify the issues exist (`quadflow issues get <ref>`)
