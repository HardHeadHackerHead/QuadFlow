import { useState, useEffect, useMemo, useRef } from 'react'
import { useStoredPromptStore } from '../../stores/storedPromptStore'
import { terminalApi } from '../../lib/tauri-api'
import { StoredPrompt } from '../../types'
import { useOverlayRegistration } from '../../stores/overlayStore'

interface StoredPromptsModalProps {
  isOpen: boolean
  onClose: () => void
  targetTerminalId: string
}

export default function StoredPromptsModal({ isOpen, onClose, targetTerminalId }: StoredPromptsModalProps) {
  useOverlayRegistration('stored-prompts-modal', isOpen)
  const { prompts, isLoading, loadPrompts, addPrompt, updatePrompt, deletePrompt, initChangeListener } = useStoredPromptStore()

  const [search, setSearch] = useState('')
  const [editingPrompt, setEditingPrompt] = useState<StoredPrompt | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Edit form state
  const [editName, setEditName] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState('')

  const searchRef = useRef<HTMLInputElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  // Load prompts and init listener when modal opens
  useEffect(() => {
    if (!isOpen) return
    loadPrompts()
    let unlisten: (() => void) | undefined
    const init = async () => {
      unlisten = await initChangeListener()
    }
    init()
    return () => { if (unlisten) unlisten() }
  }, [isOpen, loadPrompts, initChangeListener])

  // Focus search on open
  useEffect(() => {
    if (isOpen && !editingPrompt && !isCreating) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [isOpen, editingPrompt, isCreating])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingPrompt || isCreating) {
          setEditingPrompt(null)
          setIsCreating(false)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, editingPrompt, isCreating, onClose])

  // Existing categories for datalist
  const categories = useMemo(() => {
    const cats = new Set<string>()
    prompts.forEach((p) => { if (p.category) cats.add(p.category) })
    return Array.from(cats).sort()
  }, [prompts])

  // Filtered prompts
  const filtered = useMemo(() => {
    if (!search.trim()) return prompts
    const q = search.toLowerCase()
    return prompts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q) ||
        (p.category && p.category.toLowerCase().includes(q))
    )
  }, [prompts, search])

  const handleInject = async (prompt: StoredPrompt) => {
    await terminalApi.write(targetTerminalId, prompt.content)
    onClose()
  }

  const startEdit = (prompt: StoredPrompt) => {
    setEditingPrompt(prompt)
    setEditName(prompt.name)
    setEditContent(prompt.content)
    setEditCategory(prompt.category || '')
    setIsCreating(false)
  }

  const startCreate = () => {
    setIsCreating(true)
    setEditingPrompt(null)
    setEditName('')
    setEditContent('')
    setEditCategory('')
  }

  const handleSave = async () => {
    const name = editName.trim()
    const content = editContent.trim()
    if (!name || !content) return

    if (isCreating) {
      await addPrompt({ name, content, category: editCategory.trim() || undefined })
    } else if (editingPrompt) {
      await updatePrompt(editingPrompt.id, {
        name,
        content,
        category: editCategory.trim(),
      })
    }
    setEditingPrompt(null)
    setIsCreating(false)
  }

  const handleDelete = async (id: string) => {
    await deletePrompt(id)
    if (editingPrompt?.id === id) {
      setEditingPrompt(null)
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }

  if (!isOpen) return null

  const isEditMode = editingPrompt !== null || isCreating

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div className="bg-vibe-surface border border-vibe-border rounded-xl shadow-2xl w-[520px] max-h-[70vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-vibe-border">
          <h2 className="text-sm font-semibold text-vibe-text">
            {isCreating ? 'New Prompt' : editingPrompt ? 'Edit Prompt' : 'Stored Prompts'}
          </h2>
          <div className="flex items-center gap-2">
            {!isEditMode && (
              <button
                onClick={startCreate}
                className="px-2.5 py-1 text-xs bg-vibe-primary text-white rounded-md hover:bg-vibe-primary/80 transition-colors"
              >
                + New
              </button>
            )}
            <button
              onClick={() => {
                if (isEditMode) {
                  setEditingPrompt(null)
                  setIsCreating(false)
                } else {
                  onClose()
                }
              }}
              className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {isEditMode ? (
          /* Edit/Create form */
          <div className="p-4 flex flex-col gap-3 overflow-y-auto">
            <div>
              <label className="block text-xs text-vibe-muted mb-1">Name</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g. Fix lint errors"
                autoFocus
                className="w-full px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded-md text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-vibe-primary"
              />
            </div>
            <div>
              <label className="block text-xs text-vibe-muted mb-1">Category</label>
              <input
                type="text"
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value)}
                placeholder="e.g. debugging"
                list="prompt-categories"
                className="w-full px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded-md text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-vibe-primary"
              />
              <datalist id="prompt-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-xs text-vibe-muted mb-1">Content</label>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="The prompt text to inject..."
                rows={6}
                className="w-full px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded-md text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-vibe-primary resize-y font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => { setEditingPrompt(null); setIsCreating(false) }}
                className="px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text border border-vibe-border rounded-md transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!editName.trim() || !editContent.trim()}
                className="px-3 py-1.5 text-xs bg-vibe-primary text-white rounded-md hover:bg-vibe-primary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isCreating ? 'Create' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          /* List mode */
          <>
            {/* Search */}
            <div className="px-4 py-2 border-b border-vibe-border">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search prompts..."
                className="w-full px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded-md text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-vibe-primary"
              />
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="p-4 text-center text-xs text-vibe-muted">Loading...</div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-center text-xs text-vibe-muted">
                  {prompts.length === 0 ? 'No stored prompts yet. Click "+ New" to create one.' : 'No matches found.'}
                </div>
              ) : (
                <div className="divide-y divide-vibe-border">
                  {filtered.map((prompt) => (
                    <div
                      key={prompt.id}
                      className="px-4 py-2.5 hover:bg-vibe-border/20 cursor-pointer group flex items-start gap-3 transition-colors"
                      onClick={() => handleInject(prompt)}
                      title="Click to inject into terminal"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-vibe-text truncate">{prompt.name}</span>
                          {prompt.category && (
                            <span className="px-1.5 py-0.5 text-[10px] bg-vibe-primary/20 text-vibe-primary rounded flex-shrink-0">
                              {prompt.category}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-vibe-muted truncate mt-0.5 font-mono">{prompt.content}</p>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); startEdit(prompt) }}
                          className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
                          title="Edit"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(prompt.id) }}
                          className="p-1 text-vibe-muted hover:text-red-400 rounded transition-colors"
                          title="Delete"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
