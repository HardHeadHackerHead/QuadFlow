---
name: launch-team
description: Launch a mission (agent team) from a plan. Promotes steps to issues, creates a mission with those issues, and prepares it for multi-agent coordination.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [plan ID or leave blank to select]
---

# Launch Team

Turn a plan into a mission: promote its steps to issues, create a mission linked to the
plan, put the issues in it, and set up members so several agents can work in parallel.

## Process

1. **Select a plan**:
   - If $ARGUMENTS is given, treat it as a plan id:
     ```bash
     quadflow plans get <plan_id> --json
     ```
   - Otherwise list plans and let the user choose:
     ```bash
     quadflow plans list --json
     ```
   Confirm the plan with the user before going on.

2. **Show the plan overview**: title, description, step count; each step's status,
   `dependsOn` and whether it already has an `issueId`. From the dependency graph, work out
   how many independent work streams there are. Warn and stop if the plan has no steps.

3. **Promote steps to issues** (idempotent — already promoted steps return their existing
   issue):
   ```bash
   quadflow plans promote <plan_id> --json
   ```
   Collect the issue refs from the output (or from `quadflow plans get <plan_id> --json`,
   field `steps[].issueId`). Depending on the plan's promotion profile, step dependencies
   become issue `blockedBy` links.

4. **Create the mission** linked to the plan with those issues:
   ```bash
   quadflow missions create "Team: <plan title>" --plan <plan_id> \
     --template builtin-feature-build --issues <ref>,<ref>,... --json
   ```
   (`quadflow missions templates` lists templates; omit `--template` for a blank mission.)
   If issues were added later, `quadflow missions assign <mission> <ref>...` adds them.
   Verify with `quadflow missions get <mission> --json` and report the mission id.

5. **Add members** — one per independent work stream, usually 2–4. Pick agent definitions
   from `quadflow missions agents` by step kind:
   - research steps -> `builtin-researcher`
   - design/document steps -> `builtin-tech-lead` or `builtin-tech-writer`
   - implement steps -> `builtin-frontend-dev`, `builtin-backend-dev` or `builtin-fullstack-dev`
   - test/verify/review steps -> `builtin-qa-eng`
   ```bash
   quadflow missions member-add <mission> builtin-fullstack-dev --name dev1 --json
   ```
   Ask the user before adding members if the team shape is not obvious.

6. **Show readiness**:
   ```bash
   quadflow missions progress <mission> --json
   quadflow issues list --mission <mission> --status todo --json
   ```
   Report how many issues are ready, blocked, in progress and done.

7. **Next steps for the user**:
   - Open the Missions panel to see the mission dashboard and start the members' agents
   - Activate the mission when ready: `quadflow missions update <mission> --status active`
   - As issues close, the issues they were blocking unblock automatically

## Coordination Protocol (for members)

Each member agent, using its own member name:
```bash
quadflow missions heartbeat <mission> <me>                 # every ~2 minutes
quadflow missions claim-next <mission> <me> --json         # take the next unblocked todo issue
quadflow missions inbox <mission> <me> --json              # read new messages
quadflow missions send <mission> "<summary>" --from <me> --kind completion --issue <ref>
quadflow missions send <mission> "<problem>" --from <me> --kind blocker --issue <ref>
quadflow issues status <ref> qa                            # finished work goes to QA
```

## Guidelines

- Always show the plan overview before creating the mission
- Suggest a reasonable team size (2–4 members for most plans)
- `/team-status` shows the mission dashboard afterwards
