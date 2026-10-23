/**
 * The shared modules of the host (plugin-system.md §8.3): the import-map specifiers a plugin must
 * keep external, and the names each one exports at runtime.
 *
 * Source of truth is `public/qf-shared/exports.json`, written by the QuadFlow checkout's
 * `scripts/gen-shared-shims.mjs` from the host's real modules. Lookup order:
 *  1. `QUADFLOW_SHARED_EXPORTS` (path to an exports.json),
 *  2. the QuadFlow checkout this package lives in (workspace / `file:` installs) — regenerated
 *     with `gen-shared-shims.mjs` when missing,
 *  3. `dist/shared-exports.json`, the snapshot `npm run build` of this package writes (published
 *     package).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'

export const PACKAGE_DIR = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..')
const SNAPSHOT = join(PACKAGE_DIR, 'dist', 'shared-exports.json')

/** The QuadFlow checkout containing this package, if any (has scripts/gen-shared-shims.mjs). */
export function findCheckout(from = PACKAGE_DIR) {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'scripts', 'gen-shared-shims.mjs')) && existsSync(join(dir, 'packages', 'plugin-api'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

let cached
/** `{ [specifier]: string[] }` of value exports per shared specifier. */
export function sharedExports() {
  if (cached) return cached
  const env = process.env.QUADFLOW_SHARED_EXPORTS
  let file = env && resolve(env)
  if (!file) {
    const checkout = findCheckout()
    if (checkout) {
      file = join(checkout, 'public', 'qf-shared', 'exports.json')
      if (!existsSync(file)) {
        execFileSync(process.execPath, [join(checkout, 'scripts', 'gen-shared-shims.mjs')], { cwd: checkout, stdio: 'inherit' })
      }
    } else {
      file = SNAPSHOT
    }
  }
  if (!existsSync(file)) {
    throw new Error(`@quadflow/plugin-build: shared export list ${file} not found (run \`npm run build\` in packages/plugin-build)`)
  }
  cached = JSON.parse(readFileSync(file, 'utf8'))
  return cached
}

/** Import-map specifiers, in a stable order. Plugins must not bundle these. */
export function sharedSpecifiers() {
  return Object.keys(sharedExports()).sort()
}

const IMPORT_RE = /\bimport\s*(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*(?:from\s*)?["']([^"']+)["']/g
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
const EXPORT_FROM_RE = /\bexport\s*(?:\*|\{([^}]*)\})\s*from\s*["']([^"']+)["']/g

/**
 * `{ spec, names }` of every import / re-export / literal dynamic import of an ES module, in
 * source order (`names`: imported binding names; `undefined` = namespace, side effect or dynamic).
 * Parsed with Rollup's parser, so text inside strings and comments (e.g. CodeMirror's
 * `import {…} from "…"` completion snippets) is never mistaken for an import. Falls back to the
 * regular expressions if the file does not parse.
 */
export function moduleImports(src) {
  let ast
  try {
    ast = parseAst(src)
  } catch {
    return regexImports(src)
  }
  const out = []
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'ImportDeclaration':
        out.push({
          spec: node.source.value,
          names: node.specifiers.some((x) => x.type === 'ImportNamespaceSpecifier')
            ? undefined
            : node.specifiers.map((x) => (x.type === 'ImportDefaultSpecifier' ? 'default' : importedName(x.imported))),
        })
        return
      case 'ExportNamedDeclaration':
        if (node.source) out.push({ spec: node.source.value, names: node.specifiers.map((x) => importedName(x.local)) })
        break
      case 'ExportAllDeclaration':
        out.push({ spec: node.source.value, names: undefined })
        return
      case 'ImportExpression':
        if (node.source?.type === 'Literal' && typeof node.source.value === 'string') out.push({ spec: node.source.value, names: undefined })
        break
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  return out
}

const importedName = (n) => (n.type === 'Identifier' ? n.name : String(n.value))

function regexImports(src) {
  const out = []
  const names = (list) => (list ?? '').split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)
  for (const m of src.matchAll(IMPORT_RE)) out.push({ spec: m[3], names: names(m[2]) })
  for (const m of src.matchAll(DYNAMIC_RE)) out.push({ spec: m[1], names: undefined })
  for (const m of src.matchAll(EXPORT_FROM_RE)) out.push({ spec: m[2], names: names(m[1]) })
  return out
}

const isBare = (spec) => !(spec.startsWith('.') || spec.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(spec))

/**
 * Checks built ES modules: every bare import must be a shared specifier, and every named import
 * must be exported by that shared module. Returns a list of error strings (empty = ok).
 */
export function checkSharedImports(files, exportsMap = sharedExports()) {
  const errors = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const { spec, names } of moduleImports(src)) {
      if (!isBare(spec)) continue
      const known = exportsMap[spec]
      if (!known) {
        errors.push(`${f}: imports ${JSON.stringify(spec)}, which is not a shared module — bundle it (shared: ${Object.keys(exportsMap).join(', ')})`)
        continue
      }
      for (const name of names ?? []) {
        if (name && name !== 'default' && !known.includes(name)) {
          errors.push(`${f}: ${JSON.stringify(spec)} has no runtime export ${JSON.stringify(name)} in the host`)
        }
      }
    }
  }
  return errors
}
