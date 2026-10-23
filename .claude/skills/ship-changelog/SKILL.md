---
name: ship-changelog
description: Generate a changelog from git log between the last release tag and HEAD. Useful as input to a gh_release phase's notes.
allowed-tools: Bash, Read, Write
user-invocable: true
argument-hint: [--since <ref>] [--out <path>]
---

# Ship Changelog Skill

Build a changelog for the next release from `git log`. Default range:
last tag → HEAD. Output: stdout, or a file with `--out`.

## Process

1. **Resolve range**
   - `--since <ref>` if given.
   - Else check the project's preference: `quadflow ship config show --json`
     → `data.changelog.since` (`last_tag`, or a ref).
   - `last_tag` → `git describe --tags --abbrev=0`. No tag at all → the whole
     history (`git rev-list --max-parents=0 HEAD`).

2. **Collect**

   ```bash
   git log <since>..HEAD --pretty=format:"- %s (%h)"
   ```

   Optionally group by conventional-commit prefix
   (feat/fix/docs/chore/refactor/test/style). Skip grouping if no commits
   use prefixes.

3. **Format**
   - First line: `# Release notes`
   - Sections (or a flat list)
   - Trailer: `Compare: <since>..HEAD`

4. **Output**
   - With `--out <path>`: write the file.
   - Without: print it. To use it in a release, put the text in the
     `gh_release` phase's `notes` (tokens like `{version}` still apply), or
     write it with a `write_file` phase before `gh_release`.

## Examples

```
/ship-changelog                        # since last tag, print
/ship-changelog --since v1.0.0
/ship-changelog --out RELEASE_NOTES.md
```

## Notes

- Git only — no GitHub queries; works offline.
- Run records (`quadflow ship get <run-id> --json` → `data.changelog`) hold
  the changelog captured when that run started; they describe what already
  shipped, not what is about to.
