/**
 * The Plans tile (pane and flyout): plan list + detail with the phase
 * pipeline (spec -> review -> decompose -> review steps -> promote -> execute).
 * Ported from the shell's PlansToolView (MIG-plans); data goes through
 * `ctx.data.plans` / `ctx.data.issues` / `ctx.data.ideas` only.
 */
import { useEffect, useState, useRef, useMemo, useCallback, type ReactNode } from 'react'
import type { TileProps } from '@quadflow/plugin-api'
import { Modal } from '@quadflow/ui'
import { guard, plansModel, type Plan, type PlanStep, type PlanStatus, type PlanStepStatus, type StepType, type EstimatedEffort } from './model'
import { PlansProvider, isAgentStale, runSkill, useIdeaIds, useIssuesById, useMinuteTick } from './context'
import { DiscoveryLink } from './DiscoveryLink'
import PlanPhaseStepper from './PlanPhaseStepper'
import SpecEditorView from './SpecEditorView'
import DecompositionView from './DecompositionView'
import PromotionProfileEditor from './PromotionProfileEditor'
import DependencyGraph, { GraphNode } from './DependencyGraph'

// AI Skills configuration
const AI_SKILLS = [
  {
    id: 'organize',
    name: 'Organize Plans',
    description: 'Review and organize all plans',
    command: '/organize-plans',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    color: 'text-teal-400',
  },
  {
    id: 'summary',
    name: 'Plan Summary',
    description: 'Get summary of all plans',
    command: '/plan-summary',
    icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'text-blue-400',
  },
  {
    id: 'from-idea',
    name: 'Plan from Idea',
    description: 'Create plan from an idea',
    command: '/plan-from-idea',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    color: 'text-yellow-400',
  },
  {
    id: 'update-progress',
    name: 'Update Progress',
    description: 'Check work and update step statuses',
    command: '/update-plan-progress',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    color: 'text-green-400',
  },
  {
    id: 'rich-plan',
    name: 'Rich Plan',
    description: 'Generate a comprehensive implementation plan',
    command: '/create-rich-plan',
    icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
    color: 'text-indigo-400',
  },
]

