/**
 * The Ideas tile (pane and flyout). Ported from the shell's IdeasToolView
 * (MIG-ideas): data through `ctx.data.*` (./model.ts), agents through
 * `ctx.agents` (./agent.ts), dialogs and menus from `@quadflow/ui`. Styling:
 * Tailwind classes scoped under `.qf-ideas` (see vite.config.ts).
 */
import { useEffect, useState, useRef, useCallback, useMemo, type ReactNode } from 'react'
import type { IssueStatus, Priority as IssuePriority, TileProps } from '@quadflow/plugin-api'
import { DropdownMenu, Modal } from '@quadflow/ui'
import { ideasModel, type Idea, type IdeaSuggestion, type IdeaNote } from './model'
import { agentProviders, launchAgent } from '@quadflow/plugin-kit'
import { DiscoveryLink } from './DiscoveryLink'

const statusConfig: Record<IssueStatus, { label: string; color: string; bgColor: string }> = {
  backlog: { label: 'Backlog', color: 'text-gray-400', bgColor: 'bg-gray-500/20' },
  todo: { label: 'To Do', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  in_progress: { label: 'In Progress', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  qa: { label: 'QA', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  done: { label: 'Done', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  blocked: { label: 'Blocked', color: 'text-red-400', bgColor: 'bg-red-500/20' },
  needs_human: { label: 'Needs Human', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
}
const priorityConfig: Record<IssuePriority, { label: string; color: string }> = {
  low: { label: 'Low', color: 'text-gray-400' },
  medium: { label: 'Medium', color: 'text-blue-400' },
  high: { label: 'High', color: 'text-orange-400' },
  critical: { label: 'Critical', color: 'text-red-400' },
}

/** Dialog body: portals render outside the tile, so re-enter the style scope. */
function Scoped({ children }: { children: ReactNode }) {
  return <div className="qf-ideas text-vibe-text">{children}</div>
}

// AI Skills for ideas management
const AI_SKILLS = [
  {
    id: 'organize',
    name: 'Organize Ideas',
    description: 'Categorize and tag all ideas',
    command: '/organize-ideas',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    color: 'text-teal-400',
  },
  {
    id: 'suggest',
    name: 'Suggest Improvements',
    description: 'Add AI suggestions for clarity',
    command: '/suggest-improvements',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    color: 'text-yellow-400',
  },
  {
    id: 'check',
    name: 'Check Implemented',
    description: 'Find which ideas are done',
    command: '/check-implemented',
    icon: 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z',
    color: 'text-green-400',
  },
  {
    id: 'summary',
    name: 'Get Summary',
    description: 'Overview by category',
    command: '/idea-summary',
    icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'text-blue-400',
  },
  {
    id: 'maintenance',
    name: 'Full Maintenance',
    description: 'Do everything at once',
    command: '/ideas-maintenance',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    color: 'text-purple-400',
  },
]

// Suggestion type labels
const suggestionTypeLabels: Record<string, { label: string; color: string }> = {
  reword: { label: 'Reword', color: 'text-blue-400' },
  expand: { label: 'Expand', color: 'text-green-400' },
  clarify: { label: 'Clarify', color: 'text-yellow-400' },
  summarize: { label: 'Summarize', color: 'text-purple-400' },
}

// Sort options
type SortOption = 'newest' | 'oldest' | 'most-tags' | 'recently-updated' | 'alphabetical'

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'most-tags', label: 'Most tags' },
  { value: 'recently-updated', label: 'Recently updated' },
  { value: 'alphabetical', label: 'Alphabetical' },
]

// View mode
type ViewMode = 'list' | 'kanban'

// Kanban columns
const KANBAN_COLUMNS = [
  { id: 'ideas', label: 'Ideas', tag: null, excludeTags: ['in-progress', 'implemented'] },
  { id: 'in-progress', label: 'In Progress', tag: 'in-progress', excludeTags: [] },
  { id: 'done', label: 'Done', tag: 'implemented', excludeTags: [] },
] as const

export function IdeasTile({ ctx }: TileProps) {
  const model = ideasModel(ctx)
  const ideas = model.ideas.use((s) => s.items)
  const corruptAll = model.ideas.use((s) => s.corrupt)
  const isLoading = model.ideas.use((s) => s.loading && s.items.length === 0)
  const hasProject = model.ideas.use((s) => s.root !== null)
  const [corruptDismissed, setCorruptDismissed] = useState(false)
  const corrupt = corruptDismissed ? [] : corruptAll
  const dismissCorrupt = () => setCorruptDismissed(true)
  const focusId = model.ui((s) => s.focusId)
  const composeNonce = model.ui((s) => s.composeNonce)

  // Report failures as toasts instead of failing silently.
  const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) => async (...a: A): Promise<void> => {
    try {
      await fn(...a)
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Ideas', body: e instanceof Error ? e.message : String(e) })
    }
  }
  const addIdea = guard((content: string) => model.create(content))
  const updateIdea = guard(model.update)
  const deleteIdea = guard(model.remove)
  const addTag = guard(model.addTag)
  const removeTag = guard(model.removeTag)
  const bulkTag = guard(model.bulkTag)
  const mergeIdeas = guard(model.merge)
  const setArchived = guard(model.setArchived)
  const setDiscovery = guard(model.setDiscovery)
  const acceptSuggestion = guard((id: string, sid: string) => model.resolveSuggestion(id, sid, true))
  const rejectSuggestion = guard((id: string, sid: string) => model.resolveSuggestion(id, sid, false))
  const deleteSuggestion = guard(model.deleteSuggestion)
  const revertToOriginal = guard(model.revert)
  const addNote = guard(model.addNote)
  const deleteNote = guard(model.deleteNote)
  const clearAllIdeas = guard(async () => {
    for (const idea of model.ideas.use.getState().items) await model.remove(idea.id)
  })
  const [newIdeaContent, setNewIdeaContent] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  // Tag input state
  const [addingTagId, setAddingTagId] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')

  // Expanded idea (to show suggestions, notes, and original)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Note input state
  const [newNoteContent, setNewNoteContent] = useState('')
  const [addingNoteId, setAddingNoteId] = useState<string | null>(null)

  // Promote to Issue state
  const [promotingIdea, setPromotingIdea] = useState<Idea | null>(null)
  const [promoteTitle, setPromoteTitle] = useState('')
  const [promoteStatus, setPromoteStatus] = useState<IssueStatus>('todo')
  const [promotePriority, setPromotePriority] = useState<IssuePriority>('medium')
  const [deleteAfterPromote, setDeleteAfterPromote] = useState(true)
  const [isPromoting, setIsPromoting] = useState(false)
  const [promoteSuccess, setPromoteSuccess] = useState(false)

  // AI Actions state
  const [showAiMenu, setShowAiMenu] = useState(false)
  const [runningSkill, setRunningSkill] = useState<string | null>(null)

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [sortOption, setSortOption] = useState<SortOption>('newest')
  const [showSortDropdown, setShowSortDropdown] = useState(false)

  // Bulk select state
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkTagModal, setShowBulkTagModal] = useState(false)
  const [bulkTagInput, setBulkTagInput] = useState('')
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  // View mode state
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // Drag state for Kanban
  const [draggedIdeaId, setDraggedIdeaId] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Get all unique tags from ideas
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    ideas.forEach(idea => {
      idea.tags.forEach(tag => tagSet.add(tag))
    })
    return Array.from(tagSet).sort()
  }, [ideas])

  // Filter and sort ideas
  const archivedCount = useMemo(() => ideas.filter(i => i.archived).length, [ideas])

  const filteredIdeas = useMemo(() => {
    let result = ideas.filter(idea => showArchived || !idea.archived)

    // Filter by search query
    if (debouncedSearch) {
      const query = debouncedSearch.toLowerCase()
      result = result.filter(idea =>
        idea.content.toLowerCase().includes(query) ||
        idea.tags.some(tag => tag.toLowerCase().includes(query))
      )
    }

    // Filter by selected tags (AND logic)
    if (selectedTags.length > 0) {
      result = result.filter(idea =>
        selectedTags.every(tag => idea.tags.includes(tag))
      )
    }

    // Sort
    switch (sortOption) {
      case 'newest':
        result.sort((a, b) => b.createdAt - a.createdAt)
        break
      case 'oldest':
        result.sort((a, b) => a.createdAt - b.createdAt)
        break
      case 'most-tags':
        result.sort((a, b) => b.tags.length - a.tags.length)
        break
      case 'recently-updated':
        result.sort((a, b) => b.updatedAt - a.updatedAt)
        break
      case 'alphabetical':
        result.sort((a, b) => a.content.localeCompare(b.content))
        break
    }

    return result
  }, [ideas, debouncedSearch, selectedTags, sortOption, showArchived])

  // Live data while this tile is mounted (shared with the plugin's other tiles).
  useEffect(() => model.ideas.retain(), [model])

  // Palette / command requests: reveal an idea, or focus the new-idea input.
  useEffect(() => {
    if (!focusId) return
    setShowArchived(true)
    setSearchQuery('')
    setSelectedTags([])
    setViewMode('list')
    setExpandedId(focusId)
    const t = setTimeout(() => {
      rootRef.current?.querySelector(`[data-idea-id="${focusId}"]`)?.scrollIntoView({ block: 'center' })
      model.ui.setState({ focusId: null })
    }, 50)
    return () => clearTimeout(t)
  }, [focusId, model])
  useEffect(() => {
    if (composeNonce) inputRef.current?.focus()
  }, [composeNonce])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    if (addingTagId && tagInputRef.current) {
      tagInputRef.current.focus()
    }
  }, [addingTagId])

  // Clear selected ids when exiting bulk mode
  useEffect(() => {
    if (!bulkMode) {
      setSelectedIds(new Set())
    }
  }, [bulkMode])

  const handleAddIdea = async () => {
    const content = newIdeaContent.trim()
    if (!content) return

    await addIdea(content)
    setNewIdeaContent('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleAddIdea()
    }
  }

  const handleStartEdit = (idea: Idea) => {
    setEditingId(idea.id)
    setEditContent(idea.content)
  }

  const handleSaveEdit = async () => {
    if (editingId && editContent.trim()) {
      await updateIdea(editingId, editContent.trim())
    }
    setEditingId(null)
    setEditContent('')
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditContent('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const handleClearAll = async () => {
    await clearAllIdeas()
    setShowClearConfirm(false)
  }

  // Tag handlers
  const handleAddTag = async (ideaId: string) => {
    if (!newTag.trim()) return
    await addTag(ideaId, newTag.trim())
    setNewTag('')
    setAddingTagId(null)
  }

  const handleTagKeyDown = (e: React.KeyboardEvent, ideaId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddTag(ideaId)
    } else if (e.key === 'Escape') {
      setAddingTagId(null)
      setNewTag('')
    }
  }

  // Search and filter handlers
  const handleClearSearch = () => {
    setSearchQuery('')
    searchInputRef.current?.focus()
  }

  const handleTagFilterClick = (tag: string) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    )
  }

  const handleClearFilters = () => {
    setSearchQuery('')
    setSelectedTags([])
  }

  // Bulk select handlers
  const handleToggleSelect = (ideaId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(ideaId)) {
        next.delete(ideaId)
      } else {
        next.add(ideaId)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedIds(new Set(filteredIdeas.map(i => i.id)))
  }

  const handleDeselectAll = () => {
    setSelectedIds(new Set())
  }

  const handleBulkTag = async () => {
    if (!bulkTagInput.trim()) return
    const tag = bulkTagInput.trim()
    await bulkTag(Array.from(selectedIds), tag)
    setBulkTagInput('')
    setShowBulkTagModal(false)
  }

  const handleBulkDelete = async () => {
    for (const id of selectedIds) {
      await deleteIdea(id)
    }
    setSelectedIds(new Set())
    setShowBulkDeleteConfirm(false)
    setBulkMode(false)
  }

  const handleBulkArchive = async () => {
    for (const id of selectedIds) {
      await setArchived(id, true)
    }
    setSelectedIds(new Set())
  }

  // Merge selected ideas into the oldest one (content concatenated, tags/notes unioned)
  const handleBulkMerge = async () => {
    const ids = filteredIdeas.filter(i => selectedIds.has(i.id)).map(i => i.id).sort()
    if (ids.length < 2) return
    await mergeIdeas(ids, ids[0])
    setSelectedIds(new Set())
  }

  // Kanban drag handlers
  const handleDragStart = (ideaId: string) => {
    setDraggedIdeaId(ideaId)
  }

  const handleDragEnd = () => {
    setDraggedIdeaId(null)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDropOnColumn = async (columnId: string) => {
    if (!draggedIdeaId) return

    const idea = ideas.find(i => i.id === draggedIdeaId)
    if (!idea) return

    // Remove existing status tags
    const statusTags = ['in-progress', 'implemented']
    for (const tag of statusTags) {
      if (idea.tags.includes(tag)) {
        await removeTag(idea.id, tag)
      }
    }

    // Add new tag based on column
    if (columnId === 'in-progress') {
      await addTag(idea.id, 'in-progress')
    } else if (columnId === 'done') {
      await addTag(idea.id, 'implemented')
    }
    // "ideas" column = no status tag

    setDraggedIdeaId(null)
  }

  // Get ideas for a kanban column
  const getKanbanColumnIdeas = (column: typeof KANBAN_COLUMNS[number]) => {
    return filteredIdeas.filter(idea => {
      if (column.tag) {
        return idea.tags.includes(column.tag)
      } else {
        return !column.excludeTags.some(t => idea.tags.includes(t))
      }
    })
  }

  // Promote to Issue handlers
  const handleStartPromote = (idea: Idea) => {
    const firstLine = idea.content.split('\n')[0].trim()
    const title = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine

    setPromotingIdea(idea)
    setPromoteTitle(title)
    setPromoteStatus('todo')
    setPromotePriority('medium')
    setDeleteAfterPromote(true)
    setPromoteSuccess(false)
  }

  const handleCancelPromote = () => {
    setPromotingIdea(null)
    setPromoteTitle('')
    setPromoteSuccess(false)
  }

  const handleConfirmPromote = async () => {
    if (!promotingIdea || !promoteTitle.trim()) return

    setIsPromoting(true)
    try {
      await ctx.data.issues.create(
        {
          title: promoteTitle.trim(),
          body: promotingIdea.content,
          status: promoteStatus,
          priority: promotePriority,
          source: { ideaId: promotingIdea.id },
        },
        { projectRoot: model.ideas.root() },
      )

      if (deleteAfterPromote) {
        await model.remove(promotingIdea.id)
      }

      setPromoteSuccess(true)
      setTimeout(() => {
        setPromotingIdea(null)
        setPromoteTitle('')
        setPromoteSuccess(false)
      }, 1500)
    } catch (e) {
      ctx.notifications.toast({ kind: 'error', title: 'Could not create the issue', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setIsPromoting(false)
    }
  }

  // AI skills run as a slash command in a new Claude Code session (`ctx.agents.launch`).
  const handleRunAiSkill = useCallback(async (skill: typeof AI_SKILLS[0]) => {
    setShowAiMenu(false)
    setRunningSkill(skill.id)
    try {
      await launchAgent(ctx, skill.command, { preferred: 'claude-code', autoSubmit: true })
    } finally {
      setRunningSkill(null)
    }
  }, [ctx])

  // "Send to agent": the idea text as the first prompt, left unsubmitted for editing.
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    agentProviders(ctx)
      .then((list) => setProviders(list.map((p) => ({ id: p.id, name: p.displayName }))))
      .catch(() => setProviders([]))
  }, [ctx])

  // Note handlers
  const handleAddNote = async (ideaId: string) => {
    if (!newNoteContent.trim()) return
    await addNote(ideaId, newNoteContent.trim())
    setNewNoteContent('')
    setAddingNoteId(null)
  }

  const handleNoteKeyDown = (e: React.KeyboardEvent, ideaId: string) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleAddNote(ideaId)
    } else if (e.key === 'Escape') {
      setAddingNoteId(null)
      setNewNoteContent('')
    }
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
  }

  const getPendingSuggestions = (idea: Idea) =>
    idea.suggestions.filter(s => s.accepted == null)

  const hasChanges = (idea: Idea) =>
    idea.content !== idea.originalContent

  const hasActiveFilters = searchQuery || selectedTags.length > 0

  if (!hasProject && !isLoading) {
    return (
      <div className="qf-ideas h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted text-sm">
        Open a project to collect ideas.
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="qf-ideas h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  // Render an idea card (shared between list and kanban views)
  const renderIdeaCard = (idea: Idea, compact = false) => {
    const pendingSuggestions = getPendingSuggestions(idea)
    const isExpanded = expandedId === idea.id
    const isEdited = hasChanges(idea)
    const isSelected = selectedIds.has(idea.id)

    return (
      <div
        key={idea.id}
        data-idea-id={idea.id}
        className={`group bg-vibe-bg-lighter border rounded-lg p-3 hover:border-vibe-border-bright transition-colors ${
          isSelected ? 'border-teal-500 bg-teal-500/5' : 'border-vibe-border'
        } ${compact ? 'cursor-grab active:cursor-grabbing' : ''}`}
        draggable={viewMode === 'kanban'}
        onDragStart={() => handleDragStart(idea.id)}
        onDragEnd={handleDragEnd}
      >
        {editingId === idea.id ? (
          <div className="space-y-2">
            <textarea
              ref={editInputRef}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
              className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-teal-500 min-h-[60px]"
              rows={3}
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleCancelEdit}
                className="px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-2 py-1 text-xs bg-teal-600 hover:bg-teal-500 rounded"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Bulk select checkbox */}
            {bulkMode && (
              <div className="flex items-center mb-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => handleToggleSelect(idea.id)}
                  className="w-4 h-4 rounded border-vibe-border bg-vibe-bg-lighter text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
                />
              </div>
            )}

            {/* Content */}
            <p className={`text-sm whitespace-pre-wrap break-words ${compact ? 'line-clamp-3' : ''}`}>
              {idea.content}
            </p>

            {/* Tags */}
            <div className="flex flex-wrap items-center gap-1 mt-2">
              {idea.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-vibe-bg rounded-full text-vibe-muted border border-vibe-border"
                >
                  #{tag}
                  {!compact && (
                    <button
                      onClick={() => removeTag(idea.id, tag)}
                      className="hover:text-red-400 transition-colors"
                      title="Remove tag"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </span>
              ))}
              {!compact && (
                addingTagId === idea.id ? (
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => handleTagKeyDown(e, idea.id)}
                    onBlur={() => {
                      if (newTag.trim()) handleAddTag(idea.id)
                      else {
                        setAddingTagId(null)
                        setNewTag('')
                      }
                    }}
                    placeholder="tag"
                    className="w-16 px-1 py-0.5 text-xs bg-vibe-bg border border-vibe-border rounded focus:outline-none focus:border-teal-500"
                  />
                ) : (
                  <button
                    onClick={() => setAddingTagId(idea.id)}
                    className="px-1.5 py-0.5 text-xs text-vibe-muted hover:text-teal-400 border border-dashed border-vibe-border rounded-full hover:border-teal-400 transition-colors"
                    title="Add tag"
                  >
                    + tag
                  </button>
                )
              )}
            </div>

            {/* Indicators row (list view only) */}
            {!compact && (
              <div className="flex items-center gap-2 mt-2">
                {isEdited && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : idea.id)}
                    className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1"
                    title="Content has been edited from original"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    edited
                  </button>
                )}
                {pendingSuggestions.length > 0 && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : idea.id)}
                    className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                    title={`${pendingSuggestions.length} pending suggestion(s)`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    {pendingSuggestions.length} suggestion{pendingSuggestions.length > 1 ? 's' : ''}
                  </button>
                )}
                {idea.notes.length > 0 && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : idea.id)}
                    className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1"
                    title={`${idea.notes.length} note(s)`}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                    </svg>
                    {idea.notes.length} note{idea.notes.length > 1 ? 's' : ''}
                  </button>
                )}
              </div>
            )}

            {/* Expanded section: Original content & Suggestions (list view only) */}
            {!compact && isExpanded && (
              <div className="mt-3 pt-3 border-t border-vibe-border space-y-3">
                {/* Original content */}
                {isEdited && (
                  <div className="bg-vibe-bg rounded-lg p-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-vibe-muted font-medium">Original</span>
                      <button
                        onClick={() => revertToOriginal(idea.id)}
                        className="text-xs text-amber-400 hover:text-amber-300"
                        title="Revert to original"
                      >
                        Revert
                      </button>
                    </div>
                    <p className="text-xs text-vibe-muted whitespace-pre-wrap">{idea.originalContent}</p>
                  </div>
                )}

                {/* Suggestions */}
                {idea.suggestions.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs text-vibe-muted font-medium">Suggestions (verbiage improvements)</span>
                    {idea.suggestions.map((suggestion) => (
                      <SuggestionCard
                        key={suggestion.id}
                        suggestion={suggestion}
                        onAccept={() => acceptSuggestion(idea.id, suggestion.id)}
                        onReject={() => rejectSuggestion(idea.id, suggestion.id)}
                        onDelete={() => deleteSuggestion(idea.id, suggestion.id)}
                      />
                    ))}
                  </div>
                )}

                {/* Discovery project ("Projects" tool) link */}
                <DiscoveryLink ctx={ctx} idea={idea} onChange={(id) => setDiscovery(idea.id, id)} />

                {/* Notes */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-vibe-muted font-medium">Notes</span>
                    {addingNoteId !== idea.id && (
                      <button
                        onClick={() => setAddingNoteId(idea.id)}
                        className="text-xs text-teal-400 hover:text-teal-300"
                      >
                        + Add note
                      </button>
                    )}
                  </div>

                  {/* Add note form */}
                  {addingNoteId === idea.id && (
                    <div className="bg-vibe-bg rounded-lg p-2 border border-vibe-border">
                      <textarea
                        value={newNoteContent}
                        onChange={(e) => setNewNoteContent(e.target.value)}
                        onKeyDown={(e) => handleNoteKeyDown(e, idea.id)}
                        placeholder="Add a note..."
                        className="w-full bg-vibe-bg-lighter border border-vibe-border rounded px-2 py-1 text-xs resize-none focus:outline-none focus:border-teal-500 min-h-[60px]"
                        rows={3}
                        autoFocus
                      />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] text-vibe-muted">Ctrl+Enter to save</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setAddingNoteId(null)
                              setNewNoteContent('')
                            }}
                            className="px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleAddNote(idea.id)}
                            disabled={!newNoteContent.trim()}
                            className="px-2 py-1 text-xs bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Notes list */}
                  {idea.notes.length > 0 ? (
                    idea.notes.map((note) => (
                      <NoteCard
                        key={note.id}
                        note={note}
                        onDelete={() => deleteNote(idea.id, note.id)}
                        formatDate={formatDate}
                      />
                    ))
                  ) : (
                    !addingNoteId && (
                      <p className="text-xs text-vibe-muted/50 italic">No notes yet</p>
                    )
                  )}
                </div>
              </div>
            )}

            {/* Footer with date and actions */}
            <div className={`flex items-center justify-between mt-2 pt-2 border-t border-vibe-border/50 ${compact ? 'text-[10px]' : ''}`}>
              <span className={`${compact ? 'text-[10px]' : 'text-xs'} text-vibe-muted`}>
                {formatDate(idea.createdAt)}
                {idea.updatedAt !== idea.createdAt && ' (updated)'}
                {idea.archived && (
                  <button
                    onClick={() => setArchived(idea.id, false)}
                    className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:text-amber-300"
                    title="Unarchive"
                  >
                    archived · restore
                  </button>
                )}
              </span>
              {!compact && (
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : idea.id)}
                    className={`p-1 transition-colors ${isExpanded ? 'text-teal-400' : 'text-vibe-muted hover:text-teal-400'}`}
                    title={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleStartPromote(idea)}
                    className="p-1 text-vibe-muted hover:text-green-400 transition-colors"
                    title="Promote to Issue"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                  </button>
                  <DropdownMenu
                    placement="bottom-end"
                    disabled={providers.length === 0}
                    items={providers.map((p) => ({
                      id: p.id,
                      label: `Send to ${p.name}`,
                      onSelect: () => void launchAgent(ctx, idea.content, { providerId: p.id }),
                    }))}
                    trigger={
                      <button
                        className="p-1 text-vibe-muted hover:text-purple-400 transition-colors disabled:opacity-40"
                        title="Send to Agent"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </button>
                    }
                  />
                  <button
                    onClick={() => handleStartEdit(idea)}
                    className="p-1 text-vibe-muted hover:text-teal-400 transition-colors"
                    title="Edit"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => deleteIdea(idea.id)}
                    className="p-1 text-vibe-muted hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="qf-ideas relative h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span className="font-medium">Ideas</span>
            <span className="text-xs text-vibe-muted bg-vibe-bg-lighter px-2 py-0.5 rounded-full">
              {ideas.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded-md overflow-hidden border border-vibe-border">
              <button
                onClick={() => setViewMode('list')}
                className={`px-2 py-1 text-xs transition-colors ${
                  viewMode === 'list'
                    ? 'bg-teal-600 text-white'
                    : 'bg-vibe-bg-lighter text-vibe-muted hover:text-vibe-text'
                }`}
                title="List view"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode('kanban')}
                className={`px-2 py-1 text-xs transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-teal-600 text-white'
                    : 'bg-vibe-bg-lighter text-vibe-muted hover:text-vibe-text'
                }`}
                title="Kanban view"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                </svg>
              </button>
            </div>

            {/* AI Actions dropdown */}
            {ideas.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowAiMenu(!showAiMenu)}
                  disabled={runningSkill !== null}
                  className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
                    runningSkill
                      ? 'bg-purple-600/20 text-purple-400'
                      : 'bg-purple-600/10 text-purple-400 hover:bg-purple-600/20'
                  }`}
                  title="AI Actions"
                >
                  {runningSkill ? (
                    <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  )}
                  <span>AI</span>
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showAiMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAiMenu(false)} />
                    <div className="absolute right-0 mt-1 w-56 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl z-50 overflow-hidden">
                      <div className="p-2 border-b border-vibe-border">
                        <span className="text-xs text-vibe-muted">Claude AI Actions</span>
                      </div>
                      <div className="py-1">
                        {AI_SKILLS.map((skill) => (
                          <button
                            key={skill.id}
                            onClick={() => handleRunAiSkill(skill)}
                            className="w-full flex items-start gap-3 px-3 py-2 hover:bg-vibe-bg text-left transition-colors"
                          >
                            <svg className={`w-4 h-4 mt-0.5 flex-shrink-0 ${skill.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={skill.icon} />
                            </svg>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-vibe-text">{skill.name}</div>
                              <div className="text-xs text-vibe-muted">{skill.description}</div>
                            </div>
                          </button>
                        ))}
                      </div>
                      <div className="p-2 border-t border-vibe-border bg-vibe-bg/50">
                        <p className="text-[10px] text-vibe-muted text-center">
                          Opens a new Claude terminal
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Bulk select button */}
            {ideas.length > 0 && (
              <button
                onClick={() => setBulkMode(!bulkMode)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  bulkMode
                    ? 'bg-teal-600 text-white'
                    : 'bg-vibe-bg-lighter text-vibe-muted hover:text-vibe-text border border-vibe-border'
                }`}
              >
                {bulkMode ? 'Cancel' : 'Select'}
              </button>
            )}

            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(!showArchived)}
                className={`px-2 py-1 text-xs rounded transition-colors border border-vibe-border ${
                  showArchived ? 'bg-amber-600 text-white' : 'bg-vibe-bg-lighter text-vibe-muted hover:text-vibe-text'
                }`}
                title={showArchived ? 'Hide archived ideas' : 'Show archived ideas'}
              >
                Archived ({archivedCount})
              </button>
            )}

            {ideas.length > 0 && !bulkMode && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-xs text-vibe-muted hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* New idea input */}
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={newIdeaContent}
            onChange={(e) => setNewIdeaContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What's on your mind?"
            className="flex-1 bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-teal-500 min-h-[60px]"
            rows={2}
          />
          <button
            onClick={handleAddIdea}
            disabled={!newIdeaContent.trim()}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors text-sm font-medium self-end"
          >
            Add
          </button>
        </div>
        <p className="text-xs text-vibe-muted mt-1">Ctrl+Enter to add</p>
      </div>

      {/* Search and filters */}
      {ideas.length > 0 && (
        <div className="flex-shrink-0 border-b border-vibe-border p-3 space-y-2">
          {/* Search bar */}
          <div className="flex gap-2 items-center">
            <div className="flex-1 relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ideas..."
                className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg pl-10 pr-8 py-2 text-sm focus:outline-none focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-vibe-muted hover:text-vibe-text"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Sort dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-muted hover:text-vibe-text transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
                </svg>
                <span>{SORT_OPTIONS.find(o => o.value === sortOption)?.label}</span>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showSortDropdown && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSortDropdown(false)} />
                  <div className="absolute right-0 mt-1 w-44 bg-vibe-bg-lighter border border-vibe-border rounded-lg shadow-xl z-50 overflow-hidden py-1">
                    {SORT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => {
                          setSortOption(option.value)
                          setShowSortDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-left text-xs transition-colors ${
                          sortOption === option.value
                            ? 'bg-teal-600/20 text-teal-400'
                            : 'text-vibe-text hover:bg-vibe-bg'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Results count */}
            <span className="text-xs text-vibe-muted whitespace-nowrap">
              {filteredIdeas.length} result{filteredIdeas.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Tag filter chips */}
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => handleTagFilterClick(tag)}
                  className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    selectedTags.includes(tag)
                      ? 'bg-teal-600 border-teal-600 text-white'
                      : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-border-bright'
                  }`}
                >
                  #{tag}
                </button>
              ))}
              {hasActiveFilters && (
                <button
                  onClick={handleClearFilters}
                  className="px-2 py-0.5 text-xs text-vibe-muted hover:text-red-400 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Unreadable idea files (never skipped silently) */}
      {corrupt.length > 0 && (
        <div className="mx-3 mt-2 px-3 py-2 text-xs rounded border border-red-500/40 bg-red-500/10 text-red-300 flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium">{corrupt.length} idea file{corrupt.length === 1 ? '' : 's'} could not be read</div>
            {corrupt.map((c) => (
              <div key={c.path} className="truncate" title={`${c.path}: ${c.message}`}>{c.path}</div>
            ))}
          </div>
          <button onClick={dismissCorrupt} className="text-red-300 hover:text-red-300" title="Dismiss">×</button>
        </div>
      )}

      {/* Ideas list or Kanban */}
      <div className="flex-1 overflow-hidden">
        {ideas.length === 0 ? (
          <div className="h-full flex items-center justify-center text-vibe-muted p-3">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <p>No ideas yet</p>
              <p className="text-sm mt-1">Jot down your thoughts above</p>
            </div>
          </div>
        ) : viewMode === 'list' ? (
          <div className="h-full overflow-y-auto p-3 space-y-2">
            {filteredIdeas.length === 0 ? (
              <div className="text-center text-vibe-muted py-12">
                <p>No ideas match your filters</p>
                <button
                  onClick={handleClearFilters}
                  className="text-sm text-teal-400 hover:text-teal-300 mt-2"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              filteredIdeas.map((idea) => renderIdeaCard(idea))
            )}
          </div>
        ) : (
          // Kanban view
          <div className="h-full flex gap-3 p-3 overflow-x-auto">
            {KANBAN_COLUMNS.map((column) => {
              const columnIdeas = getKanbanColumnIdeas(column)
              return (
                <div
                  key={column.id}
                  className="flex-1 min-w-[250px] max-w-[350px] flex flex-col bg-vibe-bg-lighter rounded-lg border border-vibe-border"
                  onDragOver={handleDragOver}
                  onDrop={() => handleDropOnColumn(column.id)}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-3 py-2 border-b border-vibe-border">
                    <span className="font-medium text-sm">{column.label}</span>
                    <span className="text-xs text-vibe-muted bg-vibe-bg px-2 py-0.5 rounded-full">
                      {columnIdeas.length}
                    </span>
                  </div>

                  {/* Column content */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {columnIdeas.length === 0 ? (
                      <div className="text-center text-vibe-muted text-xs py-8 opacity-50">
                        Drop ideas here
                      </div>
                    ) : (
                      columnIdeas.map((idea) => renderIdeaCard(idea, true))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Bulk actions bar */}
      {bulkMode && (
        <div className="flex-shrink-0 border-t border-vibe-border bg-vibe-bg-lighter p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm text-vibe-muted">
                {selectedIds.size} selected
              </span>
              <button
                onClick={handleSelectAll}
                className="text-xs text-teal-400 hover:text-teal-300"
              >
                Select all
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={handleDeselectAll}
                  className="text-xs text-vibe-muted hover:text-vibe-text"
                >
                  Deselect all
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowBulkTagModal(true)}
                disabled={selectedIds.size === 0}
                className="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 disabled:bg-vibe-bg disabled:text-vibe-muted rounded transition-colors"
              >
                Tag selected
              </button>
              <button
                onClick={handleBulkMerge}
                disabled={selectedIds.size < 2}
                title="Merge into the oldest selected idea"
                className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-vibe-bg disabled:text-vibe-muted rounded transition-colors"
              >
                Merge selected
              </button>
              <button
                onClick={handleBulkArchive}
                disabled={selectedIds.size === 0}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:bg-vibe-bg disabled:text-vibe-muted rounded transition-colors"
              >
                Archive selected
              </button>
              <button
                onClick={() => setShowBulkDeleteConfirm(true)}
                disabled={selectedIds.size === 0}
                className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 disabled:bg-vibe-bg disabled:text-vibe-muted rounded transition-colors"
              >
                Delete selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear confirmation */}
      <Modal open={showClearConfirm} onClose={() => setShowClearConfirm(false)} title="Clear all ideas?" size="sm" overlayId="ideas-clear"
        footer={<Scoped><div className="flex gap-2 justify-end">
          <button onClick={() => setShowClearConfirm(false)} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
          <button onClick={handleClearAll} className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded">Clear all</button>
        </div></Scoped>}>
        <Scoped>
          <p className="text-sm text-vibe-muted">
            This will permanently delete all {ideas.length} ideas. This action cannot be undone.
          </p>
        </Scoped>
      </Modal>

      {/* Bulk tag */}
      <Modal open={showBulkTagModal} onClose={() => { setShowBulkTagModal(false); setBulkTagInput('') }} size="sm" overlayId="ideas-bulk-tag"
        title={`Add tag to ${selectedIds.size} idea${selectedIds.size !== 1 ? 's' : ''}`}
        footer={<Scoped><div className="flex gap-2 justify-end">
          <button onClick={() => { setShowBulkTagModal(false); setBulkTagInput('') }} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
          <button onClick={handleBulkTag} disabled={!bulkTagInput.trim()} className="px-3 py-1.5 text-sm bg-teal-600 hover:bg-teal-500 text-white disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded transition-colors">Add tag</button>
        </div></Scoped>}>
        <Scoped>
          <input
            type="text"
            value={bulkTagInput}
            onChange={(e) => setBulkTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleBulkTag() }}
            placeholder="Enter tag name..."
            className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text focus:outline-none focus:border-teal-500"
            autoFocus
          />
        </Scoped>
      </Modal>

      {/* Bulk delete confirmation */}
      <Modal open={showBulkDeleteConfirm} onClose={() => setShowBulkDeleteConfirm(false)} size="sm" overlayId="ideas-bulk-delete"
        title={`Delete ${selectedIds.size} idea${selectedIds.size !== 1 ? 's' : ''}?`}
        footer={<Scoped><div className="flex gap-2 justify-end">
          <button onClick={() => setShowBulkDeleteConfirm(false)} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
          <button onClick={handleBulkDelete} className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded">Delete</button>
        </div></Scoped>}>
        <Scoped>
          <p className="text-sm text-vibe-muted">This will permanently delete the selected ideas. This action cannot be undone.</p>
        </Scoped>
      </Modal>

      {/* Promote to Issue */}
      <Modal open={promotingIdea !== null} onClose={handleCancelPromote} size="md" overlayId="ideas-promote" hideClose>
        <Scoped>
          {promotingIdea && (promoteSuccess ? (
              <div className="text-center py-4">
                <svg className="w-12 h-12 mx-auto text-green-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="font-medium text-green-400">Issue created!</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                  <h3 className="font-medium">Promote to Issue</h3>
                </div>

                <div className="bg-vibe-bg-lighter border border-vibe-border rounded-lg p-2 mb-4 max-h-20 overflow-y-auto">
                  <p className="text-xs text-vibe-muted whitespace-pre-wrap">{promotingIdea.content}</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-vibe-muted mb-1">Issue Title</label>
                    <input
                      type="text"
                      value={promoteTitle}
                      onChange={(e) => setPromoteTitle(e.target.value)}
                      className="w-full bg-vibe-bg-lighter border border-vibe-border rounded-lg px-3 py-2 text-sm text-vibe-text focus:outline-none focus:border-teal-500"
                      placeholder="Enter issue title..."
                      autoFocus
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-vibe-muted mb-1">Status</label>
                    <div className="flex flex-wrap gap-1">
                      {(['backlog', 'todo', 'in_progress', 'qa', 'done', 'blocked'] as IssueStatus[]).map((s) => {
                        const info = statusConfig[s]
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setPromoteStatus(s)}
                            className={`
                              px-2 py-1 text-xs font-medium rounded border transition-colors
                              ${promoteStatus === s
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

                  <div>
                    <label className="block text-xs text-vibe-muted mb-1">Priority</label>
                    <div className="flex flex-wrap gap-1">
                      {(['low', 'medium', 'high', 'critical'] as IssuePriority[]).map((p) => {
                        const info = priorityConfig[p]
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setPromotePriority(p)}
                            className={`
                              px-2 py-1 text-xs font-medium rounded border transition-colors
                              ${promotePriority === p
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

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={deleteAfterPromote}
                      onChange={(e) => setDeleteAfterPromote(e.target.checked)}
                      className="w-4 h-4 rounded border-vibe-border bg-vibe-bg-lighter text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
                    />
                    <span className="text-sm text-vibe-muted">Delete idea after promoting</span>
                  </label>
                </div>

                <div className="flex gap-2 justify-end mt-4">
                  <button
                    onClick={handleCancelPromote}
                    disabled={isPromoting}
                    className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmPromote}
                    disabled={!promoteTitle.trim() || isPromoting}
                    className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors flex items-center gap-2"
                  >
                    {isPromoting ? (
                      <>
                        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Creating...
                      </>
                    ) : (
                      'Create Issue'
                    )}
                  </button>
                </div>
              </>
            ))}
        </Scoped>
      </Modal>
    </div>
  )
}

// Suggestion card component
function SuggestionCard({
  suggestion,
  onAccept,
  onReject,
  onDelete,
}: {
  suggestion: IdeaSuggestion
  onAccept: () => void
  onReject: () => void
  onDelete: () => void
}) {
  const typeInfo = suggestionTypeLabels[suggestion.kind] || { label: suggestion.kind, color: 'text-vibe-muted' }
  const isPending = suggestion.accepted == null
  const isAccepted = suggestion.accepted === true
  const isRejected = suggestion.accepted === false

  return (
    <div className={`bg-vibe-bg rounded-lg p-2 border ${
      isAccepted ? 'border-green-500/30' :
      isRejected ? 'border-red-500/30 opacity-60' :
      'border-vibe-border'
    }`}>
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-medium ${typeInfo.color}`}>
          {typeInfo.label}
        </span>
        <div className="flex items-center gap-1">
          {isAccepted && (
            <span className="text-xs text-green-400">Accepted</span>
          )}
          {isRejected && (
            <span className="text-xs text-red-400">Rejected</span>
          )}
          {isPending && (
            <>
              <button
                onClick={onAccept}
                className="p-1 text-vibe-muted hover:text-green-400 transition-colors"
                title="Accept suggestion"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <button
                onClick={onReject}
                className="p-1 text-vibe-muted hover:text-red-400 transition-colors"
                title="Reject suggestion"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </>
          )}
          <button
            onClick={onDelete}
            className="p-1 text-vibe-muted hover:text-red-400 transition-colors"
            title="Delete suggestion"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
      <p className="text-xs text-vibe-text whitespace-pre-wrap">{suggestion.text}</p>
    </div>
  )
}

// Note card component
function NoteCard({
  note,
  onDelete,
  formatDate,
}: {
  note: IdeaNote
  onDelete: () => void
  formatDate: (timestamp: number) => string
}) {
  // Author color based on the kind of actor that wrote the note
  const authorColors: Record<string, { bg: string; text: string }> = {
    human: { bg: 'bg-blue-500/20', text: 'text-blue-400' },
    agent: { bg: 'bg-purple-500/20', text: 'text-purple-400' },
    plugin: { bg: 'bg-cyan-500/20', text: 'text-cyan-400' },
  }
  const authorStyle = authorColors[note.createdBy.kind] || { bg: 'bg-gray-500/20', text: 'text-gray-400' }

  return (
    <div className="bg-vibe-bg rounded-lg p-2 border border-vibe-border group">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${authorStyle.bg} ${authorStyle.text}`}>
            {note.createdBy.name}
          </span>
          <span className="text-[10px] text-vibe-muted">
            {formatDate(note.createdAt)}
          </span>
        </div>
        <button
          onClick={onDelete}
          className="p-1 text-vibe-muted hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
          title="Delete note"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      <p className="text-xs text-vibe-text whitespace-pre-wrap">{note.body}</p>
    </div>
  )
}
