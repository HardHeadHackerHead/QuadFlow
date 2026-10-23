/**
 * Tile `config` (agent-providers.md §9): the active project's Claude Code
 * setup — CLAUDE.md, `.claude/settings.local.json` env vars, installed skills,
 * sessions and rewind points, permissions. Port of the former shell
 * `claudeConfigStore` + `ClaudeConfigSettings`; all file access goes through
 * `ctx.fs` (`project` / `home` scopes).
 */
import { useCallback, useEffect, useState } from 'react'
import { usePluginContext, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { Badge, Button, EmptyState, Input, Spinner, Tabs, Textarea } from '@quadflow/ui'
import { CONTEXT_FILE, SCAFFOLD_VERSION_FILE, SETTINGS_FILE, SKILLS_DIR, errorMessage, readTextOrNull } from './paths'
import { PermissionsEditor } from './PermissionsPage'
import { RewindView, listSessionFiles, timeAgo, useRewindTarget, type SessionFile } from './RewindView'
import { readSettings, updateSettings } from './settingsFile'

type ConfigTab = 'instructions' | 'env' | 'skills' | 'sessions' | 'permissions'
const TABS: ConfigTab[] = ['instructions', 'env', 'skills', 'sessions', 'permissions']

interface Skill {
  name: string
  description: string
}

/** `description:` from the YAML frontmatter, else the first prose line. */
export function skillDescription(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  const desc = fm && /^description:\s*(.+)$/m.exec(fm[1])
  if (desc) return desc[1].trim().replace(/^["']|["']$/g, '')
  for (const line of md.replace(/^---[\s\S]*?---/, '').split('\n')) {
    const t = line.trim()
    if (t && !t.startsWith('#')) return t
  }
  return ''
}

async function loadSkills(ctx: PluginContext): Promise<Skill[]> {
  const entries = await ctx.fs.list(SKILLS_DIR, 'project').catch(() => [])
  const skills = await Promise.all(
    entries
      .filter((e) => e.kind === 'dir')
      .map(async (e) => {
        const md = await readTextOrNull(ctx, `${SKILLS_DIR}/${e.name}/SKILL.md`, 'project').catch(() => null)
        return { name: e.name, description: md ? skillDescription(md) : '' }
      }),
  )
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function InstructionsTab() {
  const ctx = usePluginContext()
  const [content, setContent] = useState<string | null | undefined>(undefined)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setContent(await readTextOrNull(ctx, CONTEXT_FILE, 'project'))
    } catch (e) {
      setError(errorMessage(e))
      setContent(null)
    }
  }, [ctx])
  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (draft === null) return
    setSaving(true)
    try {
      await ctx.fs.writeText(CONTEXT_FILE, draft, 'project')
      setContent(draft)
      setDraft(null)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  if (content === undefined) return <Spinner />
  return (
    <section className="qf-cc__section" data-testid="claude-config-instructions">
      <div className="qf-cc__row">
        <h4 className="qf-cc__section-title">
          Project instructions <code>{CONTEXT_FILE}</code>
        </h4>
        <span className="qf-cc__spacer" />
        {draft === null ? (
          <Button size="xs" onClick={() => setDraft(content ?? '# Project instructions\n\n')}>
            {content === null ? 'Create' : 'Edit'}
          </Button>
        ) : (
          <>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="xs" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        )}
      </div>
      <div className="qf-cc__muted">
        The <code>quadflow:context</code> region is rewritten by QuadFlow from the project&apos;s context modules; edit around it.
      </div>
      {error && <div className="qf-cc__error">{error}</div>}
      {draft !== null ? (
        <Textarea className="qf-cc__editor" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
      ) : content === null ? (
        <div className="qf-cc__muted">No {CONTEXT_FILE} in this project yet.</div>
      ) : (
        <pre className="qf-cc__pre">{content}</pre>
      )}
    </section>
  )
}

function EnvTab() {
  const ctx = usePluginContext()
  const [env, setEnv] = useState<Record<string, string> | null>(null)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setEnv({ ...((await readSettings(ctx))?.env ?? {}) })
    } catch (e) {
      setError(errorMessage(e))
      setEnv({})
    }
  }, [ctx])
  useEffect(() => {
    void load()
  }, [load])

  const write = async (next: Record<string, string>) => {
    try {
      await updateSettings(ctx, (s) => {
        if (Object.keys(next).length) s.env = next
        else delete s.env
      })
      setEnv(next)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (!env) return <Spinner />
  const add = () => {
    const k = key.trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      setError('Variable names are letters, digits and _ (not starting with a digit).')
      return
    }
    void write({ ...env, [k]: value })
    setKey('')
    setValue('')
  }
  return (
    <section className="qf-cc__section" data-testid="claude-config-env">
      <h4 className="qf-cc__section-title">
        Environment variables <code>{SETTINGS_FILE}</code>
      </h4>
      {error && <div className="qf-cc__error">{error}</div>}
      {Object.keys(env).length === 0 ? (
        <div className="qf-cc__muted">No environment variables.</div>
      ) : (
        <ul className="qf-cc__list">
          {Object.entries(env).map(([k, v]) => (
            <li key={k} className="qf-cc__item">
              <code className="qf-cc__item-key">{k}</code>=<code className="qf-cc__item-main">{v}</code>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const next = { ...env }
                  delete next[k]
                  void write(next)
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="qf-cc__row">
        <Input size="sm" placeholder="KEY" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <Input
          size="sm"
          className="qf-cc__input"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button size="sm" disabled={!key.trim()} onClick={add}>
          Add
        </Button>
      </div>
    </section>
  )
}

function SkillsTab() {
  const ctx = usePluginContext()
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [scaffold, setScaffold] = useState<string | null>(null)
  useEffect(() => {
    void loadSkills(ctx).then(setSkills)
    void readTextOrNull(ctx, SCAFFOLD_VERSION_FILE, 'project').then((v) => setScaffold(v?.trim() || null), () => {})
  }, [ctx])
  if (!skills) return <Spinner />
  return (
    <section className="qf-cc__section" data-testid="claude-config-skills">
      <div className="qf-cc__row">
        <h4 className="qf-cc__section-title">
          Skills <code>{SKILLS_DIR}</code>
        </h4>
        <Badge tone="primary">{skills.length}</Badge>
        <span className="qf-cc__spacer" />
        <Badge tone={scaffold ? 'success' : 'warning'}>{scaffold ? `QuadFlow template v${scaffold}` : 'not set up by QuadFlow'}</Badge>
      </div>
      {skills.length === 0 ? (
        <div className="qf-cc__muted">
          No skills. QuadFlow copies its skills here when the project is opened (Settings → Agents → project setup).
        </div>
      ) : (
        <ul className="qf-cc__list">
          {skills.map((s) => (
            <li key={s.name} className="qf-cc__item" title={s.description}>
              <code className="qf-cc__item-key">/{s.name}</code>
              <span className="qf-cc__item-main qf-cc__muted">{s.description}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionsTab({ cwd }: { cwd: string }) {
  const ctx = usePluginContext()
  const [sessions, setSessions] = useState<SessionFile[] | null>(null)
  useEffect(() => {
    void listSessionFiles(ctx, cwd).then(setSessions, () => setSessions([]))
  }, [ctx, cwd])
  if (!sessions) return <Spinner />
  return (
    <>
      <div className="qf-cc__muted">{sessions.length} session{sessions.length === 1 ? '' : 's'} recorded for this project.</div>
      <RewindView cwd={cwd} />
      {sessions.length > 0 && <div className="qf-cc__muted">Latest activity {timeAgo(sessions[0].modifiedAt)}.</div>}
    </>
  )
}

export function ConfigTile({ setTitle }: TileProps) {
  const ctx = usePluginContext()
  const [project, setProject] = useState(() => ctx.project.current())
  const target = useRewindTarget((s) => s.target)
  const [tab, setTab] = useState<ConfigTab>(target ? 'sessions' : 'instructions')

  useEffect(() => ctx.project.onDidChange(setProject), [ctx])
  useEffect(() => {
    if (target) setTab('sessions')
  }, [target])
  useEffect(() => {
    setTitle(project ? `Claude Config — ${project.name}` : 'Claude Config')
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) {
    return (
      <div className="qf-cc">
        <EmptyState title="No active project" description="Open a project to see its Claude Code configuration." />
      </div>
    )
  }
  const labels: Record<ConfigTab, string> = {
    instructions: 'Instructions',
    env: 'Environment',
    skills: 'Skills',
    sessions: 'Sessions & rewind',
    permissions: 'Permissions',
  }
  return (
    <div className="qf-cc" data-testid="claude-config-tile">
      <div className="qf-cc__header">
        <h3 className="qf-cc__title">Claude Code</h3>
        <span className="qf-cc__muted" title={project.root}>
          {project.name}
        </span>
      </div>
      <Tabs size="sm" value={tab} onChange={setTab} items={TABS.map((t) => ({ value: t, label: labels[t] }))} />
      <div className="qf-cc__body" key={project.root}>
        {tab === 'instructions' && <InstructionsTab />}
        {tab === 'env' && <EnvTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'sessions' && <SessionsTab cwd={project.root} />}
        {tab === 'permissions' && <PermissionsEditor />}
      </div>
    </div>
  )
}
