import { useEffect, useMemo, useState } from 'react'
import type { TileProps } from '@quadflow/plugin-api'
import { ModelContext, filterIssues, issuesModel, reportError, useFormatRef, useModel, type IssuesModel } from './model'
import type { AcceptanceCriterion, EpicStatus, Issue, IssuePriority, IssueStatus } from './types'
import IssueListView from './IssueListView'
import IssueDetailView from './IssueDetailView'
import IssueFormView from './IssueFormView'
import EpicListView from './EpicListView'
import EpicDetailView from './EpicDetailView'
import EpicFormView from './EpicFormView'

type ViewState =
  | { view: 'list' }
  | { view: 'detail'; issueId: string }
  | { view: 'create'; epicId?: string }
  | { view: 'edit'; issueId: string }
  | { view: 'settings' }
  | { view: 'epic-list' }
  | { view: 'epic-detail'; epicId: string }
  | { view: 'epic-create' }
  | { view: 'epic-edit'; epicId: string }

type ViewMode = 'list' | 'board'
type TabMode = 'issues' | 'epics'

interface IssueFormData {
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
}

interface EpicFormData {
  title: string
  description?: string
  status?: EpicStatus
  priority?: IssuePriority
  labels?: string[]
}

/** The Issues tool. Pane and flyout tiles share one model per plugin context. */
export function IssuesTile({ ctx }: TileProps) {
  const model = issuesModel(ctx)
  useEffect(() => model.retain(), [model])
  // Project code (`CODE-n`): on project switch and on `project_config` events.
  const root = model.issues.use((s) => s.root)
  const configVersion = model.issues.use((s) => s.relatedVersion)
  useEffect(() => {
    void model.loadCode()
  }, [model, root, configVersion])
  return (
    <ModelContext.Provider value={model}>
      <IssuesView model={model} hasProject={!!root || !!ctx.project.current()} />
    </ModelContext.Provider>
  )
}

function Spinner() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
      <div className="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full" />
    </div>
  )
}

