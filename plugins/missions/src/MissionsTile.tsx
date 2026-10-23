/**
 * The one Missions UI, in a pane or a flyout (it replaces the old pane-only
 * Mission Control and the flyout-only dashboard): tabs Missions / Templates /
 * Agents; the Missions tab is a mission list beside the selected mission.
 */
import { useEffect, useState } from 'react'
import type { TileProps } from '@quadflow/plugin-api'
import { membersOf, missionsModel, type MainTab } from './model'
import { MissionDetail } from './MissionDetail'
import { AgentsTab, TemplatesTab } from './Library'
import { NewMissionDialog } from './dialogs'
import { StatusBadge, smallBtn } from './bits'

const TABS: { id: MainTab; label: string }[] = [
  { id: 'missions', label: 'Missions' },
  { id: 'templates', label: 'Templates' },
  { id: 'agents', label: 'Agents' },
]

export function MissionsTile({ ctx, mode }: TileProps) {
  const model = missionsModel(ctx)
  useEffect(() => model.retain(), [model])

  const missions = model.missions.use((s) => s.items)
  const loading = model.missions.use((s) => s.loading)
  const loadError = model.missions.use((s) => s.error)
  const corrupt = model.missions.use((s) => s.corrupt)
  const root = model.missions.use((s) => s.root)
  const progress = model.extra((s) => s.progress)
  const tab = model.ui((s) => s.tab)
  const selectedId = model.ui((s) => s.selectedId)
  const nonce = model.ui((s) => s.newMissionNonce)
  const [newOpen, setNewOpen] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)

  // The "New Mission" command (and palette template items) open the dialog.
  useEffect(() => {
    if (nonce === 0) return
    setTemplateId(model.ui.getState().newMissionTemplateId)
    setNewOpen(true)
    model.ui.setState({ newMissionNonce: 0, newMissionTemplateId: null }) // handled
  }, [model, nonce])

  const selected = missions.find((m) => m.id === selectedId)
  const project = ctx.project.current()

  if (!project) {
    return <div className="h-full flex items-center justify-center text-sm text-vibe-muted bg-vibe-bg">Open a project to use Missions.</div>
  }

  const openNew = (tid: string | null) => {
    setTemplateId(tid)
    setNewOpen(true)
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden" data-testid="missions-tile" data-mode={mode}>
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-vibe-border">
        <svg className="w-4 h-4 text-orange-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span className="text-sm font-medium">Missions</span>
        <div className="flex gap-1 ml-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              data-testid={`missions-tab-${t.id}`}
              onClick={() => model.ui.setState({ tab: t.id })}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${tab === t.id ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg-lighter'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button data-testid="new-mission" onClick={() => openNew(null)} className={`${smallBtn} bg-teal-600 hover:bg-teal-500 text-white`}>
          + New Mission
        </button>
      </div>

      {loadError && <div className="px-3 py-1.5 text-[11px] text-red-400 bg-red-500/10 border-b border-red-500/20">{loadError}</div>}
      {corrupt.length > 0 && (
        <div className="px-3 py-1.5 text-[11px] text-yellow-400 bg-yellow-500/10 border-b border-yellow-500/20">
          {corrupt.length} mission file(s) could not be read: {corrupt.map((c) => c.path).join(', ')}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'templates' && (
          <div className="h-full overflow-y-auto">
            <TemplatesTab ctx={ctx} model={model} onLaunch={(tid) => openNew(tid)} />
          </div>
        )}
        {tab === 'agents' && (
          <div className="h-full overflow-y-auto">
            <AgentsTab ctx={ctx} model={model} />
          </div>
        )}
        {tab === 'missions' && (
          <div className="flex h-full">
            {/* Mission list */}
            <div className="w-[210px] flex-shrink-0 border-r border-vibe-border flex flex-col" data-testid="mission-list">
              <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
                {missions.length === 0 && !loading && <p className="text-[11px] text-vibe-muted text-center py-4 opacity-60">No missions yet</p>}
                {missions.map((m) => {
                  const p = progress[m.id]
                  const pct = p && p.total > 0 ? Math.round(((p.byStatus.done ?? 0) / p.total) * 100) : null
                  const n = membersOf(m).length
                  const isSel = m.id === selectedId
                  return (
                    <button
                      key={m.id}
                      data-testid="mission-row"
                      data-mission-name={m.name}
                      onClick={() => model.select(m.id)}
                      className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${isSel ? 'bg-teal-600/20 border-teal-500/30' : 'border-transparent hover:bg-vibe-bg-lighter'}`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className={`text-xs truncate ${isSel ? 'text-teal-300' : 'text-vibe-text'}`}>{m.name}</span>
                        <StatusBadge status={m.status} />
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-vibe-muted mt-0.5">
                        {n > 0 && (
                          <span>
                            {n} agent{n === 1 ? '' : 's'}
                          </span>
                        )}
                        {pct !== null && (
                          <span>
                            {p!.byStatus.done ?? 0}/{p!.total} done
                          </span>
                        )}
                      </div>
                      {pct !== null && (
                        <div className="h-0.5 mt-1 bg-vibe-bg rounded-full overflow-hidden">
                          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            {/* Selected mission */}
            <div className="flex-1 min-w-0">
              {selected ? (
                <MissionDetail key={selected.id} ctx={ctx} model={model} mission={selected} />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <p className="text-vibe-muted text-sm mb-3">{missions.length > 0 ? 'Select a mission' : 'Coordinate a team of agents on a set of issues'}</p>
                    <div className="flex gap-2 justify-center">
                      <button onClick={() => openNew(null)} className="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors">
                        Create a Mission
                      </button>
                      <button onClick={() => model.ui.setState({ tab: 'templates' })} className="px-4 py-2 text-sm border border-vibe-border text-vibe-text hover:bg-vibe-bg-lighter rounded transition-colors">
                        Browse Templates
                      </button>
                    </div>
                    {root && <p className="text-[10px] text-vibe-muted mt-3 opacity-70">{root}</p>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <NewMissionDialog ctx={ctx} model={model} open={newOpen} initialTemplateId={templateId} onClose={() => setNewOpen(false)} />
    </div>
  )
}
