---
name: team-status
description: Show the status of active missions (agent teams) including members, progress, recent messages, and available work.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [mission ID or leave blank for all missions]
---

# Team Status

A status dashboard for missions — teams of agents working a shared set of issues.

## Process

1. **Select missions**:
   - If $ARGUMENTS is given, treat it as a mission id:
     ```bash
     quadflow missions get <mission> --json
     ```
   - Otherwise list them, active first, then preparing/paused, then completed/cancelled:
     ```bash
     quadflow missions list --json
     ```

2. **For each active mission, gather**:
   ```bash
   quadflow missions members <mission> --json    # roles, statuses, assigned issue, heartbeat
   quadflow missions progress <mission> --json   # total, byStatus, activeMembers/totalMembers
   quadflow missions unread <mission> human --json
   ```

3. **Recent activity**:
   ```bash
   quadflow missions messages <mission> --limit 10 --json
   quadflow missions activity <mission> --limit 10 --json
   ```
   Show sender, kind and content; highlight `blocker`, `help_request`, `question` and
   `completion` messages.

4. **Available work**: issues in the mission that are `todo`, not blocked (every
   `blockedBy` issue is done) and not claimed by anyone:
   ```bash
   quadflow issues list --mission <mission> --status todo --json
   ```
   Suggest idle members who could pick them up (members take work with
   `quadflow missions claim-next <mission> <member>`). Also note pending team proposals
   (`quadflow missions proposals <mission> --json`) and queued merges
   (`quadflow missions merge-queue <mission> --json`).

5. **Health check**:
   - Members with a stale heartbeat (several minutes old) or an `error`
   - Issues with status `blocked` or `needs_human`
   - Suggest concrete actions: restart stale agents, reassign work
     (`quadflow missions member-update <mission> <member> --issue <ref>`), answer questions
     (`quadflow missions send <mission> "<text>" --to <member>`)

## Output Format

```
Mission: {name} [{status}]
Progress: {done}/{total} issues ({percent}%)
Members: {active}/{total} active · {unread} unread for you

Members:
  tech-lead (tech_lead) - working - PROJ-4
  dev1 (fullstack) - idle
  qa1 (qa) - working - PROJ-5

Recent Activity:
  [completion] dev1: Finished implementing auth module
  [status] qa1: Starting work on PROJ-5
  [blocker] dev1: Need API docs for integration

Available Work: {count} issues ready
  PROJ-6 - Implement search feature (todo)
  PROJ-8 - Add unit tests (todo)
```

## Guidelines

- Present a clear summary, not raw JSON
- Put what needs attention (stale agents, blockers, questions) first
- End with concrete next actions
