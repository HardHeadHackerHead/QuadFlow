---
name: expand-epic
description: Expand a parent step (epic) into detailed child steps with full enrichment data.
argument-hint: <plan_id> <step_id>
allowed-tools: Bash, Read, Glob, Grep
---

# Expand Epic into Child Steps

Take a parent step and create 5-20 detailed child steps under it, with full enrichment.

## Process

1. Parse arguments: plan id (first), step id (second). If the step id is missing, list the plan's top-level steps and ask which to expand.
2. Get the plan: `quadflow plans get <plan_id> --json`
3. Find the epic in `data.steps` by `id`. Note any existing children (steps whose `parentId` is the epic) so you don't duplicate them.
4. Read `data.spec.content` for context.
5. If `data.spec.kind` is `feature` or `refactor`, explore the relevant parts of the codebase.
6. Create the child steps in order:

   ```bash
   quadflow plans step-add <plan_id> "<specific task title>" --json \
     --parent <epic_step_id> \
     --kind implement \
     --effort medium \
     --description "<what to implement>" \
     --criterion "<concrete condition>" --criterion "<another>" \
     --target-files src/a.ts,src/b.ts \
     --code-context "<existing code, patterns, snippets>" \
     --depends-on <sibling-step-id> \
     --verify-method build \
     --verify-command "npm run build"
   ```

   - `--parent` is REQUIRED: without it the step becomes a new top-level epic
   - `--depends-on` takes step ids. `step-add` returns the whole plan; the step just created is the entry in `data.steps` with the highest `order`, so record each id as you go and use it for later siblings
   - `--verify-method`: `build`, `test`, `grep_check`, `file_exists` or `manual_review`; `--verify-command` when there is something to run

7. Report the children created under the epic (title, kind, effort, dependencies).

## Guidelines

- Each child is one focused task (1-4 hours of work)
- Every implementation step has acceptance criteria
- Use real file paths from the codebase
- Set dependencies wherever order matters
- Include at least one test step and one verify step per epic
