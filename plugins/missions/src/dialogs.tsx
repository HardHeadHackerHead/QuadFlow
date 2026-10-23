/** Dialogs of the Missions tile: new mission, add member. */
import { useEffect, useState } from 'react'
import { Modal } from '@quadflow/ui'
import type { MissionOrchestratorMode, PluginContext } from '@quadflow/plugin-api'
import { attempt, type MissionsModel } from './model'
import { orchestratorModeConfig, roleLook } from './display'
import { Scoped, ghostBtn, inputCls, primaryBtn } from './bits'

export function NewMissionDialog({
  ctx,
  model,
  open,
  initialTemplateId,
  onClose,
}: {
  ctx: PluginContext
  model: MissionsModel
  open: boolean
  initialTemplateId?: string | null
  onClose: () => void
}) {
  const templates = model.extra((s) => s.templates)
  const openIssues = model.extra((s) => s.openIssues)
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [mode, setMode] = useState<MissionOrchestratorMode>('manual')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [startCoordinator, setStartCoordinator] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const t = templates.find((x) => x.id === initialTemplateId)
    setName(t?.name ?? '')
    setTemplateId(t?.id ?? '')
    setMode('manual')
    setSelected(new Set())
    setStartCoordinator(false)
    void model.loadOpenIssues().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTemplateId])

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    const mission = await attempt(ctx, 'Could not create the mission', () =>
      model.createMission({ name: name.trim(), templateId: templateId || null, orchestratorMode: mode, issueRefs: [...selected] }),
    )
    setBusy(false)
    if (!mission) return
    model.select(mission.id)
    model.ui.setState({ tab: 'missions', detailTab: 'team' })
    onClose()
    if (startCoordinator) void attempt(ctx, 'Could not start the coordinator', () => model.startCoordinator(mission.id))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Mission"
      size="md"
      overlayId="missions-new"
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
            <button data-testid="new-mission-create" onClick={submit} disabled={!name.trim() || busy} className={primaryBtn}>
              {busy ? 'Creating…' : 'Create Mission'}
            </button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Mission name</label>
            <input
              data-testid="new-mission-name"
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="e.g. Sprint 12 — Auth Refactor"
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Template</label>
              <select data-testid="new-mission-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputCls}>
                <option value="">No template</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.builtIn ? '' : ' (custom)'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-vibe-muted mb-1">Orchestration</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as MissionOrchestratorMode)} className={inputCls}>
                {(Object.keys(orchestratorModeConfig) as MissionOrchestratorMode[]).map((m) => (
                  <option key={m} value={m}>
                    {orchestratorModeConfig[m].label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-[10px] text-vibe-muted -mt-1">{orchestratorModeConfig[mode].description}</p>
          {templateId && <p className="text-[10px] text-vibe-muted -mt-1">{templates.find((t) => t.id === templateId)?.description}</p>}
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Issues to include ({selected.size} selected)</label>
            <div className="max-h-40 overflow-y-auto border border-vibe-border rounded bg-vibe-bg">
              {openIssues.filter((i) => !i.missionId).length === 0 && <p className="text-[11px] text-vibe-muted text-center py-3 opacity-60">No unassigned open issues</p>}
              {openIssues
                .filter((i) => !i.missionId)
                .map((issue) => (
                  <label key={issue.id} className="flex items-center gap-2 px-2 py-1 hover:bg-vibe-bg-lighter cursor-pointer text-xs">
                    <input type="checkbox" checked={selected.has(issue.id)} onChange={() => toggle(issue.id)} />
                    <span className="text-teal-400 flex-shrink-0">{ctx.data.issues.displayRef(issue)}</span>
                    <span className="text-vibe-text truncate">{issue.title}</span>
                  </label>
                ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-vibe-text cursor-pointer">
            <input type="checkbox" checked={startCoordinator} onChange={(e) => setStartCoordinator(e.target.checked)} />
            Start a coordinator agent right away (it proposes the team)
          </label>
        </div>
      </Scoped>
    </Modal>
  )
}

export function AddMemberDialog({
  ctx,
  model,
  missionId,
  open,
  onClose,
}: {
  ctx: PluginContext
  model: MissionsModel
  missionId: string
  open: boolean
  onClose: () => void
}) {
  const agents = model.extra((s) => s.agents)
  const [defId, setDefId] = useState('')
  const [name, setName] = useState('')
  const [spawn, setSpawn] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const first = agents.find((a) => a.role === 'fullstack') ?? agents[0]
    setDefId(first?.id ?? '')
    setName('')
    setSpawn(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const def = agents.find((a) => a.id === defId)
  const submit = async () => {
    if (!defId) return
    setBusy(true)
    const member = await attempt(ctx, 'Could not add the member', () => model.addMember(missionId, defId, name.trim() || undefined))
    setBusy(false)
    if (!member) return
    onClose()
    if (spawn) void attempt(ctx, `Could not start ${member.name}`, () => model.spawnMember(missionId, member.id))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Member"
      size="sm"
      overlayId="missions-add-member"
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={ghostBtn}>
              Cancel
            </button>
            <button data-testid="add-member-submit" onClick={submit} disabled={!defId || busy} className={primaryBtn}>
              {spawn ? 'Add & Start' : 'Add'}
            </button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Agent definition</label>
            <select data-testid="add-member-definition" value={defId} onChange={(e) => setDefId(e.target.value)} className={inputCls}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {roleLook(a.role).label}
                </option>
              ))}
            </select>
            {def?.description && <p className="text-[10px] text-vibe-muted mt-1">{def.description}</p>}
          </div>
          <div>
            <label className="block text-[11px] text-vibe-muted mb-1">Name</label>
            <input data-testid="add-member-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={def?.name ?? 'Member name'} className={inputCls} />
          </div>
          <label className="flex items-center gap-2 text-xs text-vibe-text cursor-pointer">
            <input type="checkbox" checked={spawn} onChange={(e) => setSpawn(e.target.checked)} />
            Start the agent now (otherwise it waits as "pending" until the mission launches)
          </label>
        </div>
      </Scoped>
    </Modal>
  )
}
