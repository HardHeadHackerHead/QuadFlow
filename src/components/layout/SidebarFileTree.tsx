import { useEffect, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useFileExplorerStore } from '../../stores/fileExplorerStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { openFileInEditor } from '../../plugins/commands'
import { useSidebarStore } from '../../stores/sidebarStore'
import { FileEntry, isImageFile, isTextFile, isEnvFile } from '../../types/fileExplorer'
import { getFileIconPath, getFileIconColor, formatFileSize } from '../../lib/fileIcons'

// ─── Compact TreeNode for sidebar ─────────────────────────────────────────────
function SidebarTreeNode({
  entry,
  depth,
  onContextMenu,
  onFileOpen,
}: {
  entry: FileEntry
  depth: number
  onContextMenu: (e: React.MouseEvent, entry: FileEntry | null) => void
  onFileOpen: (entry: FileEntry) => void
}) {
  const {
    expandedDirs, selectedEntries, clipboard,
    toggleDir, toggleSelection, clearSelection,
    getTreeEntriesFiltered,
  } = useFileExplorerStore()

  const isExpanded = expandedDirs.has(entry.path)
  const isSelected = selectedEntries.has(entry.path)
  const isCut = clipboard.operation === 'cut' && clipboard.entries.some(e => e.path === entry.path)

  const children = entry.isDirectory && isExpanded ? getTreeEntriesFiltered(entry.path) : []

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.ctrlKey || e.metaKey) {
      toggleSelection(entry.path)
    } else {
      clearSelection()
      toggleSelection(entry.path)
    }
    if (entry.isDirectory) {
      toggleDir(entry.path)
    }
  }, [entry, toggleSelection, clearSelection, toggleDir])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!entry.isDirectory) {
      onFileOpen(entry)
    }
  }, [entry, onFileOpen])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/quadflow-file', JSON.stringify({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }, [entry])

  return (
    <>
      <div
        className={`flex items-center gap-1 py-[2px] cursor-pointer transition-colors select-none text-xs ${
          isSelected ? 'bg-teal-600/20 text-vibe-text' : 'hover:bg-vibe-bg-lighter'
        } ${isCut ? 'opacity-50' : ''}`}
        style={{ paddingLeft: depth * 14 + 6, paddingRight: 6 }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, entry) }}
        draggable
        onDragStart={handleDragStart}
      >
        {entry.isDirectory ? (
          <svg
            className={`w-3 h-3 flex-shrink-0 text-vibe-muted transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        ) : (
          <div className="w-3 flex-shrink-0" />
        )}
        <svg
          className={`w-3.5 h-3.5 ${getFileIconColor(entry.category)} flex-shrink-0`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={getFileIconPath(entry.category)} />
        </svg>
        <span className="truncate" title={entry.name}>{entry.name}</span>
      </div>
      {entry.isDirectory && isExpanded && children.map(child => (
        <SidebarTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          onContextMenu={onContextMenu}
          onFileOpen={onFileOpen}
        />
      ))}
    </>
  )
}

// ─── Sidebar Context Menu ────────────────────────────────────────────────────
function SidebarContextMenu() {
  const {
    contextMenu, closeContextMenu, clipboard,
    openRenameDialog, openDeleteConfirm, openNewItemDialog,
    copyToClipboard, cutToClipboard, paste,
    openWithSystem, revealInExplorer, addBookmark,
    toggleDir, selectedEntries, getSelectedFileEntries,
  } = useFileExplorerStore()

  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!contextMenu.isOpen) return
    const handleClick = () => closeContextMenu()
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [contextMenu.isOpen, closeContextMenu])

  useEffect(() => {
    if (!contextMenu.isOpen || !menuRef.current) return
    const menu = menuRef.current
    const rect = menu.getBoundingClientRect()
    if (rect.right > window.innerWidth) menu.style.left = `${contextMenu.x - rect.width}px`
    if (rect.bottom > window.innerHeight) menu.style.top = `${contextMenu.y - rect.height}px`
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y])

  if (!contextMenu.isOpen) return null

  const entry = contextMenu.targetEntry
  const selected = getSelectedFileEntries()
  const hasSelection = selected.length > 0
  const targetItems = entry && !selectedEntries.has(entry.path) ? [entry] : selected

  const MenuItem = ({ label, shortcut, onClick, danger }: { label: string; shortcut?: string; onClick: () => void; danger?: boolean }) => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); closeContextMenu() }}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
        danger ? 'hover:bg-red-500/20 text-red-400' : 'hover:bg-vibe-bg-lighter'
      }`}
    >
      <span>{label}</span>
      {shortcut && <span className="text-[10px] text-vibe-muted ml-4">{shortcut}</span>}
    </button>
  )

  const Separator = () => <div className="h-px bg-vibe-border my-1" />

  return createPortal(
    <div
      ref={menuRef}
      className="fixed min-w-[180px] bg-vibe-bg border border-vibe-border rounded-lg shadow-xl py-1 overflow-hidden"
      style={{ left: contextMenu.x, top: contextMenu.y, zIndex: 99999 }}
      onClick={(e) => e.stopPropagation()}
    >
      {entry ? (
        <>
          {entry.isDirectory && <MenuItem label="Open" onClick={() => toggleDir(entry.path)} />}
          {!entry.isDirectory && (isTextFile(entry) || isEnvFile(entry)) && (
            <MenuItem label="Open in Editor" onClick={() => void openFileInEditor(entry.path)} />
          )}
          {!entry.isDirectory && (
            <MenuItem label="Open with System" onClick={() => openWithSystem(entry)} />
          )}
          <MenuItem label="Reveal in Explorer" onClick={() => revealInExplorer(entry)} />
          <Separator />
          <MenuItem label="Copy" shortcut="Ctrl+C" onClick={() => copyToClipboard(targetItems)} />
          <MenuItem label="Cut" shortcut="Ctrl+X" onClick={() => cutToClipboard(targetItems)} />
          {clipboard.operation && clipboard.entries.length > 0 && (
            <MenuItem label={`Paste (${clipboard.entries.length})`} shortcut="Ctrl+V" onClick={paste} />
          )}
          <Separator />
          <MenuItem label="Rename" shortcut="F2" onClick={() => openRenameDialog(entry)} />
          <MenuItem label={hasSelection && selectedEntries.has(entry.path) ? `Delete ${selected.length}` : 'Delete'} shortcut="Del" onClick={() => openDeleteConfirm(targetItems)} danger />
          <Separator />
          <MenuItem label="Add to Quick Access" onClick={() => addBookmark(entry.name, entry.path, entry.isDirectory)} />
        </>
      ) : (
        <>
          <MenuItem label="New File" onClick={() => openNewItemDialog('file')} />
          <MenuItem label="New Folder" onClick={() => openNewItemDialog('folder')} />
          {clipboard.operation && clipboard.entries.length > 0 && (
            <>
              <Separator />
              <MenuItem label={`Paste (${clipboard.entries.length})`} onClick={paste} />
            </>
          )}
        </>
      )}
    </div>,
    document.body
  )
}

