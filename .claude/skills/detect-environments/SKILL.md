---
name: detect-environments
description: Scan the system for available terminal environments (Visual Studio, Git Bash, etc.) and register them in QuadFlow.
allowed-tools: Bash, Read
user-invocable: true
argument-hint:
---

# Detect Terminal Environments

Scan this machine for shells and toolchains and register them as terminal environments.
Environments are per machine; scripts refer to them by name.

## What Gets Detected

- **Windows**: Command Prompt, Windows PowerShell, PowerShell 7 (pwsh), Git Bash, and a
  developer prompt for each Visual Studio installation found via vswhere (x64 and x86,
  with the `vcvarsall.bat` init command preconfigured)
- **macOS/Linux**: zsh, bash, sh, pwsh

## Process

1. **Run detection**:
   ```bash
   quadflow scripts env-detect --json
   ```

2. **List the result**:
   ```bash
   quadflow scripts env-list --json
   ```
   Each environment has `name`, `kind` (`system_shell`, `vs_dev`, `custom`), `shell`,
   `available`, and for VS prompts `vs.version`, `vs.edition`, `vs.arch`.

3. **Show results**: list every environment with its availability, and call out the
   Visual Studio installations found (version, edition, arch). If this is a Rust/Tauri or
   other native-build project on Windows and no VS prompt was found, say so.

## Example Output

```
Detected 5 terminal environments:
- Command Prompt (system_shell, cmd) ✓
- Windows PowerShell (system_shell, powershell) ✓
- Git Bash (system_shell, bash) ✓
- VS 2022 Community x64 (vs_dev) ✓
- VS 2022 Community x86 (vs_dev) ✓
```

## After Detection

Tell the user they can:
- Assign an environment to a script with `/assign-environment <script> <environment>`
- Create a custom environment with `/setup-environment`
