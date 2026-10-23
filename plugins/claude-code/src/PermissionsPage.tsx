/**
 * Settings page `permissions` (agent-providers.md §9): Claude Code permission
 * rules of the active project's `.claude/settings.local.json` (`permissions.allow`
 * / `permissions.deny`). Port of the former shell `claudePermissionsStore` +
 * `PermissionsSettings`; the catalog grants the QuadFlow CLI as `Bash(quadflow:*)`.
 * Keys this page does not edit are preserved.
 */
import { useCallback, useEffect, useState } from 'react'
import { usePluginContext, type PluginContext, type SettingsPageProps } from '@quadflow/plugin-api'
import { Badge, Button, EmptyState, Input, Select, Spinner, Switch } from '@quadflow/ui'
import { SETTINGS_FILE, errorMessage } from './paths'
import { readSettings, updateSettings } from './settingsFile'

export interface CatalogPermission {
  rule: string
  label: string
  description: string
  defaultEnabled: boolean
}
export interface PermissionCategory {
  id: string
  name: string
  permissions: CatalogPermission[]
}

const p = (rule: string, label: string, description: string, defaultEnabled = true): CatalogPermission => ({
  rule,
  label,
  description,
  defaultEnabled,
})

export const PERMISSIONS_CATALOG: PermissionCategory[] = [
  {
    id: 'quadflow',
    name: 'QuadFlow',
    permissions: [p('Bash(quadflow:*)', 'quadflow CLI', 'Ideas, issues, plans, scripts, ship, missions … (all QuadFlow skills need it)')],
  },
  {
    id: 'bash-build',
    name: 'Bash: build',
    permissions: [
      p('Bash(npm run:*)', 'npm run', 'Run npm scripts'),
      p('Bash(npm install:*)', 'npm install', 'Install npm packages', false),
      p('Bash(npx:*)', 'npx', 'Run npx commands', false),
      p('Bash(node:*)', 'node', 'Run Node.js scripts', false),
      p('Bash(cargo build:*)', 'cargo build', 'Build Rust crates'),
      p('Bash(cargo check:*)', 'cargo check', 'Type-check Rust crates'),
      p('Bash(cargo test:*)', 'cargo test', 'Run Rust tests'),
      p('Bash(python:*)', 'python', 'Run Python scripts', false),
    ],
  },
  {
    id: 'bash-git',
    name: 'Bash: git',
    permissions: [
      p('Bash(git status:*)', 'git status', 'View working tree status'),
      p('Bash(git diff:*)', 'git diff', 'Show changes'),
      p('Bash(git log:*)', 'git log', 'View commit history'),
      p('Bash(git add:*)', 'git add', 'Stage changes'),
      p('Bash(git commit:*)', 'git commit', 'Create commits'),
      p('Bash(git branch:*)', 'git branch', 'Manage branches'),
      p('Bash(gh:*)', 'gh', 'GitHub CLI', false),
    ],
  },
  {
    id: 'bash-read',
    name: 'Bash: read-only shell',
    permissions: [
      p('Bash(ls:*)', 'ls', 'List directory contents'),
      p('Bash(dir:*)', 'dir', 'List directory (Windows)'),
      p('Bash(cat:*)', 'cat', 'Print files'),
      p('Bash(grep:*)', 'grep', 'Search file contents'),
      p('Bash(find:*)', 'find', 'Find files', false),
    ],
  },
  {
    id: 'web',
    name: 'Web',
    permissions: [
      p('WebSearch', 'Web search', 'Search the web'),
      p('WebFetch(domain:github.com)', 'github.com', 'Fetch pages from github.com', false),
      p('WebFetch(domain:docs.anthropic.com)', 'docs.anthropic.com', 'Fetch Anthropic docs', false),
    ],
  },
]

const CATALOG_RULES = new Set(PERMISSIONS_CATALOG.flatMap((c) => c.permissions.map((x) => x.rule)))
export const DEFAULT_RULES = PERMISSIONS_CATALOG.flatMap((c) => c.permissions.filter((x) => x.defaultEnabled).map((x) => x.rule))

interface Rules {
  allow: string[]
  deny: string[]
}

async function loadRules(ctx: PluginContext): Promise<Rules> {
  const s = await readSettings(ctx)
  const perms = s?.permissions ?? {}
  return {
    allow: Array.isArray(perms.allow) ? [...perms.allow] : [],
    deny: Array.isArray(perms.deny) ? [...perms.deny] : [],
  }
}

async function saveRules(ctx: PluginContext, rules: Rules): Promise<void> {
  await updateSettings(ctx, (s) => {
    s.permissions = { ...(s.permissions ?? {}), allow: rules.allow, deny: rules.deny }
  })
}

