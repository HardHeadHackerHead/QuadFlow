import type { PlanStatus } from './model'

const PLAN_PHASES: { status: PlanStatus; label: string; shortLabel: string; icon: string }[] = [
  {
    status: 'spec_draft',
    label: 'Spec Draft',
    shortLabel: 'Spec',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  },
  {
    status: 'spec_review',
    label: 'Review Spec',
    shortLabel: 'Review',
    icon: 'M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  },
  {
    status: 'decomposing',
    label: 'Decompose',
    shortLabel: 'Decompose',
    icon: 'M4 6h16M4 12h16m-7 6h7',
  },
  {
    status: 'review_steps',
    label: 'Review Steps',
    shortLabel: 'Steps',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  },
  {
    status: 'promoting',
    label: 'Promote',
    shortLabel: 'Promote',
    icon: 'M7 11l5-5m0 0l5 5m-5-5v12',
  },
  {
    status: 'executing',
    label: 'Execute',
    shortLabel: 'Execute',
    icon: 'M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  {
    status: 'completed',
    label: 'Complete',
    shortLabel: 'Done',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
  },
]

interface PlanPhaseStepperProps {
  currentPhase: PlanStatus
  onPhaseChange: (status: PlanStatus) => void
  compact?: boolean
}

export default function PlanPhaseStepper({ currentPhase, onPhaseChange, compact }: PlanPhaseStepperProps) {
  const currentIndex = PLAN_PHASES.findIndex(p => p.status === currentPhase)

  const canGoBack = currentIndex > 0
  const prevPhase = canGoBack ? PLAN_PHASES[currentIndex - 1] : null

  const getNextPhase = (): PlanStatus | null => {
    if (currentIndex < PLAN_PHASES.length - 1) {
      return PLAN_PHASES[currentIndex + 1].status
    }
    return null
  }

  const nextPhase = getNextPhase()

  return (
    <div className="flex items-center gap-1">
      {/* Back button */}
      {canGoBack && prevPhase && (
        <button
          onClick={() => onPhaseChange(prevPhase.status)}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors mr-1"
          title={`Back to ${prevPhase.label}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      {/* Phase circles */}
      <div className="flex items-center">
        {PLAN_PHASES.map((phase, index) => {
          const isPast = index < currentIndex
          const isCurrent = index === currentIndex

          return (
            <div key={phase.status} className="flex items-center">
              {/* Connecting line */}
              {index > 0 && (
                <div
                  className={`h-0.5 transition-colors ${compact ? 'w-3' : 'w-6'} ${
                    isPast ? 'bg-teal-500' : 'bg-vibe-border'
                  }`}
                />
              )}

              {/* Phase circle */}
              <div className="relative group">
                <div
                  className={`flex items-center justify-center rounded-full transition-all ${
                    compact ? 'w-6 h-6' : 'w-7 h-7'
                  } ${
                    isPast
                      ? 'bg-teal-500/20 text-teal-400 border border-teal-500/50'
                      : isCurrent
                        ? 'bg-teal-500/30 text-teal-300 border-2 border-teal-400 ring-2 ring-teal-400/20'
                        : 'bg-vibe-bg-lighter text-vibe-muted border border-vibe-border'
                  }`}
                >
                  {isPast ? (
                    <svg className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={isCurrent ? 2 : 1.5} d={phase.icon} />
                    </svg>
                  )}
                </div>

                {/* Label (below circle) — hidden in compact mode */}
                {!compact && (
                  <span
                    className={`absolute top-full left-1/2 -translate-x-1/2 mt-1 text-[9px] whitespace-nowrap font-medium ${
                      isCurrent ? 'text-teal-400' : isPast ? 'text-vibe-muted' : 'text-vibe-muted/50'
                    }`}
                  >
                    {phase.shortLabel}
                  </span>
                )}

                {/* Tooltip (always available) */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-vibe-bg-lighter border border-vibe-border rounded text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  {phase.label}
                  {isCurrent && ' (current)'}
                  {isPast && ' ✓'}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Advance button */}
      {nextPhase && (
        <button
          onClick={() => onPhaseChange(nextPhase)}
          className="ml-2 px-2 py-0.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded flex items-center gap-1 transition-colors"
          title={`Advance to ${PLAN_PHASES.find(p => p.status === nextPhase)?.label}`}
        >
          Next
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  )
}
