---
name: find-related-code
description: Search the codebase for files and code related to ideas. Adds notes about existing code to help understand what already exists.
allowed-tools: Bash, Read, Grep, Glob
user-invocable: true
argument-hint: [idea-id or "all" or tag-name]
---

# Find Related Code Skill

Find existing code related to QuadFlow ideas and record the findings as notes on each idea.

## Process

1. **Select the ideas** from `$ARGUMENTS`:
   - An idea id: `quadflow ideas get <id> --json`
   - `all` or nothing: `quadflow ideas list --json`, skipping ideas tagged `implemented`
   - A tag: `quadflow ideas list --tag <tag> --json`

2. **For each idea**:

   ### Extract search terms
   - Key nouns and technical terms from the idea
   - Related concepts (e.g. "dark mode" -> theme, colors, CSS variables)
   - Feature names that might already exist
   - File types likely involved

   ### Search the codebase
   Use `Grep` and `Glob` to find files with relevant names, code with relevant keywords, similar functionality, related configuration or constants, and tests that reveal existing features. Trace imports to see what uses the code you find.

   ### Analyze findings
   For each relevant file: what it does, how it relates to the idea, whether to extend or rewrite it, and which patterns it follows.

3. **Categorize findings**:
   - **Direct match**: already implements part of the idea
   - **Building block**: can be reused or extended
   - **Pattern example**: a similar feature to learn from
   - **Conflict**: may need refactoring first
   - **Test coverage**: existing tests to update

4. **Add a note** to each idea, prefixed `[find-related-code]`, with file paths and line numbers, the specific functions or types, and an integration approach:
   ```bash
   quadflow ideas add-note <id> "[find-related-code] Related code found:
   - src/lib/database.ts:45-80 - existing CRUD pattern
   - src/stores/itemStore.ts - state management

   Could extend the existing pattern."
   ```

5. **Report**:

````
## Related Code Analysis

### [idea-id]: [brief content]

#### Direct Matches
| File | Relevance | Notes |
|------|-----------|-------|

#### Building Blocks
| File | Can Provide | Usage |
|------|-------------|-------|

#### Patterns to Follow
| File | Pattern | Applicable Because |
|------|---------|--------------------|

#### Potential Conflicts
| File | Issue | Resolution |
|------|-------|------------|

#### Implementation Suggestions
1. Start with `[file]` as a template
2. Use `[utility]` for [purpose]
3. Follow the pattern in `[example]`
4. Update tests in `[test file]`

#### Key Code Snippets
```
// From path/to/file - relevant function
[snippet]
```

---

### Summary
| Idea | Related Files | Ready to Implement | Needs Refactoring |
|------|---------------|--------------------|-------------------|

### Codebase Insights
- Common patterns: [list]
- Suggested starting points: [files]
- Areas needing cleanup first: [files]
````

## Notes vs suggestions

- **Notes** (`quadflow ideas add-note`): code references, findings, observations.
- **Suggestions** (`quadflow ideas add-suggestion`): only for rewording the idea text itself.

## Guidance

- Keep findings actionable, with enough context to be useful.
- Mention code-quality concerns where they matter.
- Distinguish quick wins from major refactors, and prefer incremental approaches.
