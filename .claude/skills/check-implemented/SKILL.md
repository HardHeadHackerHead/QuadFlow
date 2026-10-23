---
name: check-implemented
description: Check if ideas have been implemented in the codebase. Use this to audit which ideas are complete, in progress, or still pending.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [tag]
---

# Check Implemented Ideas Skill

Audit which QuadFlow ideas are already implemented in the codebase and record the result on each idea.

## Process

1. **Get the ideas**:
   ```bash
   quadflow ideas list --json              # all active ideas
   quadflow ideas list --tag <tag> --json  # when $ARGUMENTS names a tag
   ```
   Skip ideas whose notes already contain a recent `[check-implemented]` note unless the code has changed since.

2. **For each idea, search the codebase**:
   - `Grep` for keywords and related terms from the idea
   - `Glob` for likely files
   - `Read` the candidates to confirm what actually exists

3. **Set exactly one status tag**: `implemented` (fully done), `in-progress` (partial) or `not-started` (nothing found). Remove the stale status tag if it changed; `remove-tag` is a no-op when the tag is absent:
   ```bash
   quadflow ideas remove-tag <id> not-started
   quadflow ideas add-tag <id> implemented
   ```

4. **Add an implementation note**, prefixed with `[check-implemented]` so its origin is visible:
   - Implemented: where it lives (file paths, line ranges).
   - In progress: what is done and what remains.
   - Not started: existing code that could help.
   ```bash
   quadflow ideas add-note <id> "[check-implemented] Implemented in src/lib/database.ts:123-150. Full CRUD operations complete."
   ```

5. **Report**:
   - Implemented: count and list
   - In progress: count and list
   - Not started: count and list
   - Coverage: implemented / total, as a percentage

## Tag filter

If `$ARGUMENTS` is a tag (for example `ui` or `backend`), check only ideas with that tag. Run `quadflow ideas stats --json` to see which tags exist.

## Notes vs suggestions

- **Notes** (`quadflow ideas add-note`): implementation status, observations, code references.
- **Suggestions** (`quadflow ideas add-suggestion`): only for rewording the idea text itself.
