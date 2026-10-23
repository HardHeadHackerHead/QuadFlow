/** One mission member: status, assignment, branch, live terminal preview and actions. */
import type { Issue_Serialize, PluginContext } from '@quadflow/plugin-api'
import { attempt, type Member, type Mission, type MissionsModel } from './model'
import { memberStatusConfig } from './display'
import { Health, MemberDot, RoleBadge, smallBtn } from './bits'
import { TerminalPreview } from './TerminalPreview'

export function AgentCard({
  ctx,
  model,
  mission,
  member,
  issues,
}: {
  ctx: PluginContext
  model: MissionsModel
  mission: Mission
  member: Member
  issues: Issue_Serialize[]
}) {
  const busy = model.ui((s) => !!s.busy[member.id])
  const status = memberStatusConfig[member.status] ?? memberStatusConfig.pending
  const running = member.status === 'working' || member.status === 'idle' || member.status === 'spawning'
  const assigned = member.assignedIssueId ? issues.find((i) => i.id === member.assignedIssueId) : undefined
  const canStart = member.status === 'pending' || member.status === 'stopped' || member.status === 'error'
  const finished = mission.status === 'completed' || mission.status === 'cancelled'

  const act = (title: string, fn: () => Promise<unknown>) => () => void attempt(ctx, title, fn)

  return (
    <div data-testid="member-card" data-member-name={member.name} className="border border-vibe-border rounded-lg p-2 bg-vibe-bg flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <MemberDot status={member.status} />
          <span className="text-sm font-medium text-vibe-text truncate">{member.name}</span>
          {running && <Health lastHeartbeat={member.lastHeartbeat} />}
        </div>
        <RoleBadge role={member.role} />
      </div>

      <div className="text-[11px] text-vibe-muted truncate" data-testid="member-assignment">
        {assigned ? (
          <>
            <span className="text-teal-400">{ctx.data.issues.displayRef(assigned)}</span> {assigned.title}
          </>
        ) : member.assignedIssueId ? (
          <span>Issue {member.assignedIssueId.slice(0, 8)}</span>
        ) : (
          <span className="opacity-60">No issue assigned</span>
        )}
      </div>

      {member.branchName && <div className="text-[10px] text-vibe-muted font-mono truncate opacity-70">{member.branchName}</div>}

      {member.terminalId && running ? (
        <TerminalPreview ctx={ctx} terminalId={member.terminalId} onClick={() => model.focusTerminal(member.terminalId!)} />
      ) : (
        <div data-testid="member-status" className={`text-[10px] px-2 py-1 rounded ${status.bgColor} ${status.color}`}>
          {status.label}
          {member.error && <span className="ml-1 text-red-400">— {member.error}</span>}
        </div>
      )}

      <select
        value={member.assignedIssueId ?? ''}
        onChange={(e) => void attempt(ctx, 'Could not assign the issue', () => model.updateMember(mission.id, member.id, { assignedIssueId: e.target.value || null }))}
        className="w-full bg-vibe-bg border border-vibe-border rounded px-1.5 py-0.5 text-[10px] text-vibe-text focus:outline-none focus:border-teal-500"
      >
        <option value="">No issue assigned</option>
        {issues.map((i) => (
          <option key={i.id} value={i.id}>
            {ctx.data.issues.displayRef(i)}: {i.title}
          </option>
        ))}
      </select>

      <div className="flex flex-wrap items-center gap-1">
        {canStart && !finished && (
          <button
            data-testid="member-start"
            disabled={busy}
            onClick={act(`Could not start ${member.name}`, () => model.spawnMember(mission.id, member.id))}
            className={`${smallBtn} bg-green-500/20 text-green-400 hover:bg-green-500/30`}
          >
            {busy ? 'Starting…' : member.status === 'pending' ? 'Start' : 'Restart'}
          </button>
        )}
        {running && (
          <button onClick={act(`Could not stop ${member.name}`, () => model.stopMember(mission.id, member.id))} className={`${smallBtn} bg-red-500/20 text-red-400 hover:bg-red-500/30`}>
            Stop
          </button>
        )}
        {running && member.terminalId && (
          <button onClick={act('Could not nudge the agent', () => model.nudge(mission.id, member.id))} className={`${smallBtn} bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30`}>
            Nudge
          </button>
        )}
        {member.terminalId && (
          <button onClick={() => model.focusTerminal(member.terminalId!)} className={`${smallBtn} bg-blue-500/20 text-blue-400 hover:bg-blue-500/30`}>
            Show terminal
          </button>
        )}
        <div className="flex-1" />
        {!running && (
          <button
            title="Remove from the mission"
            onClick={act('Could not remove the member', () => model.removeMember(mission.id, member.id))}
            className={`${smallBtn} text-vibe-muted hover:text-red-400`}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}