// Status configuration
const PLAN_STATUS_CONFIG: Record<PlanStatus, { label: string; color: string; bgColor: string }> = {
  spec_draft: { label: 'Spec Draft', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  spec_review: { label: 'Review', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  decomposing: { label: 'Decompose', color: 'text-indigo-400', bgColor: 'bg-indigo-500/20' },
  review_steps: { label: 'Review Steps', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  promoting: { label: 'Promote', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  executing: { label: 'Executing', color: 'text-teal-400', bgColor: 'bg-teal-500/20' },
  completed: { label: 'Completed', color: 'text-green-400', bgColor: 'bg-green-500/20' },
}

const STEP_STATUS_CONFIG: Record<PlanStepStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'text-gray-400' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400' },
  completed: { label: 'Completed', color: 'text-green-400' },
  skipped: { label: 'Skipped', color: 'text-gray-500' },
}

// Step type configuration
const STEP_TYPE_CONFIG: Record<StepType, { label: string; color: string; bgColor: string }> = {
  research: { label: 'Research', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  design: { label: 'Design', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  implement: { label: 'Implement', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  test: { label: 'Test', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  verify: { label: 'Verify', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20' },
  document: { label: 'Document', color: 'text-amber-400', bgColor: 'bg-amber-500/20' },
}

// Effort level configuration
const EFFORT_CONFIG: Record<EstimatedEffort, { label: string; color: string }> = {
  low: { label: 'Low', color: 'text-green-400' },
  medium: { label: 'Med', color: 'text-yellow-400' },
  high: { label: 'High', color: 'text-red-400' },
}

// Sort options
type SortOption = 'newest' | 'oldest' | 'recently-updated' | 'alphabetical' | 'status'

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'recently-updated', label: 'Recently updated' },
  { value: 'alphabetical', label: 'Alphabetical' },
  { value: 'status', label: 'By status' },
]

const STATUS_ORDER: PlanStatus[] = ['executing', 'review_steps', 'decomposing', 'spec_review', 'spec_draft', 'promoting', 'completed']

/** Wraps portal content (modal bodies/footers) in the plugin's style scope. */
const Scoped = ({ children }: { children: ReactNode }) => <div className="qf-plans">{children}</div>

export function PlansTile(props: TileProps) {
  return (
    <PlansProvider ctx={props.ctx}>
      <PlansView {...props} />
    </PlansProvider>
  )
}

function PlansView({ ctx }: TileProps) {
  const model = plansModel(ctx)
  useEffect(() => model.plans.retain(), [model])
  const plans = model.plans.use((s) => s.items)
  const isLoading = model.plans.use((s) => s.loading && s.items.length === 0)
  const corrupt = model.plans.use((s) => s.corrupt)
  const relatedVersion = model.plans.use((s) => s.relatedVersion)
  const hasProject = model.plans.use((s) => s.root !== null)
  const dismissCorrupt = () => model.plans.use.setState({ corrupt: [] })
  const run = useMemo(() => guard(ctx, 'Plans'), [ctx])
  const updatePlan = (id: string, u: Parameters<typeof model.updatePlan>[1]) => run(() => model.updatePlan(id, u))
  const deletePlan = (id: string) => run(() => model.deletePlan(id))
  const addStep = (planId: string, title: string, description?: string) => run(() => model.addStep(planId, title, description))
  const updateStep = (stepId: string, u: Parameters<typeof model.updateStep>[1]) => run(() => model.updateStep(stepId, u))
  const deleteStep = (stepId: string) => run(() => model.deleteStep(stepId))
  const toggleStepComplete = (stepId: string) => run(() => model.toggleStepComplete(stepId))
  const promoteStepToIssue = (stepId: string) => run(() => model.promoteStepToIssue(stepId))
  const promoteAllSteps = (planId: string) => run(() => model.promoteAllSteps(planId))
  const ideaIds = useIdeaIds(ctx, relatedVersion)
  const hasPromoted = plans.some((p) => p.steps.some((s) => s.promotedIssueId))
  const issuesById = useIssuesById(ctx, relatedVersion, hasPromoted)
  const now = useMinuteTick(hasPromoted)
  const focusId = model.ui((s) => s.focusId)
  const composeNonce = model.ui((s) => s.composeNonce)

  // AI skills state
  const [showAiMenu, setShowAiMenu] = useState(false)
  const [runningSkill, setRunningSkill] = useState<string | null>(null)

  // Modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newPlanTitle, setNewPlanTitle] = useState('')
  const [newPlanDescription, setNewPlanDescription] = useState('')
  const [newPlanIdeaId, setNewPlanIdeaId] = useState<string | undefined>()
  const [, setNewPlanSteps] = useState<Array<{ title: string; description?: string }>>([])
  const [newStepTitle, setNewStepTitle] = useState('') // reused for brainstorm idea description
  const resetCreate = () => {
    setShowCreateModal(false)
    setNewPlanTitle('')
    setNewPlanDescription('')
    setNewPlanIdeaId(undefined)
    setNewPlanSteps([])
    setNewStepTitle('')
  }


  // Edit state
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editDescription, setEditDescription] = useState('')

  // Selected plan (for detail panel)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)

  // View mode for steps (list or dependency graph)
  const [stepViewMode, setStepViewMode] = useState<'list' | 'graph'>('list')
  const [collapsedSteps, setCollapsedSteps] = useState<Set<string>>(new Set())

  const toggleStepCollapse = (stepId: string) => {
    setCollapsedSteps(prev => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  // Add step state
  const [addingStepToPlanId, setAddingStepToPlanId] = useState<string | null>(null)
  const [addStepTitle, setAddStepTitle] = useState('')
  const [addStepDescription, setAddStepDescription] = useState('')

  // Edit step state
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [editStepTitle, setEditStepTitle] = useState('')
  const [editStepDescription, setEditStepDescription] = useState('')
  const [editStepNotes, setEditStepNotes] = useState('')

  // Filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<PlanStatus | 'all'>('all')
  const [sortOption, setSortOption] = useState<SortOption>('newest')
  const [showSortDropdown, setShowSortDropdown] = useState(false)
  const [showStatusDropdown, setShowStatusDropdown] = useState(false)
  const [launchingTeam, setLaunchingTeam] = useState(false)
  const [teamsByPlan, setTeamsByPlan] = useState<Record<string, { id: string; name: string; status: string; memberCount: number }>>({})

  const searchInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Native teams don't map by planId; the team badge stays empty.
  useEffect(() => setTeamsByPlan({}), [])

  // Palette / command focus: select the plan.
  useEffect(() => {
    if (!focusId) return
    if (!plans.some((p) => p.id === focusId)) return // not loaded yet
    setSelectedPlanId(focusId)
    model.ui.setState({ focusId: null })
  }, [focusId, plans, model])

  // "New Plan" command while the tile is open: show the wizard.
  useEffect(() => {
    if (composeNonce) setShowCreateModal(true)
  }, [composeNonce])

  // Focus title input when modal opens
  useEffect(() => {
    if (showCreateModal && titleInputRef.current) {
      titleInputRef.current.focus()
    }
  }, [showCreateModal])

  // Filter and sort plans
  const filteredPlans = useMemo(() => {
    let result = [...plans]

    // Filter by search
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
      result = result.filter(plan =>
        plan.title.toLowerCase().includes(query) ||
        plan.description?.toLowerCase().includes(query) ||
        plan.steps.some(s => s.title.toLowerCase().includes(query))
      )
    }

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter(plan => plan.status === statusFilter)
    }

    // Sort
    switch (sortOption) {
      case 'newest':
        result.sort((a, b) => b.createdAt - a.createdAt)
        break
      case 'oldest':
        result.sort((a, b) => a.createdAt - b.createdAt)
        break
      case 'recently-updated':
        result.sort((a, b) => b.updatedAt - a.updatedAt)
        break
      case 'alphabetical':
        result.sort((a, b) => a.title.localeCompare(b.title))
        break
      case 'status':
        result.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
        break
    }

    return result
  }, [plans, debouncedSearch, statusFilter, sortOption])

  // Helpers
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  const getProgressPercentage = (plan: Plan) => {
    if (plan.steps.length === 0) return 0
    const completed = plan.steps.filter(s => s.status === 'completed').length
    return Math.round((completed / plan.steps.length) * 100)
  }

  const getLinkedIdea = (ideaId?: string) => {
    if (!ideaId) return null
    return ideaIds.has(ideaId) ? { id: ideaId } : null
  }

  // AI skill handler
  const handleRunAiSkill = useCallback(
    async (skill: (typeof AI_SKILLS)[0]) => {
      setShowAiMenu(false)
      setRunningSkill(skill.id)
      try {
        await runSkill(ctx, skill.command)
      } finally {
        setRunningSkill(null)
      }
    },
    [ctx]
  )

  // Handlers
  const handleStartEdit = (plan: Plan) => {
    setEditingPlanId(plan.id)
    setEditTitle(plan.title)
    setEditDescription(plan.description || '')
  }

  const handleSaveEdit = async () => {
    if (!editingPlanId || !editTitle.trim()) return
    await updatePlan(editingPlanId, {
      title: editTitle.trim(),
      description: editDescription.trim() || undefined,
    })
    setEditingPlanId(null)
  }

  const handleStatusChange = async (planId: string, status: PlanStatus) => {
    await updatePlan(planId, { status })
  }

  const handleAddStep = async (planId: string) => {
    if (!addStepTitle.trim()) return
    await addStep(planId, addStepTitle.trim(), addStepDescription.trim() || undefined)
    setAddingStepToPlanId(null)
    setAddStepTitle('')
    setAddStepDescription('')
  }

  const handleStartEditStep = (step: PlanStep) => {
    setEditingStepId(step.id)
    setEditStepTitle(step.title)
    setEditStepDescription(step.description || '')
    setEditStepNotes(step.notes || '')
  }

  const handleSaveStepEdit = async () => {
    if (!editingStepId || !editStepTitle.trim()) return
    await updateStep(editingStepId, {
      title: editStepTitle.trim(),
      description: editStepDescription.trim() || undefined,
      notes: editStepNotes.trim() || undefined,
    })
    setEditingStepId(null)
  }

  const handleStepStatusChange = async (stepId: string, status: PlanStepStatus) => {
    await updateStep(stepId, { status })
  }

  const handleLaunchTeam = async (_planId: string) => {
    // Native teams: this now just signals the user to use the Teams tool launch flow
    // The old createTeamFromPlan is removed; teams are launched via the Teams dashboard
    setLaunchingTeam(true)
    setTimeout(() => setLaunchingTeam(false), 500)
  }

  if (!hasProject && !isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-sm text-vibe-muted">
        Open a project to see its plans.
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden" data-testid="plans-tile">
      {corrupt.length > 0 && (
        <div className="m-2 mb-0 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 flex items-start gap-2" role="alert">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{corrupt.length} plan file{corrupt.length === 1 ? '' : 's'} could not be read</div>
            {corrupt.map((c) => (
              <div key={c.path} className="font-mono truncate" title={`${c.path}: ${c.message}`}>{c.path}</div>
            ))}
          </div>
          <button onClick={dismissCorrupt} className="text-red-300 hover:text-red-300" aria-label="Dismiss">×</button>
        </div>
      )}
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            <span className="font-medium">Plans</span>
            <span className="text-xs text-vibe-muted bg-vibe-bg-lighter px-2 py-0.5 rounded-full">
              {plans.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* AI Skills dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowAiMenu(!showAiMenu)}
                disabled={runningSkill !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {runningSkill ? (
                  <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                )}
                AI Skills
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showAiMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAiMenu(false)} />
                  <div className="absolute right-0 mt-1 w-56 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl z-50 py-1">
                    {AI_SKILLS.map((skill) => (
                      <button
                        key={skill.id}
                        onClick={() => handleRunAiSkill(skill)}
                        className="w-full px-3 py-2 text-left hover:bg-vibe-bg transition-colors flex items-center gap-2"
                      >
                        <svg className={`w-4 h-4 ${skill.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={skill.icon} />
                        </svg>
                        <div>
                          <div className="text-sm">{skill.name}</div>
                          <div className="text-xs text-vibe-muted">{skill.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Plan
            </button>
          </div>
        </div>

        {/* Search and filters */}
        {plans.length > 0 && (
          <div className="flex gap-2 items-center">
            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search plans..."
                className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg pl-10 pr-8 py-2 text-sm focus:outline-none focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-vibe-muted hover:text-vibe-text"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Status filter */}
            <div className="relative">
              <button
                onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-muted hover:text-vibe-text transition-colors"
              >
                <span>{statusFilter === 'all' ? 'All Status' : PLAN_STATUS_CONFIG[statusFilter].label}</span>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showStatusDropdown && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowStatusDropdown(false)} />
                  <div className="absolute right-0 mt-1 w-36 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl z-50 py-1">
                    <button
                      onClick={() => { setStatusFilter('all'); setShowStatusDropdown(false) }}
                      className={`w-full px-3 py-2 text-left text-xs transition-colors ${statusFilter === 'all' ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-text hover:bg-vibe-bg'}`}
                    >
                      All Status
                    </button>
                    {(Object.keys(PLAN_STATUS_CONFIG) as PlanStatus[]).map((status) => (
                      <button
                        key={status}
                        onClick={() => { setStatusFilter(status); setShowStatusDropdown(false) }}
                        className={`w-full px-3 py-2 text-left text-xs transition-colors ${statusFilter === status ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-text hover:bg-vibe-bg'}`}
                      >
                        {PLAN_STATUS_CONFIG[status].label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Sort dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-muted hover:text-vibe-text transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                </svg>
                <span>{SORT_OPTIONS.find(o => o.value === sortOption)?.label}</span>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showSortDropdown && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSortDropdown(false)} />
                  <div className="absolute right-0 mt-1 w-44 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl z-50 py-1">
                    {SORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => { setSortOption(option.value); setShowSortDropdown(false) }}
                        className={`w-full px-3 py-2 text-left text-xs transition-colors ${sortOption === option.value ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-text hover:bg-vibe-bg'}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Two-panel layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - Plan list */}
        <div className={`${selectedPlanId ? 'w-[35%] min-w-[200px]' : 'w-full'} border-r border-vibe-border overflow-y-auto p-2 space-y-1.5 transition-all`}>
          {filteredPlans.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-12 h-12 mx-auto text-vibe-muted mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
              <p className="text-vibe-muted text-sm">
                {plans.length === 0 ? 'No plans yet' : 'No plans match your filters'}
              </p>
            </div>
          ) : (
            filteredPlans.map((plan) => {
              const isSelected = selectedPlanId === plan.id
              const progress = getProgressPercentage(plan)
              const statusConfig = PLAN_STATUS_CONFIG[plan.status]
              const completedSteps = plan.steps.filter(s => s.status === 'completed').length
              const promotedCount = plan.steps.filter(s => s.promotedIssueId).length

              return (
                <button
                  key={plan.id}
                  data-plan-id={plan.id}
                  onClick={() => setSelectedPlanId(isSelected ? null : plan.id)}
                  className={`w-full text-left p-2.5 rounded-lg transition-colors ${
                    isSelected
                      ? 'bg-teal-500/10 border border-teal-500/30'
                      : 'hover:bg-vibe-bg-lighter border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium truncate flex-1">{plan.title}</span>
                    <span className={`px-1.5 py-0.5 text-[10px] rounded-full flex-shrink-0 ${statusConfig.bgColor} ${statusConfig.color}`}>
                      {statusConfig.label}
                    </span>
                  </div>
                  {plan.steps.length > 0 && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 bg-vibe-bg rounded-full overflow-hidden">
                        <div className="h-full bg-teal-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                      </div>
                      <span className="text-[10px] text-vibe-muted flex-shrink-0">{completedSteps}/{plan.steps.length}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {plan.steps.length > 0 && (
                      <div className="flex gap-0.5">
                        {plan.steps.slice(0, 8).map((s) => (
                          <span
                            key={s.id}
                            className={`w-1.5 h-1.5 rounded-full ${
                              s.status === 'completed' ? 'bg-green-400' :
                              s.status === 'in_progress' ? 'bg-yellow-400' :
                              s.status === 'skipped' ? 'bg-gray-500' : 'bg-gray-600'
                            }`}
                            title={`${s.title} (${s.status})`}
                          />
                        ))}
                        {plan.steps.length > 8 && <span className="text-[8px] text-vibe-muted">+{plan.steps.length - 8}</span>}
                      </div>
                    )}
                    <span className="text-[10px] text-vibe-muted ml-auto">{formatDate(plan.updatedAt)}</span>
                    {plan.architecturalDecisions && plan.architecturalDecisions.length > 0 && (
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" title="Arch decisions" />
                    )}
                    {plan.riskNotes && <span className="w-1.5 h-1.5 rounded-full bg-red-400" title="Risks" />}
                    {promotedCount > 0 && (
                      <span className="text-[10px] text-blue-400">{promotedCount}i</span>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Right panel - Plan detail */}
        {selectedPlanId && (() => {
          const plan = plans.find(p => p.id === selectedPlanId)
          if (!plan) return null
          const progress = getProgressPercentage(plan)
          const linkedIdea = getLinkedIdea(plan.ideaId)

          return (
            <div className="flex-1 overflow-y-auto">
              {/* Detail header */}
              <div className="sticky top-0 bg-vibe-bg border-b border-vibe-border p-3 z-10">
                {editingPlanId === plan.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full bg-vibe-bg-lighter border border-vibe-border rounded px-3 py-1.5 text-sm font-medium focus:outline-none focus:border-teal-500"
                      placeholder="Plan title"
                    />
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="w-full bg-vibe-bg-lighter border border-vibe-border rounded px-3 py-1.5 text-sm resize-none focus:outline-none focus:border-teal-500"
                      rows={2}
                      placeholder="Description (optional)"
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditingPlanId(null)} className="px-3 py-1 text-xs text-vibe-muted hover:text-vibe-text">Cancel</button>
                      <button onClick={handleSaveEdit} className="px-3 py-1 text-xs bg-teal-600 hover:bg-teal-500 rounded">Save</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-medium text-base">{plan.title}</h2>
                        </div>
                        <div className="mt-1.5">
                          <PlanPhaseStepper
                            currentPhase={plan.status}
                            onPhaseChange={(status) => handleStatusChange(plan.id, status)}
                            compact
                          />
                        </div>
                        {plan.description && (
                          <p className="text-sm text-vibe-muted mt-1">{plan.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleStartEdit(plan)} className="p-1.5 text-vibe-muted hover:text-teal-400 transition-colors" title="Edit">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button onClick={() => { deletePlan(plan.id); setSelectedPlanId(null) }} className="p-1.5 text-vibe-muted hover:text-red-400 transition-colors" title="Delete">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* Progress bar + metadata */}
                    <div className="flex items-center gap-3 mt-2 text-xs text-vibe-muted">
                      {plan.steps.length > 0 && (
                        <>
                          <div className="flex items-center gap-2 flex-1">
                            <div className="flex-1 h-1.5 bg-vibe-bg-lighter rounded-full overflow-hidden">
                              <div className="h-full bg-teal-500 transition-all duration-300" style={{ width: `${progress}%` }} />
                            </div>
                            <span>{plan.steps.filter(s => s.status === 'completed').length}/{plan.steps.length} steps ({progress}%)</span>
                            {(() => {
                              const totalEst = plan.steps.reduce((sum, s) => sum + (s.estimatedHours || 0), 0)
                              const totalActual = plan.steps.reduce((sum, s) => sum + (s.actualHours || 0), 0)
                              if (totalEst > 0) return <span className="text-vibe-muted">{totalActual > 0 ? `${totalActual}/` : ''}{totalEst}h est.</span>
                              return null
                            })()}
                          </div>
                        </>
                      )}
                      <span>{formatDate(plan.createdAt)}</span>
                      {linkedIdea && (
                        <span className="text-yellow-400 flex items-center gap-1">
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                          </svg>
                          Linked idea
                        </span>
                      )}
                    </div>
                    <div className="mt-2">
                      <DiscoveryLink ctx={ctx} discoveryId={plan.discoveryId} onChange={(discoveryId) => updatePlan(plan.id, { discoveryId: discoveryId ?? undefined })} />
                    </div>
                  </>
                )}
              </div>

              <div className="p-3 space-y-3">
                {/* Spec Editor phases (spec_draft, spec_review) */}
                {(plan.status === 'spec_draft' || plan.status === 'spec_review') && (
                  <SpecEditorView plan={plan} />
                )}

                {/* Decomposition phase (decomposing, review_steps) */}
                {(plan.status === 'decomposing' || plan.status === 'review_steps') && (
                  <DecompositionView plan={plan} />
                )}

                {/* Promotion Profile (promoting phase) */}
                {plan.status === 'promoting' && (
                  <PromotionProfileEditor plan={plan} />
                )}

                {/* Executing phase — dispatch button */}
                {plan.status === 'executing' && (
                  <div className="flex items-center gap-2 bg-teal-500/5 border border-teal-500/20 rounded-lg p-2.5">
                    <svg className="w-4 h-4 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-xs text-teal-400 font-medium">Executing</span>
                    <span className="text-xs text-vibe-muted">
                      — {plan.steps.filter(s => s.status === 'completed').length}/{plan.steps.length} steps done
                    </span>
                    <div className="flex-1" />
                    <button
                      onClick={() => {
                        void runSkill(ctx, '/dispatch')
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-purple-400 bg-purple-500/10 border border-purple-500/30 rounded hover:bg-purple-500/20 transition-colors"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      Dispatch Agents
                    </button>
                  </div>
                )}

                {/* Completed phase — summary */}
                {plan.status === 'completed' && (
                  <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="text-sm font-medium text-green-400">Plan Complete</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-center text-xs">
                      <div>
                        <div className="text-lg font-bold text-green-400">{plan.steps.filter(s => s.status === 'completed').length}</div>
                        <div className="text-vibe-muted">Completed</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-gray-400">{plan.steps.filter(s => s.status === 'skipped').length}</div>
                        <div className="text-vibe-muted">Skipped</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-blue-400">{plan.steps.filter(s => s.promotedIssueId).length}</div>
                        <div className="text-vibe-muted">Issues Created</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Enrichment sections — only shown after spec phases */}
                {plan.status !== 'spec_draft' && plan.status !== 'spec_review' && plan.architecturalDecisions && plan.architecturalDecisions.length > 0 && (
                  <details className="group/detail">
                    <summary className="text-xs font-medium text-indigo-400 cursor-pointer hover:text-indigo-300 flex items-center gap-1">
                      <svg className="w-3 h-3 transition-transform group-open/detail:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Architectural Decisions ({plan.architecturalDecisions.length})
                    </summary>
                    <div className="mt-2 bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-3">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-vibe-muted">
                            <th className="pb-1.5 pr-3 font-medium">Decision</th>
                            <th className="pb-1.5 font-medium">Rationale</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.architecturalDecisions.map((ad, i) => (
                            <tr key={i} className="border-t border-indigo-500/10">
                              <td className="py-1.5 pr-3 text-vibe-text align-top">{ad.decision}</td>
                              <td className="py-1.5 text-vibe-muted">{ad.rationale}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

                {plan.status !== 'spec_draft' && plan.status !== 'spec_review' && plan.riskNotes && (
                  <details className="group/detail">
                    <summary className="text-xs font-medium text-red-400 cursor-pointer hover:text-red-300 flex items-center gap-1">
                      <svg className="w-3 h-3 transition-transform group-open/detail:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Risk Notes
                    </summary>
                    <div className="mt-2 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                      <div className="text-sm text-vibe-muted whitespace-pre-wrap">{plan.riskNotes}</div>
                    </div>
                  </details>
                )}

                {plan.status !== 'spec_draft' && plan.status !== 'spec_review' && plan.context && (
                  <details className="group/detail">
                    <summary className="text-xs font-medium text-cyan-400 cursor-pointer hover:text-cyan-300 flex items-center gap-1">
                      <svg className="w-3 h-3 transition-transform group-open/detail:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Codebase Context
                    </summary>
                    <div className="mt-2 bg-cyan-500/5 border border-cyan-500/20 rounded-lg p-3">
                      <pre className="text-xs text-vibe-muted whitespace-pre-wrap font-mono">{plan.context}</pre>
                    </div>
                  </details>
                )}

                {/* Steps section — hidden during spec phases */}
                {plan.status !== 'spec_draft' && plan.status !== 'spec_review' && (<>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Steps</span>
                      {/* View mode toggle */}
                      {plan.steps.length > 0 && (
                        <div className="flex items-center bg-vibe-bg-lighter border border-vibe-border rounded-lg overflow-hidden">
                          <button
                            onClick={() => setStepViewMode('list')}
                            className={`px-2 py-0.5 text-[10px] transition-colors ${stepViewMode === 'list' ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-muted hover:text-vibe-text'}`}
                            title="List view"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                            </svg>
                          </button>
                          <button
                            onClick={() => setStepViewMode('graph')}
                            className={`px-2 py-0.5 text-[10px] transition-colors ${stepViewMode === 'graph' ? 'bg-teal-600/20 text-teal-400' : 'text-vibe-muted hover:text-vibe-text'}`}
                            title="Dependency graph"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                          </button>
                        </div>
                      )}
                      {/* Expand/Collapse all toggle for hierarchical steps */}
                      {stepViewMode === 'list' && plan.steps.some(s => plan.steps.some(c => c.parentStepId === s.id)) && (
                        <button
                          onClick={() => {
                            const parentIds = plan.steps.filter(s => plan.steps.some(c => c.parentStepId === s.id)).map(s => s.id)
                            const allCollapsed = parentIds.every(id => collapsedSteps.has(id))
                            if (allCollapsed) {
                              setCollapsedSteps(prev => {
                                const next = new Set(prev)
                                parentIds.forEach(id => next.delete(id))
                                return next
                              })
                            } else {
                              setCollapsedSteps(prev => {
                                const next = new Set(prev)
                                parentIds.forEach(id => next.add(id))
                                return next
                              })
                            }
                          }}
                          className="px-1.5 py-0.5 text-[10px] text-vibe-muted hover:text-vibe-text transition-colors"
                          title={plan.steps.filter(s => plan.steps.some(c => c.parentStepId === s.id)).every(s => collapsedSteps.has(s.id)) ? 'Expand all' : 'Collapse all'}
                        >
                          {plan.steps.filter(s => plan.steps.some(c => c.parentStepId === s.id)).every(s => collapsedSteps.has(s.id)) ? (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {plan.steps.length > 0 && teamsByPlan[plan.id] ? (
                        <span
                          className={`text-xs flex items-center gap-1 px-2 py-0.5 rounded-full ${
                            teamsByPlan[plan.id].status === 'active'
                              ? 'bg-green-500/10 text-green-400'
                              : teamsByPlan[plan.id].status === 'completing'
                              ? 'bg-yellow-500/10 text-yellow-400'
                              : teamsByPlan[plan.id].status === 'completed'
                              ? 'bg-blue-500/10 text-blue-400'
                              : 'bg-vibe-bg-lighter text-vibe-muted'
                          }`}
                          title={`Team: ${teamsByPlan[plan.id].name} (${teamsByPlan[plan.id].memberCount} members)`}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                          </svg>
                          {teamsByPlan[plan.id].status === 'active' ? 'Team Active' :
                           teamsByPlan[plan.id].status === 'completing' ? 'Completing' :
                           teamsByPlan[plan.id].status === 'completed' ? 'Team Done' : 'Team'}
                        </span>
                      ) : plan.steps.length > 0 ? (
                        <button
                          onClick={() => handleLaunchTeam(plan.id)}
                          disabled={launchingTeam}
                          className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center gap-1"
                          title="Launch an agent team from this plan"
                        >
                          {launchingTeam ? (
                            <div className="animate-spin w-3 h-3 border border-purple-400 border-t-transparent rounded-full" />
                          ) : (
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                            </svg>
                          )}
                          Launch Team
                        </button>
                      ) : null}
                      {plan.steps.some(s => !s.promotedIssueId) && (
                        <button
                          onClick={() => promoteAllSteps(plan.id)}
                          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                          title="Promote all unpromoted steps to issues"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
                          </svg>
                          Promote All
                        </button>
                      )}
                      <button
                        onClick={() => setAddingStepToPlanId(plan.id)}
                        className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Add Step
                      </button>
                    </div>
                  </div>

                  {plan.steps.length === 0 ? (
                    <p className="text-sm text-vibe-muted text-center py-6">No steps yet. Add one to get started.</p>
                  ) : stepViewMode === 'graph' ? (
                    /* Dependency Graph view */
                    <DependencyGraph
                      nodes={plan.steps.map((step): GraphNode => ({
                        id: step.id,
                        label: step.title,
                        sublabel: step.stepType || undefined,
                        status: step.status,
                        statusColor:
                          step.status === 'completed' ? 'bg-green-500' :
                          step.status === 'in_progress' ? 'bg-yellow-500' :
                          step.status === 'skipped' ? 'bg-gray-400' :
                          'bg-blue-500',
                        dependsOn: step.dependencies || [],
                      }))}
                    />
                  ) : (
                    /* List view - hierarchical rendering */
                    <div className="space-y-2">
                      {(() => {
                        // Build tree structure from flat steps
                        const rootSteps = plan.steps.filter(s => !s.parentStepId)
                        const childStepsByParent = new Map<string, PlanStep[]>()
                        plan.steps.forEach(s => {
                          if (s.parentStepId) {
                            const existing = childStepsByParent.get(s.parentStepId) || []
                            existing.push(s)
                            childStepsByParent.set(s.parentStepId, existing)
                          }
                        })

                        // Render a single step card (used for both root and child steps)
                        const renderStepCard = (step: PlanStep, displayIndex: number, isChild: boolean) => {
                          const isEditingStep = editingStepId === step.id
                          const hasChildren = childStepsByParent.has(step.id)
                          const isCollapsed = collapsedSteps.has(step.id)

                          return (
                            <div key={step.id} data-step-id={step.id} data-step-status={step.status} className={`group/step bg-vibe-bg-lighter border border-vibe-border rounded-lg p-3 ${isChild ? 'bg-opacity-60' : ''}`}>
                              {isEditingStep ? (
                                <div className="space-y-2">
                                  <input type="text" value={editStepTitle} onChange={(e) => setEditStepTitle(e.target.value)}
                                    className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-sm focus:outline-none focus:border-teal-500" placeholder="Step title" />
                                  <textarea value={editStepDescription} onChange={(e) => setEditStepDescription(e.target.value)}
                                    className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-teal-500" rows={2} placeholder="Description" />
                                  <textarea value={editStepNotes} onChange={(e) => setEditStepNotes(e.target.value)}
                                    className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-teal-500" rows={2} placeholder="Notes" />
                                  <div className="flex gap-2 justify-end">
                                    <button onClick={() => setEditingStepId(null)} className="px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text">Cancel</button>
                                    <button onClick={handleSaveStepEdit} className="px-2 py-1 text-xs bg-teal-600 hover:bg-teal-500 rounded">Save</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start gap-2.5">
                                  {/* Collapse/expand toggle for parent steps */}
                                  {!isChild && hasChildren ? (
                                    <button
                                      onClick={() => toggleStepCollapse(step.id)}
                                      className="mt-0.5 w-5 h-5 flex-shrink-0 flex items-center justify-center text-vibe-muted hover:text-vibe-text transition-colors"
                                      title={isCollapsed ? 'Expand sub-steps' : 'Collapse sub-steps'}
                                    >
                                      <svg className={`w-3 h-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                      </svg>
                                    </button>
                                  ) : !isChild ? (
                                    <div className="w-5 flex-shrink-0" />
                                  ) : null}
                                  <button
                                    onClick={() => toggleStepComplete(step.id)}
                                    className={`mt-0.5 w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                                      step.status === 'completed' ? 'bg-green-500 border-green-500 text-white' : 'border-vibe-border hover:border-green-500'
                                    }`}
                                  >
                                    {step.status === 'completed' && (
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                      </svg>
                                    )}
                                  </button>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className={`font-mono ${isChild ? 'text-[10px] text-vibe-muted/70' : 'text-xs text-vibe-muted'}`}>#{displayIndex + 1}</span>
                                      {step.stepType && (
                                        <span className={`px-1.5 py-0.5 text-[10px] rounded ${STEP_TYPE_CONFIG[step.stepType].bgColor} ${STEP_TYPE_CONFIG[step.stepType].color}`}>
                                          {STEP_TYPE_CONFIG[step.stepType].label}
                                        </span>
                                      )}
                                      <span className={`font-medium ${isChild ? 'text-xs' : 'text-sm'} ${step.status === 'completed' ? 'line-through text-vibe-muted' : ''}`}>
                                        {step.title}
                                      </span>
                                      {hasChildren && (
                                        <span className="text-[10px] text-vibe-muted">
                                          ({childStepsByParent.get(step.id)!.length} sub-step{childStepsByParent.get(step.id)!.length !== 1 ? 's' : ''})
                                        </span>
                                      )}
                                      {step.estimatedEffort && (
                                        <span className={`text-[10px] ${EFFORT_CONFIG[step.estimatedEffort].color}`}>
                                          [{EFFORT_CONFIG[step.estimatedEffort].label}]
                                        </span>
                                      )}
                                      {step.promotedIssueId && (
                                        <span className="text-[10px] text-blue-400 flex items-center gap-0.5" title="Promoted to issue">
                                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                                          </svg>
                                          Issue
                                        </span>
                                      )}
                                    </div>
                                    {step.description && (
                                      <p className={`${isChild ? 'text-xs' : 'text-sm'} text-vibe-muted mt-1`}>{step.description}</p>
                                    )}
                                    {step.notes && (
                                      <p className="text-xs text-yellow-400/80 mt-1.5 italic bg-yellow-500/5 rounded px-2 py-1">{step.notes}</p>
                                    )}
                                    {step.acceptanceCriteria && step.acceptanceCriteria.length > 0 && (
                                      <div className="mt-2 space-y-1">
                                        <span className="text-[10px] text-vibe-muted font-medium uppercase tracking-wider">Acceptance Criteria</span>
                                        {step.acceptanceCriteria.map((ac, ai) => (
                                          <div key={ai} className="flex items-start gap-1.5 text-xs text-vibe-muted">
                                            <span className="mt-0.5 text-green-500/50">&#10003;</span>
                                            <span>{ac}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {step.targetFiles && step.targetFiles.length > 0 && (
                                      <div className="mt-2">
                                        <span className="text-[10px] text-vibe-muted font-medium uppercase tracking-wider">Target Files</span>
                                        <div className="mt-0.5 flex flex-wrap gap-1">
                                          {step.targetFiles.map((f, fi) => (
                                            <span key={fi} className="text-xs font-mono bg-vibe-bg px-1.5 py-0.5 rounded text-vibe-muted">{f}</span>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {step.dependencies && step.dependencies.length > 0 && (
                                      <div className="mt-2">
                                        <span className="text-[10px] text-vibe-muted font-medium uppercase tracking-wider">Dependencies</span>
                                        <div className="mt-0.5 flex flex-wrap gap-1">
                                          {step.dependencies.map((depId, di) => {
                                            const depStep = plan.steps.find(s => s.id === depId)
                                            return (
                                              <span key={di} className="text-xs bg-vibe-bg px-1.5 py-0.5 rounded flex items-center gap-1">
                                                <span className={`w-1.5 h-1.5 rounded-full ${
                                                  depStep?.status === 'completed' ? 'bg-green-400' :
                                                  depStep?.status === 'in_progress' ? 'bg-yellow-400' : 'bg-gray-500'
                                                }`} />
                                                <span className="text-vibe-muted">{depStep ? `#${depStep.stepOrder + 1} ${depStep.title}` : depId}</span>
                                              </span>
                                            )
                                          })}
                                        </div>
                                      </div>
                                    )}
                                    {step.verificationStrategy && (
                                      <div className="mt-2 border border-vibe-border rounded px-2 py-1.5 bg-vibe-bg">
                                        <span className="text-[10px] text-vibe-muted font-medium uppercase tracking-wider">Verification</span>
                                        <div className="text-xs text-vibe-muted mt-0.5">
                                          {step.verificationStrategy.method}
                                          {step.verificationStrategy.command && (
                                            <code className="ml-1 font-mono text-cyan-400/70">{step.verificationStrategy.command}</code>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                    {step.codeContext && (
                                      <details className="mt-2">
                                        <summary className="text-[10px] text-vibe-muted cursor-pointer hover:text-vibe-text font-medium uppercase tracking-wider">Code Context</summary>
                                        <pre className="text-xs text-vibe-muted bg-vibe-bg p-2 rounded mt-1 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">{step.codeContext}</pre>
                                      </details>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1 opacity-0 group-hover/step:opacity-100 transition-opacity flex-shrink-0">
                                    <select
                                      value={step.status}
                                      onChange={(e) => handleStepStatusChange(step.id, e.target.value as PlanStepStatus)}
                                      className="text-xs bg-vibe-bg border border-vibe-border rounded px-1 py-0.5 focus:outline-none focus:border-teal-500"
                                    >
                                      {(Object.keys(STEP_STATUS_CONFIG) as PlanStepStatus[]).map((status) => (
                                        <option key={status} value={status}>{STEP_STATUS_CONFIG[status].label}</option>
                                      ))}
                                    </select>
                                    {!step.promotedIssueId && (
                                      <button onClick={() => promoteStepToIssue(step.id)} className="p-1 text-vibe-muted hover:text-blue-400 transition-colors" title="Promote to issue">
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
                                        </svg>
                                      </button>
                                    )}
                                    <button onClick={() => handleStartEditStep(step)} className="p-1 text-vibe-muted hover:text-teal-400 transition-colors" title="Edit">
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                      </svg>
                                    </button>
                                    <button onClick={() => deleteStep(step.id)} className="p-1 text-vibe-muted hover:text-red-400 transition-colors" title="Delete">
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        }

                        // Render steps hierarchically: root steps first, then children indented below
                        return rootSteps.map((step, index) => {
                          const children = childStepsByParent.get(step.id) || []
                          const isCollapsed = collapsedSteps.has(step.id)

                          return (
                            <div key={step.id}>
                              {renderStepCard(step, index, false)}
                              {children.length > 0 && !isCollapsed && (
                                <div className="ml-6 mt-1 space-y-1 border-l-2 border-vibe-border pl-3">
                                  {children.map((child, ci) => renderStepCard(child, ci, true))}
                                </div>
                              )}
                            </div>
                          )
                        })
                      })()}
                    </div>
                  )}

                  {/* Add step form */}
                  {addingStepToPlanId === plan.id && (
                    <div className="mt-2 p-3 bg-vibe-bg border border-vibe-border rounded-lg space-y-2">
                      <input type="text" value={addStepTitle} onChange={(e) => setAddStepTitle(e.target.value)}
                        className="w-full bg-vibe-bg-lighter border border-vibe-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-teal-500"
                        placeholder="Step title" autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddStep(plan.id) }
                          else if (e.key === 'Escape') { setAddingStepToPlanId(null); setAddStepTitle(''); setAddStepDescription('') }
                        }}
                      />
                      <textarea value={addStepDescription} onChange={(e) => setAddStepDescription(e.target.value)}
                        className="w-full bg-vibe-bg-lighter border border-vibe-border rounded px-2 py-1.5 text-sm resize-none focus:outline-none focus:border-teal-500"
                        rows={2} placeholder="Description (optional)" />
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => { setAddingStepToPlanId(null); setAddStepTitle(''); setAddStepDescription('') }}
                          className="px-3 py-1 text-xs text-vibe-muted hover:text-vibe-text">Cancel</button>
                        <button onClick={() => handleAddStep(plan.id)} disabled={!addStepTitle.trim()}
                          className="px-3 py-1 text-xs bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded">Add</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Coordination Dashboard - shown when plan has promoted issues */}
                {plan.steps.some(s => s.promotedIssueId) && (() => {
                  const promotedSteps = plan.steps.filter(s => s.promotedIssueId)
                  const completedCount = promotedSteps.filter(s => s.status === 'completed').length
                  const inProgressCount = promotedSteps.filter(s => s.status === 'in_progress').length
                  const pendingCount = promotedSteps.filter(s => s.status === 'pending').length
                  const blockedCount = promotedSteps.filter(s => {
                    if (!s.dependencies || s.dependencies.length === 0) return false
                    return s.dependencies.some(depId => {
                      const dep = plan.steps.find(ds => ds.id === depId)
                      return dep && dep.status !== 'completed'
                    })
                  }).length
                  const readyCount = promotedSteps.length - completedCount - inProgressCount - blockedCount

                  // Count active and stale agents
                  const assignedIssues = promotedSteps
                    .map(s => issuesById.get(s.promotedIssueId!))
                    .filter(i => i?.assignment?.terminalId)
                  const activeAgents = assignedIssues.filter(i => i && !isAgentStale(i, now)).length
                  const staleAgents = assignedIssues.filter(i => i && isAgentStale(i, now)).length

                  return (
                    <div className="mt-1">
                      <details className="group/coord" open>
                        <summary className="text-xs font-medium text-purple-400 cursor-pointer hover:text-purple-300 flex items-center gap-1">
                          <svg className="w-3 h-3 transition-transform group-open/coord:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                          Multi-Agent Coordination ({promotedSteps.length} issues)
                        </summary>
                        <div className="mt-2 bg-purple-500/5 border border-purple-500/20 rounded-lg p-3">
                          {/* Summary bar */}
                          <div className="flex items-center gap-3 text-[10px] mb-3 flex-wrap">
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full bg-green-500" />
                              {completedCount} done
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full bg-yellow-500" />
                              {inProgressCount} in progress{activeAgents > 0 ? ` (${activeAgents} agent${activeAgents > 1 ? 's' : ''})` : ''}
                            </span>
                            {staleAgents > 0 && (
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-orange-500" />
                                {staleAgents} stale
                              </span>
                            )}
                            {blockedCount > 0 && (
                              <span className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full bg-red-500" />
                                {blockedCount} blocked
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-full bg-blue-500" />
                              {readyCount > 0 ? readyCount : pendingCount} ready
                            </span>
                          </div>

                          {/* Step list with dependency visualization */}
                          <div className="space-y-1.5">
                            {plan.steps.map((step, idx) => {
                              const isPromoted = !!step.promotedIssueId
                              const linkedIssue = isPromoted ? issuesById.get(step.promotedIssueId!) : undefined
                              const hasDeps = step.dependencies && step.dependencies.length > 0
                              const isBlocked = hasDeps && step.dependencies!.some(depId => {
                                const dep = plan.steps.find(ds => ds.id === depId)
                                return dep && dep.status !== 'completed'
                              })
                              const statusColor =
                                step.status === 'completed' ? 'bg-green-500' :
                                step.status === 'in_progress' ? 'bg-yellow-500' :
                                isBlocked ? 'bg-red-500' :
                                step.status === 'skipped' ? 'bg-gray-500' : 'bg-gray-600'

                              // Calculate indent level based on dependencies
                              const depLevel = hasDeps ? 1 : 0

                              // Agent info for this step's issue
                              const agentLabel = linkedIssue?.assignment?.agentLabel
                              const agentIsStale = linkedIssue ? isAgentStale(linkedIssue, now) : false

                              return (
                                <div key={step.id} className="flex items-center gap-2 text-xs" style={{ paddingLeft: `${depLevel * 16}px` }}>
                                  {depLevel > 0 && (
                                    <span className="text-vibe-muted text-[10px]">&#8627;</span>
                                  )}
                                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
                                  <span className="text-vibe-muted font-mono">#{idx + 1}</span>
                                  <span className={`flex-1 truncate ${step.status === 'completed' ? 'line-through text-vibe-muted' : ''}`}>
                                    {step.title}
                                  </span>
                                  {agentLabel && (
                                    <span className={`text-[10px] flex-shrink-0 flex items-center gap-0.5 ${agentIsStale ? 'text-orange-400' : 'text-green-400'}`} title={agentIsStale ? 'Agent may be inactive' : 'Agent active'}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${agentIsStale ? 'bg-orange-400' : 'bg-green-400'}`} />
                                      {agentLabel}
                                    </span>
                                  )}
                                  {isPromoted && !agentLabel && (
                                    <span className="text-[10px] text-blue-400 flex-shrink-0" data-testid="coord-issue-ref" title={linkedIssue ? `${linkedIssue.title} (${linkedIssue.status})` : undefined}>
                                      {linkedIssue ? ctx.data.issues.displayRef(linkedIssue) : 'issue'}
                                    </span>
                                  )}
                                  <span className={`text-[10px] flex-shrink-0 ${STEP_STATUS_CONFIG[step.status].color}`}>
                                    {STEP_STATUS_CONFIG[step.status].label}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </details>
                    </div>
                  )
                })()}
                {/* End of steps+coordination conditional */}
                </>)}
              </div>
            </div>
          )
        })()}
      </div>

      {/* Create Plan Modal — Guided Wizard */}
      <Modal open={showCreateModal} onClose={resetCreate} overlayId="plans-create" title="New Plan" description="How would you like to start?"
        footer={<Scoped><div className="flex justify-end gap-2">
              <button
                onClick={resetCreate}
                className="px-4 py-2 text-sm text-vibe-muted hover:text-vibe-text transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="plans-create-submit"
                onClick={async () => {
                  if (!newPlanTitle.trim()) return
                  const specType = (['greenfield', 'feature', 'refactor'].includes(newPlanDescription))
                    ? newPlanDescription as 'greenfield' | 'feature' | 'refactor'
                    : undefined
                  const plan = await run(() => model.createPlan(newPlanTitle.trim(), { specType }))
                  if (!plan) return

                  if (newPlanIdeaId === 'brainstorm') {
                    // Launch brainstorm agent
                    const ideaText = newStepTitle.trim()
                    const prompt = ideaText
                      ? `/brainstorm-spec ${plan.id} ${ideaText}`
                      : `/brainstorm-spec ${plan.id}`
                    void runSkill(ctx, prompt)
                  }

                  resetCreate()
                  setSelectedPlanId(plan.id)
                }}
                disabled={!newPlanTitle.trim() || !newPlanIdeaId}
                className="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {newPlanIdeaId === 'brainstorm' ? 'Create & Brainstorm' : 'Create Plan'}
              </button>
        </div></Scoped>}>
        <Scoped>
            <div className="space-y-4" data-testid="plans-create-modal">
              {/* Title */}
              <div>
                <label className="block text-xs text-vibe-muted mb-1">Plan Title *</label>
                <input
                  ref={titleInputRef}
                  type="text"
                  value={newPlanTitle}
                  onChange={(e) => setNewPlanTitle(e.target.value)}
                  className="w-full bg-vibe-bg border border-vibe-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
                  placeholder="e.g., User Authentication System"
                />
              </div>

              {/* Project Type */}
              <div>
                <label className="block text-xs text-vibe-muted mb-1">Project Type</label>
                <div className="flex gap-2">
                  {[
                    { value: 'greenfield', label: 'New Project', desc: 'Building from scratch', icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6' },
                    { value: 'feature', label: 'New Feature', desc: 'Adding to existing code', icon: 'M12 4v16m8-8H4' },
                    { value: 'refactor', label: 'Refactor', desc: 'Improving existing code', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
                  ].map((st) => (
                    <button
                      key={st.value}
                      onClick={() => setNewPlanDescription(st.value)}
                      className={`flex-1 flex flex-col items-center gap-1.5 p-3 text-xs rounded-lg border transition-colors ${
                        newPlanDescription === st.value
                          ? 'bg-teal-600/20 border-teal-500/50 text-teal-400'
                          : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={st.icon} />
                      </svg>
                      <span className="font-medium">{st.label}</span>
                      <span className="text-[10px] text-vibe-muted/70">{st.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Starting Point — the key choice */}
              <div>
                <label className="block text-xs text-vibe-muted mb-2">Starting Point</label>
                <div className="grid grid-cols-2 gap-3">
                  {/* I have a spec */}
                  <button
                    onClick={() => setNewPlanIdeaId('has_spec')}
                    className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                      newPlanIdeaId === 'has_spec'
                        ? 'bg-blue-600/20 border-blue-500/50 text-blue-400'
                        : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
                    }`}
                  >
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-sm font-medium">I Have a Spec</span>
                    <span className="text-[10px] text-vibe-muted/70 text-center">Paste or import an existing spec document</span>
                  </button>

                  {/* Start from scratch — brainstorm */}
                  <button
                    onClick={() => setNewPlanIdeaId('brainstorm')}
                    className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                      newPlanIdeaId === 'brainstorm'
                        ? 'bg-purple-600/20 border-purple-500/50 text-purple-400'
                        : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
                    }`}
                  >
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    <span className="text-sm font-medium">Start from Scratch</span>
                    <span className="text-[10px] text-vibe-muted/70 text-center">Brainstorm with an AI agent to create the spec</span>
                  </button>
                </div>
              </div>

              {/* Brainstorm options — shown when "Start from Scratch" selected */}
              {newPlanIdeaId === 'brainstorm' && (
                <div className="space-y-3 bg-purple-500/5 border border-purple-500/20 rounded-lg p-3">
                  <div>
                    <label className="block text-xs text-purple-400 font-medium mb-1">Describe your idea</label>
                    <textarea
                      value={newStepTitle}
                      onChange={(e) => setNewStepTitle(e.target.value)}
                      className="w-full bg-vibe-bg border border-vibe-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-purple-500"
                      rows={3}
                      placeholder="What are you building? What problem does it solve? Any initial thoughts on how..."
                    />
                  </div>
                  <div className="text-[10px] text-vibe-muted">
                    An AI agent will open in a terminal to brainstorm with you. Once you're happy with the direction, it will generate a spec document for the plan.
                  </div>
                </div>
              )}
            </div>
        </Scoped>
      </Modal>
    </div>
  )
}
