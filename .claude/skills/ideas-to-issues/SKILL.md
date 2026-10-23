---
name: ideas-to-issues
description: Convert QuadFlow ideas into QuadFlow issues (or GitHub issues with --github). Maps tags to labels and priority, and can archive the idea after creation.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [idea-id | all | tagged:tag-name] [--archive] [--dry-run] [--github] [--milestone=NAME]
---

# Ideas to Issues Skill

Turn QuadFlow ideas into tracked issues. By default the issues are created in QuadFlow (`quadflow issues`); with `--github` they are created on GitHub with the `gh` CLI.

## Process

1. **Select the ideas** from `$ARGUMENTS`:
   - An idea id: that idea.
   - `all`: every active idea.
   - `tagged:<tag>`: `quadflow ideas list --tag <tag> --json`.
   - Nothing: `quadflow ideas list --json`, then ask the user to pick.

   Skip ideas already tagged `converted-to-issue`.

2. **Read each idea** for its content, tags, notes and creation date:
   ```bash
   quadflow ideas get <id> --json
   ```

3. **Map tags**:
   - `priority-high` / `priority-medium` / `priority-low` -> issue priority (`high` / `medium` / `low`; default `medium`)
   - `bug` -> label `bug`; other category tags -> a label of the same name
   - `complexity-low` -> label `good-first-issue`; `complexity-high` -> label `help-wanted`
   - status tags (`implemented`, `in-progress`, `not-started`) and bookkeeping tags (`brainstormed`, `related-to-*`) are not carried over

4. **Draft the issue**:
   - **Title**: a short imperative summary of the idea (not the full text).
   - **Body**:
     ```markdown
     ## Description
     [Idea content]

     ## Context
     - Source: QuadFlow idea [id], created [date]
     - Tags: [tags]

     ## Notes
     [Relevant notes from the idea, e.g. code references]
     ```
   - **Acceptance criteria**: 1-5 specific, testable conditions derived from the idea.

   With `--dry-run`, print the drafts and stop.

5. **Create the issue**.

   QuadFlow (default). Criteria go in `--criterion`, not the body:
   ```bash
   quadflow labels list --json   # check which labels exist
   quadflow issues create "<title>" --body "<markdown>" --priority high --labels enhancement,ui \
     --criterion "<testable condition>" --criterion "<another>" --json
   ```
   Create a missing label first with `quadflow labels upsert <name>` if the project wants it in its catalog.

   GitHub (`--github`). Run `gh auth status` once before a batch:
   ```bash
   gh issue create --title "<title>" --body "<markdown, with criteria as a - [ ] checklist>" --label "enhancement,ui"
   ```
   Add `--milestone "<NAME>"` when `--milestone=NAME` was given. Labels must already exist on the repository (`gh label list`).

6. **Update the idea** after each successful creation:
   ```bash
   quadflow ideas add-tag <id> converted-to-issue
   quadflow ideas add-note <id> "[ideas-to-issues] Converted to issue <CODE-n or GitHub URL>."
   quadflow ideas archive <id>   # only with --archive
   ```

7. **Report**:

```
## Ideas to Issues Conversion Report

### Created
| Idea | Issue | Title | Priority | Labels |
|------|-------|-------|----------|--------|

### Skipped
| Idea | Reason |
|------|--------|
|      | Already tagged converted-to-issue |

### Summary
- Ideas processed: X
- Issues created: X
- Ideas archived: X
```

## Options

- `--archive` / `-a`: archive each idea after converting it
- `--dry-run` / `-d`: show what would be created, change nothing
- `--github`: create GitHub issues with `gh` instead of QuadFlow issues
- `--milestone=NAME`: GitHub milestone (with `--github` only)

## Notes

- Show the drafts and let the user edit them before a bulk conversion.
- For `--github`, the repository needs a GitHub remote and an authenticated `gh`; pace large batches to stay under rate limits.
