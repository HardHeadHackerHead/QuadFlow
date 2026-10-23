import { useState, useCallback, useEffect, useMemo } from 'react'
import { guard, type Plan, type PlanStatus, type PromotionProfile } from './model'
import { runSkill, usePlans } from './context'

const DEFAULT_PROFILE: PromotionProfile = {
  createEpics: true,
  labelStrategy: 'auto',
  customLabels: [],
  labelPrefix: '',
  createBlockers: true,
  defaultPriority: 'medium',
  priorityStrategy: 'auto',
  includeAcceptanceCriteria: true,
  includeVerificationStrategies: true,
}

interface PromotionProfileEditorProps {
  plan: Plan
}

export default function PromotionProfileEditor({ plan }: PromotionProfileEditorProps) {
  const { ctx, model } = usePlans()
  const run = useMemo(() => guard(ctx, 'Plans'), [ctx])
  const updatePlan = useCallback((id: string, u: Parameters<typeof model.updatePlan>[1]) => run(() => model.updatePlan(id, u)), [model, run])
  const promoteAllSteps = model.promoteAllSteps
  const [profile, setProfile] = useState<PromotionProfile>(
    (plan.promotionProfile as PromotionProfile) || DEFAULT_PROFILE
  )
  const [customLabelInput, setCustomLabelInput] = useState('')
  const [isPromoting, setIsPromoting] = useState(false)
  const [promotionResult, setPromotionResult] = useState<{ count: number } | null>(null)
  const [runningSkill, setRunningSkill] = useState<string | null>(null)

  // Auto-save profile on change
  useEffect(() => {
    const timer = setTimeout(() => {
      updatePlan(plan.id, { promotionProfile: profile })
    }, 500)
    return () => clearTimeout(timer)
  }, [profile, plan.id, updatePlan])

  // Compute stats
  const stats = useMemo(() => {
    const parentSteps = plan.steps.filter(s => !s.parentStepId)
    const childSteps = plan.steps.filter(s => s.parentStepId)
    const totalSteps = plan.steps.length
    const stepsWithDeps = plan.steps.filter(s => s.dependencies && s.dependencies.length > 0).length

    return {
      epicCount: profile.createEpics ? parentSteps.length : 0,
      issueCount: profile.createEpics ? childSteps.length : totalSteps,
      blockerCount: profile.createBlockers ? stepsWithDeps : 0,
      totalSteps,
    }
  }, [plan.steps, profile.createEpics, profile.createBlockers])

  const updateField = <K extends keyof PromotionProfile>(key: K, value: PromotionProfile[K]) => {
    setProfile(prev => ({ ...prev, [key]: value }))
  }

  const addCustomLabel = () => {
    if (customLabelInput.trim() && !profile.customLabels.includes(customLabelInput.trim())) {
      updateField('customLabels', [...profile.customLabels, customLabelInput.trim()])
      setCustomLabelInput('')
    }
  }

  const removeCustomLabel = (label: string) => {
    updateField('customLabels', profile.customLabels.filter(l => l !== label))
  }

  const handlePromote = useCallback(async () => {
    setIsPromoting(true)
    try {
      const count = await promoteAllSteps(plan.id)
      setPromotionResult({ count })
      // Auto-advance to executing
      await updatePlan(plan.id, { status: 'executing' as PlanStatus })
    } catch (error) {
      ctx.notifications.toast({ kind: 'error', title: 'Promotion failed', body: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsPromoting(false)
    }
  }, [ctx, plan.id, promoteAllSteps, updatePlan])

  const handleRunSkill = useCallback(async (command: string, skillId: string) => {
    setRunningSkill(skillId)
    try {
      await runSkill(ctx, command)
    } finally {
      setRunningSkill(null)
    }
  }, [ctx])

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="bg-vibe-bg-lighter border border-vibe-border rounded-lg p-3">
        <div className="text-xs font-medium text-vibe-muted mb-2">Promotion Summary</div>
        <div className="grid grid-cols-4 gap-3 text-center">
          <div>
            <div className="text-lg font-bold text-indigo-400">{stats.epicCount}</div>
            <div className="text-[10px] text-vibe-muted">Epics</div>
          </div>
          <div>
            <div className="text-lg font-bold text-teal-400">{stats.issueCount}</div>
            <div className="text-[10px] text-vibe-muted">Issues</div>
          </div>
          <div>
            <div className="text-lg font-bold text-red-400">{stats.blockerCount}</div>
            <div className="text-[10px] text-vibe-muted">Blockers</div>
          </div>
          <div>
            <div className="text-lg font-bold text-vibe-text">{stats.totalSteps}</div>
            <div className="text-[10px] text-vibe-muted">Total Steps</div>
          </div>
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-3">
        {/* Create Epics */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium">Create Epics</div>
            <div className="text-[10px] text-vibe-muted">Parent steps become standalone Epics</div>
          </div>
          <button
            onClick={() => updateField('createEpics', !profile.createEpics)}
            className={`w-9 h-5 rounded-full transition-colors relative ${profile.createEpics ? 'bg-teal-600' : 'bg-vibe-bg-lighter border border-vibe-border'}`}
          >
            <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-transform ${profile.createEpics ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>

        {/* Create Blockers */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium">Create Blockers</div>
            <div className="text-[10px] text-vibe-muted">Step dependencies become issue blocked_by</div>
          </div>
          <button
            onClick={() => updateField('createBlockers', !profile.createBlockers)}
            className={`w-9 h-5 rounded-full transition-colors relative ${profile.createBlockers ? 'bg-teal-600' : 'bg-vibe-bg-lighter border border-vibe-border'}`}
          >
            <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-transform ${profile.createBlockers ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>

        {/* Label Strategy */}
        <div>
          <div className="text-xs font-medium mb-1.5">Label Strategy</div>
          <div className="flex gap-2">
            {(['auto', 'none', 'custom'] as const).map((strategy) => (
              <button
                key={strategy}
                onClick={() => updateField('labelStrategy', strategy)}
                className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                  profile.labelStrategy === strategy
                    ? 'bg-teal-600/20 border-teal-500/50 text-teal-400'
                    : 'bg-vibe-bg-lighter border-vibe-border text-vibe-muted hover:text-vibe-text'
                }`}
              >
                {strategy === 'auto' ? 'Auto (from step type)' : strategy === 'none' ? 'No labels' : 'Custom'}
              </button>
            ))}
          </div>

          {profile.labelStrategy === 'custom' && (
            <div className="mt-2 space-y-2">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={profile.labelPrefix}
                  onChange={(e) => updateField('labelPrefix', e.target.value)}
                  className="flex-1 px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-teal-500"
                  placeholder="Label prefix (e.g., 'auth-')"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {profile.customLabels.map((label) => (
                  <span key={label} className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-teal-500/10 text-teal-400 border border-teal-500/30 rounded">
                    {label}
                    <button onClick={() => removeCustomLabel(label)} className="text-teal-400/50 hover:text-red-400">x</button>
                  </span>
                ))}
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={customLabelInput}
                    onChange={(e) => setCustomLabelInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomLabel()}
                    className="w-24 px-1.5 py-0.5 text-[10px] bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-teal-500"
                    placeholder="Add label..."
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Priority */}
        <div>
          <div className="text-xs font-medium mb-1.5">Priority Strategy</div>
          <div className="flex gap-2">
            <button
              onClick={() => updateField('priorityStrategy', 'auto')}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                profile.priorityStrategy === 'auto'
                  ? 'bg-teal-600/20 border-teal-500/50 text-teal-400'
                  : 'bg-vibe-bg-lighter border-vibe-border text-vibe-muted hover:text-vibe-text'
              }`}
            >
              Auto-assign
            </button>
            <button
              onClick={() => updateField('priorityStrategy', 'uniform')}
              className={`px-2.5 py-1 text-xs rounded border transition-colors ${
                profile.priorityStrategy === 'uniform'
                  ? 'bg-teal-600/20 border-teal-500/50 text-teal-400'
                  : 'bg-vibe-bg-lighter border-vibe-border text-vibe-muted hover:text-vibe-text'
              }`}
            >
              Uniform
            </button>
          </div>
          {profile.priorityStrategy === 'uniform' && (
            <div className="mt-1.5 flex gap-1.5">
              {(['low', 'medium', 'high', 'critical'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => updateField('defaultPriority', p)}
                  className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                    profile.defaultPriority === p
                      ? p === 'critical' ? 'bg-red-500/20 border-red-500/50 text-red-400'
                        : p === 'high' ? 'bg-orange-500/20 border-orange-500/50 text-orange-400'
                        : p === 'medium' ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400'
                        : 'bg-gray-500/20 border-gray-500/50 text-gray-400'
                      : 'bg-vibe-bg-lighter border-vibe-border text-vibe-muted hover:text-vibe-text'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Include toggles */}
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Include Acceptance Criteria</div>
          <button
            onClick={() => updateField('includeAcceptanceCriteria', !profile.includeAcceptanceCriteria)}
            className={`w-9 h-5 rounded-full transition-colors relative ${profile.includeAcceptanceCriteria ? 'bg-teal-600' : 'bg-vibe-bg-lighter border border-vibe-border'}`}
          >
            <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-transform ${profile.includeAcceptanceCriteria ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Include Verification Strategies</div>
          <button
            onClick={() => updateField('includeVerificationStrategies', !profile.includeVerificationStrategies)}
            className={`w-9 h-5 rounded-full transition-colors relative ${profile.includeVerificationStrategies ? 'bg-teal-600' : 'bg-vibe-bg-lighter border border-vibe-border'}`}
          >
            <div className={`w-3.5 h-3.5 rounded-full bg-white absolute top-[3px] transition-transform ${profile.includeVerificationStrategies ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-vibe-border">
        <button
          onClick={() => handleRunSkill(`/preview-promotion ${plan.id}`, 'preview')}
          disabled={runningSkill === 'preview'}
          className="flex items-center gap-1 px-2.5 py-1 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/30 rounded hover:bg-blue-500/20 transition-colors disabled:opacity-50"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          {runningSkill === 'preview' ? 'Previewing...' : 'Preview'}
        </button>

        <div className="flex-1" />

        {promotionResult && (
          <span className="text-xs text-green-400">
            Created {promotionResult.count} issues
          </span>
        )}

        <button
          onClick={handlePromote}
          disabled={isPromoting || plan.steps.length === 0}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors disabled:opacity-50"
        >
          {isPromoting ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Promoting...
            </>
          ) : (
            <>
              Create Issues
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
