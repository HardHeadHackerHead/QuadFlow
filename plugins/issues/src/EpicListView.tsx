import { useMemo } from 'react'
import { EpicStatus, IssuePriority, priorityConfig } from './types'
import { useModel } from './model'

interface EpicListViewProps {
  onSelectEpic: (id: string) => void
  onCreateEpic: () => void
}

const epicStatusConfig: Record<EpicStatus, { label: string; color: string; bgColor: string }> = {
  open: { label: 'Open', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  done: { label: 'Done', color: 'text-green-400', bgColor: 'bg-green-500/20' },
}

const priorityBorderColor: Record<IssuePriority, string> = {
  low: 'border-l-gray-500',
  medium: 'border-l-blue-500',
  high: 'border-l-orange-500',
  critical: 'border-l-red-500',
}

export default function EpicListView({ onSelectEpic, onCreateEpic }: EpicListViewProps) {
  const model = useModel()
  const epics = model.epics.use((s) => s.items)
  const issues = model.issues.use((s) => s.items)

  // Compute progress for each epic
  const epicProgress = useMemo(() => {
    const progressMap = new Map<string, { total: number; done: number }>()
    for (const epic of epics) {
      const linkedIssues = issues.filter((i) => i.epicId === epic.id)
      const doneCount = linkedIssues.filter((i) => i.status === 'done').length
      progressMap.set(epic.id, { total: linkedIssues.length, done: doneCount })
    }
    return progressMap
  }, [epics, issues])

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span className="font-medium">Epics</span>
            <span className="text-xs text-vibe-muted">{epics.length} total</span>
          </div>
        </div>
      </div>

      {/* Epic list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {epics.length === 0 ? (
          <div className="text-center text-vibe-muted py-12">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <p>No epics yet</p>
            <p className="text-sm mt-1">Create your first epic to group related issues</p>
          </div>
        ) : (
          epics.map((epic) => {
            const progress = epicProgress.get(epic.id) || { total: 0, done: 0 }
            const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
            const statusInfo = epicStatusConfig[epic.status]
            const prioInfo = priorityConfig[epic.priority] ?? { label: epic.priority || '?', color: 'text-gray-400' }

            return (
              <button
                key={epic.id}
                onClick={() => onSelectEpic(epic.id)}
                className={`w-full text-left bg-vibe-bg-lighter border border-vibe-border rounded-lg p-3 hover:border-vibe-border-bright transition-colors border-l-4 ${priorityBorderColor[epic.priority]}`}
              >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2">
                  <h3 className={`font-medium text-sm ${epic.status === 'done' ? 'text-vibe-muted line-through' : ''}`}>
                    {epic.title}
                  </h3>
                  <span className={`flex-shrink-0 px-2 py-0.5 rounded text-xs font-medium ${statusInfo.color} ${statusInfo.bgColor}`}>
                    {statusInfo.label}
                  </span>
                </div>

                {/* Meta row */}
                <div className="flex items-center gap-3 mt-1.5 text-xs">
                  <span className={`font-medium ${prioInfo.color}`}>{prioInfo.label}</span>
                  {epic.labels.length > 0 && (
                    <>
                      <span className="text-vibe-muted">·</span>
                      <div className="flex items-center gap-1 flex-wrap">
                        {epic.labels.map((label) => (
                          <span
                            key={label}
                            className="px-1.5 py-0.5 rounded-full bg-white/10 text-vibe-muted text-[10px]"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  <span className="text-vibe-muted">·</span>
                  <span className="text-vibe-muted">{progress.total} issue{progress.total !== 1 ? 's' : ''}</span>
                </div>

                {/* Progress bar */}
                {progress.total > 0 && (
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between text-[10px] text-vibe-muted mb-1">
                      <span>{progress.done}/{progress.total} done</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )}
              </button>
            )
          })
        )}
      </div>

      {/* Create button */}
      <div className="flex-shrink-0 border-t border-vibe-border p-3">
        <button
          onClick={onCreateEpic}
          className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors font-medium text-sm flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Epic
        </button>
      </div>
    </div>
  )
}
