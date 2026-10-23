/**
 * Where Claude Code keeps things, relative to the fs scopes of the host API:
 * `home` → `~/.claude/projects/<encoded cwd>/<session>.jsonl`,
 * `project` → `CLAUDE.md`, `.claude/settings.local.json`, `.claude/skills/`.
 */
import type { PluginContext } from '@quadflow/plugin-api'

export const PROVIDER_ID = 'claude-code'
export const CONTEXT_FILE = 'CLAUDE.md'
export const SETTINGS_FILE = '.claude/settings.local.json'
export const SKILLS_DIR = '.claude/skills'
export const SCAFFOLD_VERSION_FILE = '.claude/.quadflow-scaffold-version'
export const PROJECTS_DIR = '.claude/projects'

/** Claude Code's project-dir encoding: every char outside `[A-Za-z0-9]` becomes `-`. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Candidate session dirs (home-relative) for `cwd`. Windows paths are tried
 * with the drive letter as given, upper- and lower-cased (Claude records the
 * cwd exactly as the shell reported it).
 */
export function sessionDirsFor(cwd: string): string[] {
  const variants = new Set([cwd])
  if (/^[A-Za-z]:/.test(cwd)) {
    variants.add(cwd[0].toUpperCase() + cwd.slice(1))
    variants.add(cwd[0].toLowerCase() + cwd.slice(1))
  }
  return [...variants].map((v) => `${PROJECTS_DIR}/${encodeCwd(v)}`)
}

/**
 * `~/.claude/projects/...` absolute path → home-relative path for `ctx.fs`
 * (`null` if the path is not under a `.claude/projects` dir).
 */
export function homeRelative(absPath: string): string | null {
  const norm = absPath.replace(/\\/g, '/')
  const i = norm.lastIndexOf(`/${PROJECTS_DIR}/`)
  return i < 0 ? null : norm.slice(i + 1)
}

/** `child` relative to `root` (both absolute), or `null` if outside. */
export function relativeTo(root: string, child: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const c = norm(child)
  const win = /^[A-Za-z]:/.test(r)
  const eq = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (eq(c, r)) return ''
  const prefix = c.slice(0, r.length + 1)
  if (!eq(prefix, `${r}/`)) return null
  return c.slice(r.length + 1)
}

/** Find a session file (home-relative) for `sessionId` started in `cwd`. */
export async function findSessionFile(ctx: PluginContext, cwd: string, sessionId: string): Promise<string | null> {
  for (const dir of sessionDirsFor(cwd)) {
    const p = `${dir}/${sessionId}.jsonl`
    if (await ctx.fs.stat(p, 'home').catch(() => null)) return p
  }
  return null
}

export function isWindows(): boolean {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
}

/** `ctx.fs.readText` that maps "missing" to `null`. */
export async function readTextOrNull(ctx: PluginContext, path: string, scope: 'project' | 'home'): Promise<string | null> {
  const st = await ctx.fs.stat(path, scope).catch(() => null)
  if (!st || st.kind !== 'file') return null
  return ctx.fs.readText(path, scope)
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
