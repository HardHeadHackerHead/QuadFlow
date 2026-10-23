// Agent prompts must only use real `quadflow` CLI subcommands (the MCP tools are gone).
// Run: npm test (in plugins/missions)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMemberPrompt,
  buildOrchestratorPrompt,
  coordinatorOverlay,
  missionCliCommands,
  nudgeText,
  rejectionNudge,
  reviewTask,
  workerOverlay,
} from '../src/prompts.ts'

// `quadflow missions --help` / `quadflow issues --help` (src-tauri/quadflow-core/src/cli/{missions,issues}.rs).
const MISSIONS = new Set([
  'list', 'get', 'create', 'update', 'progress', 'issues', 'assign', 'delete', 'members', 'member-add',
  'member-update', 'member-remove', 'heartbeat', 'claim-next', 'send', 'messages', 'unread', 'inbox',
  'mark-read', 'log', 'activity', 'propose', 'proposal-modify', 'proposal-status', 'proposals',
  'merge-queue', 'merge-enqueue', 'merge-next', 'merge-update', 'templates', 'template',
  'template-upsert', 'template-delete', 'agents', 'agent-upsert', 'agent-delete',
])
const ISSUES = new Set(['list', 'get', 'create', 'update', 'status', 'close', 'reopen', 'delete', 'comment'])

const ROOT = 'C:/work/web "api"'
const mission = {
  id: '01jmission0000000000000000',
  name: 'Sprint',
  status: 'active',
  orchestratorMode: 'persistent',
  orchestratorMemberId: null,
  config: { successCriteria: ['green'], workflowPhases: [{ name: 'Build', description: 'do it', gate: 'all_issues_done' }], memberPromptExtra: 'be nice', orchestratorPromptExtra: 'be quick' },
  members: [],
  createdAt: 0,
  createdBy: { kind: 'human', name: 'me' },
  updatedAt: 0,
} as never
const member = (id: string, role: string) =>
  ({ id, agentDefinitionId: 'builtin-x', name: id, role, providerId: 'default', status: 'pending', createdAt: 0, updatedAt: 0 }) as never
const dev = member('dev', 'fullstack')
const lead = member('lead', 'scrum_master')
const task = { id: '01jissue', number: 7, title: 'Login', body: 'Build it', acceptanceCriteria: ['works'], allowedFiles: ['src/a.ts'] }

function texts(): string[] {
  const cli = missionCliCommands('m1', ROOT, 'dev')
  return [
    ...Object.values(cli).map((v) => (typeof v === 'function' ? (v as (a: string, b?: string) => string)('x', 'y') : v)),
    buildMemberPrompt(dev, mission, ROOT, task),
    buildMemberPrompt(dev, mission, ROOT),
    buildOrchestratorPrompt(mission, ROOT, [dev, lead], [{ id: 'i', number: 7, title: 'Login', status: 'todo', priority: 'high' }], lead),
    workerOverlay(dev, mission, ROOT, 'C:/wt', task),
    coordinatorOverlay(lead, mission, ROOT, [dev, lead]),
    nudgeText('m1', ROOT, 'dev'),
    nudgeText('m1', ROOT, 'dev', 6),
    rejectionNudge('m1', ROOT, 'lead'),
    reviewTask('m1', ROOT, 'rev', 'agent/x/dev', '7').body ?? '',
  ]
}

test('every quadflow invocation in the prompts is a real CLI subcommand', () => {
  let n = 0
  for (const t of texts()) {
    for (const m of t.matchAll(/quadflow --project "(?:[^"\\]|\\.)*" (\w+) ([\w-]+)/g)) {
      n++
      const [, group, sub] = m
      if (group === 'missions') assert.ok(MISSIONS.has(sub), `missions ${sub}`)
      else if (group === 'issues') assert.ok(ISSUES.has(sub), `issues ${sub}`)
      else assert.fail(`unknown group ${group}`)
    }
  }
  assert.ok(n > 40, `found ${n} invocations`)
})

test('commands pin the project and never use #n refs or MCP tools', () => {
  const all = texts().join('\n')
  assert.match(all, /quadflow --project "C:\/work\/web \\"api\\"" missions heartbeat m1 dev/)
  assert.doesNotMatch(all, /issues (?:close|status|comment|get) #\d/)
  assert.doesNotMatch(all, /mcp__|quadcode_|\bsend_message\b|\bget_mission\b/)
})

test('member prompt carries identity, playbook and the workflow of its issue', () => {
  const p = buildMemberPrompt(dev, mission, ROOT, task)
  assert.match(p, /IDENTITY: mission 01jmission0000000000000000, member dev/)
  assert.match(p, /MISSION PLAYBOOK:\nbe nice/)
  assert.match(p, /ASSIGNED ISSUE: #7: Login/)
  assert.match(p, /issues close 7/)
})
