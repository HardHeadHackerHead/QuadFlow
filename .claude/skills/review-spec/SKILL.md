---
name: review-spec
description: Review a plan's spec document against the actual codebase. Posts structured feedback as plan comments.
argument-hint: <plan_id> [--focus=general|architecture|security|scope]
allowed-tools: Bash, Read, Glob, Grep
---

# Review Spec

Review a plan's spec with codebase awareness: read the actual code and flag conflicts, missing considerations and existing patterns.

## Process

1. Parse arguments: plan id (required) and optional `--focus=`
2. Get the plan: `quadflow plans get <plan_id> --json`
3. Read `data.spec.content`. If there is no spec, stop and suggest `/new-spec` or `/brainstorm-spec`. Glance at earlier review comments (`data.comments` with `kind: "review"`) so you don't repeat them.
4. Explore the codebase (`Glob`, `Grep`, `Read` key files)
5. Review according to the focus:

### Focus Areas

**general** (default): everything below
**architecture**: design decisions, patterns, scalability, tech stack choices
**security**: authentication, authorization, data handling, input validation, OWASP concerns
**scope**: feasibility, missing requirements, scope creep, ambiguity, timeline risks

### Review Checklist

- **Completeness**: missing sections or unaddressed requirements?
- **Codebase conflicts**: does it clash with the existing architecture?
- **Existing patterns**: does it follow or deviate from established patterns?
- **Ambiguity**: vague requirements that need clarification?
- **Edge cases**: errors, empty states, boundaries covered?
- **Dependencies**: external dependencies and integrations accounted for?
- **Testing**: is there a testing strategy?
- **Migration**: for features/refactors, is there a migration path?

6. Post the findings as ONE review comment:

   ```bash
   quadflow plans comment <plan_id> --kind review --author spec-reviewer --body "$(cat <<'EOF'
   ## Spec review (focus: general)

   ### Architecture
   - **Critical**: ...
   - **Warning**: ...
   - **Info**: ...

   **Summary:** 1 critical, 2 warnings, 3 info
   EOF
   )"
   ```

   - Severity: **Critical** (must be addressed before decomposition), **Warning** (should be considered, not blocking), **Info** (suggestions)
   - Group findings by category
   - Reference file paths and line numbers where relevant

7. Tell the user the result. If there are no critical findings, suggest `/decompose-spec <plan_id>` next.

## Guidelines

- Always explore the codebase before reviewing
- Be specific: "src/auth/middleware.ts already validates JWTs at line 45", not "auth exists"
- One comprehensive comment, not many small ones
- End with the counts of critical/warning/info findings
- If nothing is wrong, still post a comment confirming the spec looks good
