/** The selected mission: header + actions, pending proposal, and the detail tabs. */
import { useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '@quadflow/ui'
import type { MissionOrchestratorMode, PluginContext } from '@quadflow/plugin-api'
import { attempt, membersOf, mergeQueueOf, proposalsOf, type DetailTab, type Mission, type MissionsModel, type Proposal } from './model'
import { activityKindConfig, mergeStatusConfig, messageKindConfig, orchestratorModeConfig, timeAgo } from './display'
import { isCoordinatorRole } from './prompts'
import { AgentCard } from './AgentCard'
import { AddMemberDialog } from './dialogs'
import { Empty, MemberDot, StatusBadge, inputCls, smallBtn } from './bits'

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'team', label: 'Team' },
  { id: 'issues', label: 'Issues' },
  { id: 'messages', label: 'Messages' },
  { id: 'activity', label: 'Activity' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'merge', label: 'Merge Queue' },
]

export function MissionDetail({ ctx, model, mission }: { ctx: PluginContext; model: MissionsModel; mission: Mission }) {
  const tab = model.ui((s) => s.detailTab)
  const progress = model.extra((s) => s.progress[mission.id])
  const issues = model.extra((s) => s.issues[mission.id]) ?? []
  const messages = model.extra((s) => s.messages[mission.id]) ?? []
  const activity = model.extra((s) => s.activity[mission.id]) ?? []
  const [confirmDelete, setConfirmDelete] = useState(false)

  const members = membersOf(mission)
  const proposals = proposalsOf(mission)
  const queue = mergeQueueOf(mission)
  const pending = proposals.find((p) => p.status === 'pending')
  const coordinator = members.find((m) => isCoordinatorRole(m.role))
  const finished = mission.status === 'completed' || mission.status === 'cancelled'
  const total = progress?.total ?? 0
  const done = progress?.byStatus.done ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  useEffect(() => {
    void model.loadDetail(mission.id)
  }, [model, mission.id])

  const act = (title: string, fn: () => Promise<unknown>) => () => void attempt(ctx, title, fn)
  const count = (t: DetailTab) =>
    t === 'team' ? members.length : t === 'issues' ? issues.length : t === 'messages' ? messages.length : t === 'activity' ? activity.length : t === 'proposals' ? proposals.filter((p) => p.status === 'pending').length : queue.filter((e) => e.status === 'queued' || e.status === 'merging').length

  return (
    <div className="flex flex-col h-full min-w-0" data-testid="mission-detail">
      {/* Header */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-vibe-border space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-vibe-text truncate" data-testid="mission-title">
            {mission.name}
          </span>
          <StatusBadge status={mission.status} />
          <select
            title="Orchestration mode"
            value={mission.orchestratorMode}
            onChange={(e) => void attempt(ctx, 'Could not change the mode', () => model.updateMission(mission.id, { orchestratorMode: e.target.value as MissionOrchestratorMode }))}
            className="bg-vibe-bg border border-vibe-border rounded px-1.5 py-0.5 text-[10px] text-vibe-text focus:outline-none"
          >
            {(Object.keys(orchestratorModeConfig) as MissionOrchestratorMode[]).map((m) => (
              <option key={m} value={m}>
                {orchestratorModeConfig[m].label}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          {!finished && !coordinator && (
            <button onClick={act('Could not start the coordinator', () => model.startCoordinator(mission.id))} className={`${smallBtn} bg-purple-600 hover:bg-purple-500 text-white`}>
              Start Coordinator
            </button>
          )}
          {mission.status === 'preparing' && members.some((m) => m.status === 'pending') && (
            <button onClick={act('Could not launch the mission', () => model.launchMission(mission.id))} className={`${smallBtn} bg-green-600/20 text-green-400 hover:bg-green-600/30`}>
              Launch
            </button>
          )}
          {mission.status === 'active' && (
            <button onClick={act('Could not stop the agents', () => model.stopAll(mission.id))} className={`${smallBtn} bg-red-600/20 text-red-400 hover:bg-red-600/30`}>
              Stop All
            </button>
          )}
          {finished && (
            <button onClick={act('Cleanup failed', () => model.cleanup(mission.id))} className={`${smallBtn} bg-gray-600/20 text-gray-300 hover:bg-gray-600/30`}>
              Close & Cleanup
            </button>
          )}
          <button title="Delete mission" onClick={() => setConfirmDelete(true)} className={`${smallBtn} text-vibe-muted hover:text-red-400`}>
            Delete
          </button>
        </div>
        {total > 0 && (
          <div data-testid="mission-progress">
            <div className="flex items-center justify-between text-[10px] text-vibe-muted mb-0.5">
              <span>
                {done}/{total} issues done
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-1.5 bg-vibe-bg rounded-full overflow-hidden">
              <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {coordinator && (
          <div className="flex items-center gap-1.5 text-[10px] text-vibe-muted">
            <MemberDot status={coordinator.status} />
            <span className="text-purple-400 font-medium">Coordinator</span>
            <span>{coordinator.name}</span>
            <span>·</span>
            <span>{orchestratorModeConfig[mission.orchestratorMode]?.description}</span>
          </div>
        )}
      </div>

      {pending && <ProposalCard ctx={ctx} model={model} mission={mission} proposal={pending} banner />}

      {/* Tabs */}
      <div className="flex-shrink-0 flex flex-wrap gap-1 px-2 py-1.5 border-b border-vibe-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`mission-tab-${t.id}`}
            onClick={() => model.ui.setState({ detailTab: t.id })}
            className={`px-2 py-1 text-[11px] rounded transition-colors ${tab === t.id ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-muted hover:text-vibe-text'}`}
          >
            {t.label}
            {count(t.id) > 0 && <span className="ml-1 opacity-70">({count(t.id)})</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {tab === 'team' && <TeamTab ctx={ctx} model={model} mission={mission} />}
        {tab === 'issues' && <IssuesTab ctx={ctx} model={model} mission={mission} />}
        {tab === 'messages' && <MessagesTab ctx={ctx} model={model} mission={mission} />}
        {tab === 'activity' &&
          (activity.length === 0 ? (
            <Empty>No activity yet</Empty>
          ) : (
            <div className="space-y-0.5" data-testid="mission-activity">
              {activity.map((a) => {
                const cfg = activityKindConfig[a.kind]
                return (
                  <div key={a.id} className="flex items-start gap-2 py-0.5 text-[11px]">
                    <span className={`flex-shrink-0 ${cfg?.color ?? 'text-gray-400'}`}>{cfg?.label ?? a.kind}</span>
                    <span className="text-vibe-muted flex-1 min-w-0 break-words">
                      {a.memberName && <span className="text-vibe-text">{a.memberName}: </span>}
                      {a.detail ?? ''}
                    </span>
                    <span className="text-[10px] text-vibe-muted opacity-60 flex-shrink-0">{timeAgo(a.createdAt)}</span>
                  </div>
                )
              })}
            </div>
          ))}
        {tab === 'proposals' &&
          (proposals.length === 0 ? (
            <Empty>
              <p>No proposals yet.</p>
              <p className="mt-1 text-[10px]">Start a coordinator (or run /dispatch) to have an agent analyze the issues and propose a team.</p>
            </Empty>
          ) : (
            <div className="space-y-2">
              {proposals.map((p) => (
                <ProposalCard key={p.id} ctx={ctx} model={model} mission={mission} proposal={p} />
              ))}
            </div>
          ))}
        {tab === 'merge' && <MergeTab ctx={ctx} model={model} mission={mission} />}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        overlayId="missions-delete"
        onConfirm={() => {
          setConfirmDelete(false)
          void attempt(ctx, 'Could not delete the mission', () => model.deleteMission(mission.id))
        }}
        title="Delete mission?"
        message={`"${mission.name}" and its messages and activity are deleted. Its issues stay (they leave the mission).`}
        confirmLabel="Delete"
        danger
      />
    </div>
  )
}

function TeamTab({ ctx, model, mission }: { ctx: PluginContext; model: MissionsModel; mission: Mission }) {
  const issues = model.extra((s) => s.issues[mission.id]) ?? []
  const [adding, setAdding] = useState(false)
  const members = membersOf(mission)
  const finished = mission.status === 'completed' || mission.status === 'cancelled'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-vibe-muted">
          {members.length} member{members.length === 1 ? '' : 's'}
        </span>
        {!finished && (
          <button data-testid="add-member" onClick={() => setAdding(true)} className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30`}>
            + Add Member
          </button>
        )}
      </div>
      {members.length === 0 ? (
        <Empty testId="team-empty">No agents yet. Add members, start a coordinator, or approve a proposal.</Empty>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {members.map((m) => (
            <AgentCard key={m.id} ctx={ctx} model={model} mission={mission} member={m} issues={issues} />
          ))}
        </div>
      )}
      <AddMemberDialog ctx={ctx} model={model} missionId={mission.id} open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function IssuesTab({ ctx, model, mission }: { ctx: PluginContext; model: MissionsModel; mission: Mission }) {
  const issues = model.extra((s) => s.issues[mission.id]) ?? []
  const openIssues = model.extra((s) => s.openIssues)
  const [picking, setPicking] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const members = membersOf(mission)
  const free = openIssues.filter((i) => !i.missionId)

  return (
    <div className="space-y-1.5" data-testid="mission-issues">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-vibe-muted">{issues.length} issues in this mission</span>
        <button
          onClick={() => {
            setPicking(!picking)
            if (!picking) void model.loadOpenIssues().catch(() => {})
          }}
          className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30`}
        >
          + Add Issues
        </button>
      </div>
      {picking && (
        <div className="p-2 rounded-lg border border-teal-500/30 bg-teal-600/5 space-y-1">
          {free.length === 0 ? (
            <p className="text-[11px] text-vibe-muted">No unassigned open issues</p>
          ) : (
            free.map((i) => (
              <label key={i.id} className="flex items-center gap-1.5 py-0.5 cursor-pointer text-[11px] text-vibe-text">
                <input
                  type="checkbox"
                  checked={selected.has(i.id)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(i.id)) next.delete(i.id)
                      else next.add(i.id)
                      return next
                    })
                  }
                />
                <span className="text-teal-400">{ctx.data.issues.displayRef(i)}</span> {i.title}
                <span className="text-[10px] text-vibe-muted">({i.priority})</span>
              </label>
            ))
          )}
          {selected.size > 0 && (
            <button
              onClick={async () => {
                await attempt(ctx, 'Could not add the issues', () => model.assignIssues(mission.id, [...selected]))
                setSelected(new Set())
                setPicking(false)
              }}
              className={`${smallBtn} bg-teal-600 hover:bg-teal-500 text-white`}
            >
              Add {selected.size} issue{selected.size > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      {issues.length === 0 && !picking && <Empty>No issues in this mission yet</Empty>}
      {issues.map((i) => {
        const who = members.find((m) => m.assignedIssueId === i.id)
        return (
          <div key={i.id} className="p-2 rounded-lg border border-vibe-border">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-vibe-text truncate">
                <span className="text-teal-400">{ctx.data.issues.displayRef(i)}</span> {i.title}
              </span>
              <span
                className={`px-1.5 py-0.5 text-[9px] rounded-full flex-shrink-0 ${
                  i.status === 'done' ? 'bg-green-500/20 text-green-400' : i.status === 'in_progress' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {i.status}
              </span>
            </div>
            {who && <p className="text-[10px] text-vibe-muted mt-0.5">Assigned to {who.name}</p>}
          </div>
        )
      })}
    </div>
  )
}

function MessagesTab({ ctx, model, mission }: { ctx: PluginContext; model: MissionsModel; mission: Mission }) {
  const messages = model.extra((s) => s.messages[mission.id]) ?? []
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const members = membersOf(mission)
  const names = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members])

  const send = async () => {
    if (!text.trim()) return
    const ok = await attempt(ctx, 'Could not send the message', () => model.sendMessage(mission.id, text.trim(), to || null))
    if (ok !== undefined) setText('')
  }

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex-1 space-y-1" data-testid="mission-messages">
        {messages.length === 0 ? (
          <Empty>No messages yet</Empty>
        ) : (
          messages.map((m) => {
            const cfg = messageKindConfig[m.kind]
            return (
              <div key={m.id} data-testid="mission-message" className="p-2 rounded-lg border border-vibe-border">
                <div className="flex items-center gap-1.5 mb-0.5 text-[10px]">
                  <span className="font-medium text-vibe-text">{m.fromName || 'Human'}</span>
                  {m.toMemberId && <span className="text-vibe-muted">to {names.get(m.toMemberId) ?? m.toMemberId.slice(0, 8)}</span>}
                  <span className={cfg?.color ?? 'text-gray-400'}>{cfg?.label ?? m.kind}</span>
                  <span className="flex-1" />
                  <span className="text-vibe-muted opacity-60">{new Date(m.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="text-[12px] text-vibe-text whitespace-pre-wrap break-words">{m.content}</p>
              </div>
            )
          })
        )}
      </div>
      <div className="flex-shrink-0 flex gap-1.5 items-center">
        <select value={to} onChange={(e) => setTo(e.target.value)} className="bg-vibe-bg border border-vibe-border rounded px-1.5 py-1 text-[11px] text-vibe-text">
          <option value="">Everyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input
          data-testid="mission-message-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message the team…"
          className={`${inputCls} flex-1 py-1`}
        />
        <button onClick={send} disabled={!text.trim()} className={`${smallBtn} bg-teal-600 hover:bg-teal-500 text-white`}>
          Send
        </button>
      </div>
    </div>
  )
}

function ProposalCard({ ctx, model, mission, proposal, banner }: { ctx: PluginContext; model: MissionsModel; mission: Mission; proposal: Proposal; banner?: boolean }) {
  const [expanded, setExpanded] = useState(!banner)
  const [acting, setActing] = useState(false)
  const agents = proposal.agents ?? []
  const n = agents.length
  const cost = proposal.estimatedCostUsd ?? null
  const minutes = proposal.estimatedMinutes ?? null
  const solo = cost !== null ? cost / Math.max(n, 1) : null
  const overEngineered = cost !== null && solo !== null && n > 1 && cost > solo * 2

  const run = (title: string, fn: () => Promise<void>) => async () => {
    setActing(true)
    await attempt(ctx, title, fn)
    setActing(false)
  }
  const statusCls =
    proposal.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' : proposal.status === 'approved' ? 'bg-green-500/20 text-green-400' : proposal.status === 'rejected' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'

  return (
    <div data-testid={banner ? 'proposal-banner' : 'proposal-card'} className={banner ? 'mx-2 mt-2 bg-teal-600/10 border border-teal-500/30 rounded-lg p-2.5' : 'p-2 rounded-lg border border-vibe-border'}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {banner && <div className="text-xs font-medium text-teal-300 mb-0.5">Proposal pending</div>}
          <p className="text-xs text-vibe-text">{proposal.goal}</p>
          <div className="flex flex-wrap gap-x-3 text-[10px] text-vibe-muted mt-0.5">
            <span>
              {n} agent{n === 1 ? '' : 's'}
            </span>
            {cost !== null && (
              <span>
                ${(cost * 0.7).toFixed(2)}–${(cost * 1.4).toFixed(2)} est.{solo !== null && n > 1 && ` (solo ~$${(solo * 0.7).toFixed(2)}–${(solo * 1.4).toFixed(2)})`}
              </span>
            )}
            {minutes !== null && (
              <span>
                ~{minutes} min parallel{n > 1 && ` (vs ~${minutes * n} min solo)`}
              </span>
            )}
          </div>
        </div>
        {proposal.status === 'pending' ? (
          <div className="flex gap-1.5 flex-shrink-0">
            <button disabled={acting} onClick={run('Could not approve the proposal', () => model.approveProposal(mission.id, proposal.id))} className={`${smallBtn} bg-green-600 hover:bg-green-500 text-white`}>
              {acting ? 'Working…' : 'Approve & Spawn'}
            </button>
            <button disabled={acting} onClick={run('Could not reject the proposal', () => model.rejectProposal(mission.id, proposal.id))} className={`${smallBtn} bg-red-600/80 hover:bg-red-500 text-white`}>
              Reject
            </button>
          </div>
        ) : (
          <span className={`px-1.5 py-0.5 text-[9px] rounded-full flex-shrink-0 ${statusCls}`}>{proposal.status}</span>
        )}
      </div>
      {overEngineered && <p className="mt-1 text-[10px] text-yellow-400">High coordination overhead detected. Consider running sequentially.</p>}
      <button onClick={() => setExpanded(!expanded)} className="mt-1 text-[10px] text-teal-400 hover:text-teal-300">
        {expanded ? 'Hide agent breakdown' : 'Show agent breakdown'}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {agents.map((a, i) => (
            <div key={i} className="pl-2 border-l border-vibe-border text-[10px] text-vibe-muted">
              <span className="font-medium text-teal-400">{a.name}</span> ({a.role})
              {(a.issueIds ?? []).length > 0 && <div>Issues: {(a.issueIds ?? []).map((x) => x.slice(0, 8)).join(', ')}</div>}
              {(a.allowedFiles ?? []).length > 0 && <div className="truncate">Files: {(a.allowedFiles ?? []).join(', ')}</div>}
              {(a.rationale || a.focus) && <div className="italic opacity-80">{a.rationale || a.focus}</div>}
            </div>
          ))}
          {proposal.rationale && <p className="text-[10px] text-vibe-muted italic">{proposal.rationale}</p>}
        </div>
      )}
    </div>
  )
}

function MergeTab({ ctx, model, mission }: { ctx: PluginContext; model: MissionsModel; mission: Mission }) {
  const [merging, setMerging] = useState<string | null>(null)
  const queue = mergeQueueOf(mission)
  if (queue.length === 0) {
    return (
      <Empty>
        <p>Merge queue is empty.</p>
        <p className="mt-1 text-[10px]">Branches are queued automatically when an agent closes its issue (quadflow issues close).</p>
      </Empty>
    )
  }
  return (
    <div className="space-y-1.5" data-testid="mission-merge-queue">
      {queue.map((e) => {
        const cfg = mergeStatusConfig[e.status] ?? mergeStatusConfig.queued
        return (
          <div key={e.id} className={`p-2 rounded-lg border ${cfg.border}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono text-vibe-text truncate">{e.branchName}</span>
              <span className={`px-1.5 py-0.5 text-[9px] rounded-full ${cfg.bgColor} ${cfg.color}`}>{cfg.label}</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] text-vibe-muted">
                #{e.position} · {e.priority} · {new Date(e.createdAt).toLocaleTimeString()}
              </span>
              {e.status === 'queued' && (
                <div className="flex gap-1">
                  <button
                    onClick={() => void attempt(ctx, 'Could not start the reviewer', () => model.spawnReviewer(mission.id, e.id))}
                    className={`${smallBtn} bg-purple-600/20 text-purple-400 hover:bg-purple-600/30`}
                  >
                    Review
                  </button>
                  <button
                    disabled={merging === e.id}
                    onClick={async () => {
                      setMerging(e.id)
                      const r = await attempt(ctx, 'Merge failed', () => model.merge(mission.id, e.id))
                      setMerging(null)
                      if (r) ctx.notifications.toast({ kind: r.success ? 'success' : 'error', title: r.success ? 'Merged' : 'Merge failed', body: r.message })
                    }}
                    className={`${smallBtn} bg-teal-600/20 text-teal-400 hover:bg-teal-600/30`}
                  >
                    {merging === e.id ? 'Merging…' : 'Merge'}
                  </button>
                </div>
              )}
              {e.status === 'merged' && e.mergedAt && <span className="text-[10px] text-green-400">Merged {new Date(e.mergedAt).toLocaleTimeString()}</span>}
              {e.status === 'failed' && <span className="text-[10px] text-red-400">Conflicts — resolve manually</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
