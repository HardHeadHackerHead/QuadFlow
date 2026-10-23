# Discovery

Big-picture discovery projects (shown as "Projects" in the app): goals,
success criteria, and items — research, requirements, open questions,
references, decisions, notes. Ideas and plans link to a discovery project
through their own `discoveryId`. Stored in `.quadflow/discovery/<id>.json`.

## Commands

Run `quadflow discovery --help` for the authoritative list. Add `--json` for
`{"ok":true,"data":…}` output.

- `quadflow discovery list [--status <s>] [--text <q>]` — newest first
- `quadflow discovery get <id>` — one project with all items
- `quadflow discovery create "<title>" [--overview "<o>"] [--goal "<g>"]… [--criterion "<c>"]… [--status <s>]`
- `quadflow discovery update <id> [--title …] [--overview …|""] [--goal …]… [--no-goals] [--criterion …]… [--no-criteria] [--status <s>]`
  (`--goal` / `--criterion` replace the whole list)
- `quadflow discovery delete <id>` — also clears `discoveryId` on linked ideas and plans
- `quadflow discovery item-add <id> --kind <kind> --title "<t>" [--content …] [--status …] [--metadata '<json>']`
- `quadflow discovery item-update <id> <item-id> [--kind …] [--title …] [--content …|""] [--status …|""] [--metadata '<json>'|""]`
- `quadflow discovery item-delete <id> <item-id>`
- `quadflow discovery items-reorder <id> <item-id,item-id,…>`
- `quadflow discovery linked <id>` — `{ideas: [Idea…], plans: [{id, title, status, stepsTotal, stepsCompleted}]}`
- Link an idea: `quadflow ideas update <idea-id> --discovery <id>` (`--no-discovery` unlinks);
  `quadflow ideas create "<text>" --discovery <id>`.

Statuses: `discovery`, `planning`, `in_progress`, `completed`, `archived`.
Item kinds: `research`, `requirement`, `question`, `reference`, `decision`, `note`.
Item status is free text; conventions: `pending`, `answered`, `must_have`,
`nice_to_have`. Put URLs in metadata: `--metadata '{"url":"https://…"}'`.

## JSON shape

`{id, title, overview?, goals[], successCriteria[], status, items[{id, kind,
title, content?, status?, metadata?, order, createdAt, updatedAt}], createdAt,
createdBy, updatedAt}` — empty lists and absent optionals are omitted.

## Notes

Discovery is the phase before plans. If you already know what to build, a
Plan is the right abstraction.
