---
name: setup-scripts
description: Analyze the project and create appropriate build scripts for common tasks like build, test, dev server, etc.
allowed-tools: Bash, Read, Glob
user-invocable: true
argument-hint: [project-type]
---

# Setup Build Scripts

Analyze the project and save useful build/test/run scripts in QuadFlow.

## Process

1. **Detect the project type** (or use $ARGUMENTS if it names one):
   - `package.json` -> Node.js (read its `scripts` to pick real commands)
   - `Cargo.toml` -> Rust
   - `tauri.conf.json` (often in `src-tauri/`) -> Tauri
   - `pyproject.toml` or `requirements.txt` -> Python
   - `go.mod` -> Go

2. **Check existing scripts** and skip ones that already exist:
   ```bash
   quadflow scripts list --include-archived --json
   ```

3. **Check this machine's environments**:
   ```bash
   quadflow scripts env-list --json
   ```
   On Windows, Rust/Tauri builds need a Visual Studio developer prompt (`kind` = `vs_dev`)
   for cl.exe and link.exe. If there is none, suggest `/detect-environments` first.

4. **Choose scripts** for the project type:

   **Tauri (Windows)** — assign the VS x64 environment to the Rust parts
   - Dev: `npm run tauri dev` (kind `server`)
   - Build: `npm run tauri build` (kind `build`)
   - Test Frontend: `npm test`
   - Test Backend: `cargo test` (working directory `src-tauri`)
   - Lint: `npm run lint && cargo clippy`

   **Tauri (macOS/Linux)**
   - Dev: `npm run tauri dev`
   - Build: `npm run tauri build`
   - Test: `npm test && cargo test`

   **Node.js**
   - Dev: `npm run dev` or `npm start` (kind `server`)
   - Build: `npm run build`
   - Test: `npm test`
   - Lint: `npm run lint`

   **Rust** — VS x64 environment on Windows
   - Build: `cargo build` / Build Release: `cargo build --release`
   - Test: `cargo test`
   - Run: `cargo run`
   - Check: `cargo check && cargo clippy`

   **Go**
   - Build: `go build ./...`
   - Test: `go test ./...`
   - Run: `go run .`

   **Python**
   - Run: `python <entry point>` (`main.py`, `app.py`, `manage.py`, …)
   - Dev (Watchdog): `watchmedo auto-restart --patterns="*.py" --recursive -- python <entry point>`
   - Test: `pytest` or `python -m unittest discover`
   - Install Deps: `pip install -r requirements.txt` or `pip install -e .`
   - For framework detection (Django, Flask, FastAPI, Streamlit), venv activation and
     watchdog dev scripts, suggest `/setup-python`

   Only use npm script names that exist in `package.json`; use the project's package
   manager (pnpm, yarn, bun) if its lockfile is present.

5. **Create each script** (`--setup`, `--env`, `--platform` and `--tag` are repeatable;
   `--environment` takes the environment's name):
   ```bash
   quadflow scripts create "Tauri Build" --command "npm run tauri build" \
     --description "Production build" --kind build \
     --environment "VS 2022 Community x64" --platform windows --json

   quadflow scripts create "Test Backend" --command "cargo test" \
     --working-directory src-tauri --json
   ```
   To add an environment to a script that already exists:
   ```bash
   quadflow scripts update <id> --environment "<environment name>" --json
   ```

6. **Optionally group** scripts that run together (e.g. backend + frontend dev servers):
   ```bash
   quadflow scripts groups create "Full Dev" --mode parallel --script <id> --script <id> --json
   ```

7. **Report** the created scripts and how to run them (`/run-script <name>`).

## Note on Environments

The environment is stored by name and resolved on each machine. A script restricted with
`--platform windows` will not show up for macOS/Linux teammates; create platform variants
when commands differ.
