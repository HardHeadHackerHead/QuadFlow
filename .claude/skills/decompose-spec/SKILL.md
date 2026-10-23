---
name: decompose-spec
description: Break a plan's spec into high-level epic steps. Creates parent steps representing major work areas.
argument-hint: <plan_id>
allowed-tools: Bash, Read, Glob, Grep
---

# Decompose Spec into Epics

Read a plan's spec and break it into 8-15 high-level parent steps (epics), one per major work area.

## Process

1. Get the plan: `quadflow plans get <plan_id> --json`
2. Read `data.spec.content`. If there is no spec, stop and suggest `/new-spec` or `/brainstorm-spec`.
3. If `data.spec.kind` is `feature` or `refactor`, explore the codebase to understand the existing architecture.
4. Look at `data.steps`: if top-level steps already exist, extend or refine them instead of duplicating.
5. Identify 8-15 major work areas / subsystems / phases.
6. Set the plan to `decomposing` (if it is not already):

   ```bash
   quadflow plans update <plan_id> --status decomposing
   ```

7. Create one top-level step per area, roughly in dependency order:

   ```bash
   quadflow plans step-add <plan_id> "Database Layer" \
     --description "<2-3 sentences on what this area covers>" \
     --kind implement \
     --effort high
   ```

   - `--kind`: `research` | `design` | `implement` | `test` | `verify` | `document`
   - `--effort`: `low` | `medium` | `high`, by scope
   - Do NOT pass `--parent`: these steps are the parents
   - If one area clearly depends on another, pass `--depends-on <step-id>` (the earlier step's id, from `data.steps` in the `--json` output)

8. Report the epics created (title, kind, effort) and suggest `/expand-epic <plan_id> <step_id>` for each.

## Guidelines

- Steps are logical groupings, not sequential tasks
- Each epic should be independently workable by one agent or team
- Think about: infrastructure, data model, API, frontend, auth, testing, deployment, docs
- Foundational work first
- Don't create child steps; that is what `/expand-epic` does
- Concise but descriptive titles
