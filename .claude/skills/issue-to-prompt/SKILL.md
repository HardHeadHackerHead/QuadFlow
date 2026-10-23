---
name: issue-to-prompt
description: Convert an issue into an implementation prompt and autonomously work it to completion. Takes an issue ID or lets user select one. Works without asking for confirmation and automatically moves to QA when done.
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
user-invocable: true
argument-hint: [issue-ref]
---

# Issue to Prompt Skill

Turn an issue into a detailed implementation prompt, then implement it autonomously and hand it to QA.

## Process

1. **Get the issue**:
   - With a ref in $ARGUMENTS (`WEB-12` or `12`):
     ```bash
     quadflow issues get WEB-12 --json
     ```
   - Without one, list ready work and ask the user to pick:
     ```bash
     quadflow issues list --status todo,in_progress --json
     ```
   - If `blockedBy` lists unfinished issues, tell the user and stop (`quadflow issues blocking WEB-12 --json` shows them).

2. **Claim it and mark it in progress**:
   ```bash
   quadflow issues claim WEB-12 --agent-label "<your agent name>"
   quadflow issues status WEB-12 in_progress
   ```
   A conflict (exit code 4) means another agent holds a fresh claim: stop and report it. During long work, refresh the claim with `quadflow issues heartbeat WEB-12`.

3. **Analyze the issue**: title, body, user story, acceptance criteria, priority, labels, epic/parent (`quadflow issues children WEB-12` for sub-issues), comments.

4. **Search the codebase** with `Grep`, `Glob` and `Read` for related code, patterns and conventions.

5. **Write the implementation prompt** (format below): objective, context, requirements, technical approach, files involved, acceptance criteria, priority context.

6. **Implement immediately** — do not ask for confirmation:
   - Make the changes with `Edit`/`Write`, following existing patterns
   - Build/test where possible (check `quadflow scripts list` for the project's saved commands)
   - Tick each acceptance criterion as it is met:
     ```bash
     quadflow issues criterion WEB-12 <criterionId> --checked true
     ```

7. **Comment progress** as you go, especially on large issues:
   ```bash
   quadflow issues comment WEB-12 --body "Approach: ... Files: ..."
   ```

## Output Format

```
## Implementation Plan for WEB-12

**Title**: [issue title]
**Priority**: [priority] | **Status**: in_progress

### Objective
[Clear, actionable objective]

### Context
[Background from the issue and the codebase]

### Requirements
- [ ] Requirement 1
- [ ] Requirement 2

### Technical Approach
[Implementation strategy]

### Files Involved
- `path/to/file1.ts` - [what to modify]
- `path/to/file2.ts` - [what to create/modify]

### Acceptance Criteria
- [ ] [criteria from the issue]
- [ ] No regressions introduced
- [ ] Code follows existing patterns
```

## After Implementation

1. Add a final comment: what changed, which files, how it was tested, and what a reviewer should verify.
2. Move it to QA and release the claim — do not ask, and do not close it (closing is a human's call after review):
   ```bash
   quadflow issues comment WEB-12 --body "<summary + verification steps>"
   quadflow issues status WEB-12 qa
   quadflow issues release WEB-12
   ```
3. If you cannot finish (missing information, external blocker), comment why, set `blocked` or `needs_human`, and release the claim.

## Notes

- Search the codebase before writing code
- Follow existing style and conventions
- Work autonomously; break large changes into small steps
- Keep the issue updated with progress comments
