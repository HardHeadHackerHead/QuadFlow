/**
 * What mission agents are told. Agents talk to QuadFlow only through the real
 * `quadflow` CLI (`quadflow missions …` / `quadflow issues …`), pinned to the
 * mission's project with `--project` (agents run in git worktrees nested in or
 * beside the project, so walking up from their cwd could find the wrong
 * `.quadflow/`).
 *
 * - `buildMemberPrompt` / `buildOrchestratorPrompt`: the initial prompt typed
 *   into the agent (delivered by the provider, never argv).
 * - `workerOverlay` / `coordinatorOverlay`: the context markdown handed to the
 *   provider's `prepareWorktree` hook (agent-providers.md §4.2), which writes it
 *   into its context file and enforces the file scope where it can.
 */
import type { Issue_Serialize, MissionMember_Serialize, Mission_Serialize } from '@quadflow/plugin-api'

type Member = MissionMember_Serialize
type Mission = Mission_Serialize

export const isCoordinatorRole = (role: string) => role === 'scrum_master' || role === 'tech_lead'

/** `quadflow` invocation pinned to the mission's project. */
export function quadflowCli(projectDir: string): string {
  return `quadflow --project "${projectDir.replace(/"/g, '\\"')}"`
}

/** The CLI commands a mission member uses, ready to paste into prompts. */
export function missionCliCommands(missionId: string, projectDir: string, memberId: string) {
  const q = quadflowCli(projectDir)
  const m = missionId
  return {
    heartbeat: `${q} missions heartbeat ${m} ${memberId}`,
    inbox: `${q} missions inbox ${m} ${memberId}`,
    send: (args: string) => `${q} missions send ${m} ${args} --from ${memberId}`,
    claimNext: `${q} missions claim-next ${m} ${memberId}`,
    progress: `${q} missions progress ${m}`,
    issues: `${q} missions issues ${m}`,
    members: `${q} missions members ${m}`,
    messages: `${q} missions messages ${m} --for ${memberId}`,
    log: (args: string) => `${q} missions log ${m} ${args} --member ${memberId}`,
    propose: `${q} missions propose ${m}`,
    proposals: `${q} missions proposals ${m}`,
    mergeQueue: `${q} missions merge-queue ${m}`,
    mergeNext: `${q} missions merge-next ${m}`,
    mergeUpdate: (entry: string, status: string) => `${q} missions merge-update ${m} ${entry} --status ${status}`,
    complete: `${q} missions update ${m} --status completed`,
    issue: (ref: string) => `${q} issues get ${ref}`,
    comment: (ref: string) => `${q} issues comment ${ref} --body "<summary>"`,
    status: (ref: string, status: string) => `${q} issues status ${ref} ${status}`,
    close: (ref: string) => `${q} issues close ${ref}`,
    createIssue: `${q} issues create "<title>" --mission ${m}`,
  }
}

/** The issue an agent starts on (a real issue, or a synthetic review task). */
export interface AgentTask {
  id: string
  /** Display number (`n`); refs are plain numbers — `#n` would start a shell comment. */
  number?: number
  title: string
  body?: string | null
  acceptanceCriteria?: string[]
  /** Project-relative paths the agent may modify (empty = unrestricted). */
  allowedFiles?: string[]
}

export function taskFromIssue(i: Issue_Serialize, allowedFiles?: string[]): AgentTask {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    acceptanceCriteria: (i.acceptanceCriteria ?? []).map((c) => c.text),
    allowedFiles,
  }
}

const taskRef = (t: AgentTask) => (t.number ? String(t.number) : t.id)
const taskLabel = (t: AgentTask) => (t.number ? `#${t.number}` : t.id)

// ---------------------------------------------------------------- initial prompts

