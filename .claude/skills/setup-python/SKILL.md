---
name: setup-python
description: Detect Python project structure and create scripts with watchdog auto-restart for dev mode.
allowed-tools: Bash, Read, Glob, Grep
user-invocable: true
argument-hint: [entry-point]
---

# Setup Python Scripts

Detect Python project structure and create build/run scripts with watchdog file-watching for dev mode.

## Process

1. **Detect Python project** by looking for:
   - `pyproject.toml` -> Modern Python project (check for framework in `[project.dependencies]`)
   - `setup.py` or `setup.cfg` -> Legacy Python project
   - `requirements.txt` -> Pip-based project
   - `Pipfile` -> Pipenv project
   - `poetry.lock` -> Poetry project

2. **Detect virtual environment** by checking for:
   - `.venv/` or `venv/` or `env/` directories
   - If found, activate it as a setup command (match the script's shell):
     - Windows cmd: `.venv\Scripts\activate.bat`; PowerShell: `.venv\Scripts\Activate.ps1`
     - Unix shells: `source .venv/bin/activate`

3. **Detect entry point** (use `$ARGUMENTS` if provided, otherwise auto-detect):
   - `manage.py` -> Django project
   - `app.py` -> Check for Flask/FastAPI imports
   - `main.py` -> Check for FastAPI/general entry
   - `run.py`, `server.py`, `wsgi.py`, `asgi.py` -> Web server entry
   - `src/<package>/__main__.py` -> Package with __main__
   - Fallback: first `.py` file with `if __name__` block in project root

4. **Detect framework** by reading the entry point and config files:
   - **Django**: `manage.py` exists, imports `django`
   - **Flask**: imports `flask`, has `app = Flask(...)`
   - **FastAPI**: imports `fastapi`, has `app = FastAPI(...)`
   - **Streamlit**: imports `streamlit`
   - **General**: no framework detected

5. **Detect testing tools** by checking:
   - `pytest` in dependencies or `pytest.ini` / `pyproject.toml [tool.pytest]` -> pytest
   - `tests/` or `test/` directory exists -> likely has tests
   - Fallback: `python -m unittest discover`

6. **Detect linting tools**:
   - `ruff` in dependencies or `ruff.toml` -> `ruff check .`
   - `flake8` in dependencies or `.flake8` -> `flake8`
   - `pylint` in dependencies -> `pylint <package>`
   - Fallback: suggest `ruff check .`

7. **Check existing scripts** and skip any that already exist:
   ```bash
   quadflow scripts list --include-archived --json
   ```

8. **Create scripts**, one call each (`--setup`, `--env` and `--tag` are repeatable;
   use `--kind server` for long-running servers):
   ```bash
   quadflow scripts create "Dev (Watchdog)" \
     --command "watchmedo auto-restart --patterns=\"*.py\" --recursive -- python main.py" \
     --description "Auto-restart on file changes" --kind server \
     --setup "source .venv/bin/activate" --tag python --json
   ```

### For Django Projects
| Script | Command | Description |
|--------|---------|-------------|
| Run Server | `python manage.py runserver` | Start Django dev server |
| Dev (Watchdog) | `watchmedo auto-restart --patterns="*.py;*.html;*.css" --recursive --signal SIGTERM -- python manage.py runserver` | Auto-restart on file changes |
| Migrate | `python manage.py migrate` | Run database migrations |
| Make Migrations | `python manage.py makemigrations` | Create new migrations |
| Test | `python manage.py test` or `pytest` | Run tests |
| Shell | `python manage.py shell` | Django interactive shell |

### For Flask Projects
| Script | Command | Description |
|--------|---------|-------------|
| Run | `python <entry_point>` | Start Flask app |
| Dev (Watchdog) | `watchmedo auto-restart --patterns="*.py;*.html;*.css" --recursive --signal SIGTERM -- python <entry_point>` | Auto-restart on file changes |
| Test | `pytest` | Run tests |

- Also set `--env FLASK_DEBUG=1` on dev scripts

### For FastAPI Projects
| Script | Command | Description |
|--------|---------|-------------|
| Run | `uvicorn <module>:app --host 0.0.0.0 --port 8000` | Start with uvicorn |
| Dev (Watchdog) | `uvicorn <module>:app --host 0.0.0.0 --port 8000 --reload` | Uvicorn's built-in reload (uses watchdog internally) |
| Test | `pytest` | Run tests |

- Note: FastAPI/uvicorn has built-in `--reload` which uses watchdog. Prefer this over manual watchmedo.

### For Streamlit Projects
| Script | Command | Description |
|--------|---------|-------------|
| Run | `streamlit run <entry_point>` | Start Streamlit app (has built-in file watching) |
| Test | `pytest` | Run tests |

### For General Python Projects
| Script | Command | Description |
|--------|---------|-------------|
| Run | `python <entry_point>` | Run the main script |
| Dev (Watchdog) | `watchmedo auto-restart --patterns="*.py" --recursive --signal SIGTERM -- python <entry_point>` | Auto-restart on file changes |
| Test | `pytest` or `python -m unittest discover` | Run tests |
| Install Deps | `pip install -r requirements.txt` or `pip install -e .` | Install dependencies |

### Common Scripts (all project types)
| Script | Command | Description |
|--------|---------|-------------|
| Lint | Detected linter command | Run linter |
| Format | `ruff format .` or `black .` | Format code |
| Install Deps | Package manager install command | Install/update dependencies |

9. **Venv activation**: if a venv was detected, pass its activation command as `--setup` on every script

10. **Report results**: List created scripts and note:
    - If watchdog is not installed, tell user to run: `pip install watchdog`
    - If no entry point was found, explain how to specify one: `/setup-python app.py`

## Override

If `$ARGUMENTS` provides an entry point file, use it directly instead of auto-detecting.

## Notes

- The `watchmedo` command comes from the `watchdog` Python package (`pip install watchdog`)
- For FastAPI, prefer uvicorn's `--reload` flag over watchmedo since it uses watchdog internally
- For Streamlit, file watching is built-in so no watchdog script is needed
- `--signal SIGTERM` is not available on Windows; omit `--signal` there (or restrict the script with `--platform macos --platform linux` and create a Windows variant)
- The `--patterns` flag accepts semicolon-separated globs
