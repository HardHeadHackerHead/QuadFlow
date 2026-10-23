/**
 * The Plans plugin's state: one live collection of the project's plans per
 * plugin context (pane and flyout share it) plus every mutation, all through
 * `ctx.data.plans.*` with an explicit `projectRoot` captured before the call
 * (a reply that lands after a project switch never touches the new list).
 *
 * The view works on a small view model (`Plan` / `PlanStep` below) mapped from
 * the core's `Plan_Serialize`; `planPatch` / `stepPatch` build the core patches
 * (a present key with `undefined` / `''` clears that field).
 */
import { create } from 'zustand'
import type {
  NewPlanStep_Deserialize,
  PlanCommentKind,
  PlanPatch_Deserialize,
  PlanSpecKind,
  PlanStatus,
  PlanStepEffort,
  PlanStepKind,
  PlanStepPatch_Deserialize,
  PlanStepStatus,
  Plan_Serialize,
  PluginContext,
  PromotionProfile_Serialize,
} from '@quadflow/plugin-api'
import { createCollection, type Collection } from '@quadflow/plugin-kit'

// ------------------------------------------------------------------ view model

export type { PlanStatus, PlanStepStatus }
export type StepType = PlanStepKind
export type EstimatedEffort = PlanStepEffort
export type PlanSpecType = PlanSpecKind
export type PlanCommentType = PlanCommentKind

export interface VerificationStrategy {
  method: string
  pattern?: string
  command?: string
}

export interface ArchitecturalDecision {
  decision: string
  rationale: string
}

export interface PlanComment {
  id: string
  planId: string
  body: string
  author?: { type: string; name: string }
  commentType: PlanCommentType
  createdAt: number
}

export interface PromotionProfile {
  createEpics: boolean
  labelStrategy: 'auto' | 'none' | 'custom'
  customLabels: string[]
  labelPrefix: string
  createBlockers: boolean
  defaultPriority: 'low' | 'medium' | 'high' | 'critical'
  priorityStrategy: 'uniform' | 'auto'
  includeAcceptanceCriteria: boolean
  includeVerificationStrategies: boolean
}

export interface PlanStep {
  id: string
  planId: string
  stepOrder: number
  title: string
  description?: string
  status: PlanStepStatus
  notes?: string
  stepType?: StepType
  acceptanceCriteria?: string[]
  targetFiles?: string[]
  codeContext?: string
  estimatedEffort?: EstimatedEffort
  dependencies?: string[]
  verificationStrategy?: VerificationStrategy
  promotedIssueId?: string
  /** Epic this parent step was promoted to (promotion profile `createEpics`). */
  promotedEpicId?: string
  parentStepId?: string
  estimatedHours?: number
  actualHours?: number
  startedAt?: number
  completedAt?: number
  createdAt: number
  updatedAt: number
}

export interface Plan {
  id: string
  title: string
  description?: string
  status: PlanStatus
  ideaId?: string
  discoveryId?: string
  steps: PlanStep[]
  /** Oldest first. */
  comments: PlanComment[]
  architecturalDecisions?: ArchitecturalDecision[]
  riskNotes?: string
  context?: string
  specContent?: string
  specType?: PlanSpecType
  promotionProfile?: PromotionProfile
  createdAt: number
  updatedAt: number
}

// ------------------------------------------------------------------ mapping

function toProfile(p: PromotionProfile_Serialize): PromotionProfile {
  return {
    createEpics: p.createEpics ?? false,
    labelStrategy: p.labelStrategy ?? 'auto',
    customLabels: p.customLabels ?? [],
    labelPrefix: p.labelPrefix ?? '',
    createBlockers: p.createBlockers ?? false,
    defaultPriority: p.defaultPriority ?? 'medium',
    priorityStrategy: p.priorityStrategy ?? 'auto',
    includeAcceptanceCriteria: p.includeAcceptanceCriteria ?? false,
    includeVerificationStrategies: p.includeVerification ?? false,
  }
}

function fromProfile(p: PromotionProfile): PromotionProfile_Serialize {
  return {
    createEpics: p.createEpics,
    labelStrategy: p.labelStrategy,
    customLabels: p.customLabels,
    labelPrefix: p.labelPrefix.trim() || null,
    createBlockers: p.createBlockers,
    defaultPriority: p.defaultPriority,
    priorityStrategy: p.priorityStrategy,
    includeAcceptanceCriteria: p.includeAcceptanceCriteria,
    includeVerification: p.includeVerificationStrategies,
  }
}

