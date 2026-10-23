/**
 * The one Scripts UI, in a pane and in a flyout (compact). Lists package.json,
 * Python and saved scripts plus script groups; runs go to the shared output
 * panel (./RunPanel.tsx); everything else lives in the model (./model.ts).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ScriptInput_Deserialize, TileProps } from '@quadflow/plugin-api'
import { DropdownMenu, type MenuItem } from '@quadflow/ui'
import { launchAgent } from '@quadflow/plugin-kit'
import { AI_SKILLS, SCRIPT_TEMPLATES } from './constants'
import { GroupEditModal } from './GroupEditModal'
import { RunPanel } from './RunPanel'
import { ScriptEditModal } from './ScriptEditModal'
import { PLATFORM, keyOf, runsOnThisPlatform, scriptsModel, type Environment, type RunTarget, type Script, type ScriptGroup } from './model'

type Tab = 'npm' | 'python' | 'saved' | 'groups'

const TAB_STYLE: Record<Tab, string> = {
  saved: 'bg-purple-600 text-white',
  npm: 'bg-teal-600 text-white',
  python: 'bg-yellow-600 text-white',
  groups: 'bg-indigo-600 text-white',
}

function Svg({ d, className = 'w-4 h-4', fill }: { d: string; className?: string; fill?: boolean }) {
  return (
    <svg className={className} fill={fill ? 'currentColor' : 'none'} stroke={fill ? undefined : 'currentColor'} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  )
}
const ICON = {
  terminal: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  bolt: 'M13 10V3L4 14h7v7l9-11h-7z',
  chevron: 'M19 9l-7 7-7-7',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 4v16m8-8H4',
  edit: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  play: 'M8 5v14l11-7z',
  template:
    'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
}

function RunButton({ running, onRun, tone, label = 'Run' }: { running: boolean; onRun(): void; tone: string; label?: string }) {
  return (
    <button
      onClick={onRun}
      disabled={running}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded text-white disabled:bg-vibe-bg disabled:text-vibe-muted ${tone}`}
      title={running ? 'Running' : label}
    >
      {running ? (
        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        <Svg d={ICON.play} className="w-3 h-3" fill />
      )}
      {running ? 'Running' : label}
    </button>
  )
}

function Row({
  name,
  subtitle,
  badges,
  actions,
  tone,
  attr,
}: {
  name: string
  subtitle: string
  badges?: ReactNode
  actions: ReactNode
  tone: string
  attr: Record<string, string>
}) {
  return (
    <div
      {...attr}
      className="group flex items-center gap-2 bg-vibe-bg-lighter border border-vibe-border hover:border-vibe-border-bright rounded-lg px-2.5 py-2"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`font-medium text-sm ${tone}`}>{name}</span>
          {badges}
        </div>
        <p className="text-xs text-vibe-muted truncate mt-0.5" title={subtitle}>
          {subtitle}
        </p>
      </div>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  )
}

function Badge({ children, className }: { children: ReactNode; className: string }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-medium ${className}`}>{children}</span>
}

function Empty({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="text-center text-vibe-muted py-10">
      <Svg d={ICON.terminal} className="w-10 h-10 mx-auto mb-2 opacity-50" />
      <p className="text-sm">{title}</p>
      {hint && <p className="text-xs mt-1 opacity-75">{hint}</p>}
      {children}
    </div>
  )
}

function HoverButton({ title, onClick, d, danger }: { title: string; onClick(): void; d: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded text-vibe-muted opacity-0 group-hover:opacity-100 focus:opacity-100 ${danger ? 'hover:text-red-400 hover:bg-red-500/10' : 'hover:text-vibe-text hover:bg-vibe-bg'}`}
    >
      <Svg d={d} className="w-3.5 h-3.5" />
    </button>
  )
}

export function ScriptsTile({ ctx, mode, visible }: TileProps) {
  const model = useMemo(() => scriptsModel(ctx), [ctx])
  useEffect(() => model.retain(), [model])
  const compact = mode === 'flyout'

  const scripts = model.scripts.use((s) => s.items)
  const scriptsLoading = model.scripts.use((s) => s.loading && s.items.length === 0)
  const scriptsError = model.scripts.use((s) => s.error)
  const corrupt = model.scripts.use((s) => s.corrupt)
  const groups = model.groups.use((s) => s.items)
  const root = model.scripts.use((s) => s.root)
  const { npm, npmError, python, loading: detecting } = model.detected()
  const environments = model.env((s) => s.list)
  const defaultEnv = model.env((s) => s.defaultName)
  const envDetecting = model.env((s) => s.detecting)
  const runs = model.runsStore((s) => s.runs)
  const af = model.autoFix()
  const { tab, tabChosen, runInNewTerminal, newScriptPending } = model.ui()

  const [editing, setEditing] = useState<Script | 'new' | null>(null)
  const [editingGroup, setEditingGroup] = useState<ScriptGroup | 'new' | null>(null)

  const saved = useMemo(() => scripts.filter(runsOnThisPlatform), [scripts])
  const project = ctx.project.current()

  // First view of a project: the tab that has something to run.
  useEffect(() => {
    if (tabChosen || scriptsLoading || detecting) return
    const next: Tab = saved.length > 0 ? 'saved' : npm.length > 0 ? 'npm' : python.length > 0 ? 'python' : 'saved'
    if (next !== tab) model.ui.setState({ tab: next })
  }, [model, tabChosen, scriptsLoading, detecting, saved.length, npm.length, python.length, tab])

  // Commands open a tile only when none is visible.
  useEffect(() => {
    if (!visible) return
    model.ui.setState((s) => ({ visibleTiles: s.visibleTiles + 1 }))
    return () => model.ui.setState((s) => ({ visibleTiles: Math.max(0, s.visibleTiles - 1) }))
  }, [model, visible])

  // `new-script` command → the first visible tile opens the editor.
  useEffect(() => {
    if (!newScriptPending || !visible) return
    model.ui.setState({ newScriptPending: false, tab: 'saved', tabChosen: true })
    setEditing('new')
  }, [model, newScriptPending, visible])

  const setTab = (t: Tab) => model.ui.setState({ tab: t, tabChosen: true })
  const running = (t: RunTarget) => runs.some((r) => r.key === keyOf(t) && (r.status === 'running' || r.status === 'starting'))
  const groupRunning = (g: ScriptGroup) => runs.some((r) => r.groupId === g.id && (r.status === 'running' || r.status === 'starting'))
  const envOf = (name: string | null | undefined): Environment | undefined =>
    name ? environments.find((e) => e.name.toLowerCase() === name.toLowerCase()) : undefined

  const guard = async (title: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      return true
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title, body: e instanceof Error ? e.message : String(e) })
      return false
    }
  }

  const saveScript = async (input: ScriptInput_Deserialize) => {
    const target = editing
    const ok = await guard(`Could not save "${input.name}"`, () =>
      target && target !== 'new' ? model.updateScript(target.id, input) : model.createScript(input),
    )
    if (ok) setEditing(null)
  }

  const deleteScript = async (s: Script) => {
    if (!(await ctx.ui.confirm({ title: 'Delete script?', message: `"${s.name}" is removed from the project and from every group.`, confirmLabel: 'Delete', danger: true }))) return
    await guard(`Could not delete "${s.name}"`, () => model.deleteScript(s.id))
  }

  const deleteGroup = async (g: ScriptGroup) => {
    if (!(await ctx.ui.confirm({ title: 'Delete group?', message: `The group "${g.name}" is deleted (its scripts stay).`, confirmLabel: 'Delete', danger: true }))) return
    await guard(`Could not delete "${g.name}"`, () => model.deleteGroup(g.id))
  }

  const templates = SCRIPT_TEMPLATES.filter((t) => t.platform === 'all' || t.platform === PLATFORM)

  const optionItems: MenuItem[] = [
    { type: 'label', label: 'Run options' },
    {
      id: 'auto-fix',
      label: 'Auto-fix failed builds',
      description: 'Send errors to an agent, then re-run (up to 5 times)',
      checked: af.enabled,
      disabled: af.active || runInNewTerminal,
      onSelect: () => model.autoFix.setState({ enabled: !af.enabled }),
    },
    {
      id: 'new-terminal',
      label: 'Run in a new terminal tile',
      checked: runInNewTerminal,
      disabled: af.active,
      onSelect: () => model.ui.setState({ runInNewTerminal: !runInNewTerminal }),
    },
    { type: 'separator' },
    { id: 'refresh', label: 'Refresh detected scripts', onSelect: () => void model.reloadDetected() },
    { id: 'detect-env', label: envDetecting ? 'Detecting environments…' : 'Detect terminal environments', disabled: envDetecting, onSelect: () => void model.reloadEnvironments(true) },
  ]

  const aiItems: MenuItem[] = [
    { type: 'label', label: 'Opens a new agent session' },
    ...AI_SKILLS.map(
      (s): MenuItem => ({
        id: s.id,
        label: s.name,
        description: s.description,
        onSelect: () => void launchAgent(ctx, s.command, { preferred: 'claude-code', autoSubmit: true }),
      }),
    ),
  ]

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'saved', label: compact ? 'Saved' : 'Saved scripts', count: saved.length },
    { id: 'npm', label: compact ? 'npm' : 'package.json', count: npm.length },
    { id: 'python', label: 'Python', count: python.length },
    { id: 'groups', label: 'Groups', count: groups.length },
  ]

  if (!project) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted text-sm" data-scripts-tile={mode}>
        Open a project to see its scripts.
      </div>
    )
  }

  const pad = compact ? 'px-2 py-1.5' : 'px-3 py-2'

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden" data-scripts-tile={mode}>
      {/* Header */}
      <div className={`flex-shrink-0 border-b border-vibe-border ${pad} space-y-1.5`}>
        <div className="flex items-center gap-2">
          <Svg d={ICON.terminal} className="w-4 h-4 text-green-400 flex-shrink-0" />
          <select
            value={defaultEnv ?? ''}
            onChange={(e) => void model.setDefaultEnvironment(e.target.value || null)}
            className="min-w-0 max-w-[45%] text-xs px-1.5 py-1 bg-vibe-bg-lighter border border-vibe-border rounded text-vibe-text"
            title="Environment for scripts that name none (and for package.json / Python scripts)"
            aria-label="Default environment"
          >
            <option value="">Default shell</option>
            {environments
              .filter((e) => e.available || e.name === defaultEnv)
              .map((e) => (
                <option key={e.id} value={e.name}>
                  {e.name}
                </option>
              ))}
          </select>
          <div className="flex-1" />
          {af.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 flex items-center gap-0.5" title="Auto-fix is on">
              <Svg d={ICON.bolt} className="w-3 h-3" fill />
              {!compact && 'Auto-fix'}
            </span>
          )}
          <DropdownMenu
            placement="bottom-end"
            overlayId="scripts-ai"
            items={aiItems}
            trigger={
              <button className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-purple-600/10 text-purple-400 hover:bg-purple-600/20" title="AI actions">
                <Svg d={ICON.bolt} className="w-3.5 h-3.5" />
                AI
              </button>
            }
          />
          <DropdownMenu
            placement="bottom-end"
            overlayId="scripts-options"
            items={optionItems}
            trigger={
              <button className="p-1 rounded text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg-lighter" title="Options" aria-label="Script options">
                <Svg d={ICON.dots} className="w-4 h-4" />
              </button>
            }
          />
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              data-scripts-tab={t.id}
              className={`${compact ? 'px-2 py-1 text-xs' : 'px-2.5 py-1 text-sm'} rounded whitespace-nowrap ${
                tab === t.id ? TAB_STYLE[t.id] : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg-lighter'
              }`}
            >
              {t.label}
              {t.count > 0 && <span className="ml-1 text-xs opacity-75">({t.count})</span>}
            </button>
          ))}
        </div>
        {!compact && (
          <div className="text-[11px] text-vibe-muted truncate" title={root ?? project.root}>
            {root ?? project.root}
          </div>
        )}
      </div>

      {/* List */}
      <div className={`flex-1 min-h-0 overflow-y-auto ${compact ? 'p-2' : 'p-3'} space-y-1.5`}>
        {tab === 'saved' && (
          <>
            <div className="flex gap-2">
              <button
                onClick={() => setEditing('new')}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-vibe-border rounded-lg text-sm text-vibe-muted hover:text-purple-400 hover:border-purple-500/50"
              >
                <Svg d={ICON.plus} />
                New Script
              </button>
              <DropdownMenu
                placement="bottom-end"
                overlayId="scripts-templates"
                items={[
                  { type: 'label', label: 'Add from a template' },
                  ...templates.map(
                    (t, i): MenuItem => ({
                      id: `tpl-${i}`,
                      label: t.name,
                      description: t.description,
                      onSelect: () => void guard(`Could not add "${t.name}"`, () => model.createScript(t.template)),
                    }),
                  ),
                ]}
                trigger={
                  <button className="h-full flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-vibe-border rounded-lg text-sm text-vibe-muted hover:text-amber-400 hover:border-amber-500/50" title="Templates">
                    <Svg d={ICON.template} />
                    {!compact && 'Templates'}
                  </button>
                }
              />
            </div>
            {corrupt.length > 0 && (
              <p className="text-xs text-amber-400" title={corrupt.map((c) => `${c.path}: ${c.message}`).join('\n')}>
                {corrupt.length} script file(s) could not be read.
              </p>
            )}
            {scriptsError && <p className="text-xs text-red-400">{scriptsError}</p>}
            {saved.length === 0 && !scriptsLoading ? (
              <Empty title="No saved scripts yet" hint="Save builds with their environment, setup commands and variables. Agents can add them with `quadflow scripts create`." />
            ) : (
              saved.map((s) => {
                const t: RunTarget = { type: 'saved', script: s }
                const e = envOf(s.environment)
                return (
                  <Row
                    key={s.id}
                    attr={{ 'data-script-row': s.name }}
                    name={s.name}
                    subtitle={s.description || s.command}
                    tone="text-purple-400"
                    badges={
                      <>
                        {s.kind !== 'command' && <Badge className={s.kind === 'server' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-orange-500/20 text-orange-400'}>{s.kind}</Badge>}
                        {s.platforms && s.platforms.length > 0 && <Badge className="bg-vibe-bg text-vibe-muted">{s.platforms.join(', ')}</Badge>}
                        {s.environment && (
                          <Badge className={e?.available ? 'bg-amber-500/20 text-amber-400 normal-case' : 'bg-red-500/20 text-red-400 normal-case'}>
                            {e?.available ? s.environment : `${s.environment} (missing)`}
                          </Badge>
                        )}
                        {s.env && Object.keys(s.env).length > 0 && <Badge className="bg-amber-500/10 text-amber-400 normal-case">{Object.keys(s.env).length} env</Badge>}
                      </>
                    }
                    actions={
                      <>
                        <HoverButton title="Edit script" d={ICON.edit} onClick={() => setEditing(s)} />
                        <HoverButton title="Delete script" d={ICON.trash} danger onClick={() => void deleteScript(s)} />
                        <RunButton running={running(t)} onRun={() => void model.run(t)} tone="bg-purple-600 hover:bg-purple-500" />
                      </>
                    }
                  />
                )
              })
            )}
          </>
        )}

        {tab === 'npm' &&
          (npm.length === 0 ? (
            <Empty title={npmError ?? 'No scripts in package.json'} hint={npmError ? undefined : 'Add scripts to your package.json'}>
              <button onClick={() => void model.reloadDetected()} className="mt-2 text-xs text-teal-400 hover:text-teal-300">
                Refresh
              </button>
            </Empty>
          ) : (
            npm.map((s) => {
              const t: RunTarget = { type: 'npm', script: s }
              return (
                <Row
                  key={s.name}
                  attr={{ 'data-script-row': s.name }}
                  name={s.name}
                  subtitle={s.command}
                  tone="text-teal-400"
                  actions={<RunButton running={running(t)} onRun={() => void model.run(t)} tone="bg-teal-600 hover:bg-teal-500" />}
                />
              )
            })
          ))}

        {tab === 'python' &&
          (python.length === 0 ? (
            <Empty title="No Python project detected" hint="Add a pyproject.toml, requirements.txt or a Python entry point" />
          ) : (
            python.map((s) => {
              const t: RunTarget = { type: 'python', script: s }
              return (
                <Row
                  key={s.name}
                  attr={{ 'data-script-row': s.name }}
                  name={s.name}
                  subtitle={s.command}
                  tone="text-yellow-400"
                  actions={<RunButton running={running(t)} onRun={() => void model.run(t)} tone="bg-yellow-600 hover:bg-yellow-500" />}
                />
              )
            })
          ))}

        {tab === 'groups' && (
          <>
            <button
              onClick={() => setEditingGroup('new')}
              disabled={saved.length === 0}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-vibe-border rounded-lg text-sm text-vibe-muted hover:text-indigo-400 hover:border-indigo-500/50 disabled:opacity-40"
              title={saved.length === 0 ? 'Save a script first' : 'New group'}
            >
              <Svg d={ICON.plus} />
              New Group
            </button>
            {groups.length === 0 ? (
              <Empty title="No script groups" hint="Group scripts to start your whole dev stack (parallel) or a pipeline (sequential) with one click." />
            ) : (
              groups.map((g) => {
                const byId = new Map(scripts.map((s) => [s.id, s]))
                const members = g.members ?? []
                return (
                  <Row
                    key={g.id}
                    attr={{ 'data-script-group': g.name }}
                    name={g.name}
                    tone="text-indigo-400"
                    subtitle={
                      members.length === 0
                        ? 'No scripts'
                        : members.map((m) => byId.get(m.scriptId)?.name ?? '(missing script)').join(g.mode === 'sequential' ? ' → ' : ' + ')
                    }
                    badges={<Badge className="bg-vibe-bg text-vibe-muted">{g.mode}</Badge>}
                    actions={
                      <>
                        <HoverButton title="Edit group" d={ICON.edit} onClick={() => setEditingGroup(g)} />
                        <HoverButton title="Delete group" d={ICON.trash} danger onClick={() => void deleteGroup(g)} />
                        <RunButton
                          running={groupRunning(g)}
                          onRun={() => void model.runGroup(g)}
                          tone="bg-indigo-600 hover:bg-indigo-500"
                          label={members.length === 0 ? 'Empty' : 'Run'}
                        />
                      </>
                    }
                  />
                )
              })
            )}
          </>
        )}
      </div>

      {/* Auto-fix status */}
      {(af.active || af.phase === 'success' || af.phase === 'failed') && af.label && (
        <div
          className={`flex-shrink-0 flex items-center gap-2 ${pad} border-t text-xs ${
            af.phase === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' : af.phase === 'failed' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
          }`}
          data-autofix-phase={af.phase}
        >
          {af.active && <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />}
          <span className="flex-1 min-w-0 truncate">
            Auto-fix {af.label}: {af.message}
            {af.active && <span className="opacity-60"> (attempt {af.attempt})</span>}
          </span>
          {af.active ? (
            <button onClick={() => void model.stopAutoFix()} className="px-2 py-0.5 rounded hover:bg-amber-500/20">
              Stop
            </button>
          ) : (
            <button onClick={() => model.autoFix.setState({ label: '', phase: 'idle' })} className="px-1 rounded hover:bg-vibe-bg-lighter" title="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      <RunPanel ctx={ctx} model={model} compact={compact} visible={visible} />

      {editing && (
        <ScriptEditModal
          key={editing === 'new' ? 'new' : editing.id}
          open
          script={editing === 'new' ? null : editing}
          environments={environments}
          onSave={saveScript}
          onClose={() => setEditing(null)}
        />
      )}
      {editingGroup && (
        <GroupEditModal
          key={editingGroup === 'new' ? 'new' : editingGroup.id}
          open
          group={editingGroup === 'new' ? null : editingGroup}
          scripts={saved}
          onSave={async (g) => {
            const target = editingGroup
            const ok = await guard(`Could not save "${g.name}"`, () => model.saveGroup(target === 'new' ? null : target.id, g))
            if (ok) setEditingGroup(null)
          }}
          onClose={() => setEditingGroup(null)}
        />
      )}
    </div>
  )
}
