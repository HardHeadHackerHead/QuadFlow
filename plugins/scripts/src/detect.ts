/**
 * Scripts found in the project itself (not saved): `package.json` scripts and
 * the usual commands of a Python project (Django, Flask, FastAPI, Streamlit,
 * pytest, ruff). Read through `ctx.fs` (`fs:read:project`), relative to the
 * project root.
 */
import type { PluginContext } from '@quadflow/plugin-api'

export interface DetectedScript {
  name: string
  command: string
}

export interface Detected {
  npm: DetectedScript[]
  /** Why there are no npm scripts (no / invalid package.json). */
  npmError: string | null
  python: DetectedScript[]
}

async function read(ctx: PluginContext, path: string): Promise<string | null> {
  try {
    return await ctx.fs.readText(path, 'project')
  } catch {
    return null
  }
}

async function exists(ctx: PluginContext, path: string): Promise<boolean> {
  try {
    return (await ctx.fs.stat(path, 'project')) !== null
  } catch {
    return false
  }
}

/**
 * Does Python source `src` import `module` (`import m` / `from m import …`)? A RegExp rather
 * than `'import ' + m` string literals, which the plugin build's shared-import check would read
 * as ES imports in the bundle.
 */
function pyImports(src: string, module: string): boolean {
  return new RegExp(`\\b(?:from|import)\\s+${module}\\b`).test(src)
}

async function detectNpm(ctx: PluginContext): Promise<{ npm: DetectedScript[]; npmError: string | null }> {
  const text = await read(ctx, 'package.json')
  if (text === null) return { npm: [], npmError: 'No package.json found in the project root' }
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> }
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    return {
      npm: Object.entries(scripts)
        .filter(([, cmd]) => typeof cmd === 'string')
        .map(([name, cmd]) => ({ name, command: cmd as string })),
      npmError: null,
    }
  } catch {
    return { npm: [], npmError: 'Invalid package.json format' }
  }
}

async function detectPython(ctx: PluginContext): Promise<DetectedScript[]> {
  const scripts: DetectedScript[] = []

  let venv = ''
  for (const dir of ['.venv', 'venv', 'env']) {
    if (await exists(ctx, `${dir}/Scripts/activate`)) {
      venv = `source ${dir}/Scripts/activate && `
      break
    }
    if (await exists(ctx, `${dir}/bin/activate`)) {
      venv = `source ${dir}/bin/activate && `
      break
    }
  }

  const hasRequirements = await exists(ctx, 'requirements.txt')
  const pyproject = await read(ctx, 'pyproject.toml')
  const hasPipfile = await exists(ctx, 'Pipfile')
  let install = `${venv}pip install -r requirements.txt`
  if (pyproject?.includes('[tool.poetry]')) install = 'poetry install'
  else if (pyproject?.includes('[project]')) install = `${venv}pip install -e .`
  if (hasPipfile) install = 'pipenv install'

  if (pyproject === null && !hasRequirements && !hasPipfile) {
    let any = false
    for (const f of ['manage.py', 'app.py', 'main.py', 'run.py', 'server.py']) {
      if (await exists(ctx, f)) {
        any = true
        break
      }
    }
    if (!any) return []
  }

  const manage = await read(ctx, 'manage.py')
  if (manage && (manage.includes('django') || manage.includes('DJANGO_SETTINGS_MODULE'))) {
    const py = `${venv}python manage.py`
    return [
      { name: 'Run Server', command: `${py} runserver` },
      { name: 'Migrate', command: `${py} migrate` },
      { name: 'Make Migrations', command: `${py} makemigrations` },
      { name: 'Shell', command: `${py} shell` },
      { name: 'Test', command: `${py} test` },
      { name: 'Collect Static', command: `${py} collectstatic --noinput` },
      { name: 'Install Deps', command: install },
    ]
  }

  const firstMatching = async (files: string[], test: (src: string) => boolean): Promise<string | null> => {
    for (const f of files) {
      const src = await read(ctx, f)
      if (src !== null && test(src)) return f
    }
    return null
  }

  const flask = await firstMatching(['app.py', 'wsgi.py', 'run.py', 'main.py', 'server.py'], (s) =>
    pyImports(s, 'flask') || s.includes('Flask('),
  )
  if (flask) {
    const mod = flask.replace(/\.py$/, '')
    scripts.push({ name: 'Run', command: `${venv}flask --app ${mod} run` }, { name: 'Dev (debug)', command: `${venv}flask --app ${mod} run --debug` })
  }
  if (scripts.length === 0) {
    const fastapi = await firstMatching(['app.py', 'main.py', 'server.py', 'api.py'], (s) =>
      pyImports(s, 'fastapi') || s.includes('FastAPI('),
    )
    if (fastapi) {
      const mod = fastapi.replace(/\.py$/, '')
      scripts.push(
        { name: 'Run', command: `${venv}uvicorn ${mod}:app --host 0.0.0.0 --port 8000` },
        { name: 'Dev (reload)', command: `${venv}uvicorn ${mod}:app --reload --host 0.0.0.0 --port 8000` },
      )
    }
  }
  if (scripts.length === 0) {
    const st = await firstMatching(['app.py', 'main.py', 'streamlit_app.py'], (s) => pyImports(s, 'streamlit'))
    if (st) scripts.push({ name: 'Run', command: `${venv}streamlit run ${st}` })
  }
  if (scripts.length === 0) {
    for (const f of ['main.py', 'app.py', 'run.py', 'server.py', 'manage.py']) {
      if (await exists(ctx, f)) {
        scripts.push({ name: 'Run', command: `${venv}python ${f}` })
        break
      }
    }
  }

  if ((await exists(ctx, 'pytest.ini')) || (await exists(ctx, 'conftest.py')) || (await exists(ctx, 'setup.cfg'))) {
    scripts.push({ name: 'Test (pytest)', command: `${venv}pytest` })
  } else {
    scripts.push({ name: 'Test', command: `${venv}python -m pytest` })
  }
  if (pyproject?.includes('ruff')) {
    scripts.push({ name: 'Lint (ruff)', command: `${venv}ruff check .` }, { name: 'Format (ruff)', command: `${venv}ruff format .` })
  }
  scripts.push({ name: 'Install Deps', command: install })
  return scripts
}

export async function detectScripts(ctx: PluginContext): Promise<Detected> {
  const [npm, python] = await Promise.all([detectNpm(ctx), detectPython(ctx)])
  return { ...npm, python }
}