function IssuesView({ model, hasProject }: { model: IssuesModel; hasProject: boolean }) {
  const { ctx } = model
  const issues = model.issues.use((s) => s.items)
  const isLoading = model.issues.use((s) => s.loading)
  const corrupt = model.issues.use((s) => s.corrupt)
  const loadError = model.issues.use((s) => s.error)
  const labels = model.labels.use((s) => s.items)
  const epics = model.epics.use((s) => s.items)
  const filters = model.ui((s) => s.filters)
  const focusId = model.ui((s) => s.focusId)
  const composeNonce = model.ui((s) => s.composeNonce)
  model.ui((s) => s.tick) // stale-agent indicators re-render
  const formatRef = useFormatRef()

  const [viewState, setViewState] = useState<ViewState>({ view: 'list' })
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [tabMode, setTabMode] = useState<TabMode>('issues')
  const [dismissedCorrupt, setDismissedCorrupt] = useState(0)

  // Palette / "open issue by ref" / "new issue" → this tile.
  useEffect(() => {
    if (!focusId) return
    setTabMode('issues')
    setViewState({ view: 'detail', issueId: focusId })
    model.ui.setState({ focusId: null })
  }, [focusId, model])
  useEffect(() => {
    if (composeNonce === 0) return
    setTabMode('issues')
    setViewState({ view: 'create' })
  }, [composeNonce])

  const filteredIssues = useMemo(() => filterIssues(issues, filters, formatRef), [issues, filters, formatRef])
  const currentIssue = 'issueId' in viewState ? issues.find((i) => i.id === viewState.issueId) ?? null : null

  /** Run a mutation; failures become toasts. */
  const run = async (title: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      return true
    } catch (e) {
      reportError(ctx, title, e)
      return false
    }
  }

  const handleIssueClick = (issue: Issue) => setViewState({ view: 'detail', issueId: issue.id })
  const handleBack = () => setViewState({ view: 'list' })

  const handleCreateIssue = async (data: IssueFormData) => {
    let created: Issue | null = null
    const ok = await run('Could not create the issue', async () => {
      created = await model.createIssue(data.title, {
        body: data.body,
        status: data.status,
        priority: data.priority,
        labels: data.labels,
        parentIssueId: data.parentIssueId,
        blockedBy: data.blockedBy,
        dependsOn: data.dependsOn,
        userStory: data.userStory,
        acceptanceCriteria: data.acceptanceCriteria,
        epicId: data.epicId,
      })
    })
    if (!ok || !created) return
    setViewState({ view: 'list' })
    ctx.notifications.toast({ kind: 'success', title: `Created ${formatRef((created as Issue).displayNumber)}` })
  }

  const handleUpdateIssue = async (data: IssueFormData) => {
    if (viewState.view !== 'edit') return
    const id = viewState.issueId
    const ok = await run('Could not save the issue', () =>
      model.updateIssue(id, {
        title: data.title,
        body: data.body,
        status: data.status,
        priority: data.priority,
        labels: data.labels,
        parentIssueId: data.parentIssueId,
        blockedBy: data.blockedBy,
        dependsOn: data.dependsOn,
        userStory: data.userStory,
        acceptanceCriteria: data.acceptanceCriteria,
        epicId: data.epicId,
      }),
    )
    if (ok) setViewState({ view: 'detail', issueId: id })
  }

  const handleCreateEpic = async (data: EpicFormData) => {
    const ok = await run('Could not create the epic', () =>
      model.createEpic(data.title, {
        description: data.description,
        status: data.status || 'open',
        priority: data.priority || 'medium',
        labels: data.labels || [],
      }),
    )
    if (ok) setViewState({ view: 'epic-list' })
  }

  const handleUpdateEpic = async (data: EpicFormData) => {
    if (viewState.view !== 'epic-edit') return
    const id = viewState.epicId
    const ok = await run('Could not save the epic', () =>
      model.updateEpic(id, {
        title: data.title,
        description: data.description,
        status: data.status,
        priority: data.priority,
        labels: data.labels,
      }),
    )
    if (ok) setViewState({ view: 'epic-detail', epicId: id })
  }

  if (!hasProject) {
    return <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-sm text-vibe-muted">Open a project to see its issues.</div>
  }

  // Only show the spinner on the initial load, not during create/edit (keeps form state).
  if (isLoading && viewState.view === 'list' && issues.length === 0) return <Spinner />

  const showCorrupt = corrupt.length > 0 && dismissedCorrupt !== corrupt.length

  const tabToggle = (
    <div className="flex-shrink-0 border-b border-vibe-border px-3 pt-2">
      {loadError && (
        <div className="mb-2 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300" role="alert">
          Could not load issues: {loadError}
        </div>
      )}
      {showCorrupt && (
        <div className="mb-2 px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 flex items-start gap-2" role="alert">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{corrupt.length} issue file{corrupt.length === 1 ? '' : 's'} could not be read</div>
            {corrupt.map((c) => (
              <div key={c.path} className="font-mono truncate" title={`${c.path}: ${c.message}`}>{c.path}</div>
            ))}
          </div>
          <button onClick={() => setDismissedCorrupt(corrupt.length)} className="text-red-300 hover:text-red-300" aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="flex gap-1">
        <button
          onClick={() => { setTabMode('issues'); setViewState({ view: 'list' }) }}
          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border border-b-0 transition-colors ${
            tabMode === 'issues' ? 'border-vibe-border bg-vibe-bg text-vibe-text' : 'border-transparent text-vibe-muted hover:text-vibe-text'
          }`}
        >
          Issues
        </button>
        <button
          onClick={() => { setTabMode('epics'); setViewState({ view: 'epic-list' }) }}
          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border border-b-0 transition-colors ${
            tabMode === 'epics' ? 'border-vibe-border bg-vibe-bg text-indigo-400' : 'border-transparent text-vibe-muted hover:text-vibe-text'
          }`}
        >
          Epics
        </button>
      </div>
    </div>
  )

  switch (viewState.view) {
    case 'list':
      return (
        <div className="relative h-full w-full flex flex-col">
          {tabToggle}
          <div className="flex-1 min-h-0">
            <IssueListView
              issues={filteredIssues}
              allIssues={issues}
              labels={labels}
              filters={filters}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onFiltersChange={model.setFilters}
              onIssueClick={handleIssueClick}
              onStatusChange={(id, status) => void run('Could not change the status', () => model.setStatus(id, status))}
              onNewIssue={() => setViewState({ view: 'create' })}
              onOpenSettings={() => setViewState({ view: 'settings' })}
            />
          </div>
        </div>
      )

    case 'epic-list':
      return (
        <div className="relative h-full w-full flex flex-col">
          {tabToggle}
          <div className="flex-1 min-h-0">
            <EpicListView
              onSelectEpic={(id) => setViewState({ view: 'epic-detail', epicId: id })}
              onCreateEpic={() => setViewState({ view: 'epic-create' })}
            />
          </div>
        </div>
      )

    case 'epic-detail':
      return (
        <EpicDetailView
          epicId={viewState.epicId}
          onBack={() => setViewState({ view: 'epic-list' })}
          onEditEpic={(id) => setViewState({ view: 'epic-edit', epicId: id })}
          onSelectIssue={(id) => setViewState({ view: 'detail', issueId: id })}
          onCreateIssue={(epicId) => setViewState({ view: 'create', epicId })}
        />
      )

    case 'epic-create':
      return <EpicFormView onSave={handleCreateEpic} onCancel={() => setViewState({ view: 'epic-list' })} />

    case 'epic-edit': {
      const epicToEdit = epics.find((e) => e.id === viewState.epicId)
      return (
        <EpicFormView
          epic={epicToEdit}
          onSave={handleUpdateEpic}
          onCancel={() => setViewState({ view: 'epic-detail', epicId: viewState.epicId })}
        />
      )
    }

    case 'detail':
      if (!currentIssue) return <MissingIssue loading={isLoading} onBack={handleBack} />
      return (
        <IssueDetailView
          issue={currentIssue}
          labels={labels}
          comments={currentIssue.comments}
          isLoadingComments={false}
          onBack={handleBack}
          onEdit={() => setViewState({ view: 'edit', issueId: currentIssue.id })}
          onSetStatus={(status) => void run('Could not change the status', () => model.setStatus(currentIssue.id, status))}
          onDelete={async () => {
            if (await run('Could not delete the issue', () => model.deleteIssue(currentIssue.id))) handleBack()
          }}
          onAddComment={async (body) => {
            await run('Could not add the comment', () => model.addComment(currentIssue.id, body))
          }}
          onDeleteComment={async (id) => {
            await run('Could not delete the comment', () => model.deleteComment(currentIssue.id, id))
          }}
          onUpdateIssue={async (updates) => {
            await run('Could not save the issue', () => model.updateIssue(currentIssue.id, updates))
          }}
          onNavigateToIssue={(issueId) => setViewState({ view: 'detail', issueId })}
        />
      )

    case 'create':
      return (
        <IssueFormView
          labels={labels}
          defaultEpicId={viewState.epicId}
          onSave={handleCreateIssue}
          onCancel={handleBack}
          onCreateLabel={model.createLabel}
        />
      )

    case 'edit':
      if (!currentIssue) return <MissingIssue loading={isLoading} onBack={handleBack} />
      return (
        <IssueFormView
          issue={currentIssue}
          labels={labels}
          onSave={handleUpdateIssue}
          onCancel={() => setViewState({ view: 'detail', issueId: currentIssue.id })}
          onCreateLabel={model.createLabel}
        />
      )

    case 'settings':
      return <SettingsView onBack={handleBack} />

    default:
      return null
  }
}

