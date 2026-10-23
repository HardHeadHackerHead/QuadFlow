---
name: plan-from-idea
description: Create a detailed implementation plan from an existing idea
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
argument-hint: <idea-id or idea text>
---

# Plan From Idea Skill

Create a structured, enriched implementation plan from an existing idea.

## Process

1. **Find the idea**:
   - An id: `quadflow ideas get <id> --json`
   - Text: `quadflow ideas list --text "<text>" --json` and pick the match (ask if several)
   - No argument: `quadflow ideas list --json`, show the ideas and ask the user to choose
   - Check it has no plan yet: `quadflow plans list --idea <id> --json`. If one exists, offer to extend it instead.

2. **Analyze the idea**: content, notes, tags, complexity indicators, prerequisites.

3. **Explore the codebase** with `Glob`, `Read` and `Grep`: structure, tech stack, conventions, existing code to extend, key files for the plan's context.

4. **Design the steps**. Order: research → design → implement → test → verify → document. For each step:
   - **kind**: `research` | `design` | `implement` | `test` | `verify` | `document`
   - **acceptance criteria**: what "done" means
   - **target files**: real paths found while exploring
   - **effort**: `low` | `medium` | `high`
   - **dependencies**: earlier steps it needs
   - **verification**: method (`build`, `test`, `grep_check`, `file_exists`, `manual_review`) and optional command
   - **code context**: functions, types, patterns for the implementer

5. **Create the plan**, linked to the idea:

   ```bash
   quadflow plans create "<title derived from the idea>" --json \
     --idea <idea-id> \
     --description "<what the plan delivers>" \
     --spec-kind feature \
     --decision "<decision>: <rationale>" \
     --risk-notes "<risk — mitigation, one per line>" \
     --context "<key files, patterns, conventions>"
   ```

   Then add the steps in order (the plan id is `data.id`):

   ```bash
   quadflow plans step-add <plan-id> "<step title>" --json \
     --kind implement --effort medium \
     --description "<what to do>" \
     --criterion "<criterion>" \
     --target-files src/a.ts,src/b.ts \
     --code-context "<notes>" \
     --depends-on <step-id> \
     --verify-method test --verify-command "npm test"
   ```

   `step-add` returns the whole plan; the new step is the entry in `data.steps` with the highest `order`. Keep each id for later `--depends-on` values. When all steps are in: `quadflow plans update <plan-id> --status review_steps`.

6. **Tag the idea** (optional): `quadflow ideas add-tag <idea-id> planned`

7. **Report**:
   - Plan id and summary
   - Steps with kind and effort
   - Risks identified
   - Next actions (e.g. `/verify-plan <plan-id>`, then `/plan-to-issues <plan-id>`)

## Guidelines

- Steps are atomic and completable in one session
- Order steps by dependency; test/verify after implementation
- Every implementation step has at least one acceptance criterion
- Target files are actual paths from the codebase
- Prefer programmatically checkable verification
- Be specific in code context
- Risk notes contain both the risk and the mitigation
