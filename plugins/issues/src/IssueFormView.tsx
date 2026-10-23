import { useState, useEffect, useRef } from 'react'
import { Issue, IssueLabel, IssuePriority, IssueStatus, AcceptanceCriterion, priorityConfig, statusConfig, defaultLabelColors } from './types'
import { useModel, useFormatRef } from './model'
import LabelBadge from './LabelBadge'
import { Overlay } from './Overlay'

interface IssueFormViewProps {
  issue?: Issue | null
  labels: IssueLabel[]
  defaultEpicId?: string
  onSave: (data: {
    title: string
    body?: string
    status: IssueStatus
    priority: IssuePriority
    labels: string[]
    parentIssueId?: string
    blockedBy?: string[]
    dependsOn?: string[]
    userStory?: string
    acceptanceCriteria?: AcceptanceCriterion[]
    epicId?: string
  }) => Promise<void>
  onCancel: () => void
  onCreateLabel: (name: string, color: string) => Promise<IssueLabel>
}

export default function IssueFormView({ issue, labels, defaultEpicId, onSave, onCancel, onCreateLabel }: IssueFormViewProps) {
  const [title, setTitle] = useState(issue?.title || '')
  const [body, setBody] = useState(issue?.body || '')
  const [status, setStatus] = useState<IssueStatus>(issue?.status || 'todo')
  const [priority, setPriority] = useState<IssuePriority>(issue?.priority || 'medium')
  const [selectedLabels, setSelectedLabels] = useState<string[]>(issue?.labels || [])
  const [parentIssueId, setParentIssueId] = useState<string>(issue?.parentIssueId || '')
  const [blockedBy, setBlockedBy] = useState<string[]>(issue?.blockedBy || [])
  const [userStory, setUserStory] = useState(issue?.userStory || '')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<AcceptanceCriterion[]>(
    issue?.acceptanceCriteria?.map(c =>
      typeof c === 'object' ? c : { id: crypto.randomUUID(), text: String(c), checked: false }
    ) || []
  )
  const [epicId, setEpicId] = useState<string>(issue?.epicId || defaultEpicId || '')
  const [newCriterion, setNewCriterion] = useState('')
  const [blockerSearch, setBlockerSearch] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const allIssues = useModel().issues.use((s) => s.items)
  const formatRef = useFormatRef()
  const parentCandidates = allIssues.filter(i => i.id !== issue?.id)
  const blockerCandidates = allIssues.filter(i =>
    i.id !== issue?.id &&
    (blockerSearch === '' ||
      i.title.toLowerCase().includes(blockerSearch.toLowerCase()) ||
      (i.displayNumber && formatRef(i.displayNumber).toLowerCase().includes(blockerSearch.toLowerCase())))
  )

  // New label modal state
  const [showNewLabel, setShowNewLabel] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(defaultLabelColors[0])

  const titleRef = useRef<HTMLInputElement>(null)
  const criterionRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const epics = useModel().epics.use((s) => s.items)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    setIsSaving(true)
    setSaveError(null)
    try {
      await onSave({
        title: title.trim(),
        body: body.trim() || undefined,
        status,
        priority,
        labels: selectedLabels,
        parentIssueId: parentIssueId || undefined,
        blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
        userStory: userStory.trim() || undefined,
        acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
        epicId: epicId || undefined,
      })
    } catch (err) {
      console.error('Failed to save issue:', err)
      setSaveError(err instanceof Error ? err.message : 'Failed to save issue. Check console for details.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCreateLabel = async () => {
    if (!newLabelName.trim()) return
    const newLabel = await onCreateLabel(newLabelName.trim(), newLabelColor)
    setSelectedLabels([...selectedLabels, newLabel.name])
    setNewLabelName('')
    setNewLabelColor(defaultLabelColors[Math.floor(Math.random() * defaultLabelColors.length)])
    setShowNewLabel(false)
  }

  const toggleLabel = (labelName: string) => {
    setSelectedLabels(prev =>
      prev.includes(labelName) ? prev.filter(l => l !== labelName) : [...prev, labelName]
    )
  }

  const toggleBlocker = (issueId: string) => {
    setBlockedBy(prev =>
      prev.includes(issueId) ? prev.filter(id => id !== issueId) : [...prev, issueId]
    )
  }

  const addCriterion = () => {
    const trimmed = newCriterion.trim()
    if (!trimmed) return
    setAcceptanceCriteria(prev => [...prev, { id: crypto.randomUUID(), text: trimmed, checked: false }])
    setNewCriterion('')
    criterionRef.current?.focus()
  }

  const removeCriterion = (index: number) => {
    setAcceptanceCriteria(prev => prev.filter((_, i) => i !== index))
  }

  const statusOptions: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'qa', 'done', 'blocked', 'needs_human']
  const priorityOptions: IssuePriority[] = ['low', 'medium', 'high', 'critical']

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              aria-label="Go back"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium">{issue ? 'Edit Issue' : 'New Issue'}</span>
          </div>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-3 space-y-4">

        {/* Title */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Title <span className="text-red-400">*</span></label>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title..."
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-teal-500"
            required
          />
        </div>

        {/* User Story */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">User Story</label>
          <textarea
            value={userStory}
            onChange={(e) => setUserStory(e.target.value)}
            placeholder="As a [user], I need [capability] so that [benefit]..."
            rows={3}
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted resize-none focus:outline-none focus:border-teal-500"
          />
        </div>

        {/* Acceptance Criteria */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Acceptance Criteria</label>
          <div className="space-y-1 mb-2">
            {acceptanceCriteria.map((criterion, i) => (
              <div key={criterion.id || i} className="flex items-start gap-2 group">
                <span className="text-vibe-muted mt-1 text-xs select-none">{criterion.checked ? '☑' : '☐'}</span>
                <span className="flex-1 text-sm">{criterion.text}</span>
                <button
                  type="button"
                  onClick={() => removeCriterion(i)}
                  className="p-0.5 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                  aria-label="Remove criterion"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              ref={criterionRef}
              type="text"
              value={newCriterion}
              onChange={(e) => setNewCriterion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addCriterion() }
              }}
              placeholder="Add a condition of satisfaction..."
              className="flex-1 bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-teal-500"
            />
            <button
              type="button"
              onClick={addCriterion}
              disabled={!newCriterion.trim()}
              className="px-3 py-1.5 text-xs bg-vibe-bg-lighter border border-vibe-border rounded-lg hover:border-teal-500 hover:text-teal-400 disabled:opacity-40 transition-colors"
            >
              Add
            </button>
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Description / Technical Notes</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Technical details, implementation notes..."
            rows={5}
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted resize-none focus:outline-none focus:border-teal-500"
          />
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Status</label>
          <div className="flex flex-wrap gap-2">
            {statusOptions.map((s) => {
              const info = statusConfig[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`
                    px-3 py-2 text-xs font-medium rounded-lg border transition-colors
                    ${status === s
                      ? `border-current ${info.color} ${info.bgColor}`
                      : 'border-vibe-border text-vibe-muted hover:text-vibe-text'
                    }
                  `}
                >
                  {info.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Priority */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Priority</label>
          <div className="flex gap-2">
            {priorityOptions.map((p) => {
              const info = priorityConfig[p]
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`
                    flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors
                    ${priority === p
                      ? `border-current ${info.color} bg-current/10`
                      : 'border-vibe-border text-vibe-muted hover:text-vibe-text'
                    }
                  `}
                >
                  {info.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Epic */}
        {epics.length > 0 && (
          <div>
            <label className="block text-xs text-vibe-muted mb-1">Epic</label>
            <select
              value={epicId}
              onChange={(e) => setEpicId(e.target.value)}
              className="w-full bg-vibe-bg border border-vibe-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
            >
              <option value="">None</option>
              {epics.map((epic) => (
                <option key={epic.id} value={epic.id}>{epic.title}</option>
              ))}
            </select>
          </div>
        )}

        {/* Parent Issue (Epic) */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Parent Issue (Epic)</label>
          <select
            value={parentIssueId}
            onChange={(e) => setParentIssueId(e.target.value)}
            className="w-full bg-vibe-bg border border-vibe-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
          >
            <option value="">None (top-level issue)</option>
            {parentCandidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.displayNumber ? `${formatRef(candidate.displayNumber)}: ` : ''}{candidate.title}
              </option>
            ))}
          </select>
        </div>

        {/* Blocked By */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">
            Blocked By
            {blockedBy.length > 0 && (
              <span className="ml-1 text-red-400">({blockedBy.length} issue{blockedBy.length > 1 ? 's' : ''})</span>
            )}
          </label>
          <input
            type="text"
            value={blockerSearch}
            onChange={(e) => setBlockerSearch(e.target.value)}
            placeholder="Search issues..."
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-teal-500 mb-2"
          />
          <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-vibe-border bg-vibe-bg-lighter p-1">
            {blockerCandidates.length === 0 ? (
              <p className="text-xs text-vibe-muted text-center py-2">No issues found</p>
            ) : (
              blockerCandidates.slice(0, 30).map((candidate) => {
                const selected = blockedBy.includes(candidate.id)
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggleBlocker(candidate.id)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${
                      selected
                        ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                        : 'hover:bg-vibe-bg text-vibe-muted hover:text-vibe-text'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 flex-shrink-0 rounded border flex items-center justify-center ${selected ? 'border-red-400 bg-red-500/20' : 'border-vibe-border'}`}>
                      {selected && (
                        <svg className="w-2.5 h-2.5 text-red-400" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </span>
                    {candidate.displayNumber && (
                      <span className="font-mono text-vibe-muted flex-shrink-0">{formatRef(candidate.displayNumber)}</span>
                    )}
                    <span className="truncate">{candidate.title}</span>
                  </button>
                )
              })
            )}
          </div>
          {blockedBy.length > 0 && (
            <button
              type="button"
              onClick={() => setBlockedBy([])}
              className="mt-1 text-xs text-vibe-muted hover:text-red-400 transition-colors"
            >
              Clear all blockers
            </button>
          )}
        </div>

        {/* Labels */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-vibe-muted">Labels</label>
            <button
              type="button"
              onClick={() => setShowNewLabel(true)}
              className="text-xs text-teal-400 hover:text-teal-300"
            >
              + New label
            </button>
          </div>
          <div className="flex flex-wrap gap-2 p-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg min-h-[40px]">
            {labels.length === 0 && selectedLabels.length === 0 && (
              <span className="text-xs text-vibe-muted">No labels yet</span>
            )}
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                onClick={() => toggleLabel(label.name)}
                className={`transition-opacity ${selectedLabels.includes(label.name) ? '' : 'opacity-40 hover:opacity-70'}`}
              >
                <LabelBadge name={label.name} color={label.color} />
              </button>
            ))}
          </div>
        </div>

        {/* Selected labels preview */}
        {selectedLabels.length > 0 && (
          <div>
            <label className="block text-xs text-vibe-muted mb-1">Selected labels</label>
            <div className="flex flex-wrap gap-1">
              {selectedLabels.map((labelName) => {
                const label = labels.find((l) => l.name === labelName)
                return label ? (
                  <LabelBadge
                    key={label.id}
                    name={label.name}
                    color={label.color}
                    onRemove={() => toggleLabel(label.name)}
                  />
                ) : null
              })}
            </div>
          </div>
        )}
      </form>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-vibe-border p-3">
        {saveError && (
          <div className="mb-2 p-2 bg-red-500/15 border border-red-500/30 rounded-lg text-xs text-red-300">
            {saveError}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-vibe-muted hover:text-vibe-text"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim() || isSaving}
            className="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors font-medium"
          >
            {isSaving ? 'Saving...' : issue ? 'Save Changes' : 'Create Issue'}
          </button>
        </div>
      </div>

      {/* New label modal */}
      <Overlay open={showNewLabel} onClose={() => setShowNewLabel(false)} id="issueformview-new-label" size="sm">
          <div>
            <h3 className="font-medium mb-3">Create New Label</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-vibe-muted mb-1">Label name</label>
                <input
                  type="text"
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  placeholder="bug, feature, etc."
                  className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-teal-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-vibe-muted mb-1">Color</label>
                <div className="flex flex-wrap gap-2">
                  {defaultLabelColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewLabelColor(color)}
                      aria-label={`Select color ${color}`}
                      aria-pressed={newLabelColor === color}
                      className={`w-8 h-8 rounded-lg transition-transform ${newLabelColor === color ? 'ring-2 ring-white ring-offset-2 ring-offset-vibe-bg scale-110' : 'hover:scale-105'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              {newLabelName && (
                <div>
                  <label className="block text-xs text-vibe-muted mb-1">Preview</label>
                  <LabelBadge name={newLabelName || 'label'} color={newLabelColor} size="md" />
                </div>
              )}
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button onClick={() => setShowNewLabel(false)} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">
                Cancel
              </button>
              <button
                onClick={handleCreateLabel}
                disabled={!newLabelName.trim()}
                className="px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg"
              >
                Create Label
              </button>
            </div>
          </div>
      </Overlay>
    </div>
  )
}