export function toPlan(p: Plan_Serialize): Plan {
  const steps = [...(p.steps ?? [])].sort((a, b) => a.order - b.order)
  return {
    id: p.id,
    title: p.title,
    description: p.description ?? undefined,
    status: p.status,
    ideaId: p.ideaId ?? undefined,
    discoveryId: p.discoveryId ?? undefined,
    steps: steps.map(
      (s): PlanStep => ({
        id: s.id,
        planId: p.id,
        stepOrder: s.order,
        title: s.title,
        description: s.description ?? undefined,
        status: s.status,
        notes: s.notes ?? undefined,
        stepType: s.kind ?? undefined,
        acceptanceCriteria: s.acceptanceCriteria ?? [],
        targetFiles: s.targetFiles ?? [],
        codeContext: s.codeContext ?? undefined,
        estimatedEffort: s.effort ?? undefined,
        dependencies: s.dependsOn ?? [],
        verificationStrategy: s.verification
          ? { method: s.verification.method, pattern: s.verification.pattern ?? undefined, command: s.verification.command ?? undefined }
          : undefined,
        promotedIssueId: s.issueId ?? undefined,
        promotedEpicId: s.epicId ?? undefined,
        parentStepId: s.parentId ?? undefined,
        estimatedHours: s.estimatedHours ?? undefined,
        actualHours: s.actualHours ?? undefined,
        startedAt: s.startedAt ?? undefined,
        completedAt: s.completedAt ?? undefined,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      }),
    ),
    comments: (p.comments ?? [])
      .map(
        (c): PlanComment => ({
          id: c.id,
          planId: p.id,
          body: c.body,
          author: { type: c.createdBy.kind, name: c.createdBy.name },
          commentType: c.kind ?? 'general',
          createdAt: c.createdAt,
        }),
      )
      .sort((a, b) => a.createdAt - b.createdAt),
    architecturalDecisions: (p.decisions ?? []).map((d) => ({ decision: d.decision, rationale: d.rationale ?? '' })),
    riskNotes: p.riskNotes ?? undefined,
    context: p.context ?? undefined,
    specContent: p.spec?.content,
    specType: p.spec?.kind,
    promotionProfile: p.promotionProfile ? toProfile(p.promotionProfile) : undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

// ------------------------------------------------------------------ inputs

export interface StepInput {
  title: string
  description?: string
  status?: PlanStepStatus
  parentStepId?: string
  stepType?: StepType
  notes?: string
  acceptanceCriteria?: string[]
  targetFiles?: string[]
  codeContext?: string
  estimatedEffort?: EstimatedEffort
  estimatedHours?: number
  dependencies?: string[]
  verificationStrategy?: VerificationStrategy
}

export interface NewPlanInput {
  description?: string
  ideaId?: string
  discoveryId?: string
  architecturalDecisions?: ArchitecturalDecision[]
  riskNotes?: string
  context?: string
  specContent?: string
  specType?: PlanSpecType
  steps?: StepInput[]
}

export type PlanUpdates = Partial<
  Pick<
    Plan,
    | 'title'
    | 'description'
    | 'status'
    | 'ideaId'
    | 'discoveryId'
    | 'architecturalDecisions'
    | 'riskNotes'
    | 'context'
    | 'specContent'
    | 'specType'
    | 'promotionProfile'
  >
>

export type StepUpdates = Partial<
  Pick<
    PlanStep,
    | 'title'
    | 'description'
    | 'status'
    | 'notes'
    | 'stepType'
    | 'acceptanceCriteria'
    | 'targetFiles'
    | 'codeContext'
    | 'estimatedEffort'
    | 'estimatedHours'
    | 'actualHours'
    | 'dependencies'
    | 'verificationStrategy'
    | 'parentStepId'
  >
>

const has = <T extends object>(o: T, k: keyof T) => Object.prototype.hasOwnProperty.call(o, k)

/** Present key with `undefined` / `''` → `null` (clear); absent key → unchanged. */
function clearable<T>(o: object, k: string, v: T | undefined): T | null | undefined {
  if (!has(o as Record<string, unknown>, k)) return undefined
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return null
  return v
}

function stepFields(s: StepInput): NewPlanStep_Deserialize {
  return {
    title: s.title,
    description: s.description ?? null,
    status: s.status ?? null,
    parentId: s.parentStepId ?? null,
    kind: s.stepType ?? null,
    notes: s.notes ?? null,
    acceptanceCriteria: s.acceptanceCriteria ?? [],
    targetFiles: s.targetFiles ?? [],
    codeContext: s.codeContext ?? null,
    effort: s.estimatedEffort ?? null,
    estimatedHours: s.estimatedHours ?? null,
    dependsOn: s.dependencies ?? [],
    verification: s.verificationStrategy ?? null,
  }
}

/** Build the core patch. `current` supplies the other half of the spec when only one of content/type changes. */
export function planPatch(u: PlanUpdates, current?: Plan): PlanPatch_Deserialize {
  const p: PlanPatch_Deserialize = {}
  if (u.title !== undefined) p.title = u.title
  if (u.status !== undefined) p.status = u.status
  const d = clearable(u, 'description', u.description)
  if (d !== undefined) p.description = d
  const idea = clearable(u, 'ideaId', u.ideaId)
  if (idea !== undefined) p.ideaId = idea
  const disc = clearable(u, 'discoveryId', u.discoveryId)
  if (disc !== undefined) p.discoveryId = disc
  const r = clearable(u, 'riskNotes', u.riskNotes)
  if (r !== undefined) p.riskNotes = r
  const c = clearable(u, 'context', u.context)
  if (c !== undefined) p.context = c
  if (has(u, 'architecturalDecisions')) p.decisions = u.architecturalDecisions ?? []
  if (has(u, 'specContent') || has(u, 'specType')) {
    const content = has(u, 'specContent') ? (u.specContent ?? '') : (current?.specContent ?? '')
    const kind = has(u, 'specType') ? u.specType : current?.specType
    p.spec = !content && !kind ? null : { content, kind: kind ?? 'feature' }
  }
  if (has(u, 'promotionProfile')) p.promotionProfile = u.promotionProfile ? fromProfile(u.promotionProfile) : null
  return p
}

export function stepPatch(u: StepUpdates): PlanStepPatch_Deserialize {
  const p: PlanStepPatch_Deserialize = {}
  if (u.title !== undefined) p.title = u.title
  if (u.status !== undefined) p.status = u.status
  if (u.acceptanceCriteria !== undefined) p.acceptanceCriteria = u.acceptanceCriteria
  if (u.targetFiles !== undefined) p.targetFiles = u.targetFiles
  if (u.dependencies !== undefined) p.dependsOn = u.dependencies
  const set = <K extends keyof PlanStepPatch_Deserialize>(k: K, v: PlanStepPatch_Deserialize[K] | undefined) => {
    if (v !== undefined) p[k] = v
  }
  set('description', clearable(u, 'description', u.description))
  set('notes', clearable(u, 'notes', u.notes))
  set('kind', clearable(u, 'stepType', u.stepType))
  set('codeContext', clearable(u, 'codeContext', u.codeContext))
  set('effort', clearable(u, 'estimatedEffort', u.estimatedEffort))
  set('estimatedHours', clearable(u, 'estimatedHours', u.estimatedHours))
  set('actualHours', clearable(u, 'actualHours', u.actualHours))
  set('verification', clearable(u, 'verificationStrategy', u.verificationStrategy))
  set('parentId', clearable(u, 'parentStepId', u.parentStepId))
  return p
}

// ------------------------------------------------------------------ model

export interface PlansModel {
  plans: Collection<Plan>
  /** UI-only state shared by every tile of this plugin. */
  ui: ReturnType<typeof createUiStore>
  createPlan(title: string, o?: NewPlanInput): Promise<Plan>
  updatePlan(id: string, u: PlanUpdates): Promise<void>
  deletePlan(id: string): Promise<void>
  /** Refetch one plan (e.g. its comments). */
  refreshPlan(id: string): Promise<void>
  addStep(planId: string, title: string, description?: string, extra?: Omit<StepInput, 'title' | 'description'>): Promise<PlanStep>
  updateStep(stepId: string, u: StepUpdates): Promise<void>
  deleteStep(stepId: string): Promise<void>
  reorderSteps(planId: string, stepIds: string[]): Promise<void>
  toggleStepComplete(stepId: string): Promise<void>
  /** Idempotent in the core: an already-promoted step returns its issue. */
  promoteStepToIssue(stepId: string): Promise<void>
  /** Returns how many issues/epics were created. */
  promoteAllSteps(planId: string): Promise<number>
  addComment(planId: string, body: string, kind?: PlanCommentType): Promise<void>
  deleteComment(planId: string, commentId: string): Promise<void>
}

function createUiStore() {
  return create<{ focusId: string | null; composeNonce: number }>(() => ({ focusId: null, composeNonce: 0 }))
}

const models = new WeakMap<PluginContext, PlansModel>()

export function plansModel(ctx: PluginContext): PlansModel {
  let m = models.get(ctx)
  if (m) return m
  const plans = createCollection<Plan>(ctx, {
    domain: 'plans',
    // Promoted issues (coordination view) and the "Linked idea" badge refetch on these.
    relatedDomains: ['issues', 'ideas'],
    list: async (c, root) => {
      const r = await c.data.plans.list({}, { projectRoot: root })
      return { items: r.items.map(toPlan), errors: r.errors }
    },
    get: async (c, id, root) => toPlan(await c.data.plans.get(id, { projectRoot: root })),
    normalize: (p) => p,
  })
  const d = ctx.data.plans
  /** Run `fn` against the current project and merge the returned plan. */
  const mutate = async (fn: (o: { projectRoot: string }) => Promise<Plan_Serialize>): Promise<Plan> => {
    const projectRoot = plans.root()
    const plan = toPlan(await fn({ projectRoot }))
    plans.apply(projectRoot, plan)
    return plan
  }
  const find = (id: string) => plans.use.getState().items.find((p) => p.id === id)
  const planOfStep = (stepId: string) => plans.use.getState().items.find((p) => p.steps.some((s) => s.id === stepId))

  m = {
    plans,
    ui: createUiStore(),
    async createPlan(title, o = {}) {
      return mutate((opt) =>
        d.create(
          {
            title,
            description: o.description ?? null,
            ideaId: o.ideaId ?? null,
            discoveryId: o.discoveryId ?? null,
            spec: o.specContent || o.specType ? { content: o.specContent ?? '', kind: o.specType ?? 'feature' } : null,
            decisions: o.architecturalDecisions ?? [],
            riskNotes: o.riskNotes ?? null,
            context: o.context ?? null,
            steps: (o.steps ?? []).map(stepFields),
          },
          opt,
        ),
      )
    },
    async updatePlan(id, u) {
      await mutate((o) => d.update(id, planPatch(u, find(id)), o))
    },
    async deletePlan(id) {
      const projectRoot = plans.root()
      await d.delete(id, { projectRoot })
      plans.remove(projectRoot, [id])
    },
    async refreshPlan(id) {
      await mutate((o) => d.get(id, o))
    },
    async addStep(planId, title, description, extra) {
      const before = new Set(find(planId)?.steps.map((s) => s.id) ?? [])
      const plan = await mutate((o) => d.stepAdd(planId, stepFields({ ...extra, title, description }), o))
      // Steps are appended with the highest order; prefer the id that is new.
      const step = plan.steps.find((s) => !before.has(s.id)) ?? plan.steps[plan.steps.length - 1]
      if (!step) throw new Error('step was not added')
      return step
    },
    async updateStep(stepId, u) {
      const plan = planOfStep(stepId)
      if (!plan) throw new Error(`Step not found: ${stepId}`)
      await mutate((o) => d.stepUpdate(plan.id, stepId, stepPatch(u), o))
    },
    async deleteStep(stepId) {
      const plan = planOfStep(stepId)
      if (!plan) return
      await mutate((o) => d.stepDelete(plan.id, stepId, o))
    },
    async reorderSteps(planId, stepIds) {
      await mutate((o) => d.stepsReorder(planId, stepIds, o))
    },
    async toggleStepComplete(stepId) {
      const step = planOfStep(stepId)?.steps.find((s) => s.id === stepId)
      if (!step) return
      await m!.updateStep(stepId, { status: step.status === 'completed' ? 'pending' : 'completed' })
    },
    async promoteStepToIssue(stepId) {
      const plan = planOfStep(stepId)
      if (!plan) return
      await mutate(async (o) => (await d.promoteStep(plan.id, stepId, o)).plan)
    },
    async promoteAllSteps(planId) {
      const projectRoot = plans.root()
      const res = await d.promoteAll(planId, { projectRoot })
      plans.apply(projectRoot, toPlan(res.plan))
      return res.created
    },
    async addComment(planId, body, kind = 'general') {
      await mutate((o) => d.commentAdd(planId, { body, kind }, o))
    },
    async deleteComment(planId, commentId) {
      await mutate((o) => d.commentDelete(planId, commentId, o))
    },
  }
  models.set(ctx, m)
  return m
}

/** Wrap a UI action: failures become an error toast instead of a silent console error. */
export function guard(ctx: PluginContext, title: string) {
  return async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (e) {
      ctx.log.error(`${title}:`, e)
      ctx.notifications.toast({ kind: 'error', title, body: e instanceof Error ? e.message : String(e) })
      return undefined
    }
  }
}
