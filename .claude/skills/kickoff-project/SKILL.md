---
name: kickoff-project
description: Guide through structured project setup - goals, research areas, requirements, and open questions
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [project name or topic]
---

# Kickoff Project Skill

Guide the user through creating a well-structured discovery project (shown as
"Projects" in QuadFlow) with populated sections. All data goes through the
`quadflow discovery` CLI via the Bash tool; run `quadflow docs discovery` for
the full reference.

## Process

1. **Understand the project** from $ARGUMENTS or ask the user:
   - What are we building?
   - What problem does it solve?
   - Who is it for?

2. **Create the discovery project** with title, overview, goals and success criteria in one call:

   ```bash
   quadflow discovery create "<title>" --overview "<1-2 sentence pitch>" \
     --goal "<goal 1>" --goal "<goal 2>" --goal "<goal 3>" \
     --criterion "<measurable outcome 1>" --criterion "<measurable outcome 2>" --json
   ```

   Take the new id from `data.id`. To change them later:
   `quadflow discovery update <id> --goal "…" --goal "…"` (replaces the list).

3. **Populate initial items** with
   `quadflow discovery item-add <id> --kind <kind> --title "<title>" [--content "<details>"] [--status <status>] [--metadata '<json>'] --json`:

   **Research** (`--kind research`):
   - Key technical areas to investigate
   - Existing solutions to evaluate
   - `--status pending`

   **Requirements** (`--kind requirement`):
   - Must-have features (`--status must_have`)
   - Nice-to-have features (`--status nice_to_have`)

   **Open questions** (`--kind question`):
   - Technical unknowns (`--status pending`)
   - Design decisions needed
   - Scope questions

   **References** (`--kind reference`):
   - Relevant docs, repos, or examples
   - Put URLs in metadata: `--metadata '{"url": "https://..."}'`

   **Decisions** (`--kind decision`) and **notes** (`--kind note`) for
   anything already settled or worth recording.

4. **Link existing ideas and plans** that belong to this project (find
   candidates with `quadflow ideas list --json` / `quadflow plans list --search "<term>" --json`):

   ```bash
   quadflow ideas update <idea-id> --discovery <id>
   quadflow plans update <plan-id> --discovery <id>
   ```

5. **Present the kickoff summary** (`quadflow discovery get <id> --json`,
   plus `quadflow discovery linked <id> --json`) showing:
   - Project overview
   - Goals and success criteria
   - Item counts by kind
   - Suggested next steps

## Output Format

Present the created project as a structured summary with clear sections and next-step recommendations.
