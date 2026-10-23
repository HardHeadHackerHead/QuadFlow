# Missions

Multi-agent coordination: a mission is a team of agents (members) working a
shared set of issues. Members have roles (scrum_master, tech_lead, frontend,
qa, …), an assigned issue, a branch/worktree, and a heartbeat. Missions are
machine-local (`.quadflow/local/missions/<id>/`); custom templates are shared
(`.quadflow/mission-templates/`). Built-in templates and agent definitions
(`builtin-*` ids) are always available.

Run `quadflow missions --help` for the authoritative list. Add `--json` for the
`{"ok":…,"data":…}` envelope. Members are referenced by id or unique name;
issues by id, `CODE-n` or `n` (not `#n` — the shell treats `#` as a comment).

## Missions

- `quadflow missions list [--status active]` / `get <mission>`
- `quadflow missions create "<name>" [--template builtin-feature-build] [--mode manual|on_demand|persistent] [--issues 3,4]`
- `quadflow missions update <mission> [--status active|paused|completed|cancelled] [--mode …] [--orchestrator <member>]`
- `quadflow missions progress <mission>` — issue counts by status (computed from issues)
- `quadflow missions issues <mission>` / `assign <mission> <ref>…`
- `quadflow missions delete <mission>`

## Members (what an agent runs)

- `quadflow missions members <mission>`
- `quadflow missions member-add <mission> <agent-definition> [--name] [--model]`
- `quadflow missions heartbeat <mission> <me>` — every ~2 minutes
- `quadflow missions claim-next <mission> <me>` — atomically take the highest-priority
  unblocked, unclaimed `todo` issue (prints `null` when none)
- `quadflow missions inbox <mission> <me>` — unread messages (marks them read)
- `quadflow missions send <mission> "<text>" --from <me> [--to <member>] [--kind blocker|completion|question|…] [--issue <ref>]`
- `quadflow missions log <mission> "<decision>" --member <me>`

Closing an issue (`quadflow issues close <ref>`) logs it to the mission and
queues the member's branch in the merge queue.

## Coordinator

- `quadflow missions propose <mission> --goal "<g>" --agents '[{"name","role","issueIds":["3"],"allowedFiles":[…]}]'`
- `quadflow missions proposals <mission>` — pending / approved / rejected (the human approves in the UI)
- `quadflow missions merge-queue <mission>` / `merge-next <mission>` / `merge-update <mission> <entry> --status merged|failed|skipped`
- `quadflow missions activity <mission> [--limit 20]`

## Templates and agent definitions

- `quadflow missions templates` / `template <id>` / `template-upsert '<json>'` / `template-delete <id>`
- `quadflow missions agents` / `agent-upsert --name … --role … [--provider] [--model]` / `agent-delete <id>`
