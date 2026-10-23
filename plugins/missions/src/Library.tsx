/**
 * The Templates and Agents tabs: browse, launch, create and edit mission
 * templates (project-shared) and agent definitions (app-wide). Built-ins are
 * consts in the core — "editing" one saves a custom copy.
 */
import { useEffect, useState } from 'react'
import { Modal } from '@quadflow/ui'
import type { AgentDefinition, MissionAgentRole, MissionTemplateCategory, ModelInfo, PluginContext } from '@quadflow/plugin-api'
import { attempt, type MissionsModel, type Template } from './model'
import { ROLES, TEMPLATE_CATEGORIES, agentRoleConfig, roleLook, templateCategoryConfig } from './display'
import { Empty, ProviderBadge, RoleBadge, Scoped, ghostBtn, inputCls, primaryBtn, smallBtn } from './bits'

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)

// ---------------------------------------------------------------- templates

export function TemplatesTab({ ctx, model, onLaunch }: { ctx: PluginContext; model: MissionsModel; onLaunch: (templateId: string) => void }) {
  const templates = model.extra((s) => s.templates)
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const [confirm, setConfirm] = useState<Template | null>(null)

  useEffect(() => {
    void model.loadTemplates().catch(() => {})
  }, [model])

  const groups = TEMPLATE_CATEGORIES.map((c) => ({ c, items: templates.filter((t) => t.category === c) })).filter((g) => g.items.length > 0)

  return (
    <div className="p-3 space-y-4" data-testid="templates-tab">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-vibe-muted">Mission templates are playbooks: workflow phases, skills, success criteria and extra prompts for the coordinator and members.</p>
        <button data-testid="template-new" onClick={() => setEditing('new')} className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 flex-shrink-0`}>
          + New Template
        </button>
      </div>
      {templates.length === 0 && <Empty>No mission templates found</Empty>}
      {groups.map(({ c, items }) => (
        <div key={c}>
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-xs font-medium ${templateCategoryConfig[c].color}`}>{templateCategoryConfig[c].label}</span>
            <span className="text-[11px] text-vibe-muted">{templateCategoryConfig[c].description}</span>
          </div>
          <div className="space-y-2">
            {items.map((t) => (
              <div key={t.id} data-testid="template-card" data-template-name={t.name} className="bg-vibe-bg-lighter rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-vibe-text">{t.name}</span>
                    <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${t.builtIn ? 'bg-teal-500/20 text-teal-400' : 'bg-purple-500/20 text-purple-400'}`}>{t.builtIn ? 'built-in' : 'custom'}</span>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button data-testid="template-edit" onClick={() => setEditing(t)} className={`${smallBtn} text-vibe-muted hover:text-vibe-text`}>
                      {t.builtIn ? 'Customize' : 'Edit'}
                    </button>
                    {!t.builtIn && (
                      <button onClick={() => setConfirm(t)} className={`${smallBtn} text-vibe-muted hover:text-red-400`}>
                        Delete
                      </button>
                    )}
                    <button data-testid="template-launch" onClick={() => onLaunch(t.id)} className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30`}>
                      Launch
                    </button>
                  </div>
                </div>
                {t.description && <div className="text-xs text-vibe-muted">{t.description}</div>}
                {(t.skillsUsed ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {(t.skillsUsed ?? []).map((s) => (
                      <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-vibe-bg text-vibe-muted">
                        /{s}
                      </span>
                    ))}
                  </div>
                )}
                {(t.workflowPhases ?? []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-vibe-muted">
                    {(t.workflowPhases ?? []).map((p, i) => (
                      <span key={`${p.name}-${i}`}>
                        {i > 0 && <span className="opacity-50 mr-1">{'>'}</span>}
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
                {(t.successCriteria ?? []).length > 0 && (
                  <div className="text-[10px] text-vibe-muted">
                    <span className="text-green-400">Success:</span> {(t.successCriteria ?? []).join(' | ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <TemplateEditor ctx={ctx} model={model} template={editing} onClose={() => setEditing(null)} />
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Delete template?"
        size="sm"
        overlayId="missions-template-delete"
        footer={
          <Scoped>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className={ghostBtn}>
                Cancel
              </button>
              <button
                onClick={() => {
                  const t = confirm
                  setConfirm(null)
                  if (t) void attempt(ctx, 'Could not delete the template', () => model.deleteTemplate(t.id))
                }}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded"
              >
                Delete
              </button>
            </div>
          </Scoped>
        }
      >
        <Scoped>
          <p className="text-sm text-vibe-muted">"{confirm?.name}" is removed for everyone on this project. Missions created from it keep their playbook.</p>
        </Scoped>
      </Modal>
    </div>
  )
}

interface TemplateForm {
  name: string
  description: string
  category: MissionTemplateCategory
  phases: string
  skills: string
  criteria: string
  orchestratorPromptExtra: string
  memberPromptExtra: string
}

function toForm(t: Template | null): TemplateForm {
  return {
    name: t?.name ?? '',
    description: t?.description ?? '',
    category: t?.category ?? 'general',
    phases: (t?.workflowPhases ?? []).map((p) => (p.description ? `${p.name}: ${p.description}` : p.name)).join('\n'),
    skills: (t?.skillsUsed ?? []).join(', '),
    criteria: (t?.successCriteria ?? []).join('\n'),
    orchestratorPromptExtra: t?.orchestratorPromptExtra ?? '',
    memberPromptExtra: t?.memberPromptExtra ?? '',
  }
}

function TemplateEditor({ ctx, model, template, onClose }: { ctx: PluginContext; model: MissionsModel; template: Template | 'new' | null; onClose: () => void }) {
  const t = template === 'new' ? null : template
  const [f, setF] = useState<TemplateForm>(toForm(null))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (template) setF(toForm(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template])

  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setF((p) => ({ ...p, [k]: v }))
  const save = async () => {
    if (!f.name.trim()) return
    setBusy(true)
    const original = t?.workflowPhases ?? []
    const saved = await attempt(ctx, 'Could not save the template', () =>
      model.upsertTemplate({
        id: t && !t.builtIn ? t.id : null,
        name: f.name.trim(),
        description: f.description.trim() || null,
        category: f.category,
        workflowPhases: lines(f.phases).map((l) => {
          const i = l.indexOf(':')
          const name = (i > 0 ? l.slice(0, i) : l).trim()
          const prev = original.find((p) => p.name === name)
          return { name, description: i > 0 ? l.slice(i + 1).trim() || null : null, gate: prev?.gate ?? null, skills: prev?.skills ?? [] }
        }),
        skillsUsed: f.skills.split(',').map((s) => s.trim().replace(/^\//, '')).filter(Boolean),
        successCriteria: lines(f.criteria),
        orchestratorPromptExtra: f.orchestratorPromptExtra.trim() || null,
        memberPromptExtra: f.memberPromptExtra.trim() || null,
      }),
    )
    setBusy(false)
    if (saved) {
      ctx.notifications.toast({ kind: 'success', title: t?.builtIn ? `Saved a custom copy of "${t.name}"` : 'Template saved' })
      onClose()
    }
  }

  return (
    <Modal
      open={!!template}
      onClose={onClose}
      size="lg"
      overlayId="missions-template-edit"
      title={t ? (t.builtIn ? `Customize "${t.name}"` : `Edit "${t.name}"`) : 'New Template'}
      description={t?.builtIn ? 'Built-in templates cannot change; saving creates a custom template in this project.' : undefined}
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
            <button data-testid="template-save" onClick={save} disabled={!f.name.trim() || busy} className={primaryBtn}>
              Save
            </button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="space-y-2.5">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block text-[11px] text-vibe-muted mb-1">Name</label>
              <input data-testid="template-name" value={f.name} onChange={(e) => set('name', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Category</label>
              <select value={f.category} onChange={(e) => set('category', e.target.value as MissionTemplateCategory)} className={inputCls}>
                {TEMPLATE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {templateCategoryConfig[c].label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Description</label>
            <input data-testid="template-description" value={f.description} onChange={(e) => set('description', e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Workflow phases (one per line, "Name: description")</label>
              <textarea rows={4} value={f.phases} onChange={(e) => set('phases', e.target.value)} className={`${inputCls} resize-y font-mono text-xs`} />
            </div>
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Success criteria (one per line)</label>
              <textarea data-testid="template-criteria" rows={4} value={f.criteria} onChange={(e) => set('criteria', e.target.value)} className={`${inputCls} resize-y text-xs`} />
            </div>
          </div>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Skills (comma-separated)</label>
            <input value={f.skills} onChange={(e) => set('skills', e.target.value)} placeholder="triage-issues, review-spec" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Coordinator prompt extra</label>
              <textarea rows={3} value={f.orchestratorPromptExtra} onChange={(e) => set('orchestratorPromptExtra', e.target.value)} className={`${inputCls} resize-y text-xs`} />
            </div>
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Member prompt extra</label>
              <textarea rows={3} value={f.memberPromptExtra} onChange={(e) => set('memberPromptExtra', e.target.value)} className={`${inputCls} resize-y text-xs`} />
            </div>
          </div>
        </div>
      </Scoped>
    </Modal>
  )
}

// ---------------------------------------------------------------- agent definitions

export function AgentsTab({ ctx, model }: { ctx: PluginContext; model: MissionsModel }) {
  const agents = model.extra((s) => s.agents)
  const providers = model.extra((s) => s.providers)
  const [editing, setEditing] = useState<AgentDefinition | 'new' | null>(null)

  return (
    <div className="p-2 space-y-1.5" data-testid="agents-tab">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-vibe-muted">{agents.length} agent definitions</span>
        <button data-testid="agent-new" onClick={() => setEditing('new')} className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30`}>
          + New Agent
        </button>
      </div>
      {agents.length === 0 && <Empty>No agent definitions</Empty>}
      {agents.map((def) => (
        <div key={def.id} data-testid="agent-card" data-agent-name={def.name} className="p-2 rounded-lg border border-vibe-border hover:border-vibe-border-bright transition-colors">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
              <span className="text-xs font-medium text-vibe-text">{def.name}</span>
              <RoleBadge role={def.role} />
              <ProviderBadge providerId={def.providerId} providers={providers} />
              {def.builtin && <span className="text-[9px] text-vibe-muted">(built-in)</span>}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button data-testid="agent-edit" onClick={() => setEditing(def)} className={`${smallBtn} text-vibe-muted hover:text-vibe-text`}>
                {def.builtin ? 'Customize' : 'Edit'}
              </button>
              {!def.builtin && (
                <button onClick={() => void attempt(ctx, 'Could not delete the agent', () => model.deleteAgent(def.id))} className={`${smallBtn} text-vibe-muted hover:text-red-400`}>
                  Delete
                </button>
              )}
            </div>
          </div>
          {def.description && <p className="text-[10px] text-vibe-muted mt-0.5 truncate">{def.description}</p>}
          {def.model && <p className="text-[10px] text-vibe-muted">Model: {def.model}</p>}
        </div>
      ))}
      <AgentEditor ctx={ctx} model={model} def={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

interface AgentForm {
  name: string
  description: string
  role: MissionAgentRole
  providerId: string
  model: string
  systemPrompt: string
}

function AgentEditor({ ctx, model, def, onClose }: { ctx: PluginContext; model: MissionsModel; def: AgentDefinition | 'new' | null; onClose: () => void }) {
  const d = def === 'new' ? null : def
  const providers = model.extra((s) => s.providers)
  const [f, setF] = useState<AgentForm>({ name: '', description: '', role: 'fullstack', providerId: 'default', model: '', systemPrompt: '' })
  const [models, setModels] = useState<ModelInfo[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!def) return
    setF({
      name: d?.name ?? '',
      description: d?.description ?? '',
      role: (ROLES as string[]).includes(d?.role ?? '') ? (d!.role as MissionAgentRole) : d ? 'custom' : 'fullstack',
      providerId: d?.providerId ?? 'default',
      model: d?.model ?? '',
      systemPrompt: d?.systemPrompt ?? '',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def])

  // Models of the chosen provider (`default` → the first provider's list).
  const modelProvider = f.providerId === 'default' ? providers[0]?.id : f.providerId
  useEffect(() => {
    if (!def || !modelProvider) return setModels([])
    let live = true
    ctx.agents
      .models(modelProvider)
      .then((m) => live && setModels(m))
      .catch(() => live && setModels([]))
    return () => {
      live = false
    }
  }, [ctx, def, modelProvider])

  const set = <K extends keyof AgentForm>(k: K, v: AgentForm[K]) => setF((p) => ({ ...p, [k]: v }))
  const save = async () => {
    if (!f.name.trim()) return
    setBusy(true)
    const saved = await attempt(ctx, 'Could not save the agent definition', () =>
      model.upsertAgent({
        id: d && !d.builtin ? d.id : null,
        name: f.name.trim(),
        description: f.description.trim() || null,
        role: f.role,
        providerId: f.providerId,
        model: f.model || null,
        systemPrompt: f.systemPrompt.trim() || null,
      }),
    )
    setBusy(false)
    if (saved) {
      ctx.notifications.toast({ kind: 'success', title: d?.builtin ? `Saved a custom copy of "${d.name}"` : 'Agent definition saved' })
      onClose()
    }
  }

  return (
    <Modal
      open={!!def}
      onClose={onClose}
      size="md"
      overlayId="missions-agent-edit"
      title={d ? (d.builtin ? `Customize "${d.name}"` : `Edit "${d.name}"`) : 'New Agent Definition'}
      description={d?.builtin ? 'Built-in definitions cannot change; saving creates a custom definition.' : undefined}
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
            <button data-testid="agent-save" onClick={save} disabled={!f.name.trim() || busy} className={primaryBtn}>
              {d ? 'Save' : 'Create'}
            </button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="space-y-2.5">
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Name</label>
            <input data-testid="agent-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Senior Reviewer" className={inputCls} />
          </div>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Description</label>
            <input data-testid="agent-description" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="What this agent specializes in (optional)" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Role</label>
              <select value={f.role} onChange={(e) => set('role', e.target.value as MissionAgentRole)} className={inputCls}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {agentRoleConfig[r].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Provider</label>
              <select value={f.providerId} onChange={(e) => setF((p) => ({ ...p, providerId: e.target.value, model: '' }))} className={inputCls}>
                <option value="default">Default provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-[10px] text-vibe-muted -mt-1">{roleLook(f.role).description}</p>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Model</label>
            <select value={f.model} onChange={(e) => set('model', e.target.value)} className={inputCls}>
              <option value="">Provider default</option>
              {f.model && !models.some((m) => m.id === f.model) && <option value={f.model}>{f.model}</option>}
              {models
                .filter((m) => m.id !== 'system-default')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">System prompt</label>
            <textarea rows={5} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} placeholder="Custom instructions for this agent (optional)" className={`${inputCls} resize-y text-xs`} />
          </div>
        </div>
      </Scoped>
    </Modal>
  )
}