// ─── Sidebar Dialogs ─────────────────────────────────────────────────────────
function DialogOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-black/50" style={{ zIndex: 99999 }} onClick={onClose}>
      <div className="bg-vibe-bg border border-vibe-border rounded-lg shadow-xl p-4 min-w-[300px] max-w-md" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  )
}

function SidebarRenameDialog() {
  const { renameDialog, closeRenameDialog, renameEntry } = useFileExplorerStore()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renameDialog.isOpen && renameDialog.entry) {
      setName(renameDialog.entry.name)
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus()
          const dotIndex = renameDialog.entry!.name.lastIndexOf('.')
          inputRef.current.setSelectionRange(0, dotIndex > 0 ? dotIndex : renameDialog.entry!.name.length)
        }
      }, 50)
    }
  }, [renameDialog.isOpen, renameDialog.entry])

  if (!renameDialog.isOpen || !renameDialog.entry) return null

  const handleSubmit = () => {
    if (name.trim() && renameDialog.entry) {
      renameEntry(renameDialog.entry, name)
      closeRenameDialog()
    }
  }

  return (
    <DialogOverlay onClose={closeRenameDialog}>
      <h3 className="text-sm font-medium mb-3">Rename</h3>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') closeRenameDialog() }}
        className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-teal-500"
      />
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={closeRenameDialog} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
        <button onClick={handleSubmit} className="px-3 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-500">Rename</button>
      </div>
    </DialogOverlay>
  )
}

