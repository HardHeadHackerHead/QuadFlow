---
name: organize-ideas
description: Categorize, tag, and organize all ideas in QuadFlow. Use this when the user wants to clean up, categorize, or organize their ideas.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [priority|tags|duplicates|clarity]
---

# Organize Ideas Skill

Categorize and tag every QuadFlow idea in the project.

## Process

1. **Get the ideas and existing tags**:
   ```bash
   quadflow ideas list --json
   quadflow ideas stats --json   # byTag: tags already in use
   ```

2. **Choose the category tags.** Reuse tags already in use. If there are few, derive a small set (roughly 5-10) from the project's main areas, looking at its structure with `Glob` where needed, e.g. `ui`, `backend`, `api`, `cli`, `docs`, `dev-tools`, `performance`, `misc`. Merge near-synonyms rather than adding more.

3. **Give each idea a category tag**, plus where it applies:
   - a status tag: `implemented` (already exists), `in-progress` (being worked on)
   - a priority tag: `priority-high`, `priority-medium`, `priority-low`

4. **Apply the tags**:
   ```bash
   quadflow ideas add-tag <id> <tag>
   quadflow ideas bulk-tag <id,id,…> <tag>     # one tag on many ideas
   quadflow ideas update <id> --tags ui,priority-high   # replace an idea's whole tag set
   quadflow ideas remove-tag <id> <old-tag>    # drop a retired synonym
   ```
   Tags are lowercased automatically.

5. **Report**:
   - Ideas organized
   - Count per category
   - Tags renamed or retired
   - Possible duplicates and unclear ideas (suggest `/find-duplicates` and `/suggest-improvements`)

## Focus (`$ARGUMENTS`)

- `priority` — concentrate on assigning `priority-*` tags
- `tags` — thorough category tagging
- `duplicates` — find duplicate or similar ideas (see `/find-duplicates` for merging)
- `clarity` — find unclear ideas that need rewording (see `/suggest-improvements`)
