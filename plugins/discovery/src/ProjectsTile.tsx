/**
 * The Projects (discovery) tile, pane and flyout. Ported from the shell's
 * ProjectsToolView (MIG-discovery): data through `ctx.data.discovery.*` and
 * `ctx.data.ideas.*` (./model.ts), AI skills through `ctx.agents.launch`.
 * Styling: Tailwind classes scoped under `.qf-discovery` (vite.config.ts).
 */
import { useEffect, useState, useRef, useMemo } from 'react'
import type { DiscoveryLinks_Serialize as DiscoveryLinks, Idea_Serialize, PluginContext, TileProps } from '@quadflow/plugin-api'
import {
  discoveryModel,
  type DiscoveryItem,
  type DiscoveryItemKind,
  type DiscoveryItemPatch,
  type DiscoveryPatch,
  type DiscoveryProject,
  type DiscoveryStatus,
} from './model'
import { launchAgent } from '@quadflow/plugin-kit'

// AI Skills configuration
const AI_SKILLS = [
  {
    id: 'kickoff',
    name: 'Kickoff Project',
    description: 'Guide through structured project setup',
    command: '/kickoff-project',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    color: 'text-yellow-400',
  },
  {
    id: 'summary',
    name: 'Project Summary',
    description: 'Overview of all projects',
    command: '/project-summary',
    icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'text-blue-400',
  },
  {
    id: 'organize',
    name: 'Organize Projects',
    description: 'Review and organize all projects',
    command: '/organize-projects',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    color: 'text-teal-400',
  },
]

