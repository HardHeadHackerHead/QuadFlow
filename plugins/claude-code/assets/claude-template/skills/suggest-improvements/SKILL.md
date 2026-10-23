---
name: suggest-improvements
description: Analyze ideas and add verbiage suggestions for improvements - rewording for clarity, expanding vague ideas, or summarizing verbose ones. This is for TEXT improvements only, not implementation notes.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [reword|expand|clarify|summarize]
---

# Suggest Improvements Skill

Propose better wording for QuadFlow ideas. Suggestions sit alongside the idea until the user accepts or rejects them.

## Suggestions vs notes

**This skill only improves the text of ideas.**
- Suggestions = better phrasing of the idea itself.
- Notes = implementation status, code references, observations. Use `/check-implemented` or `quadflow ideas add-note` for those.

## Suggestion kinds

- `reword` — clearer, more professional phrasing
- `expand` — add detail to a vague idea
- `clarify` — make an ambiguous idea specific
- `summarize` — condense a verbose idea

## Process

1. **Get the ideas**:
   ```bash
   quadflow ideas list --json
   ```
   Skip ideas that already have a pending suggestion (an entry in `suggestions` with no `accepted` field). Resolved suggestions carry `accepted: true|false`; avoid re-proposing one the user rejected.

2. **Assess each idea's text**:
   - too short or unclear -> `expand` or `clarify`
   - long or rambling -> `summarize`
   - slang or fragments -> `reword`
   - already clear -> skip

3. **Add the suggestion**; the text is your full improved version of the idea:
   ```bash
   quadflow ideas add-suggestion <id> --kind clarify "<improved idea text>"
   ```

4. **Report**:
   - Ideas analyzed
   - Suggestions added, by kind
   - Ideas that need no change

The user reviews suggestions in the Ideas tool, or with `quadflow ideas resolve-suggestion <id> <suggestion-id> --accept` (content becomes the suggestion) or `--reject`. `quadflow ideas revert <id>` restores the original text.

## Focus mode

If `$ARGUMENTS` names a kind, add only that kind, e.g. `/suggest-improvements summarize`.

## Quality guidelines

- Preserve the original intent.
- Make ideas actionable and specific.
- Use professional, plain language.
- Keep expansions concise.
- Name specific features or components when possible.
- Never put implementation status in a suggestion.
