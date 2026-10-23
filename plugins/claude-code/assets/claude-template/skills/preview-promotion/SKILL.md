---
name: preview-promotion
description: Preview what issues would be created from plan steps without actually creating them. Dry-run report.
argument-hint: <plan_id>
allowed-tools: Bash, Read
---

# Preview Promotion

Show what `quadflow plans promote` would create for a plan, without creating anything.

## Process

1. Get the plan: `quadflow plans get <plan_id> --json`
2. Read `data.promotionProfile`. When it is absent, the defaults apply:
   `createEpics: true`, `labelStrategy: "auto"`, `createBlockers: true`, `defaultPriority: "medium"`, `priorityStrategy: "auto"`, `includeAcceptanceCriteria: true`, `includeVerification: true`.
3. Compute what promotion would do with these rules:
   - Every non-skipped step is promoted, in plan order
   - Steps that already have an `issueId` (or `epicId`) are reused, not created again
   - With `createEpics`, a step that has children (other steps whose `parentId` is it) becomes an epic, and its descendants' issues join that epic. Without it, parent steps become parent issues
   - Issue status follows the step: `pending`/`skipped` → `todo`, `in_progress` → `in_progress`, `completed` → `done`
   - With `createBlockers`, each step's `dependsOn` becomes the issue's `blockedBy` (only dependencies whose issue is not done)
   - Labels: `auto` → `plan` plus the step's `kind`; `custom` → `customLabels`; `none` → no labels. `labelPrefix` is prepended to each
   - Priority: `auto` → from step effort (high/medium/low), falling back to `defaultPriority` when effort is unset; `uniform` → `defaultPriority`
   - `includeAcceptanceCriteria` copies step criteria into the issue; `includeVerification` adds the verification method/command to the body

## Report Contents

**Epics** (if `createEpics`):
- Each parent step that would become an epic, with how many issues it would contain

**Issues**:
- Number of new issues vs. already-promoted steps reused
- Breakdown by step kind (implement, test, design, …)
- Which would start blocked (unfinished dependencies)

**Labels** (unless `labelStrategy` is `none`):
- The labels that would be applied (and created if missing; compare with `quadflow labels list --json`)

**Blockers** (if `createBlockers`):
- Number of blocking relationships
- Any circular dependencies or `dependsOn` ids that point at missing or skipped steps

**Priority distribution**:
- Count per priority

Output the report as plain text.

## Guidelines

- This is a DRY RUN: do not run `quadflow plans promote` or create issues, epics or labels
- Be specific about counts and names
- Flag problems: circular dependencies, steps with no description or criteria, empty epics
- End by pointing to `/plan-to-issues <plan_id>` to do the real promotion
