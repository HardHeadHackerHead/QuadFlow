#!/usr/bin/env node
/**
 * Generates docs/plugins/manifest-reference.md from the manifest JSON Schemas
 * (packages/plugin-api/schema/quadflow-plugin.schema.json + agent-provider.schema.json), so the
 * reference can never drift from what the host validates (plugin-system.md §3.2, PL-10).
 *
 * Usage:
 *   node scripts/gen-plugin-docs.mjs           # write the file (npm run docs:manifest)
 *   node scripts/gen-plugin-docs.mjs --check   # exit 1 if the committed file is stale (npm run check:docs)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_DIR = join(ROOT, 'packages', 'plugin-api', 'schema')
const OUT = join(ROOT, 'docs', 'plugins', 'manifest-reference.md')
const readJson = (f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'))

const manifest = readJson('quadflow-plugin.schema.json')
const provider = readJson('agent-provider.schema.json')
const PROVIDER_ID = provider.$id

/** Small `$defs` rendered inline instead of getting a section. */
const INLINE = {
  relPath: 'path',
  contribId: 'id',
  category: 'category',
  permission: 'permission',
  jsonSchemaObject: 'JSON Schema',
  when: '`when` expression',
  safeArg: 'safe arg',
  argTemplate: 'arg template[]',
  pathList: 'path template[]',
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
// Everything ends up in table cells: escape pipes (GFM renders `\|` inside a code span as `|`).
const code = (v) => `\`${(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\|/g, '\\|')}\``
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')

/**
 * Renders one schema document into sections. Object schemas with properties get a section
 * (`#<prefix><path>`); `$defs` objects referenced from them get one too.
 */
function renderSchema(doc, { prefix, title }) {
  const sections = []
  const queued = new Set()
  const queue = []
  const defSection = (name) => `${prefix}${slug(name)}`

  const resolveRef = (ref) => {
    if (ref.startsWith('#/$defs/')) return { name: ref.slice('#/$defs/'.length), schema: doc.$defs[ref.slice('#/$defs/'.length)] }
    return null
  }

  function typeOf(s, path) {
    if (!s) return 'any'
    if (s.$ref) {
      if (s.$ref === PROVIDER_ID) return '[agentProvider](#agent-provider)'
      const r = resolveRef(s.$ref)
      if (!r) return code(s.$ref)
      if (INLINE[r.name]) return INLINE[r.name]
      if (!queued.has(r.name)) {
        queued.add(r.name)
        queue.push(r)
      }
      return `[${r.name}](#${defSection(r.name)})`
    }
    if (s.const !== undefined) return code(s.const)
    if (s.enum) return s.enum.map(code).join(' \\| ')
    if (s.oneOf) return 'one of: ' + s.oneOf.map((o, i) => typeOf(o, `${path}[${i}]`)).join(' / ')
    if (s.type === 'array') {
      const t = typeOf(s.items, `${path}[]`)
      return t.includes(' \\| ') ? `(${t})[]` : `${t}[]`
    }
    if (s.type === 'object' || s.properties) {
      if (s.properties) {
        sub.push({ path, schema: s })
        return `[object](#${prefix}${slug(path)})`
      }
      if (s.patternProperties) {
        const [k, v] = Object.entries(s.patternProperties)[0]
        return `map ${code(k)} → ${typeOf(v, `${path}{}`)}`
      }
      if (s.additionalProperties && typeof s.additionalProperties === 'object') return `map → ${typeOf(s.additionalProperties, `${path}{}`)}`
      return 'object'
    }
    return s.type ?? 'any'
  }

  function notes(s) {
    const n = []
    if (s.description) n.push(esc(s.description).replace(/\.$/, ''))
    if (s.$ref && resolveRef(s.$ref)?.name === 'relPath' && !/relative/i.test(s.description ?? '')) n.push('relative to the plugin root')
    if (s.default !== undefined) n.push(`default ${code(s.default)}`)
    if (s.pattern) n.push(`pattern ${code(s.pattern)}`)
    if (s.items?.pattern) n.push(`items: pattern ${code(s.items.pattern)}`)
    if (s.minLength !== undefined) n.push(`min length ${s.minLength}`)
    if (s.maxLength !== undefined) n.push(`max length ${s.maxLength}`)
    if (s.minItems !== undefined) n.push(`min ${s.minItems} item(s)`)
    if (s.maximum !== undefined) n.push(`max ${s.maximum}`)
    if (s.uniqueItems) n.push('unique')
    if (s.format) n.push(`format ${s.format}`)
    return n.join('; ')
  }

  let sub = []
  function table(schema, path) {
    const req = new Set(schema.required ?? [])
    const rows = ['| Field | Type | Required | Notes |', '|---|---|---|---|']
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      rows.push(`| \`${k}\` | ${typeOf(v, path ? `${path}.${k}` : k)} | ${req.has(k) ? 'yes' : ''} | ${notes(v)} |`)
    }
    const extra = []
    if (schema.additionalProperties === false) extra.push('No other fields are allowed.')
    if (schema.oneOf && !schema.properties?.oneOf) {
      extra.push(
        'Exactly one of: ' + schema.oneOf.map((o) => (o.required ? o.required.map((r) => `\`${r}\``).join(' + ') : typeOf(o, path))).join(', or ') + '.',
      )
    }
    return [rows.join('\n'), ...extra].join('\n\n')
  }

  function section(heading, anchor, schema, path) {
    sub = []
    const body = [`<a id="${anchor}"></a>`, `### ${heading}`, '']
    if (schema.description) body.push(esc(schema.description), '')
    body.push(table(schema, path))
    sections.push(body.join('\n'))
    // Inline objects found while rendering this table, depth-first.
    const nested = sub
    for (const n of nested) section(`\`${n.path}\``, `${prefix}${slug(n.path)}`, n.schema, n.path)
  }

  section(title, `${prefix}root`, doc, '')
  while (queue.length) {
    const { name, schema } = queue.shift()
    if (schema.properties) section(`\`${name}\``, defSection(name), schema, name)
    else sections.push([`<a id="${defSection(name)}"></a>`, `### \`${name}\``, '', `${typeOf(schema, name)}${notes(schema) ? ` — ${notes(schema)}` : ''}`].join('\n'))
  }
  return sections
}

