---
name: idea-to-prompt
description: Convert an idea into a detailed implementation prompt and begin working on it. Takes an idea ID or lets user select one.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
user-invocable: true
argument-hint: [idea-id]
---

# Idea to Prompt Skill

Turn a QuadFlow idea into a detailed implementation prompt, then implement it.

## Process

1. **Get the idea**:
   ```bash
   quadflow ideas get <id> --json   # when $ARGUMENTS is an idea id
   quadflow ideas list --json       # otherwise: show the list and ask the user to pick
   ```
   Read its notes too; earlier skills (`find-related-code`, `estimate-complexity`) may have left code references there.

2. **Analyze it**: the core requirement, technical components, dependencies and prerequisites, and any ambiguity that needs the user's answer.

3. **Explore the codebase** with `Grep`, `Glob` and `Read` to find the files involved and the patterns to follow.

4. **Write the implementation prompt** (format below) and present it to the user for confirmation.

5. **Implement once confirmed**: make the changes with `Edit` / `Write`, following existing conventions, and run the project's tests or build where possible (`/run-script` lists saved scripts).

6. **Update the idea**:
   ```bash
   quadflow ideas add-tag <id> in-progress
   quadflow ideas add-note <id> "[idea-to-prompt] Implementation started.

   Files modified:
   - src/lib/database.ts
   - src/types/index.ts

   Progress: basic structure in place.
   Next: add UI components."
   ```
   When the work is complete, swap the tag: `quadflow ideas remove-tag <id> in-progress` then `quadflow ideas add-tag <id> implemented`.

## Output format

```
## Implementation Prompt for Idea [id]

### Objective
[Clear, actionable objective]

### Context
[Background and motivation]

### Requirements
- [ ] Requirement 1
- [ ] Requirement 2

### Technical Approach
[Implementation strategy]

### Files Involved
- `path/to/file1` - [what changes]
- `path/to/file2` - [what changes]

### Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

### Potential Challenges
[Risks and complexities]

### Estimated Complexity
[Low/Medium/High] - [reasoning]
```

## Notes vs suggestions

- **Notes** (`quadflow ideas add-note`): progress, files changed, blockers.
- **Suggestions** (`quadflow ideas add-suggestion`): only for rewording the idea text itself.

## Guidance

- Search the codebase before proposing an approach.
- Ask for clarification when the idea is ambiguous.
- Break large work into smaller steps. If it is too big for one session, offer to track it as an issue (`quadflow issues create "<title>" --body "<markdown>" --criterion "<testable condition>"`) or a plan instead.
