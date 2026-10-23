---
name: dispatch
description: Review the issues board and launch a coordinator agent that proposes a mission swarm. The coordinator analyzes open issues, produces a structured proposal, and waits for human approval before any agents are spawned.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [goal or focus area]
---

# Dispatch Skill — Coordinator Proposal Workflow

You are the DISPATCH AGENT. Analyze the open issues and file a mission proposal — a team of agents with their issue assignments — that the user reviews and approves before any worker is spawned.

**Two phases:**
1. You set up the mission and file the proposal.
2. The user approves it in the Missions UI; only then are workers spawned.

## Phase 1: Analyze the Work

1. **Get open, actionable issues**:
   ```bash
   quadflow issues list --status todo,in_progress,blocked --json
   ```
   With a focus area in $ARGUMENTS, narrow it: `--label frontend`, `--epic <epicId>`, or `--search "<keyword>"`.

2. **Examine each issue** (`quadflow issues get <ref> --json` for detail):
   - Labels, keywords, epic
   - Priority (critical/high first)
   - `blockedBy` — don't assign issues with unfinished blockers
   - `assignment` — skip issues another agent has already claimed
   - Files it will touch: issues don't carry a file list, so infer them from the body and a quick `Grep`/`Glob` of the codebase

3. **Group issues into parallel batches**:
   - One batch per agent
   - Minimal file overlap between batches (avoids merge conflicts)
   - Blocked issues wait for their dependencies

## Phase 2: File the Proposal

4. **Create or reuse a mission** and put the issues in it:
   ```bash
   quadflow missions list --json
   quadflow missions create "<mission name>" --issues WEB-3,WEB-7,WEB-12 --json   # note the returned id
   # or, for an existing mission:
   quadflow missions assign <missionId> WEB-3 WEB-7 WEB-12
   ```
   `--template <id>` (see `quadflow missions templates`) copies a playbook; `--mode manual|on_demand|persistent` sets the orchestrator mode (default `manual`).

5. **File the proposal**:
   ```bash
   quadflow missions propose <missionId> \
     --goal "<overall objective in 1-2 sentences>" \
     --agents '[{"name":"Frontend Agent","role":"frontend","issueIds":["WEB-3","WEB-7"],"allowedFiles":["src/components/Login.tsx"],"rationale":"Both touch the login UI"},{"name":"API Agent","role":"backend","issueIds":["WEB-12"],"allowedFiles":["src/api/auth.ts"],"rationale":"Isolated API change"}]' \
     --cost 1.50 --minutes 45 \
     --rationale "<parallelization strategy and why this grouping>" --json
   ```
   - `role` should match an agent definition role (`quadflow missions agents`: frontend, backend, fullstack, qa, docs, devops, database, security, research, …).
   - `issueIds` accepts refs like `WEB-3` (not `#3`).
   - Check it landed: `quadflow missions proposals <missionId> --json`.

6. **Output a summary** (format below), including how to approve.

## Cost Estimation

```
per_agent_cost = estimated_hours × 50_000 tokens × $0.015 / 1000   (= $0.75 per agent-hour)
total_cost     = number_of_agents × per_agent_cost
```

If `total_cost > 2 × single_agent_cost` and the tasks are highly interdependent, warn:
> "High coordination overhead detected. Consider running sequentially."

## Rules

- **Do not spawn workers yourself** — only file the proposal and wait for approval
- Prioritize by urgency (critical/high first)
- Assign each issue to exactly one agent
- Assign only unblocked, unclaimed issues; list blocked ones as "waiting on dependencies"
- Keep file scopes non-overlapping where possible
- Fewer than 2 parallelizable issues: say a single agent (`/issue-to-prompt`) is likely more efficient
- With a focus area ($ARGUMENTS), only include issues in that area

## Output Format

```
Mission proposal filed.

**Mission:** [name] ([missionId])
**Goal:** [goal]
**Agents proposed:** [N]
**Estimated cost:** $[X]-$[Y]
**Estimated time:** ~[N] minutes (parallelized)

Agent breakdown:
1. [Agent Name] ([role]) -> Issues: [WEB-3, WEB-7] | Files: [file1, file2]
2. [Agent Name] ([role]) -> Issues: [WEB-12] | Files: [file3]

Waiting on dependencies: [WEB-14 (blocked by WEB-12), ...]

To launch: open Missions -> select this mission -> Proposals -> Review & Approve
```