export function buildMemberPrompt(member: Member, mission: Mission, root: string, task?: AgentTask): string {
  const cli = missionCliCommands(mission.id, root, member.id)
  const lines: string[] = []

  lines.push(`You are "${member.name}", a ${member.role} on mission "${mission.name}".`)
  lines.push('')
  if (member.systemPrompt) {
    lines.push(member.systemPrompt)
    lines.push('')
  }
  if (mission.config.memberPromptExtra) {
    lines.push('MISSION PLAYBOOK:')
    lines.push(mission.config.memberPromptExtra)
    lines.push('')
  }
  lines.push(`IDENTITY: mission ${mission.id}, member ${member.id}`)
  lines.push('')
  lines.push('QUADFLOW CLI (run with your shell tool; add --json for machine-readable output):')
  lines.push(`- Heartbeat every ~2 minutes: ${cli.heartbeat}`)
  lines.push(`- Read your unread messages: ${cli.inbox}`)
  lines.push(`- Message the team: ${cli.send('"<text>" --kind <finding|blocker|completion|question|help_request> [--to <member>]')}`)
  lines.push(`- Take the next free issue: ${cli.claimNext}`)
  lines.push('')

  if (task) {
    const ref = taskRef(task)
    const label = taskLabel(task)
    lines.push(`ASSIGNED ISSUE: ${label}: ${task.title}`)
    if (task.body) lines.push(task.body)
    lines.push('')
    lines.push('WORKFLOW:')
    lines.push(`1. ${cli.status(ref, 'in_progress')}`)
    lines.push(`2. ${cli.comment(ref).replace('<summary>', 'Starting work')}`)
    lines.push('3. Do the implementation work')
    lines.push(`4. ${cli.comment(ref)}  (what you did and how you tested it)`)
    lines.push(`5. ${cli.close(ref)}  (queues your branch for merge)`)
    lines.push(`6. ${cli.send(`"Completed issue ${label}" --kind completion --issue ${ref}`)}`)
    lines.push(`7. ${cli.claimNext}  (pick up more work, or stop if nothing is left)`)
  } else {
    lines.push(`No issue assigned yet: run ${cli.claimNext}, or wait for an assignment in ${cli.inbox}.`)
  }
  return lines.join('\n').trim()
}

