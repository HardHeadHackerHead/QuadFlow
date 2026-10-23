# Ideas

Capture, tag, and triage lightweight thoughts before they become issues or plans.

## Commands

Run `quadflow ideas --help` (or `quadflow ideas <cmd> --help`) for the authoritative reference.

- `quadflow ideas list [--text <q>] [--tag <t>]... [--include-archived] [--from <ms>] [--to <ms>]` — newest first (`search` is an alias)
- `quadflow ideas get <id>`
- `quadflow ideas create "<text>" [--tag <t>]...`
- `quadflow ideas update <id> [--content "<text>"] [--tags a,b] [--archived true|false]`
- `quadflow ideas delete <id>`
- `quadflow ideas add-tag <id> <tag>` / `remove-tag <id> <tag>` (aliases `tag` / `untag`); tags are lowercased
- `quadflow ideas bulk-tag <id,id,…> <tag>`
- `quadflow ideas archive <id>` / `unarchive <id>` — hide from default listings without deleting
- `quadflow ideas merge <id,id,…> <keep-id>` — concatenates content, unions tags and notes, deletes the others
- `quadflow ideas add-note <id> "<text>"` / `delete-note <id> <note-id>`
- `quadflow ideas add-suggestion <id> [--kind reword|expand|clarify|summarize] "<text>"`
- `quadflow ideas resolve-suggestion <id> <suggestion-id> --accept|--reject` — accept replaces the content
- `quadflow ideas delete-suggestion <id> <suggestion-id>`
- `quadflow ideas revert <id>` — restore the original text
- `quadflow ideas stats` · `quadflow ideas export [--format json|markdown|csv]`

To turn an idea into tracked work, create an issue (`quadflow issues create …`) and archive
or delete the idea.

## JSON output

Pass `--json` for one document on stdout: `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":"not_found","message":"…"}}`. Ideas are camelCase:
`{id, content, originalContent, tags, archived, discoveryId?, suggestions, notes, createdAt, createdBy, updatedAt}`.
Exit codes: 0 ok, 2 invalid input, 3 not found, 4 conflict, 5 not in a QuadFlow project.

## Notes

- Ideas are meant to be lightweight. If something is actionable and has
  acceptance criteria, prefer `quadflow issues create` over an idea.
- Changes made here appear live in the QuadFlow Ideas tool.