function SidebarNewItemDialog() {
  const { newItemDialog, closeNewItemDialog, createNewFile, createNewFolder } = useFileExplorerStore()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (newItemDialog.isOpen) {
      setName('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [newItemDialog.isOpen])

  if (!newItemDialog.isOpen) return null

  const handleSubmit = () => {
    if (!name.trim()) return
    if (newItemDialog.type === 'file') createNewFile(name)
    else createNewFolder(name)
    closeNewItemDialog()
  }

  return (
    <DialogOverlay onClose={closeNewItemDialog}>
      <h3 className="text-sm font-medium mb-3">New {newItemDialog.type === 'file' ? 'File' : 'Folder'}</h3>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') closeNewItemDialog() }}
        placeholder={newItemDialog.type === 'file' ? 'filename.txt' : 'New Folder'}
        className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-teal-500"
      />
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={closeNewItemDialog} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
        <button onClick={handleSubmit} className="px-3 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-500">Create</button>
      </div>
    </DialogOverlay>
  )
}

function SidebarDeleteDialog() {
  const { deleteConfirm, closeDeleteConfirm, deleteEntries } = useFileExplorerStore()

  useEffect(() => {
    if (!deleteConfirm.isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { deleteEntries(deleteConfirm.entries); closeDeleteConfirm() }
      if (e.key === 'Escape') closeDeleteConfirm()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [deleteConfirm.isOpen, deleteConfirm.entries, deleteEntries, closeDeleteConfirm])

  if (!deleteConfirm.isOpen) return null
  const count = deleteConfirm.entries.length

  return (
    <DialogOverlay onClose={closeDeleteConfirm}>
      <h3 className="text-sm font-medium mb-2">Confirm Delete</h3>
      <p className="text-sm text-vibe-muted mb-1">
        Delete {count} item{count !== 1 ? 's' : ''} permanently?
      </p>
      {count <= 5 && (
        <ul className="text-xs text-vibe-muted mb-2 ml-2">
          {deleteConfirm.entries.map(e => (
            <li key={e.path} className="truncate">- {e.name}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2 mt-3">
        <button onClick={closeDeleteConfirm} className="px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text">Cancel</button>
        <button onClick={() => { deleteEntries(deleteConfirm.entries); closeDeleteConfirm() }} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-500">Delete</button>
      </div>
    </DialogOverlay>
  )
}

// ─── Bookmarks Section ──────────────────────────────────────────────────────
function BookmarksSection() {
  const { settings, expandToPath, removeBookmark, addBookmark, openImageViewer, openWithSystem } = useFileExplorerStore()
  const [isExpanded, setIsExpanded] = useState(true)
  const [isDragOver, setIsDragOver] = useState(false)

  const bookmarks = settings.bookmarks

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/quadflow-file')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/quadflow-file'))
      if (data.path && data.name) {
        addBookmark(data.name, data.path, data.isDirectory)
      }
    } catch {
      // Ignore invalid drop data
    }
  }, [addBookmark])

  const handleBookmarkClick = useCallback(async (bm: { path: string; isDirectory?: boolean; name: string }) => {
    if (bm.isDirectory !== false) {
      await expandToPath(bm.path)
    } else {
      await expandToPath(bm.path)
      const ext = '.' + (bm.path.split('.').pop()?.toLowerCase() || '')
      const entry: FileEntry = {
        name: bm.name,
        path: bm.path,
        isDirectory: false,
        isSymlink: false,
        size: 0,
        mtime: 0,
        extension: ext,
        category: 'unknown',
      }
      if (isTextFile(entry)) {
        void openFileInEditor(entry.path)
      } else if (isImageFile(entry)) {
        openImageViewer(entry)
      } else {
        openWithSystem(entry)
      }
    }
  }, [expandToPath, openImageViewer, openWithSystem])

  if (bookmarks.length === 0 && !isDragOver) return null

  return (
    <div
      className={`border-b border-vibe-border flex-shrink-0 ${isDragOver ? 'bg-teal-500/10' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-vibe-muted uppercase tracking-wider hover:text-vibe-text transition-colors"
      >
        <svg
          className={`w-2.5 h-2.5 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span>Quick Access</span>
        <span className="text-vibe-muted/60 ml-auto">{bookmarks.length}</span>
      </button>

      {isExpanded && (
        <div className="pb-1">
          {bookmarks.map((bm) => (
            <div key={bm.path} className="group flex items-center">
              <button
                onClick={() => handleBookmarkClick(bm)}
                className="flex-1 flex items-center gap-1 px-3 py-[2px] text-xs text-vibe-text hover:bg-vibe-bg-lighter transition-colors truncate min-w-0"
                title={bm.path}
              >
                <svg className={`w-3 h-3 flex-shrink-0 ${bm.isDirectory !== false ? 'text-amber-400' : 'text-blue-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={bm.icon} />
                </svg>
                <span className="truncate">{bm.name}</span>
              </button>
              <button
                onClick={() => removeBookmark(bm.path)}
                className="p-0.5 mr-1 opacity-0 group-hover:opacity-100 text-vibe-muted hover:text-red-400 transition-all flex-shrink-0"
                title="Remove"
              >
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
          {bookmarks.length === 0 && isDragOver && (
            <p className="px-3 py-1 text-[10px] text-teal-400">Drop here to bookmark</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main SidebarFileTree ────────────────────────────────────────────────────
export default function SidebarFileTree() {
  const {
    rootPath, currentPath, searchQuery, setSearchQuery, settings,
    toggleHiddenFiles, getTreeEntriesFiltered,
    refresh, collapseAll, openContextMenu, openNewItemDialog,
    initialize, clipboard, selectedEntries, selectAll, clearSelection,
    getSelectedFileEntries, openRenameDialog, openDeleteConfirm,
    copyToClipboard, cutToClipboard, paste, closeContextMenu,
  } = useFileExplorerStore()

  const globalWorkingDirectory = useTerminalStore(s => s.globalWorkingDirectory)
  const sidebarSide = useSidebarStore(s => s.side)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Initialize or re-initialize when the project directory changes
  useEffect(() => {
    if (!globalWorkingDirectory) return
    if (!currentPath || rootPath !== globalWorkingDirectory) {
      initialize()
    }
  }, [globalWorkingDirectory, currentPath, rootPath, initialize])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if focused on input/textarea or inside CodeMirror editor
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if ((document.activeElement as HTMLElement)?.closest('.cm-editor')) return

      // Don't handle if a modal is open
      const { imageViewer, renameDialog, newItemDialog, deleteConfirm } = useFileExplorerStore.getState()
      if (imageViewer.isOpen || renameDialog.isOpen || newItemDialog.isOpen || deleteConfirm.isOpen) return

      // Only handle when sidebar is focused/hovered — check if the event target is inside our sidebar
      const sidebar = document.querySelector('[data-sidebar-file-tree]')
      if (!sidebar) return
      // For global shortcuts like Ctrl+N, we only intercept when sidebar has focus context
      const sidebarHasFocus = sidebar.contains(document.activeElement) || sidebar.matches(':hover')
      if (!sidebarHasFocus) return

      switch (e.key) {
        case 'F5':
          e.preventDefault()
          refresh()
          break
        case 'F2': {
          const selected = getSelectedFileEntries()
          if (selected.length === 1) openRenameDialog(selected[0])
          break
        }
        case 'Delete': {
          const selected = getSelectedFileEntries()
          if (selected.length > 0) openDeleteConfirm(selected)
          break
        }
        case 'Enter': {
          const selected = getSelectedFileEntries()
          if (selected.length === 1) handleFileOpen(selected[0])
          break
        }
        case 'a':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); selectAll() }
          break
        case 'c':
          if (e.ctrlKey || e.metaKey) {
            const selected = getSelectedFileEntries()
            if (selected.length > 0) copyToClipboard(selected)
          }
          break
        case 'x':
          if (e.ctrlKey || e.metaKey) {
            const selected = getSelectedFileEntries()
            if (selected.length > 0) cutToClipboard(selected)
          }
          break
        case 'v':
          if (e.ctrlKey || e.metaKey) paste()
          break
        case 'n':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            openNewItemDialog(e.shiftKey ? 'folder' : 'file')
          }
          break
        case 'f':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            searchInputRef.current?.focus()
          }
          break
        case 'Escape':
          clearSelection()
          closeContextMenu()
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [rootPath, refresh, selectAll, clearSelection, closeContextMenu, getSelectedFileEntries,
      copyToClipboard, cutToClipboard, paste, openRenameDialog, openDeleteConfirm, openNewItemDialog])

  const rootEntries = getTreeEntriesFiltered(rootPath)

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null) => {
    openContextMenu(e.clientX, e.clientY, entry)
  }, [openContextMenu])

  const handleFileOpen = useCallback((entry: FileEntry) => {
    if (entry.isDirectory) return
    if (isEnvFile(entry)) {
      void openFileInEditor(entry.path)
    } else if (isImageFile(entry)) {
      useFileExplorerStore.getState().openImageViewer(entry)
    } else if (isTextFile(entry)) {
      void openFileInEditor(entry.path)
    } else {
      useFileExplorerStore.getState().openWithSystem(entry)
    }
  }, [])

  // Count visible tree entries
  const countTreeEntries = useCallback(() => {
    const { expandedDirs } = useFileExplorerStore.getState()
    let count = 0
    const countDir = (dirPath: string) => {
      const entries = getTreeEntriesFiltered(dirPath)
      count += entries.length
      for (const entry of entries) {
        if (entry.isDirectory && expandedDirs.has(entry.path)) {
          countDir(entry.path)
        }
      }
    }
    if (rootPath) countDir(rootPath)
    return count
  }, [getTreeEntriesFiltered, rootPath])

  const selectedFiles = getSelectedFileEntries()
  const selectedSize = selectedFiles.reduce((sum, e) => sum + (e.isDirectory ? 0 : e.size), 0)

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden" data-sidebar-file-tree>
      {/* Compact toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-vibe-border flex-shrink-0">
        {/* Search */}
        <div className="flex-1 relative">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchQuery(''); (e.target as HTMLInputElement).blur() } }}
            placeholder="Filter files..."
            className="w-full pl-6 pr-2 py-1 bg-vibe-bg-lighter border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-teal-500"
          />
          <svg className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-1 top-1/2 -translate-y-1/2 text-vibe-muted hover:text-vibe-text">
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
        </div>

        {/* New file */}
        <button
          onClick={() => openNewItemDialog('file')}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
          title="New File (Ctrl+N)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* Collapse all */}
        <button
          onClick={collapseAll}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
          title="Collapse All"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>

        {/* Refresh */}
        <button
          onClick={() => refresh()}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
          title="Refresh (F5)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        {/* Open in system file explorer */}
        <button
          onClick={() => { if (rootPath) revealItemInDir(rootPath) }}
          disabled={!rootPath}
          className="p-1 text-vibe-muted hover:text-vibe-text transition-colors disabled:opacity-30"
          title="Open in File Explorer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>

        {/* Hidden files toggle */}
        <button
          onClick={toggleHiddenFiles}
          className={`p-1 transition-colors ${settings.showHiddenFiles ? 'text-teal-400' : 'text-vibe-muted hover:text-vibe-text'}`}
          title={settings.showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {settings.showHiddenFiles ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            )}
          </svg>
        </button>
      </div>

      {/* Clipboard indicator */}
      {clipboard.operation && clipboard.entries.length > 0 && (
        <div className="flex-shrink-0 px-2 py-1 bg-teal-500/10 border-b border-teal-500/20 text-teal-400 text-[10px] flex items-center justify-between">
          <span>
            {clipboard.entries.length} {clipboard.operation === 'cut' ? 'cut' : 'copied'}
          </span>
          <button
            onClick={() => useFileExplorerStore.setState({ clipboard: { entries: [], operation: null } })}
            className="hover:text-teal-300"
          >
            Clear
          </button>
        </div>
      )}

      {/* Bookmarks */}
      <BookmarksSection />

      {/* Tree content */}
      <div
        className="file-tree-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1"
        style={{ direction: sidebarSide === 'left' ? 'rtl' : 'ltr' }}
        onContextMenu={(e) => { e.preventDefault(); handleContextMenu(e, null) }}
      >
        <div style={{ direction: 'ltr' }}>
          {rootEntries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-vibe-muted text-xs">
              <p>Empty directory</p>
            </div>
          ) : (
            rootEntries.map(entry => (
              <SidebarTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                onContextMenu={handleContextMenu}
                onFileOpen={handleFileOpen}
              />
            ))
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex-shrink-0 border-t border-vibe-border px-2 py-1 flex items-center justify-between text-[10px] text-vibe-muted">
        <span>{countTreeEntries()} items</span>
        <div className="flex items-center gap-2">
          {selectedEntries.size > 0 && (
            <span className="text-teal-400">
              {selectedEntries.size} sel{selectedSize > 0 ? ` (${formatFileSize(selectedSize)})` : ''}
            </span>
          )}
          {searchQuery && (
            <span className="text-amber-400 truncate max-w-[80px]" title={searchQuery}>
              "{searchQuery}"
            </span>
          )}
        </div>
      </div>

      {/* Portals for context menu and dialogs */}
      <SidebarContextMenu />
      <SidebarRenameDialog />
      <SidebarNewItemDialog />
      <SidebarDeleteDialog />
    </div>
  )
}