export function buildOrchestratorPrompt(
  mission: Mission,
  root: string,
  members: Member[],
  issues: Pick<Issue_Serialize, 'id' | 'title' | 'status' | 'priority' | 'number'>[],
  self?: Member,
): string {
  const memberId = self?.id ?? mission.orchestratorMemberId ?? '<your member id>'
  const cli = missionCliCommands(mission.id, root, memberId)
  const lines: string[] = []

  lines.push(`You are the ORCHESTRATOR for mission "${mission.name}" in project "${root}".`)
  lines.push(`IDENTITY: mission ${mission.id}, member ${memberId}`)
  lines.push('')
  lines.push(`Your job: coordinate ${members.length} agents working on the mission's issues.`)
  lines.push('')
  lines.push('QUADFLOW CLI (run with your shell tool; add --json for machine-readable output):')
  lines.push(`- Issue board: ${cli.issues}`)
  lines.push(`- Progress: ${cli.progress}`)
  lines.push(`- Team: ${cli.members}`)
  lines.push(`- Unread messages: ${cli.inbox}`)
  lines.push(`- Instruct a member: ${cli.send('"<text>" --to <member> --kind assignment [--issue <ref>]')}`)
  lines.push(`- Comment on an issue: ${cli.comment('<ref>')}`)
  lines.push(`- Log a decision: ${cli.log('"<decision>" --kind note')}`)
  lines.push(`- Heartbeat every ~2 minutes: ${cli.heartbeat}`)
  lines.push('')

  lines.push('TEAM:')
  for (const m of members.filter((m) => m.id !== memberId && m.role !== 'scrum_master')) {
    const assigned = m.assignedIssueId ? ` (working on ${m.assignedIssueId})` : ' (available)'
    lines.push(`- ${m.name} [${m.role}] ${m.id} - ${m.status}${assigned}`)
  }
  lines.push('')

  if (issues.length > 0) {
    lines.push('ISSUES:')
    for (const issue of issues) {
      const priority = issue.priority ? ` [${issue.priority}]` : ''
      lines.push(`- #${issue.number}: ${issue.title} (${issue.status})${priority}`)
    }
    lines.push('')
  }

  lines.push('WORKFLOW:')
  lines.push(`1. Review the board: ${cli.issues}`)
  lines.push(`2. Assign issues: ${cli.send('"Take issue <n>: <why>" --to <member> --kind assignment --issue <n>')} and comment the decision on the issue`)
  lines.push(`3. Workers can also self-serve with \`${quadflowCli(root)} missions claim-next ${mission.id} <member>\``)

  if (mission.orchestratorMode === 'persistent') {
    lines.push('')
    lines.push('CONTINUOUS MONITORING LOOP (run every 60s):')
    lines.push(`1. ${cli.inbox} — process worker questions or blockers`)
    lines.push(`2. ${cli.mergeQueue} — check if branches are ready to merge`)
    lines.push(`3. ${cli.progress} — check overall completion`)
    lines.push('4. If a worker is blocked, resolve it with a message')
    lines.push(`5. If all issues are done and the merge queue is empty: ${cli.complete}`)
    lines.push(`6. ${cli.heartbeat}`)
    lines.push('')
    lines.push('Do NOT wait passively — actively poll and respond.')
  } else {
    lines.push('4. Make all assignments, then stop.')
  }

  const config = mission.config
  if (config.orchestratorPromptExtra) {
    lines.push('')
    lines.push('MISSION PLAYBOOK:')
    lines.push(config.orchestratorPromptExtra)
  }
  if ((config.successCriteria ?? []).length > 0) {
    lines.push('')
    lines.push('SUCCESS CRITERIA:')
    for (const criterion of config.successCriteria ?? []) lines.push(`- ${criterion}`)
  }
  const phases = config.workflowPhases ?? []
  if (phases.length > 0) {
    lines.push('')
    lines.push('WORKFLOW PHASES:')
    phases.forEach((phase, i) => {
      lines.push(`${i + 1}. ${phase.name}: ${phase.description ?? ''}`)
      if (phase.gate) lines.push(`   Gate: ${phase.gate}`)
    })
  }
  return lines.join('\n').trim()
}

/** Appended to a worker's prompt when its provider cannot enforce a file scope itself. */
export function scopeNote(missionId: string, root: string, memberId: string, allowedFiles: string[]): string {
  if (allowedFiles.length === 0) return ''
  const cli = missionCliCommands(missionId, root, memberId)
  return [
    '',
    'FILE SCOPE: you may ONLY modify these files:',
    ...allowedFiles.map((f) => `- ${f}`),
    `If you need more, ask the coordinator: ${cli.send('"Need scope: <file> because <why>" --kind help_request')}`,
  ].join('\n')
}

// ---------------------------------------------------------------- worktree context (prepareWorktree)

export function workerOverlay(member: Member, mission: Mission, root: string, worktreePath: string, task?: AgentTask): string {
  const branchName = member.branchName || `agent/${mission.id.slice(0, 8)}/${member.name}`
  const allowedFiles = task?.allowedFiles || []
  const cli = missionCliCommands(mission.id, root, member.id)
  const ref = task ? taskRef(task) : '<issue>'

  const criteriaSection = task?.acceptanceCriteria?.length
    ? `\n## Acceptance Criteria\nYour work is done when ALL of these are satisfied:\n${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}\n`
    : ''

  const scopeSection =
    allowedFiles.length > 0
      ? `\n## File Scope\nYou may ONLY modify these files:\n${allowedFiles.map((f) => `- \`${f}\``).join('\n')}\n\n> **DO NOT modify any files outside this list.** If you need to touch additional files, ask the coordinator to expand your scope:\n> \`${cli.send('"Need scope: <file> because <why>" --kind help_request')}\`\n`
      : '\n## File Scope\nNo specific file restriction. Use your best judgment but stay focused on your assigned task.\n'

  return `# Agent: ${member.name}
Role: ${member.role}
Mission: ${mission.name || mission.id}
Mission ID: ${mission.id}
Member ID: ${member.id}
Branch: ${branchName}
Worktree: ${worktreePath}

## Your Assignment
${
  task
    ? `**Issue ${taskLabel(task)}: ${task.title}**