// Status configuration
const PROJECT_STATUS_CONFIG: Record<DiscoveryStatus, { label: string; color: string; bgColor: string }> = {
  discovery: { label: 'Discovery', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  planning: { label: 'Planning', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  completed: { label: 'Completed', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  archived: { label: 'Archived', color: 'text-gray-400', bgColor: 'bg-gray-500/20' },
}

// Item type configuration
const ITEM_TYPE_CONFIG: Record<DiscoveryItemKind, { label: string; pluralLabel: string; color: string; bgColor: string; icon: string }> = {
  research: { label: 'Research', pluralLabel: 'Research', color: 'text-purple-400', bgColor: 'bg-purple-500/20', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  requirement: { label: 'Requirement', pluralLabel: 'Requirements', color: 'text-blue-400', bgColor: 'bg-blue-500/20', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01' },
  question: { label: 'Question', pluralLabel: 'Questions', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  reference: { label: 'Reference', pluralLabel: 'References', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  decision: { label: 'Decision', pluralLabel: 'Decisions', color: 'text-green-400', bgColor: 'bg-green-500/20', icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
  note: { label: 'Note', pluralLabel: 'Notes', color: 'text-gray-400', bgColor: 'bg-gray-500/20', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
}

type SortOption = 'newest' | 'oldest' | 'recently-updated' | 'alphabetical' | 'status'
type ActiveTab = DiscoveryItemKind | 'overview' | 'linked'

export function ProjectsTile({ ctx }: TileProps) {
  const model = discoveryModel(ctx)
  const projects = model.projects.use((s) => s.items)
  const isLoading = model.projects.use((s) => s.loading)
  const projectRoot = model.projects.use((s) => s.root)
  const corruptAll = model.projects.use((s) => s.corrupt)
  const [corruptDismissed, setCorruptDismissed] = useState(false)
  const corrupt = corruptDismissed ? [] : corruptAll
  const dismissCorrupt = () => setCorruptDismissed(true)
  const focusId = model.ui((s) => s.focusId)

  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R | undefined> => {
    try {
      return await fn(...a)
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Projects', body: e instanceof Error ? e.message : String(e) })
      return undefined
    }
  }
  const createProject = guard(model.create)
  const updateProject = guard(model.update)
  const deleteProject = guard(model.remove)
  const addItem = guard(model.addItem)
  const updateItem = guard(model.updateItem)
  const deleteItem = guard(model.deleteItem)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<DiscoveryStatus | 'all'>('all')
  const [sortBy] = useState<SortOption>('newest')
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')
  const [isCreating, setIsCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [showSkills, setShowSkills] = useState(false)
  const [addingItemType, setAddingItemType] = useState<DiscoveryItemKind | null>(null)
  const [newItemTitle, setNewItemTitle] = useState('')
  const [newItemContent, setNewItemContent] = useState('')
  const skillsRef = useRef<HTMLDivElement>(null)

  // Live data while this tile is mounted (shared with the plugin's other tiles).
  useEffect(() => model.projects.retain(), [model])
  useEffect(() => setSelectedId(null), [projectRoot])

  // Palette requests: select a project.
  useEffect(() => {
    if (!focusId) return
    setSelectedId(focusId)
    setActiveTab('overview')
    setSearch('')
    setStatusFilter('all')
    model.ui.setState({ focusId: null })
  }, [focusId, model])

  // Close skills dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (skillsRef.current && !skillsRef.current.contains(e.target as Node)) {
        setShowSkills(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectedProject = useMemo(() =>
    projects.find(p => p.id === selectedId) || null,
  [projects, selectedId])

  // Filter and sort
  const filteredProjects = useMemo(() => {
    let filtered = projects
    if (statusFilter !== 'all') {
      filtered = filtered.filter(p => p.status === statusFilter)
    }
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(p =>
        p.title.toLowerCase().includes(q) ||
        p.overview?.toLowerCase().includes(q)
      )
    }
    const sorted = [...filtered]
    switch (sortBy) {
      case 'newest': sorted.sort((a, b) => b.createdAt - a.createdAt); break
      case 'oldest': sorted.sort((a, b) => a.createdAt - b.createdAt); break
      case 'recently-updated': sorted.sort((a, b) => b.updatedAt - a.updatedAt); break
      case 'alphabetical': sorted.sort((a, b) => a.title.localeCompare(b.title)); break
      case 'status': {
        const order: DiscoveryStatus[] = ['discovery', 'planning', 'in_progress', 'completed', 'archived']
        sorted.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
        break
      }
    }
    return sorted
  }, [projects, statusFilter, search, sortBy])

  const handleCreate = async () => {
    if (!newTitle.trim()) return
    const project = await createProject(newTitle.trim())
    if (!project) return
    setSelectedId(project.id)
    setNewTitle('')
    setIsCreating(false)
  }

  // Skills run as a slash command in a new Claude Code session.
  const handleRunSkill = async (command: string) => {
    setShowSkills(false)
    await launchAgent(ctx, command, { preferred: 'claude-code', autoSubmit: true })
  }

  const handleAddItem = async (type: DiscoveryItemKind) => {
    if (!selectedProject || !newItemTitle.trim()) return
    await addItem(selectedProject.id, type, newItemTitle.trim(), newItemContent.trim() || undefined)
    setNewItemTitle('')
    setNewItemContent('')
    setAddingItemType(null)
  }

  const handleDeleteItem = async (itemId: string) => {
    if (!selectedProject) return
    await deleteItem(selectedProject.id, itemId)
  }

  const handleUpdateItem = (itemId: string, patch: DiscoveryItemPatch) => {
    if (!selectedProject) return
    void updateItem(selectedProject.id, itemId, patch)
  }

  const handleUpdateStatus = async (status: DiscoveryStatus) => {
    if (!selectedProject) return
    await updateProject(selectedProject.id, { status })
  }

  const handleSaveField = async (field: string, value: string) => {
    if (!selectedProject) return
    if (field === 'title') {
      await updateProject(selectedProject.id, { title: value })
    } else if (field === 'overview') {
      await updateProject(selectedProject.id, { overview: value.trim() ? value : null })
    }
    setEditingField(null)
  }

  const itemsOfType = (type: DiscoveryItemKind) =>
    selectedProject?.items.filter(i => i.kind === type) || []

  const tabs: { key: ActiveTab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Overview' },
    ...Object.entries(ITEM_TYPE_CONFIG).map(([key, cfg]) => ({
      key: key as ActiveTab,
      label: cfg.pluralLabel,
      count: itemsOfType(key as DiscoveryItemKind).length,
    })),
    { key: 'linked', label: 'Linked' },
  ]

  return (
    <div className="h-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {!projectRoot && !isLoading && (
        <div className="px-3 py-2 text-xs text-vibe-muted border-b border-vibe-border">Open a project to use discovery projects.</div>
      )}
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vibe-border bg-vibe-surface shrink-0">
        <input
          type="text"
          placeholder="Search projects..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder-vibe-muted focus:outline-none focus:border-vibe-primary"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as DiscoveryStatus | 'all')}
          className="px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text"
        >
          <option value="all">All Status</option>
          {Object.entries(PROJECT_STATUS_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        <div ref={skillsRef} className="relative">
          <button
            onClick={() => setShowSkills(!showSkills)}
            className="px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-muted hover:text-vibe-text hover:border-vibe-primary"
          >
            AI Skills
          </button>
          {showSkills && (
            <div className="absolute right-0 top-full mt-1 w-52 bg-vibe-surface border border-vibe-border rounded shadow-lg z-50">
              {AI_SKILLS.map(skill => (
                <button
                  key={skill.id}
                  onClick={() => handleRunSkill(skill.command)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-vibe-bg flex items-center gap-2"
                >
                  <svg className={`w-3.5 h-3.5 ${skill.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={skill.icon} />
                  </svg>
                  <div>
                    <div className="text-vibe-text">{skill.name}</div>
                    <div className="text-vibe-muted text-[10px]">{skill.description}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="px-2 py-1 text-xs bg-vibe-primary text-white rounded hover:brightness-110"
        >
          + New
        </button>
      </div>

      {corrupt.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-1.5 text-[11px] bg-red-500/10 text-red-300 border-b border-red-500/30 shrink-0">
          <div className="flex-1 min-w-0">
            {corrupt.length} file(s) could not be read:
            {corrupt.map((c) => (
              <div key={c.path} className="truncate" title={c.message}>{c.path}</div>
            ))}
          </div>
          <button onClick={dismissCorrupt} className="text-red-300 hover:text-red-300">Dismiss</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel - project list */}
        <div className="w-56 border-r border-vibe-border flex flex-col shrink-0 overflow-hidden">
          {isCreating && (
            <div className="p-2 border-b border-vibe-border">
              <input
                autoFocus
                type="text"
                placeholder="Project title..."
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setIsCreating(false); setNewTitle('') }
                }}
                className="w-full px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder-vibe-muted focus:outline-none focus:border-vibe-primary"
              />
              <div className="flex gap-1 mt-1">
                <button onClick={handleCreate} className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded">Create</button>
                <button onClick={() => { setIsCreating(false); setNewTitle('') }} className="px-2 py-0.5 text-[10px] text-vibe-muted hover:text-vibe-text">Cancel</button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            {isLoading && projects.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-vibe-muted text-xs">Loading...</div>
            ) : filteredProjects.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-vibe-muted text-xs">
                {search || statusFilter !== 'all' ? 'No matches' : 'No projects yet'}
              </div>
            ) : (
              filteredProjects.map(project => (
                <button
                  key={project.id}
                  onClick={() => { setSelectedId(project.id); setActiveTab('overview') }}
                  className={`w-full text-left px-3 py-2 border-b border-vibe-border/50 hover:bg-vibe-surface transition-colors ${
                    selectedId === project.id ? 'bg-vibe-surface border-l-2 border-l-vibe-primary' : ''
                  }`}
                >
                  <div className="text-xs font-medium text-vibe-text truncate">{project.title}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${(PROJECT_STATUS_CONFIG[project.status] ?? PROJECT_STATUS_CONFIG.discovery).bgColor} ${(PROJECT_STATUS_CONFIG[project.status] ?? PROJECT_STATUS_CONFIG.discovery).color}`}>
                      {(PROJECT_STATUS_CONFIG[project.status] ?? PROJECT_STATUS_CONFIG.discovery).label}
                    </span>
                    <span className="text-[10px] text-vibe-muted">{project.items.length} items</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel - project detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedProject ? (
            <div className="flex-1 flex items-center justify-center text-vibe-muted text-sm">
              <div className="text-center">
                <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <p>Select a project or create a new one</p>
              </div>
            </div>
          ) : (
            <>
              {/* Tab bar */}
              <div className="flex items-center border-b border-vibe-border bg-vibe-surface px-2 shrink-0 overflow-x-auto">
                {tabs.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-3 py-1.5 text-xs whitespace-nowrap border-b-2 transition-colors ${
                      activeTab === tab.key
                        ? 'border-vibe-primary text-vibe-primary'
                        : 'border-transparent text-vibe-muted hover:text-vibe-text'
                    }`}
                  >
                    {tab.label}
                    {tab.count !== undefined && tab.count > 0 && (
                      <span className="ml-1 text-[10px] text-vibe-muted">({tab.count})</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-y-auto p-3">
                {activeTab === 'overview' && (
                  <OverviewTab
                    project={selectedProject}
                    onUpdate={(patch) => void updateProject(selectedProject.id, patch)}
                    editingField={editingField}
                    editValue={editValue}
                    setEditingField={setEditingField}
                    setEditValue={setEditValue}
                    onSaveField={handleSaveField}
                    onUpdateStatus={handleUpdateStatus}
                    onDelete={() => { deleteProject(selectedProject.id); setSelectedId(null) }}
                  />
                )}
                {(Object.keys(ITEM_TYPE_CONFIG) as DiscoveryItemKind[]).includes(activeTab as DiscoveryItemKind) && (
                  <ItemsTab
                    itemType={activeTab as DiscoveryItemKind}
                    items={itemsOfType(activeTab as DiscoveryItemKind)}
                    addingItemType={addingItemType}
                    setAddingItemType={setAddingItemType}
                    newItemTitle={newItemTitle}
                    setNewItemTitle={setNewItemTitle}
                    newItemContent={newItemContent}
                    setNewItemContent={setNewItemContent}
                    onAddItem={handleAddItem}
                    onDeleteItem={handleDeleteItem}
                    onUpdateItem={handleUpdateItem}
                  />
                )}
                {activeTab === 'linked' && <LinkedTab ctx={ctx} project={selectedProject} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== Overview Tab ====================

function OverviewTab({
  project, onUpdate, editingField, editValue, setEditingField, setEditValue,
  onSaveField, onUpdateStatus, onDelete,
}: {
  project: DiscoveryProject
  onUpdate: (patch: DiscoveryPatch) => void
  editingField: string | null
  editValue: string
  setEditingField: (f: string | null) => void
  setEditValue: (v: string) => void
  onSaveField: (field: string, value: string) => void
  onUpdateStatus: (status: DiscoveryStatus) => void
  onDelete: () => void
}) {
  const [editingGoals, setEditingGoals] = useState(false)
  const [goalsText, setGoalsText] = useState('')
  const [editingCriteria, setEditingCriteria] = useState(false)
  const [criteriaText, setCriteriaText] = useState('')

  return (
    <div className="space-y-4">
      {/* Title */}
      <div>
        {editingField === 'title' ? (
          <input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onSaveField('title', editValue)
              if (e.key === 'Escape') setEditingField(null)
            }}
            onBlur={() => onSaveField('title', editValue)}
            className="w-full text-lg font-bold bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-vibe-text focus:outline-none focus:border-vibe-primary"
          />
        ) : (
          <h2
            className="text-lg font-bold text-vibe-text cursor-pointer hover:text-vibe-primary"
            onClick={() => { setEditingField('title'); setEditValue(project.title) }}
          >
            {project.title}
          </h2>
        )}
      </div>

      {/* Status + Actions */}
      <div className="flex items-center gap-2">
        <select
          value={project.status}
          onChange={e => onUpdateStatus(e.target.value as DiscoveryStatus)}
          className="px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text"
        >
          {Object.entries(PROJECT_STATUS_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        <button
          onClick={onDelete}
          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 border border-red-500/30 rounded hover:border-red-500/50"
        >
          Delete
        </button>
      </div>

      {/* Overview */}
      <div>
        <label className="text-xs text-vibe-muted font-medium block mb-1">Overview</label>
        {editingField === 'overview' ? (
          <textarea
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSaveField('overview', editValue)
              if (e.key === 'Escape') setEditingField(null)
            }}
            onBlur={() => onSaveField('overview', editValue)}
            rows={3}
            className="w-full text-xs bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-vibe-text focus:outline-none focus:border-vibe-primary resize-none"
          />
        ) : (
          <p
            className="text-xs text-vibe-text/80 cursor-pointer hover:text-vibe-text border border-transparent hover:border-vibe-border/50 rounded px-2 py-1.5 min-h-[2rem]"
            onClick={() => { setEditingField('overview'); setEditValue(project.overview || '') }}
          >
            {project.overview || <span className="text-vibe-muted italic">Click to add overview...</span>}
          </p>
        )}
      </div>

      {/* Goals */}
      <div>
        <label className="text-xs text-vibe-muted font-medium block mb-1">Goals</label>
        {editingGoals ? (
          <div>
            <textarea
              autoFocus
              value={goalsText}
              onChange={e => setGoalsText(e.target.value)}
              placeholder="One goal per line..."
              rows={4}
              className="w-full text-xs bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-vibe-text focus:outline-none focus:border-vibe-primary resize-none"
            />
            <div className="flex gap-1 mt-1">
              <button
                onClick={() => {
                  const goals = goalsText.split('\n').map(g => g.trim()).filter(Boolean)
                  onUpdate({ goals })
                  setEditingGoals(false)
                }}
                className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded"
              >Save</button>
              <button onClick={() => setEditingGoals(false)} className="px-2 py-0.5 text-[10px] text-vibe-muted">Cancel</button>
            </div>
          </div>
        ) : (
          <div
            className="cursor-pointer hover:bg-vibe-surface rounded px-2 py-1.5"
            onClick={() => { setEditingGoals(true); setGoalsText(project.goals?.join('\n') || '') }}
          >
            {project.goals && project.goals.length > 0 ? (
              <ul className="list-disc list-inside space-y-0.5">
                {project.goals.map((goal, i) => (
                  <li key={i} className="text-xs text-vibe-text/80">{goal}</li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-vibe-muted italic">Click to add goals...</span>
            )}
          </div>
        )}
      </div>

      {/* Success Criteria */}
      <div>
        <label className="text-xs text-vibe-muted font-medium block mb-1">Success Criteria</label>
        {editingCriteria ? (
          <div>
            <textarea
              autoFocus
              value={criteriaText}
              onChange={e => setCriteriaText(e.target.value)}
              placeholder="One criterion per line..."
              rows={4}
              className="w-full text-xs bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-vibe-text focus:outline-none focus:border-vibe-primary resize-none"
            />
            <div className="flex gap-1 mt-1">
              <button
                onClick={() => {
                  const criteria = criteriaText.split('\n').map(c => c.trim()).filter(Boolean)
                  onUpdate({ successCriteria: criteria })
                  setEditingCriteria(false)
                }}
                className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded"
              >Save</button>
              <button onClick={() => setEditingCriteria(false)} className="px-2 py-0.5 text-[10px] text-vibe-muted">Cancel</button>
            </div>
          </div>
        ) : (
          <div
            className="cursor-pointer hover:bg-vibe-surface rounded px-2 py-1.5"
            onClick={() => { setEditingCriteria(true); setCriteriaText(project.successCriteria?.join('\n') || '') }}
          >
            {project.successCriteria && project.successCriteria.length > 0 ? (
              <ul className="space-y-0.5">
                {project.successCriteria.map((criterion, i) => (
                  <li key={i} className="text-xs text-vibe-text/80 flex items-start gap-1.5">
                    <svg className="w-3 h-3 mt-0.5 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {criterion}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-vibe-muted italic">Click to add success criteria...</span>
            )}
          </div>
        )}
      </div>

      {/* Item summary */}
      <div>
        <label className="text-xs text-vibe-muted font-medium block mb-1">Items Summary</label>
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.entries(ITEM_TYPE_CONFIG) as [DiscoveryItemKind, typeof ITEM_TYPE_CONFIG[DiscoveryItemKind]][]).map(([type, cfg]) => {
            const count = project.items.filter(i => i.kind === type).length
            return (
              <div key={type} className={`${cfg.bgColor} rounded px-2 py-1.5 text-center`}>
                <div className={`text-sm font-bold ${cfg.color}`}>{count}</div>
                <div className="text-[10px] text-vibe-muted">{cfg.pluralLabel}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ==================== Items Tab ====================

function ItemsTab({
  itemType, items, addingItemType, setAddingItemType,
  newItemTitle, setNewItemTitle, newItemContent, setNewItemContent,
  onAddItem, onDeleteItem, onUpdateItem,
}: {
  itemType: DiscoveryItemKind
  items: DiscoveryItem[]
  addingItemType: DiscoveryItemKind | null
  setAddingItemType: (t: DiscoveryItemKind | null) => void
  newItemTitle: string
  setNewItemTitle: (v: string) => void
  newItemContent: string
  setNewItemContent: (v: string) => void
  onAddItem: (type: DiscoveryItemKind) => void
  onDeleteItem: (itemId: string) => void
  onUpdateItem: (itemId: string, patch: DiscoveryItemPatch) => void
}) {
  const cfg = ITEM_TYPE_CONFIG[itemType]
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className={`w-4 h-4 ${cfg.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={cfg.icon} />
          </svg>
          <h3 className="text-sm font-medium text-vibe-text">{cfg.pluralLabel}</h3>
          <span className="text-xs text-vibe-muted">({items.length})</span>
        </div>
        <button
          onClick={() => { setAddingItemType(itemType); setNewItemTitle(''); setNewItemContent('') }}
          className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded hover:brightness-110"
        >
          + Add
        </button>
      </div>

      {/* Add form */}
      {addingItemType === itemType && (
        <div className="border border-vibe-border rounded p-2 bg-vibe-surface space-y-1.5">
          <input
            autoFocus
            type="text"
            placeholder={`${cfg.label} title...`}
            value={newItemTitle}
            onChange={e => setNewItemTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newItemTitle.trim()) onAddItem(itemType)
              if (e.key === 'Escape') setAddingItemType(null)
            }}
            className="w-full px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder-vibe-muted focus:outline-none focus:border-vibe-primary"
          />
          <textarea
            placeholder="Details / content (optional)..."
            value={newItemContent}
            onChange={e => setNewItemContent(e.target.value)}
            rows={2}
            className="w-full px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder-vibe-muted focus:outline-none focus:border-vibe-primary resize-none"
          />
          <div className="flex gap-1">
            <button
              onClick={() => onAddItem(itemType)}
              disabled={!newItemTitle.trim()}
              className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded disabled:opacity-50"
            >Add</button>
            <button onClick={() => setAddingItemType(null)} className="px-2 py-0.5 text-[10px] text-vibe-muted">Cancel</button>
          </div>
        </div>
      )}

      {/* Items list */}
      {items.length === 0 && addingItemType !== itemType ? (
        <div className="text-xs text-vibe-muted text-center py-6">
          No {cfg.pluralLabel.toLowerCase()} yet. Click "+ Add" to create one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map(item => (
            <div key={item.id} className="border border-vibe-border/50 rounded px-3 py-2 hover:border-vibe-border group">
              {editingItem === item.id ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    className="w-full px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text focus:outline-none focus:border-vibe-primary"
                  />
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    rows={2}
                    className="w-full px-2 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text focus:outline-none focus:border-vibe-primary resize-none"
                  />
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        onUpdateItem(item.id, {
                          title: editTitle,
                          content: editContent.trim() ? editContent : null,
                        })
                        setEditingItem(null)
                      }}
                      className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded"
                    >Save</button>
                    <button onClick={() => setEditingItem(null)} className="px-2 py-0.5 text-[10px] text-vibe-muted">Cancel</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex items-start justify-between">
                    <div
                      className="flex-1 cursor-pointer"
                      onClick={() => { setEditingItem(item.id); setEditTitle(item.title); setEditContent(item.content || '') }}
                    >
                      <div className="text-xs font-medium text-vibe-text">{item.title}</div>
                      {item.content && (
                        <div className="text-[11px] text-vibe-text/70 mt-0.5 whitespace-pre-wrap">{item.content}</div>
                      )}
                      {item.status && (
                        <span className={`inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded ${
                          item.status === 'answered' || item.status === 'must_have'
                            ? 'bg-green-500/20 text-green-400'
                            : item.status === 'pending'
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-gray-500/20 text-gray-400'
                        }`}>
                          {item.status}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => onDeleteItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 p-0.5"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ==================== Linked Tab ====================

function LinkedTab({ ctx, project }: { ctx: PluginContext; project: DiscoveryProject }) {
  const model = discoveryModel(ctx)
  const relatedVersion = model.projects.use((s) => s.relatedVersion)
  const [links, setLinks] = useState<DiscoveryLinks | null>(null)
  const [ideas, setIdeas] = useState<Idea_Serialize[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState('')

  // Links and the idea picker refetch on every idea / plan change (relatedVersion).
  useEffect(() => {
    let cancelled = false
    const projectRoot = model.projects.root()
    Promise.all([ctx.data.discovery.linked(project.id, { projectRoot }), ctx.data.ideas.list({}, { projectRoot })])
      .then(([l, i]) => {
        if (cancelled) return
        setLinks(l)
        setIdeas(i.items)
        setError(null)
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)) })
    return () => { cancelled = true }
  }, [ctx, model, project.id, project.updatedAt, relatedVersion])

  const linkIdea = async (ideaId: string, projectId: string | null) => {
    try {
      await model.linkIdea(ideaId, projectId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const linkable = ideas.filter((i) => !i.archived && i.discoveryId !== project.id)
  const preview = (s: string) => {
    const first = s.split('\n')[0]
    return first.length > 90 ? first.slice(0, 90) + '…' : first
  }

  return (
    <div className="space-y-4">
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-vibe-muted font-medium">Ideas ({links?.ideas.length ?? 0})</label>
          <div className="flex items-center gap-1">
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="max-w-[16rem] px-2 py-0.5 text-[10px] bg-vibe-bg border border-vibe-border rounded text-vibe-text"
            >
              <option value="">Link an idea…</option>
              {linkable.map((i) => (
                <option key={i.id} value={i.id}>{preview(i.content)}</option>
              ))}
            </select>
            <button
              disabled={!pick}
              onClick={async () => { await linkIdea(pick, project.id); setPick('') }}
              className="px-2 py-0.5 text-[10px] bg-vibe-primary text-white rounded disabled:opacity-50"
            >Link</button>
          </div>
        </div>
        {links && links.ideas.length === 0 ? (
          <div className="text-xs text-vibe-muted italic px-2 py-1.5">No linked ideas.</div>
        ) : (
          <div className="space-y-1">
            {links?.ideas.map((i) => (
              <div key={i.id} className="flex items-start justify-between gap-2 border border-vibe-border/50 rounded px-3 py-1.5 group">
                <div className="text-xs text-vibe-text/80 whitespace-pre-wrap">{preview(i.content)}</div>
                <button
                  onClick={() => linkIdea(i.id, null)}
                  className="opacity-0 group-hover:opacity-100 text-[10px] text-vibe-muted hover:text-red-400 shrink-0"
                >Unlink</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div>
        <label className="text-xs text-vibe-muted font-medium block mb-1">Plans ({links?.plans.length ?? 0})</label>
        {links && links.plans.length === 0 ? (
          <div className="text-xs text-vibe-muted italic px-2 py-1.5">No linked plans.</div>
        ) : (
          <div className="space-y-1">
            {links?.plans.map((p) => (
              <div key={p.id} className="border border-vibe-border/50 rounded px-3 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-vibe-text">{p.title}</span>
                  <span className="text-[10px] text-vibe-muted">{p.status}</span>
                </div>
                {p.stepsTotal > 0 && (
                  <div className="mt-1 h-1 bg-vibe-surface rounded">
                    <div className="h-1 bg-green-500 rounded" style={{ width: `${(100 * p.stepsCompleted) / p.stepsTotal}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
