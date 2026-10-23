---
name: verify-plan
description: Verify a plan's spec coverage, dependency completeness, and step quality. Posts findings as verification comments.
argument-hint: <plan_id>
allowed-tools: Bash, Read, Glob, Grep
---

# Verify Plan

Audit a plan for completeness, correctness and quality. Act as a second pair of eyes, independent of whoever created the steps.

## Process

1. Get the plan: `quadflow plans get <plan_id> --json`
2. Read `data.spec.content` and all of `data.steps` (`parentId` gives the epic tree, `dependsOn` the dependencies)
3. Explore the codebase if the plan references existing code (`targetFiles`, `codeContext`)

## Verification Checks

### Spec Coverage
- Every major spec section has corresponding steps
- Spec sections with ZERO coverage (critical)
- Spec sections with weak coverage, e.g. one step for a complex area (warning)

### Orphan Steps
- Steps that don't trace back to any spec requirement

### Dependency Completeness
- Steps touching shared resources are ordered correctly
- Steps that should depend on others but have no `dependsOn`
- Circular dependencies
- `dependsOn` ids that point at missing or skipped steps

### Step Quality
- Implementation steps without `acceptanceCriteria` (warning)
- Steps without a description (warning)
- Vague titles like "Miscellaneous" or "Other" (info)
- Unreasonable `effort` estimates
- Target files that don't exist and aren't meant to be created

### Duplicates
- Steps that cover the same work; suggest merging or clarifying scope

## Output

Post ONE verification comment:

```bash
quadflow plans comment <plan_id> --kind verification --author plan-verifier --body "$(cat <<'EOF'
## Plan verification

### Spec coverage
- **CRITICAL**: ...
### Step quality
- **WARNING**: ...
- **INFO**: ...

**Summary:** 1 critical, 2 warnings, 1 info
EOF
)"
```

- Severity: **CRITICAL** (uncovered spec sections, broken dependencies), **WARNING** (missing criteria, weak coverage), **INFO** (suggestions, suspected duplicates)
- End with the counts
- If everything looks good, post a passing verification comment

Then tell the user the outcome. With no critical findings, the plan is ready for `/preview-promotion` and `/plan-to-issues`.
