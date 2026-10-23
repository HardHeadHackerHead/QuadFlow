/**
 * Path helpers of the editor (pure; unit-tested in test/paths.test.ts).
 *
 * The editor reads and writes through `ctx.fs` in the `project` scope (paths
 * relative to the project root). Callers (file explorer, terminal file links)
 * pass absolute paths; `resolveTarget` turns one under the project root into a
 * project-relative path and keeps anything else as `absolute` (readable only
 * when the user picked it with `ui.pickFile`).
 */

export type EditorScope = 'project' | 'absolute'

export interface EditorTarget {
  path: string
  scope: EditorScope
}

/** Forward slashes, no trailing slash, no `./` segments. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  s = s
    .split('/')
    .filter((seg, i) => seg !== '.' || i === 0)
    .join('/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  if (s.startsWith('./')) s = s.slice(2)
  return s
}

export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

/** Windows paths compare case-insensitively (drive letter, NTFS). */
function comparable(p: string): string {
  const n = normalizePath(p)
  return /^[a-zA-Z]:\//.test(n) || n.startsWith('//') ? n.toLowerCase() : n
}

/**
 * Where a file lives for `ctx.fs`: relative paths are project-relative;
 * absolute paths under `projectRoot` become project-relative; others stay absolute.
 */
export function resolveTarget(path: string, projectRoot: string | null | undefined): EditorTarget {
  const p = normalizePath(path.trim())
  if (!isAbsolutePath(path.trim())) return { path: p, scope: 'project' }
  if (projectRoot) {
    const root = comparable(projectRoot)
    const full = comparable(p)
    if (full.startsWith(root + '/')) return { path: p.slice(normalizePath(projectRoot).length + 1), scope: 'project' }
  }
  return { path: p, scope: 'absolute' }
}

/** Identity of an open file (one tile per file). */
export function targetKey(t: EditorTarget): string {
  return `${t.scope}:${comparable(t.path)}`
}

export function fileNameOf(path: string): string {
  const n = normalizePath(path)
  return n.slice(n.lastIndexOf('/') + 1) || n
}

/** `.ts` for `src/a.ts`, `''` for `Makefile`; `.env` files have no extension. */
export function extensionOf(path: string): string {
  const name = fileNameOf(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/** `.env`, `.env.local`, `prod.env`: shown behind a "sensitive content" gate. */
export function isEnvFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')
}
