import { useState, useCallback, useMemo } from 'react'
import { Markdown, MarkdownEditor } from '@quadflow/ui'
import { guard, type Plan, type PlanSpecType, type PlanStatus } from './model'
import { runSkill, usePlans } from './context'
import PlanCommentsPanel from './PlanCommentsPanel'

interface SpecEditorViewProps {
  plan: Plan
}

const SPEC_TYPES: { value: PlanSpecType; label: string; description: string; icon: string }[] = [
  {
    value: 'greenfield',
    label: 'New Project',
    description: 'Building from scratch',
    icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6',
  },
  {
    value: 'feature',
    label: 'New Feature',
    description: 'Adding to existing project',
    icon: 'M12 4v16m8-8H4',
  },
  {
    value: 'refactor',
    label: 'Refactor',
    description: 'Improving existing code',
    icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
  },
]

export default function SpecEditorView({ plan }: SpecEditorViewProps) {
  const { ctx, model } = usePlans()
  const run = useMemo(() => guard(ctx, 'Plans'), [ctx])
  const updatePlan = useCallback((id: string, u: Parameters<typeof model.updatePlan>[1]) => run(() => model.updatePlan(id, u)), [model, run])
  const [specContent, setSpecContent] = useState(plan.specContent || '')
  const [isEditing, setIsEditing] = useState(!plan.specContent) // Start in edit mode if no content
  const [runningSkill, setRunningSkill] = useState<string | null>(null)

  const isReviewPhase = plan.status === 'spec_review'
  const isDraftPhase = plan.status === 'spec_draft'

  const handleSaveSpec = useCallback(async () => {
    await updatePlan(plan.id, { specContent })
    setIsEditing(false)
  }, [plan.id, specContent, updatePlan])

  const handleSpecTypeChange = useCallback(async (specType: PlanSpecType) => {
    await updatePlan(plan.id, { specType })
  }, [plan.id, updatePlan])

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        setSpecContent(text)
        setIsEditing(true)
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err)
    }
  }, [])

  const handleImportFile = useCallback(async () => {
    try {
      const selected = await ctx.ui.pickFile({ filters: [{ name: 'Markdown', extensions: ['md', 'txt', 'markdown'] }] })
      if (selected && selected[0]) {
        // Picked paths join this plugin's `absolute` fs allowlist for the session.
        const content = await ctx.fs.readText(selected[0], 'absolute')
        setSpecContent(content)
        setIsEditing(true)
      }
    } catch (err) {
      ctx.notifications.toast({ kind: 'error', title: 'Could not import the file', body: err instanceof Error ? err.message : String(err) })
    }
  }, [ctx])

  const handleRunSkill = useCallback(async (command: string, skillId: string) => {
    setRunningSkill(skillId)
    try {
      await runSkill(ctx, command)
    } finally {
      setRunningSkill(null)
    }
  }, [ctx])

  const handleAdvanceToReview = useCallback(async () => {
    // Save any pending content first
    if (specContent !== plan.specContent) {
      await updatePlan(plan.id, { specContent, status: 'spec_review' as PlanStatus })
    } else {
      await updatePlan(plan.id, { status: 'spec_review' as PlanStatus })
    }
  }, [plan.id, plan.specContent, specContent, updatePlan])

  const handleBackToDraft = useCallback(async () => {
    await updatePlan(plan.id, { status: 'spec_draft' as PlanStatus })
  }, [plan.id, updatePlan])

  const handleAdvanceToDecompose = useCallback(async () => {
    await updatePlan(plan.id, { status: 'decomposing' as PlanStatus })
  }, [plan.id, updatePlan])

  return (
    <div className="space-y-3">
      {/* Spec Type Selector (draft phase only) */}
      {isDraftPhase && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-vibe-muted">Type:</span>
          {SPEC_TYPES.map((st) => (
            <button
              key={st.value}
              onClick={() => handleSpecTypeChange(st.value)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                plan.specType === st.value
                  ? 'bg-teal-600/20 border-teal-500/50 text-teal-400'
                  : 'bg-vibe-bg-lighter border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-text/30'
              }`}
              title={st.description}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={st.icon} />
              </svg>
              {st.label}
            </button>
          ))}
        </div>
      )}

      {/* Draft Phase: Import + Edit */}
      {isDraftPhase && (
        <>
          {/* Import bar */}
          <div className="flex items-center gap-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg p-2">
            <span className="text-xs text-vibe-muted">Import:</span>
            <button
              onClick={handlePaste}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-teal-500/50 hover:text-teal-400 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Paste from Clipboard
            </button>
            <button
              onClick={handleImportFile}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-teal-500/50 hover:text-teal-400 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Import .md File
            </button>
            <div className="flex-1" />
            <button
              onClick={() => handleRunSkill(`/new-spec ${plan.id}`, 'new-spec')}
              disabled={runningSkill === 'new-spec'}
              className="flex items-center gap-1 px-2 py-1 text-xs text-purple-400 bg-purple-500/10 border border-purple-500/30 rounded hover:bg-purple-500/20 transition-colors disabled:opacity-50"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              {runningSkill === 'new-spec' ? 'Generating...' : 'Generate with AI'}
            </button>
          </div>

          {/* Markdown Editor */}
          {isEditing ? (
            <div className="space-y-2">
              <MarkdownEditor
                value={specContent}
                onChange={setSpecContent}
                rows={14}
                placeholder="Paste or import your spec document here..."
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => {
                    setSpecContent(plan.specContent || '')
                    if (plan.specContent) setIsEditing(false)
                  }}
                  className="px-3 py-1 text-xs text-vibe-muted hover:text-vibe-text"
                >
                  Cancel
                </button>
                <button onClick={handleSaveSpec} data-testid="plans-spec-save" className="px-3 py-1 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded">
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => setIsEditing(true)}
              className="cursor-pointer bg-vibe-bg-lighter border border-vibe-border rounded-lg p-4 min-h-[200px] hover:border-teal-500/30 transition-colors"
            >
              {specContent ? (
                <Markdown>{specContent}</Markdown>
              ) : (
                <div className="text-sm text-vibe-muted/50 italic">
                  Click to edit, or use the import buttons above to bring in your spec...
                </div>
              )}
            </div>
          )}

          {/* Advance button */}
          {specContent && (
            <div className="flex justify-end">
              <button
                onClick={handleAdvanceToReview}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors"
              >
                Advance to Review
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}

      {/* Review Phase: Read-only spec + review comments */}
      {isReviewPhase && (
        <>
          {/* Action bar */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleBackToDraft}
              className="flex items-center gap-1 px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text border border-vibe-border rounded transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Edit Spec
            </button>

            {/* Review dropdown */}
            <div className="relative group/review">
              <button
                className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/30 rounded hover:bg-blue-500/20 transition-colors"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Request Review
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <div className="absolute left-0 top-full mt-1 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-lg z-20 min-w-[160px] hidden group-hover/review:block">
                {[
                  { label: 'General Review', focus: 'general' },
                  { label: 'Architecture Review', focus: 'architecture' },
                  { label: 'Security Review', focus: 'security' },
                  { label: 'Scope Review', focus: 'scope' },
                ].map((opt) => (
                  <button
                    key={opt.focus}
                    onClick={() => handleRunSkill(`/review-spec ${plan.id} --focus=${opt.focus}`, `review-${opt.focus}`)}
                    className="w-full text-left px-3 py-1.5 text-xs text-vibe-text hover:bg-vibe-bg transition-colors first:rounded-t-lg last:rounded-b-lg"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1" />

            <button
              onClick={handleAdvanceToDecompose}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors"
            >
              Finalize & Decompose
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Rendered spec */}
          <div className="bg-vibe-bg-lighter border border-vibe-border rounded-lg p-4">
            {plan.specType && (
              <div className="mb-3 text-xs text-vibe-muted">
                <span className={`px-1.5 py-0.5 rounded ${
                  plan.specType === 'greenfield' ? 'bg-green-500/10 text-green-400' :
                  plan.specType === 'feature' ? 'bg-blue-500/10 text-blue-400' :
                  'bg-orange-500/10 text-orange-400'
                }`}>
                  {plan.specType === 'greenfield' ? 'New Project' : plan.specType === 'feature' ? 'Feature' : 'Refactor'}
                </span>
              </div>
            )}
            <Markdown>{plan.specContent || '*No spec content*'}</Markdown>
          </div>

          {/* Review comments */}
          <PlanCommentsPanel
            planId={plan.id}
            filterType="review"
            title="Review Feedback"
          />
        </>
      )}
    </div>
  )
}