function MissingIssue({ loading, onBack }: { loading: boolean; onBack: () => void }) {
  if (loading) return <Spinner />
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 bg-vibe-bg text-sm text-vibe-muted">
      <span>This issue no longer exists.</span>
      <button onClick={onBack} className="px-3 py-1.5 text-xs border border-vibe-border rounded hover:text-vibe-text">Back to list</button>
    </div>
  )
}

function SettingsView({ onBack }: { onBack: () => void }) {
  const model = useModel()
  const projectCode = model.meta((s) => s.code)
  const labels = model.labels.use((s) => s.items)
  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1 text-vibe-muted hover:text-vibe-text transition-colors" aria-label="Back to issue list">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="font-medium">Settings</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-6">
          <div>
            <h3 className="font-medium mb-2">Project Code</h3>
            <p className="text-xs text-vibe-muted mb-2">
              Prefix for display IDs (e.g., {projectCode}-1, {projectCode}-2)
            </p>
            <div className="flex items-center gap-2">
              <input
                key={projectCode}
                type="text"
                defaultValue={projectCode}
                maxLength={6}
                pattern="[A-Za-z0-9]+"
                onInput={(e) => {
                  const input = e.target as HTMLInputElement
                  input.value = input.value.replace(/[^A-Za-z0-9]/g, '')
                }}
                onBlur={(e) => {
                  const val = e.target.value.trim().toUpperCase()
                  if (val && val !== projectCode) model.setProjectCode(val).catch((err) => reportError(model.ctx, 'Could not change the project code', err))
                  e.target.value = val || projectCode
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="w-24 px-2 py-1.5 text-sm font-mono bg-vibe-bg-lighter border border-vibe-border rounded-lg focus:outline-none focus:border-teal-500 uppercase"
                aria-label="Project code prefix"
              />
              <span className="text-xs text-vibe-muted">A-Z, 0-9 only, max 6</span>
            </div>
          </div>

          <div>
            <h3 className="font-medium mb-3">Labels</h3>
            {labels.length === 0 ? (
              <p className="text-sm text-vibe-muted">No labels created yet. Create one when adding an issue.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {labels.map((label) => (
                  <span
                    key={label.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full"
                    style={{ backgroundColor: label.color, color: getContrastColor(label.color) }}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          <p className="text-xs text-vibe-muted">GitHub sync (push, import, comments) lives in the GitHub tool, Issues tab; linked issues show their GitHub number here.</p>
        </div>
      </div>
    </div>
  )
}

// Helper function for label contrast
function getContrastColor(hexColor: string) {
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.substr(0, 2), 16)
  const g = parseInt(hex.substr(2, 2), 16)
  const b = parseInt(hex.substr(4, 2), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#000000' : '#ffffff'
}