function inlineDefsTable(doc, names) {
  const rows = ['| Name | Meaning |', '|---|---|']
  for (const n of names) {
    const s = doc.$defs?.[n]
    if (!s) continue
    const t = s.enum ? s.enum.map(code).join(', ') : s.pattern ? `string matching ${code(s.pattern)}` : s.type === 'array' ? `array of ${s.items?.$ref ? s.items.$ref.split('/').pop() : s.items?.type ?? 'any'}` : s.type ?? 'object'
    rows.push(`| ${INLINE[n]} (\`${n}\`) | ${esc(t)}${s.description ? ` — ${esc(s.description)}` : ''} |`)
  }
  return rows.join('\n')
}

const parts = [
  '<!-- @generated by scripts/gen-plugin-docs.mjs from packages/plugin-api/schema/*.schema.json. Do not edit; run `npm run docs:manifest`. -->',
  '# Manifest reference',
  '',
  'Every field of `quadflow-plugin.json`, generated from the JSON Schema the host validates against',
  '(`packages/plugin-api/schema/quadflow-plugin.schema.json`). For what the fields *do*, see',
  '[getting-started.md](getting-started.md) and [plugin-system.md §3](../architecture/plugin-system.md#3-manifest--quadflow-pluginjson).',
  'Point your editor at the schema with `"$schema": "./node_modules/@quadflow/plugin-api/schema/quadflow-plugin.schema.json"`',
  'and run `quadflow-plugin validate` (or `quadflow plugins validate <dir>`) to check a manifest.',
  '',
  '## Value types',
  '',
  inlineDefsTable(manifest, ['relPath', 'contribId', 'category', 'permission', 'when', 'jsonSchemaObject']),
  '',
  'Permissions are explained in [permissions.md](permissions.md).',
  '',
  '## Manifest',
  '',
  ...renderSchema(manifest, { prefix: '', title: '`quadflow-plugin.json`' }).flatMap((s) => [s, '']),
  '<a id="agent-provider"></a>',
  '## Agent provider (`contributes.agentProvider`)',
  '',
  'Schema `packages/plugin-api/schema/agent-provider.schema.json`; see [agent-providers.md](agent-providers.md).',
  'Launch templates may use `{model}`, `{sessionId}`, `{effort}`, `{cwd}`; path templates `{home}`, `{appData}`,',
  '`{localAppData}`, `{cwd|nonalnum-dash}`.',
  '',
  inlineDefsTable(provider, ['safeArg', 'argTemplate', 'pathList']),
  '',
  ...renderSchema(provider, { prefix: 'ap-', title: '`agentProvider`' }).flatMap((s) => [s, '']),
]
const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== text) {
    console.error('gen-plugin-docs: docs/plugins/manifest-reference.md is stale — run `npm run docs:manifest` and commit it')
    process.exit(1)
  }
  console.log('gen-plugin-docs: manifest reference is up to date')
} else {
  writeFileSync(OUT, text)
  console.log('gen-plugin-docs: wrote docs/plugins/manifest-reference.md')
}
