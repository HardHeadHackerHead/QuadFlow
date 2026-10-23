# Plans

Implementation plans with a spec, architectural decisions, risk notes and
ordered steps (steps can have a parent step — an "epic" step — and depend on
other steps). Steps are promoted to issues for multi-agent work; issue status
and step status stay in sync automatically.

## Commands

Run `quadflow plans --help` (or `quadflow plans <verb> --help`) for every flag.
Add `--json` to any command for one `{"ok":true,"data":…}` document.

- `quadflow plans list [--status executing] [--idea <id>] [--search text]` — newest first
- `quadflow plans get <plan_id>` — full plan with steps and comments
- `quadflow plans create "<title>" [--description …] [--idea <id>] [--spec-content …] [--spec-type feature] [--decision "JWT: stateless"]`
- `quadflow plans update <plan_id> [--status review_steps] [--description ""]` — `""` (or `none`) clears a field
- `quadflow plans step-add <plan_id> "<title>" [--kind implement] [--effort high] [--parent <step_id>] [--depends-on <step_id,…>] [--criterion "…"] [--target-files a.rs,b.rs]`
- `quadflow plans step-update <step_id> [--status in_progress|completed|skipped] [--notes …]` — the plan is found from the step id (`--plan` optional)
- `quadflow plans step-delete <step_id>` · `quadflow plans steps-reorder <plan_id> <step_id,…>`
- `quadflow plans comment <plan_id> --body "…" [--kind review|verification]` · `comments <plan_id>` · `comment-delete <plan_id> <comment_id>`
- `quadflow plans promote <plan_id> [--step <step_id>]` — promote every non-skipped step (or one) to issues

## Promotion

Promotion is idempotent: a step that already has an issue returns it, so
running `promote` again creates nothing. Issues get `source = {planId, stepId}`
and the plan's promotion profile decides labels, priority and structure:
with `createEpics`, parent steps become epics and their children's issues join
the epic; with `createBlockers`, step `dependsOn` becomes issue `blockedBy`.

## Status sync

Moving a promoted issue moves its step in the same transaction (`done` →
`completed`, `in_progress`/`qa` → `in_progress`, anything else → `pending`), and
updating a step's status moves its issue. Plan status:
`spec_draft` → `spec_review` → `decomposing` → `review_steps` → `promoting`
→ `executing` → `completed`. The plan becomes `executing` when a step starts
during `review_steps`/`promoting`, and `completed` when every non-skipped step
is completed.

## JSON shape

camelCase: `{id, title, description?, status, ideaId?, discoveryId?, spec?{content, kind},
decisions[{decision, rationale}], riskNotes?, context?, promotionProfile?,
steps[{id, order, parentId?, title, status, kind?, effort?, acceptanceCriteria[],
targetFiles[], dependsOn[], verification?, issueId?, epicId?, …}],
comments[{id, body, kind, createdBy, createdAt}], createdAt, updatedAt}`.
