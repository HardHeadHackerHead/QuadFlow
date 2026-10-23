# Issues

Tracked work items with status, priority, labels, acceptance criteria, dependencies,
epics and agent claims. Issues are referenced as `CODE-n` (the project code from
`.quadflow/config.json`), `#n`, `n`, or by id.

## Commands

Run `quadflow issues --help` (and `quadflow labels --help`, `quadflow epics --help`)
for the authoritative list.

- `quadflow issues list --json` — open issues (everything except `done`), sorted by priority
- `quadflow issues list --status todo,in_progress --label bug --json` — filter
- `quadflow issues get WEB-12 --json` — one issue, including comments and history
- `quadflow issues create "<title>" --priority high --criterion "<testable condition>" --labels ui`
- `quadflow issues update WEB-12 --body "<markdown>" --blocked-by WEB-3` — `""` clears a field
- `quadflow issues status WEB-12 qa` — move to QA for human review
- `quadflow issues claim WEB-12 --agent-label "<you>"` → `heartbeat` → `release`
- `quadflow issues comment WEB-12 --body "<text>"`
- `quadflow issues criterion WEB-12 <criterionId> --checked true`
- `quadflow issues close WEB-12` — sets `status: done` and unblocks issues it was blocking

Agents should move finished work to `qa`; a human closes it.

## JSON output

`--json` prints one document: `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":"not_found","message":"…"}}`. Exit codes: 0 ok, 2 invalid
argument, 3 not found, 4 conflict (e.g. claimed by someone else), 5 not in a project.
Issue fields are camelCase: `id, number, title, body, status, priority, labels, epicId,
parentId, blockedBy, dependsOn, userStory, acceptanceCriteria, assignment, comments, history`.

## Field rules

Use the dedicated fields — never encode these in the body:
- `--criterion`: specific, testable acceptance criteria (repeatable)
- `--user-story`: "As a [user], I need [capability] so that [benefit]"
- `--blocked-by`: hard dependencies (must be done first)
- `--depends-on`: informational dependencies
