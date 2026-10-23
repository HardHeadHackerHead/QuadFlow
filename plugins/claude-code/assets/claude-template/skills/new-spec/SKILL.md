---
name: new-spec
description: Generate a spec document for a plan using AI with codebase context. Secondary to pasting specs from external tools.
argument-hint: <plan_id>
allowed-tools: Bash, Read, Glob, Grep
---

# Generate Spec

Generate a specification document for a plan, informed by the codebase.

## Process

1. Get the plan (first argument): `quadflow plans get <plan_id> --json`. Use its `title`, `description`, `context` and, if `ideaId` is set, the idea (`quadflow ideas get <ideaId> --json`) as the brief.
2. If `data.spec.content` already exists, ask before replacing it.
3. Decide the kind from `data.spec.kind` (default `feature` when there is no spec):
   - **greenfield**: full project spec: architecture, tech stack, features, data model, API design, deployment
   - **feature**: explore the codebase first (`Glob`, `Grep`, `Read`) and write a spec that fits the existing system
   - **refactor**: explore the current implementation and write current state → target state, with why
4. Write the markdown spec with these sections (skip ones that don't apply):
   - Overview / Goals
   - Requirements (functional and non-functional)
   - Architecture / Design
   - Data Model
   - API Design
   - UI/UX
   - Security Considerations
   - Testing Strategy
   - Migration Plan (refactors)
   - Open Questions
5. Save it and move the plan to `spec_review` in one call:

   ```bash
   quadflow plans update <plan_id> --spec-kind feature --status spec_review --spec-content "$(cat <<'EOF'
   # <Title>

   ## Overview
   ...
   EOF
   )"
   ```

6. Tell the user the spec is saved and suggest `/review-spec <plan_id>` next.

## Guidelines

- For feature/refactor specs, always explore the codebase before writing
- Be specific: real file paths, function names, patterns
- Detailed enough for another agent to decompose into steps (`/decompose-spec`)
- Use headers, lists and code blocks
- List open questions and decisions still to be made
