---
name: architect
description: Auto-decompose a project or feature into epics, issues, sub-issues, and a comprehensive plan with dependencies
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
argument-hint: <project/feature description>
---

# Project Architect Skill

Decompose a project or feature into a complete work breakdown: a master plan with phased steps, epics, actionable issues linked to those epics, and the dependencies between them — everything needed for multi-agent execution.

## Process

1. **Parse the request**:
   - $ARGUMENTS describes what to build (e.g. "a SaaS platform for managing pet grooming appointments").
   - If empty, ask the user what to architect.
   - If a matching discovery project exists (`quadflow discovery list --json`), read it (`quadflow discovery get <id> --json`) for goals, requirements and open questions.

2. **Research** (existing codebase):
   - `Glob`/`Read` to learn the project structure
   - `Grep` for existing patterns, frameworks and conventions
   - Identify the tech stack and architecture already in use
   - Check existing work so you don't duplicate it:
     ```bash
     quadflow epics list --json
     quadflow issues list --json
     quadflow plans list --json
     ```

3. **System decomposition** — think through every subsystem the project needs, not only the business features the user mentioned. For a typical web app:
   - **Core infrastructure**: project setup, CI/CD, deployment, environments
   - **Auth**: login, signup, roles, permissions, OAuth
   - **Data layer**: schema, migrations, ORM, seed data
   - **API layer**: endpoints, middleware, validation, error handling
   - **Frontend**: layout, routing, state management, components
   - **Business logic**: the domain features described
   - **Integrations**: email, payments, file storage, third-party APIs
   - **Observability**: logging, monitoring, error tracking, analytics
   - **Security**: input sanitization, CSRF, rate limiting, secrets
   - **Testing**: unit, integration, E2E
   - **Documentation**: API docs, user guides, onboarding

4. **Labels** — check the catalog and add what's missing:
   ```bash
   quadflow labels list --json
   quadflow labels upsert epic --color "#6366f1"
   quadflow labels upsert infrastructure --color "#6b7280"
   quadflow labels upsert frontend --color "#3b82f6"
   quadflow labels upsert backend --color "#22c55e"
   quadflow labels upsert auth --color "#8b5cf6"
   quadflow labels upsert database --color "#f97316"
   quadflow labels upsert testing --color "#eab308"
   quadflow labels upsert devops --color "#ef4444"
   ```

5. **Master plan** — scope, goals, architecture and key decisions, with one step per phase:
   ```bash
   quadflow plans create "Build Pet Grooming SaaS Platform" \
     --description "<scope, goals, architecture>" \
     --spec-kind greenfield \
     --decision "Postgres + Prisma: relational data, team familiarity" \
     --risk-notes "<main risks>" --json
   quadflow plans step-add <planId> "Phase 1: Infrastructure" --kind implement --effort medium \
     --description "<what this phase delivers>" --json
   quadflow plans step-add <planId> "Phase 2: Data layer" --kind implement --depends-on <phase1StepId> --json
   ```
   Use `--spec-kind feature` when adding to an existing product. Pass `--discovery <id>` if the plan comes from a discovery project. `step-add` returns the whole plan; take the new step's id from its `steps` for later `--depends-on`.

6. **Epics** — one per major subsystem. Save each returned `id`:
   ```bash
   quadflow epics create "Authentication System" \
     --description "<what this epic covers>" --priority critical --labels "epic,auth" --json
   ```
   Priority follows dependency order: infrastructure = critical, nice-to-haves = low.

7. **Issues under each epic** — 3-8 actionable issues per epic, each completable in one agent session. **Always pass `--epic <epicId>`**; an issue without it is orphaned.
   ```bash
   quadflow issues create "Implement JWT token refresh endpoint" \
     --epic <epicId> --priority high --status todo --labels "backend,auth" \
     --body "<context, relevant file paths>" \
     --user-story "As a user, I need my session to stay valid so that I am not logged out mid-task" \
     --criterion "POST /auth/refresh returns a new access token for a valid refresh token" \
     --criterion "Expired or revoked refresh tokens return 401" --json
   ```
   - Use `--parent <ref>` for sub-issues of a larger issue.
   - Status: `todo` if it can start now, `backlog` if it will be blocked.
   - Forgot `--epic`? Fix it right away: `quadflow issues update WEB-12 --epic <epicId>`.

8. **Wire up dependencies** once all issues exist (blockers must already exist to be referenced):
   - Infrastructure blocks everything
   - Database schema blocks API endpoints
   - API endpoints block frontend integration
   - Core features block advanced features
   - Testing/docs come after what they cover

   ```bash
   quadflow issues update WEB-14 --blocked-by WEB-3,WEB-7 --status backlog
   ```
   `--blocked-by` replaces the list, so pass every blocker at once. Closing a blocker unblocks its dependents automatically.

9. **Report the architecture**:
   - Total epics and issues created (with refs)
   - Dependency graph (what blocks what)
   - Recommended execution order
   - Estimated total scope
   - Issues ready to start now (no blockers)
   - Next step: `/dispatch` to propose a mission team, or `/issue-to-prompt <ref>` to start one issue

## Guidelines

- **Be thorough**: users underestimate scope. Include auth, error handling, testing, deployment.
- **Be practical**: each issue is achievable by one agent in one session.
- **Dependencies matter**: blocked issues go to `backlog`, ready ones to `todo`.
- **Titles**: epics use broad names ("Authentication System"); issues use verb phrases ("Implement JWT token refresh endpoint").
- **Use the dedicated fields**: acceptance criteria in `--criterion`, user story in `--user-story`, blockers in `--blocked-by` — never only in the body.
- **Priority mapping**: critical = must-have infrastructure, high = core features, medium = supporting features, low = polish.
- **Don't over-subdivide**: 3-8 issues per epic; split the epic if you need more.
- **Label everything**: every issue gets at least one category label.
- **Always link issues to epics** with `--epic`.
