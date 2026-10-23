---
name: brainstorm
description: Generate related ideas around a topic or existing idea. Creates new ideas and tags them appropriately.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [topic or idea-id] [quick|deep|wild|practical]
---

# Brainstorm Skill

Generate ideas around a topic, or expand on an existing idea, and save them as QuadFlow ideas.

## Process

1. **Determine the focus** from `$ARGUMENTS`:
   - An idea id: expand on that idea.
   - Free text: brainstorm around that topic.
   - Nothing: ask the user what to brainstorm about.
   - A trailing mode word (`quick`, `deep`, `wild`, `practical`) sets the mode (see below).

2. **Gather context**:
   ```bash
   quadflow ideas get <id> --json             # when expanding an idea
   quadflow ideas list --json                 # existing ideas, to avoid duplicates
   quadflow ideas list --text "<keyword>" --json
   quadflow ideas stats --json                # existing tags (byTag) to reuse
   ```
   Search the codebase with `Grep` and `Glob` to understand what already exists.

3. **Generate ideas** across the dimensions that fit the topic:
   - **Feature topics**: core functionality, variations, enhancements, related features, edge cases, user experience.
   - **Problem topics**: root causes, workarounds, prevention, detection, recovery.
   - **Improvement topics**: performance, usability, reliability, maintainability, extensibility.

4. **Quality-check each idea**: actionable, distinct from existing ideas, relevant to this project, clear and specific. Drop the ones that fail and list them under "Discarded Ideas".

5. **Create the ideas**, with tags in the same call. Write content that stands alone and includes a one-line rationale:
   ```bash
   quadflow ideas create "<content>. Why: <benefit>" --tag brainstormed,<category> --json
   ```
   Tags to use:
   - a category tag, reusing an existing tag from `ideas stats` where one fits
   - `brainstormed`, to record the origin
   - `related-to-<idea-id>` when expanding an existing idea
   - `priority-*` / `complexity-*` only when you have a real basis for them

   To tag after creation: `quadflow ideas add-tag <id> <tag>` (several ideas at once: `quadflow ideas bulk-tag <id,id,…> <tag>`).

6. **Present the results**:

```
## Brainstorm Results: [Topic/Idea]

### Context
[What was brainstormed and what already exists]

### New Ideas Created

#### Core Ideas
1. **[idea-id]**: [content]
   - Tags: [tags]
   - Rationale: [why]

#### Enhancement Ideas
[same format]

#### Alternative Approaches
[same format]

### Summary
- Ideas created: X
- Categories covered: [list]
- Recommended starting point: [idea-id]

### Discarded Ideas
[Considered but not created, with reasons]
```

## Modes

- `quick` — 3-5 focused ideas
- `deep` — 10+ ideas with thorough analysis
- `wild` — include unconventional ideas
- `practical` — only immediately actionable ideas

## Notes

- Quality over quantity.
- Each idea must make sense on its own.
- Reference existing ideas by id when relevant.
- Consider feasibility, but don't let it kill creativity.
- Keep tagging consistent so related ideas group together.