${task.body || '(No description provided)'}
`
    : `**No issue assigned yet.** Take the next available one with \`${cli.claimNext}\`, or wait for an assignment in \`${cli.inbox}\`.`
}
${criteriaSection}
${scopeSection}
## QuadFlow CLI
Everything below goes through the \`quadflow\` CLI (run it with your shell tool; add \`--json\` for machine-readable output).
\`--project\` pins every call to the mission's project, so run the commands exactly as written.

## How To Report Progress
Every ~2 minutes while working, so the watchdog knows you are alive:
\`${cli.heartbeat}\`

Check for messages from the coordinator regularly:
\`${cli.inbox}\`

## How To Report Completion
When your task is fully done:
1. \`${cli.comment(ref)}\` — what you did and what was tested
2. \`${cli.close(ref)}\` — this queues your branch for merge automatically
3. \`${cli.send(`"Completed issue ${ref}" --kind completion --issue ${ref}`)}\`
4. \`${cli.claimNext}\` — pick up the next issue (prints null when nothing is left)

## How To Get Help
If you are blocked: \`${cli.send('"<question>" --kind blocker')}\` — the coordinator will answer in your inbox.

## Important
- Stay on your branch: \`${branchName}\`
- Do not push to main or merge branches yourself — the merge queue handles this
- Do not modify other agents' files
- Read widely, write narrowly
`
}

export function coordinatorOverlay(member: Member, mission: Mission, root: string, allMembers: Member[]): string {
  const cli = missionCliCommands(mission.id, root, member.id)
  const q = quadflowCli(root)
  const workerSummary =
    allMembers
      .filter((m) => m.id !== member.id)
      .map((m) => `- **${m.name}** (${m.role}, member \`${m.id}\`) — issue: ${m.assignedIssueId || 'unassigned'}, status: ${m.status}`)
      .join('\n') || '  (no workers yet)'

  return `# Coordinator: ${member.name}
Role: ${member.role} — Mission Orchestrator
Mission: ${mission.name || mission.id}
Mission ID: ${mission.id}
Member ID: ${member.id}

## CRITICAL: You Cannot Write Files

You are a COORDINATOR. Where your agent CLI supports it, QuadFlow blocks every file-writing tool for you. This is by design — your job is to orchestrate workers, not write code.

To change files:
1. Send a worker an assignment with the specific file changes needed:
   \`${cli.send('"<files + change>" --to <worker> --kind assignment --issue <n>')}\`
2. If no worker exists for that scope, note it in your proposal — the human spawns workers by approving it

## QuadFlow CLI
Everything goes through the \`quadflow\` CLI (run it with your shell tool; add \`--json\` for machine-readable output).
\`--project\` pins every call to the mission's project, so run the commands exactly as written.
Issue refs are plain numbers (\`12\`) or \`CODE-12\` — never \`#12\` (the shell treats \`#\` as a comment).

- \`${cli.issues}\` — the mission's issues
- \`${q} issues list --json\` — every open issue in the project
- \`${q} missions assign ${mission.id} <n> [<n> …]\` — put more issues in the mission
- \`${cli.members}\` — the team (member ids, status, assigned issue)
- \`${cli.inbox}\` — your unread messages (questions, blockers, completions)
- \`${cli.send('"<text>" --to <member> --kind assignment|answer|decision')}\` — message a worker
- \`${q} missions claim-next ${mission.id} <member>\` — atomically hand the next free issue to a worker
- \`${cli.propose} --goal "<goal>" --agents '<json>' --cost <usd> --minutes <n> --rationale "<why>"\` — propose the team (REQUIRED before workers are spawned)
- \`${cli.proposals}\` — proposal status (pending / approved / rejected)
- \`${cli.mergeQueue}\` / \`${cli.mergeNext}\` — branches waiting to merge / take the next one
- \`${cli.mergeUpdate('<entry>', 'merged|failed|skipped')}\` — record a merge result
- \`${cli.progress}\` — completion by issue status
- \`${cli.log('"<decision>" --kind note')}\` — record a decision in the activity feed
- \`${cli.createIssue}\` — file a newly discovered issue into the mission

## Your Responsibilities
1. Analyze the mission's issues and the codebase
2. Propose a mission plan with \`missions propose\`
3. Once approved, monitor workers and answer their questions
4. When workers finish, monitor the merge queue and record merges
5. Escalate blockers that you cannot resolve

## Current Team
${workerSummary}

## Proposal Format
\`--agents\` is a JSON array, one entry per worker:
\`[{"name":"FE Dev","role":"frontend","issueIds":["12"],"allowedFiles":["src/ui/Login.tsx"],"rationale":"UI only"}]\`
- A clear breakdown of which agent handles which issue (\`issueIds\` accepts refs)
- File scope for each agent (non-overlapping where possible)
- Estimated cost (assume ~$0.015 per 1k input tokens, ~50k tokens/agent/hour)
- Rationale for the parallelization strategy

## Continuous Monitoring Loop

After your proposal is approved and workers are spawned, run this loop every 60 seconds:

1. \`${cli.inbox}\` — process worker questions or blockers
2. \`${cli.mergeQueue}\` — check if branches are ready to merge
3. \`${cli.progress}\` — check overall completion
4. If a worker is blocked, answer with \`missions send … --to <worker> --kind answer\`
5. If all issues are done and the merge queue is empty: \`${cli.complete}\`
6. \`${cli.heartbeat}\`

Do NOT wait passively — actively poll and respond to your team.

## Important
- Do NOT spawn workers yourself — the proposal approval flow handles that
- Do NOT merge branches yourself — use the merge queue
- You CANNOT write or edit files — leave every change to a worker
`
}

