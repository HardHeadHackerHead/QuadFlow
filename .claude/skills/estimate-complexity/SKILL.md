---
name: estimate-complexity
description: Review each idea and estimate implementation complexity (low/medium/high), considering dependencies, scope, and technical difficulty.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [untagged|low|medium|high|tag|idea-id]
---

# Estimate Complexity Skill

Estimate the implementation complexity of QuadFlow ideas and record it as a tag plus a note.

## Process

1. **Select the ideas** (see Filter options):
   ```bash
   quadflow ideas list --json
   quadflow ideas list --tag complexity-high --json   # re-evaluate one level
   quadflow ideas get <id> --json                     # a single idea
   ```

2. **Evaluate each idea**:
   - **Scope**: how many components; one change or system-wide; UI, backend, or both.
   - **Technical difficulty**: new technologies or patterns, complex algorithms, performance-critical code, security or data-integrity concerns.
   - **Dependencies**: external libraries or APIs, features that must exist first, breaking changes.
   - **Codebase impact**: search with `Grep` and `Glob`; how many files change; existing code to build on.

3. **Assign a level**:
   - **Low**: 1-2 hours, one file, clear path.
   - **Medium**: 2-8 hours, several files, some unknowns.
   - **High**: 1+ days, architectural change, many unknowns.

4. **Tag it**, replacing any previous estimate so an idea carries only one:
   ```bash
   quadflow ideas remove-tag <id> complexity-medium
   quadflow ideas add-tag <id> complexity-low   # or complexity-medium / complexity-high
   ```

5. **Add a note** with the reasoning, prefixed `[estimate-complexity]`: reasoning, risks, prerequisites, suggested approach.
   ```bash
   quadflow ideas add-note <id> "[estimate-complexity] Complexity: MEDIUM

   Reasoning:
   - Changes 3-4 files
   - Builds on the existing pattern in src/lib/database.ts

   Risks:
   - May need a schema migration

   Suggested approach:
   1. Add type definitions
   2. Implement the data layer
   3. Wire up the UI"
   ```

6. **Report**:

```
## Complexity Estimation Report

### Summary
- Ideas analyzed: X
- Low: X (about Y hours total)
- Medium: X (about Y hours total)
- High: X (about Y hours total)

### Quick Wins (Low)
| ID | Idea | Est. Time | Notes |
|----|------|-----------|-------|

### Medium Effort
| ID | Idea | Est. Time | Dependencies | Notes |
|----|------|-----------|--------------|-------|

### Major Projects (High)
| ID | Idea | Est. Time | Dependencies | Risk Factors |
|----|------|-----------|--------------|--------------|

### Recommendations
- Start with: [quick wins]
- Do first (others depend on them): [ideas]
- Needs clarification: [ambiguous ideas]
```

## Filter options (`$ARGUMENTS`)

- `untagged` — only ideas with no `complexity-*` tag (filter the `list --json` output on `tags`)
- `low` / `medium` / `high` — re-evaluate ideas tagged `complexity-<level>`
- a tag name — only ideas with that tag (`--tag <name>`)
- an idea id — estimate that one idea in detail

## Notes vs suggestions

- **Notes** (`quadflow ideas add-note`): complexity analysis, reasoning, risks, approach.
- **Suggestions** (`quadflow ideas add-suggestion`): only for rewording the idea text itself.

## Guidance

- Be conservative; add buffer for unknowns.
- Flag ideas that need more information before they can be estimated.
- Point out ideas that should be split into smaller pieces.
