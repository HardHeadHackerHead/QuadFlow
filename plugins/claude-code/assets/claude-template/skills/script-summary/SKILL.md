---
name: script-summary
description: Get a quick summary of all build scripts and environments in QuadFlow. Shows scripts grouped by type and environment assignments.
allowed-tools: Bash, Read, Glob
user-invocable: true
argument-hint:
---

# Script Summary

A quick overview of the project's scripts and this machine's terminal environments.

## Process

1. **Get scripts, groups and environments**:
   ```bash
   quadflow scripts list --json
   quadflow scripts groups list --json
   quadflow scripts env-list --json
   ```
   Script fields: `name, command, kind` (`command` | `server` | `build`), `environment?`,
   `platforms?`, `tags?`, `pinned`.

2. **Display the summary**:

```
## Scripts (X total)

### With Environment
- Tauri Dev [VS 2022 x64] - npm run tauri dev
- Tauri Build [VS 2022 x64] - npm run tauri build

### Without Environment
- Test Frontend - npm test
- Lint - npm run lint

### By Platform
- Windows only: 2
- All platforms: 3

### Groups
- Full Stack Dev (parallel): Backend, Frontend

## Environments (X total)
- System shells: Command Prompt, Windows PowerShell, Git Bash
- VS developer prompts: VS 2022 Community x64/x86
- Custom: Rust Nightly, Python ML
```

3. **Highlight problems**:
   - Scripts that name an environment this machine does not have (not in `env-list`)
   - Scripts without an environment that probably need one (Rust/Tauri builds on Windows)
   - Unavailable environments
   - No VS developer prompt although the project has `Cargo.toml` and this is Windows

4. **Suggest actions**:
   - `/detect-environments` if no environments or no VS prompts are registered
   - `/setup-scripts` if there are few or no scripts
   - `/assign-environment` for scripts that need an environment

## Output Style

Keep it short — a quick glance, not a detailed review. Use bullet lists or tables.
