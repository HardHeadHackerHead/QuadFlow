---
name: setup-environment
description: Create a custom terminal environment with init commands and environment variables.
allowed-tools: Bash, Read
user-invocable: true
argument-hint: <environment-name>
---

# Setup Custom Environment

Create a custom terminal environment with a shell, init commands and environment
variables. Environments are per machine; scripts refer to them by name.

## When to Use

- A specialized toolchain setup (Rust nightly, a Python venv, CUDA)
- Environment variables that builds always need
- Init commands that should run before every script that uses it

## Process

1. **Name**: use $ARGUMENTS if given, otherwise ask. Check it is not taken:
   ```bash
   quadflow scripts env-list --json
   ```

2. **Gather requirements** from the user:
   - Shell: `cmd`, `powershell`, `pwsh`, `bash`, `zsh` or `sh`
   - Init commands to run when the terminal starts
   - Environment variables
   - A short description
   - Optionally an absolute shell path (when the shell is not on PATH)

3. **Create it** (`--init` and `--env` are repeatable):
   ```bash
   quadflow scripts env-add "Rust Nightly" --shell powershell \
     --description "Nightly toolchain with native CPU flags" \
     --init "rustup default nightly" \
     --env "RUSTFLAGS=-C target-cpu=native" --json
   ```

4. **Confirm** by showing the created environment:
   ```bash
   quadflow scripts env-get "Rust Nightly" --json
   ```

## Examples

### Python virtual environment
```bash
quadflow scripts env-add "Python ML Env" --shell bash \
  --init "source ~/venvs/ml/bin/activate" --env "PYTHONPATH=./src" --json
```

### CUDA build environment (Windows)
```bash
quadflow scripts env-add "CUDA Build" --shell cmd \
  --init "call \"C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat\" x64" \
  --env "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6" \
  --env "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6" --json
```

## After Creation

Tell the user they can:
- Assign it to scripts with `/assign-environment <script> "<environment name>"`
- Change it later by re-running `quadflow scripts env-add` with `--id <id>` (replaces the
  environment), or remove it with `quadflow scripts env-delete "<name>"`
- Teammates who use scripts assigned to it need an environment with the same name on
  their machine
