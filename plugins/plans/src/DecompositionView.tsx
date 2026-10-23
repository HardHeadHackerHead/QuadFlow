import { useState, useCallback, useMemo } from 'react'
import { Markdown } from '@quadflow/ui'
import { guard, type Plan, type PlanStep, type PlanStatus } from './model'
import { runSkill, usePlans } from './context'
import PlanCommentsPanel from './PlanCommentsPanel'

interface DecompositionViewProps {
  plan: Plan
}

export default function DecompositionView({ plan }: DecompositionViewProps) {
  const { ctx, model } = usePlans()
  const run = useMemo(() => guard(ctx, 'Plans'), [ctx])
  const updatePlan = useCallback((id: string, u: Parameters<typeof model.updatePlan>[1]) => run(() => model.updatePlan(id, u)), [model, run])
  const [runningSkill, setRunningSkill] = useState<string | null>(null)
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())
  const [showSpec, setShowSpec] = useState(false)

  const isDecomposing = plan.status === 'decomposing'
  const isReviewSteps = plan.status === 'review_steps'

  // Group steps by parent
  const parentSteps = plan.steps.filter(s => !s.parentStepId)
  const childStepsMap = new Map<string, PlanStep[]>()
  plan.steps.filter(s => s.parentStepId).forEach(s => {
    const children = childStepsMap.get(s.parentStepId!) || []
    children.push(s)
    childStepsMap.set(s.parentStepId!, children)
  })

  const handleRunSkill = useCallback(async (command: string, skillId: string) => {
    setRunningSkill(skillId)
    try {
      await runSkill(ctx, command)
    } finally {
      setRunningSkill(null)
    }
  }, [ctx])

  const toggleEpic = (stepId: string) => {
    setExpandedEpics(prev => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  const handleAdvance = useCallback(async (status: PlanStatus) => {
    await updatePlan(plan.id, { status })
  }, [plan.id, updatePlan])

  const STEP_TYPE_COLORS: Record<string, string> = {
    research: 'text-purple-400 bg-purple-500/20',
    design: 'text-blue-400 bg-blue-500/20',
    implement: 'text-green-400 bg-green-500/20',
    test: 'text-yellow-400 bg-yellow-500/20',
    verify: 'text-orange-400 bg-orange-500/20',
    document: 'text-cyan-400 bg-cyan-500/20',
  }

  return (
    <div className="space-y-3">
      {/* Collapsible spec reference */}
      {plan.specContent && (
        <details open={showSpec} onToggle={(e) => setShowSpec((e.target as HTMLDetailsElement).open)}>
          <summary className="text-xs font-medium text-purple-400 cursor-pointer hover:text-purple-300 flex items-center gap-1">
            <svg className="w-3 h-3 transition-transform" style={{ transform: showSpec ? 'rotate(90deg)' : '' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Spec Reference
          </summary>
          <div className="mt-2 bg-purple-500/5 border border-purple-500/20 rounded-lg p-3 max-h-[300px] overflow-y-auto">
            <Markdown className="text-xs">{plan.specContent}</Markdown>
          </div>
        </details>
      )}

      {/* Decomposing phase actions */}
      {isDecomposing && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleRunSkill(`/decompose-spec ${plan.id}`, 'decompose')}
            disabled={runningSkill === 'decompose'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-indigo-400 bg-indigo-500/10 border border-indigo-500/30 rounded hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
            </svg>
            {runningSkill === 'decompose' ? 'Generating...' : 'Generate Epics'}
          </button>

          {parentSteps.length > 0 && parentSteps.some(s => !childStepsMap.has(s.id)) && (
            <button
              onClick={() => {
                // Expand all parents that don't have children yet
                parentSteps.filter(s => !childStepsMap.has(s.id)).forEach(s => {
                  handleRunSkill(`/expand-epic ${plan.id} ${s.id}`, `expand-${s.id}`)
                })
              }}
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-teal-400 bg-teal-500/10 border border-teal-500/30 rounded hover:bg-teal-500/20 transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
              Expand All Epics
            </button>
          )}

          <div className="flex-1" />

          {plan.steps.length > 0 && (
            <button
              onClick={() => handleAdvance('review_steps')}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors"
            >
              Review Steps
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Review Steps phase actions */}
      {isReviewSteps && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => handleRunSkill(`/verify-plan ${plan.id}`, 'verify')}
            disabled={runningSkill === 'verify'}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded hover:bg-orange-500/20 transition-colors disabled:opacity-50"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {runningSkill === 'verify' ? 'Verifying...' : 'Verify Plan'}
          </button>

          <div className="flex-1" />

          <button
            onClick={() => handleAdvance('promoting')}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors"
          >
            Configure Promotion
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}

      {/* Hierarchical step list (decomposing phase) */}
      {isDecomposing && (
        <div className="space-y-2">
          {parentSteps.length === 0 ? (
            <div className="text-center py-8 text-vibe-muted/50 text-sm">
              No steps yet. Click "Generate Epics" to break the spec into high-level work areas.
            </div>
          ) : (
            parentSteps.map((parent) => {
              const children = childStepsMap.get(parent.id) || []
              const isExpanded = expandedEpics.has(parent.id)

              return (
                <div key={parent.id} className="bg-vibe-bg-lighter border border-vibe-border rounded-lg overflow-hidden">
                  {/* Parent step header */}
                  <div
                    className="flex items-center gap-2 p-2.5 cursor-pointer hover:bg-vibe-bg transition-colors"
                    onClick={() => toggleEpic(parent.id)}
                  >
                    <svg className={`w-3 h-3 text-vibe-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{parent.title}</span>
                        {parent.stepType && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${STEP_TYPE_COLORS[parent.stepType] || 'text-gray-400 bg-gray-500/20'}`}>
                            {parent.stepType}
                          </span>
                        )}
                        {parent.estimatedEffort && (
                          <span className="text-[10px] text-vibe-muted/50">{parent.estimatedEffort}</span>
                        )}
                      </div>
                      {parent.description && (
                        <p className="text-xs text-vibe-muted mt-0.5 truncate">{parent.description}</p>
                      )}
                    </div>

                    <span className="text-[10px] text-vibe-muted px-1.5 py-0.5 bg-vibe-bg rounded">
                      {children.length} sub-steps
                    </span>

                    {/* Expand button */}
                    {children.length === 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleRunSkill(`/expand-epic ${plan.id} ${parent.id}`, `expand-${parent.id}`)
                        }}
                        disabled={runningSkill === `expand-${parent.id}`}
                        className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-teal-400 bg-teal-500/10 border border-teal-500/30 rounded hover:bg-teal-500/20 transition-colors disabled:opacity-50"
                      >
                        {runningSkill === `expand-${parent.id}` ? 'Expanding...' : 'Expand'}
                      </button>
                    )}
                  </div>

                  {/* Children */}
                  {isExpanded && children.length > 0 && (
                    <div className="border-t border-vibe-border">
                      {children.sort((a, b) => a.stepOrder - b.stepOrder).map((child) => (
                        <div key={child.id} className="flex items-center gap-2 px-4 py-1.5 pl-8 border-b border-vibe-border/50 last:border-0 text-xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-vibe-muted/30 flex-shrink-0" />
                          <span className="flex-1 truncate">{child.title}</span>
                          {child.stepType && (
                            <span className={`text-[10px] px-1 py-0.5 rounded ${STEP_TYPE_COLORS[child.stepType] || 'text-gray-400 bg-gray-500/20'}`}>
                              {child.stepType}
                            </span>
                          )}
                          {child.estimatedEffort && (
                            <span className="text-[10px] text-vibe-muted/50">{child.estimatedEffort}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* Verification comments (review_steps phase) */}
      {isReviewSteps && (
        <PlanCommentsPanel
          planId={plan.id}
          filterType="verification"
          title="Verification Findings"
        />
      )}
    </div>
  )
}
