import { useState, useEffect, useMemo } from 'react'
import { Markdown } from '@quadflow/ui'
import { guard, type PlanCommentType } from './model'
import { usePlans } from './context'

interface PlanCommentsPanelProps {
  planId: string
  filterType?: PlanCommentType
  title?: string
}

export default function PlanCommentsPanel({ planId, filterType, title }: PlanCommentsPanelProps) {
  const { ctx, model } = usePlans()
  const run = useMemo(() => guard(ctx, 'Plan comments'), [ctx])
  const allComments = model.plans.use((s) => s.items.find((p) => p.id === planId)?.comments) ?? []
  const [isLoading, setIsLoading] = useState(false)

  // Comments are part of the plan document; refresh that one plan.
  useEffect(() => {
    setIsLoading(true)
    void run(() => model.refreshPlan(planId)).finally(() => setIsLoading(false))
  }, [planId, model, run])

  const deleteComment = (commentId: string, pid: string) => run(() => model.deleteComment(pid, commentId))
  const filtered = filterType ? allComments.filter(c => c.commentType === filterType) : allComments

  const getTypeColor = (type: PlanCommentType) => {
    switch (type) {
      case 'review': return 'text-blue-400 bg-blue-500/10 border-blue-500/20'
      case 'verification': return 'text-orange-400 bg-orange-500/10 border-orange-500/20'
      default: return 'text-gray-400 bg-gray-500/10 border-gray-500/20'
    }
  }

  const getTypeLabel = (type: PlanCommentType) => {
    switch (type) {
      case 'review': return 'Review'
      case 'verification': return 'Verification'
      default: return 'Comment'
    }
  }

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    const now = Date.now()
    const diff = now - ts
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return d.toLocaleDateString()
  }

  if (isLoading) {
    return (
      <div className="text-xs text-vibe-muted p-3">Loading comments...</div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="text-xs text-vibe-muted/50 p-3 text-center">
        No {filterType ? getTypeLabel(filterType).toLowerCase() : ''} comments yet
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {title && (
        <div className="text-xs font-medium text-vibe-muted px-1">
          {title} ({filtered.length})
        </div>
      )}
      {filtered.map((comment) => (
        <div key={comment.id} className="bg-vibe-bg-lighter border border-vibe-border rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              {!filterType && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${getTypeColor(comment.commentType)}`}>
                  {getTypeLabel(comment.commentType)}
                </span>
              )}
              <span className="text-[10px] text-vibe-muted">
                {comment.author?.name || 'Unknown'}
              </span>
              <span className="text-[10px] text-vibe-muted/50">
                {formatDate(comment.createdAt)}
              </span>
            </div>
            <button
              onClick={() => deleteComment(comment.id, planId)}
              className="p-0.5 text-vibe-muted/30 hover:text-red-400 transition-colors"
              title="Delete comment"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <Markdown className="text-xs">{comment.body}</Markdown>
        </div>
      ))}
    </div>
  )
}