/** Terminal nudges (watchdog / "Nudge" button). */
export function nudgeText(missionId: string, root: string, memberId: string, idleMinutes?: number): string {
  const cli = missionCliCommands(missionId, root, memberId)
  const head =
    idleMinutes !== undefined
      ? `[WATCHDOG] You have been idle for ${idleMinutes} minutes. Run \`${cli.heartbeat}\` and continue working on your assigned issue.`
      : `[NUDGE] Please continue working on your assigned task (heartbeat: \`${cli.heartbeat}\`).`
  return `\r\n${head} If you are blocked, run \`${cli.send('"<what blocks you>" --kind blocker')}\`.\r\n`
}

export function rejectionNudge(missionId: string, root: string, memberId: string): string {
  const cli = missionCliCommands(missionId, root, memberId)
  return `\r\n[SYSTEM] Your mission proposal was REJECTED. Review the issues again (\`${cli.issues}\`) and submit a revised plan with \`${cli.propose} --goal "<goal>" --agents '<json>'\`.\r\n`
}

export function reviewTask(missionId: string, root: string, reviewerId: string, branch: string, issueRef: string | null): AgentTask {
  const cli = missionCliCommands(missionId, root, reviewerId)
  return {
    id: issueRef ?? `review-${branch}`,
    title: `Review branch ${branch}`,
    body:
      `Review the changes on branch \`${branch}\` before it is merged to main.\n\n` +
      `## Review Checklist\n` +
      `- [ ] Code follows project conventions\n` +
      `- [ ] No obvious bugs or regressions\n` +
      `- [ ] Changes match the issue requirements\n` +
      `- [ ] No files modified outside the expected scope\n\n` +
      `After the review, report your findings:\n` +
      `\`${cli.send(`"<findings>" --kind review${issueRef ? ` --issue ${issueRef}` : ''}`)}\``,
  }
}