export function PermissionsEditor() {
  const ctx = usePluginContext()
  const [project, setProject] = useState(() => ctx.project.current())
  const [rules, setRules] = useState<Rules | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [custom, setCustom] = useState('')
  const [customKind, setCustomKind] = useState<'allow' | 'deny'>('allow')

  useEffect(() => ctx.project.onDidChange(setProject), [ctx])

  const reload = useCallback(async () => {
    setError(null)
    try {
      setRules(await loadRules(ctx))
    } catch (e) {
      setError(errorMessage(e))
      setRules({ allow: [], deny: [] })
    }
  }, [ctx])

  useEffect(() => {
    setRules(null)
    if (project) void reload()
  }, [project, reload])

  const apply = async (next: Rules) => {
    setRules(next)
    try {
      await saveRules(ctx, next)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
      void reload()
    }
  }

  if (!project) {
    return <EmptyState title="No active project" description="Open a project to edit its Claude Code permissions." />
  }
  if (!rules) return <Spinner />

  const toggle = (rule: string, on: boolean) =>
    void apply({ ...rules, allow: on ? [...new Set([...rules.allow, rule])] : rules.allow.filter((r) => r !== rule) })
  const addCustom = () => {
    const rule = custom.trim()
    if (!rule) return
    const list = rules[customKind]
    if (!list.includes(rule)) void apply({ ...rules, [customKind]: [...list, rule] })
    setCustom('')
  }
  const remove = (kind: 'allow' | 'deny', rule: string) => void apply({ ...rules, [kind]: rules[kind].filter((r) => r !== rule) })
  const customAllow = rules.allow.filter((r) => !CATALOG_RULES.has(r))
  const customDeny = rules.deny.filter((r) => !CATALOG_RULES.has(r))

  return (
    <div className="qf-cc__page" data-testid="claude-permissions">
      <div className="qf-cc__info">
        <strong>Claude Code permissions</strong>
        <div className="qf-cc__muted">
          Commands Claude Code may run without asking in <strong>{project.name}</strong>, saved to <code>{SETTINGS_FILE}</code>.
        </div>
      </div>
      <div className="qf-cc__row">
        <Button size="sm" onClick={() => void apply({ ...rules, allow: [...new Set([...rules.allow, ...DEFAULT_RULES])] })}>
          Apply defaults
        </Button>
        <Button size="sm" variant="danger" onClick={() => void apply({ allow: [], deny: [] })}>
          Clear all
        </Button>
        <span className="qf-cc__spacer" />
        <Badge tone="neutral">
          {rules.allow.length} allow · {rules.deny.length} deny
        </Badge>
      </div>
      {error && <div className="qf-cc__error">{error}</div>}

      {PERMISSIONS_CATALOG.map((cat) => {
        const on = cat.permissions.filter((x) => rules.allow.includes(x.rule)).length
        return (
          <section key={cat.id} className="qf-cc__section" data-testid={`claude-permissions-${cat.id}`}>
            <h4 className="qf-cc__section-title">
              {cat.name}
              <span className="qf-cc__muted">
                {on}/{cat.permissions.length}
              </span>
            </h4>
            <div className="qf-cc__grid">
              {cat.permissions.map((x) => (
                <Switch
                  key={x.rule}
                  checked={rules.allow.includes(x.rule)}
                  onChange={(v) => toggle(x.rule, v)}
                  label={x.label}
                  description={x.description}
                />
              ))}
            </div>
          </section>
        )
      })}

      {(customAllow.length > 0 || customDeny.length > 0) && (
        <section className="qf-cc__section">
          <h4 className="qf-cc__section-title">Custom rules</h4>
          <ul className="qf-cc__list">
            {customAllow.map((r) => (
              <RuleRow key={`a:${r}`} kind="allow" rule={r} onRemove={() => remove('allow', r)} />
            ))}
            {customDeny.map((r) => (
              <RuleRow key={`d:${r}`} kind="deny" rule={r} onRemove={() => remove('deny', r)} />
            ))}
          </ul>
        </section>
      )}

      <section className="qf-cc__section">
        <h4 className="qf-cc__section-title">Add a rule</h4>
        <div className="qf-cc__row">
          <Select
            size="sm"
            value={customKind}
            onChange={setCustomKind}
            options={[
              { value: 'allow', label: 'Allow' },
              { value: 'deny', label: 'Deny' },
            ]}
          />
          <Input
            size="sm"
            className="qf-cc__input"
            value={custom}
            placeholder="e.g. Bash(docker:*)"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          <Button size="sm" disabled={!custom.trim()} onClick={addCustom}>
            Add
          </Button>
        </div>
      </section>
    </div>
  )
}

function RuleRow({ kind, rule, onRemove }: { kind: 'allow' | 'deny'; rule: string; onRemove(): void }) {
  return (
    <li className="qf-cc__item">
      <Badge tone={kind === 'allow' ? 'success' : 'error'}>{kind}</Badge>
      <code className="qf-cc__item-main">{rule}</code>
      <Button size="xs" variant="ghost" onClick={onRemove} aria-label={`Remove ${rule}`}>
        Remove
      </Button>
    </li>
  )
}

export function PermissionsPage(_props: SettingsPageProps) {
  return (
    <div className="qf-cc qf-cc--page">
      <PermissionsEditor />
    </div>
  )
}
