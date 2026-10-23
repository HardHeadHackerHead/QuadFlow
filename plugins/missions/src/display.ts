/** Display tables (labels, colors) for mission entities. */
import type {
  MissionActivityKind,
  MissionAgentRole,
  MissionMemberStatus,
  MissionMergeStatus,
  MissionMessageKind,
  MissionOrchestratorMode,
  MissionStatus,
  MissionTemplateCategory,
} from '@quadflow/plugin-api'

interface Look {
  label: string
  color: string
  bgColor: string
}

export const ROLES: MissionAgentRole[] = [
  'scrum_master', 'tech_lead', 'product_owner', 'frontend', 'backend', 'fullstack', 'devops',
  'database', 'qa', 'security', 'docs', 'research', 'custom',
]

export const agentRoleConfig: Record<MissionAgentRole, Look & { description: string }> = {
  scrum_master: { label: 'Scrum Master', color: 'text-purple-400', bgColor: 'bg-purple-500/20', description: 'Runs sprints, assigns issues, tracks progress, removes blockers' },
  tech_lead: { label: 'Tech Lead', color: 'text-indigo-400', bgColor: 'bg-indigo-500/20', description: 'Makes architectural decisions, reviews critical code' },
  product_owner: { label: 'Product Owner', color: 'text-rose-400', bgColor: 'bg-rose-500/20', description: 'Defines requirements, prioritizes backlog, validates deliverables' },
  frontend: { label: 'Frontend Dev', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20', description: 'UI components, styling, accessibility, state management' },
  backend: { label: 'Backend Dev', color: 'text-green-400', bgColor: 'bg-green-500/20', description: 'APIs, server logic, business rules, service architecture' },
  fullstack: { label: 'Full Stack Dev', color: 'text-teal-400', bgColor: 'bg-teal-500/20', description: 'Works across the entire stack, frontend to database' },
  devops: { label: 'DevOps', color: 'text-orange-400', bgColor: 'bg-orange-500/20', description: 'CI/CD, Docker, deployment, infrastructure, build systems' },
  database: { label: 'Database Eng', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', description: 'Schema design, migrations, query optimization, data modeling' },
  qa: { label: 'QA Engineer', color: 'text-amber-400', bgColor: 'bg-amber-500/20', description: 'Tests, edge cases, acceptance criteria, regression testing' },
  security: { label: 'Security Eng', color: 'text-red-400', bgColor: 'bg-red-500/20', description: 'Vulnerability audits, auth review, OWASP top 10' },
  docs: { label: 'Tech Writer', color: 'text-sky-400', bgColor: 'bg-sky-500/20', description: 'Documentation, READMEs, API docs, decision records' },
  research: { label: 'Researcher', color: 'text-blue-400', bgColor: 'bg-blue-500/20', description: 'Investigates codebases, evaluates libraries, gathers context' },
  custom: { label: 'Custom', color: 'text-gray-400', bgColor: 'bg-gray-500/20', description: 'Custom role with user-defined purpose' },
}

export const roleLook = (role: string) => agentRoleConfig[role as MissionAgentRole] ?? agentRoleConfig.custom

export const missionStatusConfig: Record<MissionStatus, Look> = {
  preparing: { label: 'Preparing', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  active: { label: 'Active', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  paused: { label: 'Paused', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  completed: { label: 'Completed', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  cancelled: { label: 'Cancelled', color: 'text-red-400', bgColor: 'bg-red-500/20' },
}

export const memberStatusConfig: Record<MissionMemberStatus, Look & { dotColor: string }> = {
  pending: { label: 'Pending', color: 'text-gray-400', bgColor: 'bg-gray-500/20', dotColor: 'bg-gray-500' },
  spawning: { label: 'Spawning', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', dotColor: 'bg-yellow-500' },
  idle: { label: 'Idle', color: 'text-gray-400', bgColor: 'bg-gray-500/20', dotColor: 'bg-gray-400' },
  working: { label: 'Working', color: 'text-green-400', bgColor: 'bg-green-500/20', dotColor: 'bg-green-500' },
  stopped: { label: 'Stopped', color: 'text-red-400', bgColor: 'bg-red-500/20', dotColor: 'bg-red-500' },
  error: { label: 'Error', color: 'text-red-400', bgColor: 'bg-red-500/20', dotColor: 'bg-red-500' },
}

export const orchestratorModeConfig: Record<MissionOrchestratorMode, { label: string; description: string }> = {
  manual: { label: 'Manual', description: 'No orchestrator - assign work manually' },
  on_demand: { label: 'On-Demand', description: 'Orchestrator makes assignments then stops' },
  persistent: { label: 'Persistent', description: 'Orchestrator continuously monitors and reassigns' },
}

export const messageKindConfig: Record<MissionMessageKind, { label: string; color: string }> = {
  chat: { label: 'Chat', color: 'text-blue-400' },
  status: { label: 'Status', color: 'text-gray-400' },
  finding: { label: 'Finding', color: 'text-cyan-400' },
  blocker: { label: 'Blocker', color: 'text-red-400' },
  completion: { label: 'Done', color: 'text-green-400' },
  assignment: { label: 'Assignment', color: 'text-purple-400' },
  help_request: { label: 'Help', color: 'text-orange-400' },
  review: { label: 'Review', color: 'text-amber-400' },
  question: { label: 'Question', color: 'text-sky-400' },
  answer: { label: 'Answer', color: 'text-teal-400' },
  decision: { label: 'Decision', color: 'text-purple-400' },
  handoff: { label: 'Handoff', color: 'text-indigo-400' },
}

export const activityKindConfig: Record<MissionActivityKind, { label: string; color: string }> = {
  mission_started: { label: 'Mission Started', color: 'text-green-400' },
  mission_paused: { label: 'Mission Paused', color: 'text-yellow-400' },
  mission_completed: { label: 'Mission Completed', color: 'text-green-400' },
  member_joined: { label: 'Agent Joined', color: 'text-blue-400' },
  member_left: { label: 'Agent Left', color: 'text-red-400' },
  issue_claimed: { label: 'Issue Claimed', color: 'text-purple-400' },
  issues_assigned: { label: 'Issues Assigned', color: 'text-teal-400' },
  status_changed: { label: 'Status', color: 'text-gray-400' },
  message_sent: { label: 'Message', color: 'text-sky-400' },
  proposal_created: { label: 'Proposal', color: 'text-yellow-400' },
  proposal_updated: { label: 'Proposal Updated', color: 'text-yellow-400' },
  merge_queued: { label: 'Merge Queued', color: 'text-blue-400' },
  merge_completed: { label: 'Merged', color: 'text-green-400' },
  note: { label: 'Note', color: 'text-gray-400' },
  error: { label: 'Error', color: 'text-red-400' },
}

export const templateCategoryConfig: Record<MissionTemplateCategory, Look & { description: string }> = {
  build: { label: 'Build', color: 'text-green-400', bgColor: 'bg-green-500/20', description: 'Feature implementation and code changes' },
  quality: { label: 'Quality', color: 'text-amber-400', bgColor: 'bg-amber-500/20', description: 'Testing, reviews, and security audits' },
  ops: { label: 'Ops', color: 'text-orange-400', bgColor: 'bg-orange-500/20', description: 'Documentation, deployment, and infrastructure' },
  planning: { label: 'Planning', color: 'text-purple-400', bgColor: 'bg-purple-500/20', description: 'Sprint planning, project setup, and strategy' },
  general: { label: 'General', color: 'text-gray-400', bgColor: 'bg-gray-500/20', description: 'General purpose mission' },
}

export const TEMPLATE_CATEGORIES: MissionTemplateCategory[] = ['build', 'quality', 'ops', 'planning', 'general']

export const mergeStatusConfig: Record<MissionMergeStatus, Look & { border: string }> = {
  queued: { label: 'queued', color: 'text-blue-400', bgColor: 'bg-blue-500/20', border: 'border-blue-500/30 bg-blue-500/5' },
  merging: { label: 'merging', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', border: 'border-yellow-500/30 bg-yellow-500/5' },
  merged: { label: 'merged', color: 'text-green-400', bgColor: 'bg-green-500/20', border: 'border-green-500/30 bg-green-500/5' },
  failed: { label: 'failed', color: 'text-red-400', bgColor: 'bg-red-500/20', border: 'border-red-500/30 bg-red-500/5' },
  skipped: { label: 'skipped', color: 'text-gray-400', bgColor: 'bg-gray-500/20', border: 'border-vibe-border' },
}

export function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
