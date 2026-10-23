import { useState, useEffect, useRef } from 'react'
import { Epic, EpicStatus, IssuePriority, priorityConfig, defaultLabelColors } from './types'
import { useModel } from './model'
import LabelBadge from './LabelBadge'
import { Overlay } from './Overlay'

const epicStatusConfig: Record<EpicStatus, { label: string; color: string; bgColor: string }> = {
  open: { label: 'Open', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  done: { label: 'Done', color: 'text-green-400', bgColor: 'bg-green-500/20' },
}

const epicStatusOptions: EpicStatus[] = ['open', 'in_progress', 'done']
const priorityOptions: IssuePriority[] = ['low', 'medium', 'high', 'critical']

interface EpicFormViewProps {
  epic?: Epic
  onSave: (data: {
    title: string
    description?: string
    status?: EpicStatus
    priority?: IssuePriority
    labels?: string[]
  }) => void
  onCancel: () => void
}

export default function EpicFormView({ epic, onSave, onCancel }: EpicFormViewProps) {
  const [title, setTitle] = useState(epic?.title || '')
  const [description, setDescription] = useState(epic?.description || '')
  const [status, setStatus] = useState<EpicStatus>(epic?.status || 'open')
  const [priority, setPriority] = useState<IssuePriority>(epic?.priority || 'medium')
  const [selectedLabels, setSelectedLabels] = useState<string[]>(epic?.labels || [])
  const [isSaving, setIsSaving] = useState(false)

  // New label modal state
  const [showNewLabel, setShowNewLabel] = useState(false)
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(defaultLabelColors[0])

  const labels = useModel().labels.use((s) => s.items)
  const createLabel = useModel().createLabel

  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    setIsSaving(true)
    try {
      onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
        labels: selectedLabels.length > 0 ? selectedLabels : undefined,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const toggleLabel = (labelName: string) => {
    setSelectedLabels((prev) =>
      prev.includes(labelName) ? prev.filter((l) => l !== labelName) : [...prev, labelName]
    )
  }

  const handleCreateLabel = async () => {
    if (!newLabelName.trim()) return
    const newLabel = await createLabel(newLabelName.trim(), newLabelColor)
    setSelectedLabels([...selectedLabels, newLabel.name])
    setNewLabelName('')
    setNewLabelColor(defaultLabelColors[Math.floor(Math.random() * defaultLabelColors.length)])
    setShowNewLabel(false)
  }

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
            <span className="font-medium">{epic ? 'Edit Epic' : 'New Epic'}</span>
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
            placeholder="Epic title..."
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-indigo-500"
            required
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the epic goals, scope, and requirements (Markdown supported)..."
            rows={6}
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted resize-none focus:outline-none focus:border-indigo-500"
          />
          <p className="text-[10px] text-vibe-muted mt-1">Markdown supported</p>
        </div>

        {/* Status */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Status</label>
          <div className="flex flex-wrap gap-2">
            {epicStatusOptions.map((s) => {
              const info = epicStatusConfig[s]
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

        {/* Labels */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-vibe-muted">Labels</label>
            <button
              type="button"
              onClick={() => setShowNewLabel(true)}
              className="text-xs text-indigo-400 hover:text-indigo-300"
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
                ) : (
                  <span
                    key={labelName}
                    className="px-2 py-0.5 rounded-full bg-white/10 text-vibe-muted text-xs"
                  >
                    {labelName}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </form>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-vibe-border p-3">
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
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors font-medium"
          >
            {isSaving ? 'Saving...' : epic ? 'Save Changes' : 'Create Epic'}
          </button>
        </div>
      </div>

      {/* New label modal */}
      <Overlay open={showNewLabel} onClose={() => setShowNewLabel(false)} id="epicformview-new-label" size="sm">
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
                  className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-indigo-500"
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
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg"
              >
                Create Label
              </button>
            </div>
          </div>
      </Overlay>
    </div>
  )
}
