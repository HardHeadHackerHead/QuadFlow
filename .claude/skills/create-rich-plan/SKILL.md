---
name: create-rich-plan
description: Generate and save a comprehensive, enriched implementation plan with architectural decisions, risk analysis, and detailed steps
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
argument-hint: <feature description, idea ID, or issue ref>
---

# Create Rich Plan Skill

Generate and save an implementation plan with full enrichment: architectural decisions, risk notes, codebase context, and typed steps with acceptance criteria, target files, effort, dependencies and verification.

## Process

1. **Parse arguments**:
   - An issue ref (`CODE-12`, `#12`, `12`): fetch it with `quadflow issues get <ref> --json`
   - An id: try `quadflow ideas get <id> --json`; if not found, try it as an issue ref
   - Free text: treat it as the feature description
   - No argument: ask the user what they want to plan

2. **Gather context**:
   - Read the idea's content/notes or the issue's body, user story and acceptance criteria
   - Explore the codebase with `Glob`, `Read` and `Grep`: structure, tech stack, conventions, existing implementations to extend
   - Check for an existing plan first: `quadflow plans list --search "<keywords>" --json` (and `--idea <id>` when planning an idea)

3. **Architectural decisions**: for each significant design choice, a decision and its rationale (e.g. "Use SQLite for storage: embedded DB avoids external dependencies").

4. **Risks and mitigations**: data migration, breaking changes, performance, external dependencies. Each risk with its mitigation.

5. **Codebase context**: key files and their roles, patterns to follow, constraints.

6. **Design the steps**. For each step:
   - **title**: clear, actionable
   - **description**: what to do
   - **kind**: `research` | `design` | `implement` | `test` | `verify` | `document`
   - **acceptance criteria**: what "done" means
   - **target files**: real paths found while exploring
   - **effort**: `low` | `medium` | `high` (optionally estimated hours)
   - **dependencies**: earlier steps this one needs
   - **verification**: a method (`build`, `test`, `grep_check`, `file_exists`, `manual_review`) and optionally a command
   - **code context**: function names, types, snippets the implementer needs

   Order: research → design → implement (by dependency) → test → verify → document.

7. **Save the plan**. Create it, then add the steps in order:

   ```bash
   quadflow plans create "<title>" --json \
     --description "<summary>" \
     --idea <idea-id> \
     --spec-kind feature \
     --decision "Use SQLite for storage: embedded DB avoids external dependencies" \
     --decision "<decision>: <rationale>" \
     --risk-notes "<risk — mitigation, one per line>" \
     --context "<key files, patterns, conventions>"
   ```

   Omit `--idea` when the plan does not come from an idea; when it comes from an issue, mention the issue ref in the description. The new plan's id is `data.id`.

   ```bash
   quadflow plans step-add <plan-id> "<step title>" --json \
     --kind implement \
     --effort medium \
     --description "<what to do>" \
     --criterion "<criterion 1>" --criterion "<criterion 2>" \
     --target-files src/a.ts,src/b.ts \
     --code-context "<relevant code notes>" \
     --depends-on <step-id>,<step-id> \
     --verify-method test \
     --verify-command "npm test"
   ```

   `step-add` returns the whole plan; the new step is the entry in `data.steps` with the highest `order`. Record each step's id so later steps can pass it to `--depends-on` (dependencies are step ids, not step numbers).

   Once the steps are in, move the plan to step review: `quadflow plans update <plan-id> --status review_steps`.

8. **Report**:
   - The plan id and summary
   - Steps with kind and effort
   - Risks identified
   - Which step to start with, and that `/plan-to-issues` turns the steps into issues

## Guidelines

- Keep steps atomic and completable in one session
- Every implementation step has at least one acceptance criterion
- Target files are actual paths from the codebase
- Prefer verification that can be checked programmatically
- Be specific in code context: function names, types, patterns to follow
- Risk notes contain both the risk and the mitigation
- Pass multi-line values (context, risk notes) as one quoted argument, e.g. with a quoted heredoc:

  ```bash
  quadflow plans update <plan-id> --context "$(cat <<'EOF'
  - src/store.ts: central state, follow its action pattern
  - src/api.ts: all backend calls go through here
  EOF
  )"
  ```
