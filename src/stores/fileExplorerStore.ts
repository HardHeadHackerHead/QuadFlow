import { create } from 'zustand'
import { readDir, stat, readTextFile, writeTextFile, remove, rename, mkdir, copyFile, exists } from '@tauri-apps/plugin-fs'
import { join, dirname } from '@tauri-apps/api/path'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { useTerminalStore } from './terminalStore'
import { readFile } from '@tauri-apps/plugin-fs'
import {
  FileEntry,
  ViewMode,
  SortField,
  ImageViewerState,
  TextViewerState,
  ContextMenuState,
  ClipboardState,
  RenameDialogState,
  NewItemDialogState,
  DeleteConfirmState,
  FileExplorerSettings,
  NavigationEntry,
  QuickAccessLocation,
  DEFAULT_FILE_EXPLORER_SETTINGS,
  isImageFile,
  isHiddenFile,
  MAX_TEXT_FILE_SIZE,
} from '../types/fileExplorer'
import { getFileCategory } from '../lib/fileIcons'

// Normalize a path for comparison (lowercase, forward slashes, no trailing slash)
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// Check if a path is within (or equal to) a root boundary
function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedRoot = normalizePath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/')
}

interface FileExplorerStore {
  // Root boundary - cannot navigate above this
  rootPath: string

  // Current state
  currentPath: string
  entries: FileEntry[]
  isLoading: boolean
  error: string | null

  // Navigation history
  historyBack: NavigationEntry[]
  historyForward: NavigationEntry[]

  // Selection
  selectedEntries: Set<string>

  // Search/filter
  searchQuery: string

  // View settings
  settings: FileExplorerSettings

  // Image viewer state
  imageViewer: ImageViewerState

  // Text viewer/editor state
  textViewer: TextViewerState

  // Context menu state
  contextMenu: ContextMenuState

  // Clipboard
  clipboard: ClipboardState

  // Dialogs
  renameDialog: RenameDialogState
  newItemDialog: NewItemDialogState
  deleteConfirm: DeleteConfirmState

  // Quick access
  quickAccessLocations: QuickAccessLocation[]

  // Tree view state
  expandedDirs: Set<string>
  treeContents: Record<string, FileEntry[]>
  highlightedEntry: string | null

  // Actions
  initialize: () => Promise<void>
  navigateTo: (path: string) => Promise<void>
  navigateUp: () => Promise<void>
  navigateBack: () => Promise<void>
  navigateForward: () => Promise<void>
  refresh: () => Promise<void>
  pickDirectory: () => Promise<void>

  // Selection actions
  selectEntry: (path: string) => void
  deselectEntry: (path: string) => void
  toggleSelection: (path: string) => void
  selectAll: () => void
  clearSelection: () => void

  // Search
  setSearchQuery: (query: string) => void

  // View settings actions
  setViewMode: (mode: ViewMode) => void
  setSortConfig: (field: SortField) => void
  toggleHiddenFiles: () => void
  setThumbnailSize: (size: number) => void
  toggleSidebar: () => void

  // Image viewer actions
  openImageViewer: (entry: FileEntry) => void
  closeImageViewer: () => void
  nextImage: () => void
  prevImage: () => void
  setZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  toggleFitMode: () => void

  // Text viewer/editor actions
  openTextViewer: (entry: FileEntry) => Promise<void>
  closeTextViewer: () => void
  setTextContent: (content: string) => void
  toggleEditing: () => void
  saveTextFile: () => Promise<void>
  setSplitRatio: (ratio: number) => void
  popOutEditor: () => Promise<void>

  // Context menu actions
  openContextMenu: (x: number, y: number, entry: FileEntry | null) => void
  closeContextMenu: () => void

  // File operations
  createNewFile: (name: string) => Promise<void>
  createNewFolder: (name: string) => Promise<void>
  renameEntry: (entry: FileEntry, newName: string) => Promise<void>
  deleteEntries: (entries: FileEntry[]) => Promise<void>
  copyToClipboard: (entries: FileEntry[]) => void
  cutToClipboard: (entries: FileEntry[]) => void
  paste: () => Promise<void>
  openWithSystem: (entry: FileEntry) => Promise<void>
  revealInExplorer: (entry: FileEntry) => Promise<void>

  // Dialog actions
  openRenameDialog: (entry: FileEntry) => void
  closeRenameDialog: () => void
  openNewItemDialog: (type: 'file' | 'folder') => void
  closeNewItemDialog: () => void
  openDeleteConfirm: (entries: FileEntry[]) => void
  closeDeleteConfirm: () => void

  // Bookmark actions
  addBookmark: (name: string, path: string, isDirectory?: boolean) => void
  removeBookmark: (path: string) => void

  // Tree view actions
  toggleDir: (path: string) => Promise<void>
  expandToPath: (targetPath: string) => Promise<void>
  collapseAll: () => void
  setHighlightedEntry: (path: string | null) => void
  getTreeEntriesFiltered: (dirPath: string) => FileEntry[]
  refreshDir: (dirPath: string) => Promise<void>
  loadImageAsBlob: (path: string) => Promise<string>

  // Helpers
  getImageSrc: (path: string) => string
  getSortedEntries: () => FileEntry[]
  getFilteredEntries: () => FileEntry[]
  getSelectedFileEntries: () => FileEntry[]
}

// Helper to build entries from readDir result
async function buildEntries(path: string, dirEntries: Awaited<ReturnType<typeof readDir>>): Promise<FileEntry[]> {
  return await Promise.all(
    dirEntries.map(async (entry) => {
      const entryPath = await join(path, entry.name)
      let size = 0
      let mtime = Date.now() / 1000

      try {
        const info = await stat(entryPath)
        size = info.size
        mtime = info.mtime ? info.mtime.getTime() / 1000 : Date.now() / 1000
      } catch {
        // If stat fails, use defaults
      }

      const extension = entry.isDirectory ? '' : ('.' + entry.name.split('.').pop()?.toLowerCase() || '')

      return {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
        size,
        mtime,
        extension,
        category: getFileCategory(extension, entry.isDirectory),
      }
    })
  )
}

export const useFileExplorerStore = create<FileExplorerStore>((set, get) => ({
  // Initial state
  rootPath: '',
  currentPath: '',
  entries: [],
  isLoading: false,
  error: null,
  historyBack: [],
  historyForward: [],
  selectedEntries: new Set(),
  searchQuery: '',
  settings: { ...DEFAULT_FILE_EXPLORER_SETTINGS },
  imageViewer: {
    isOpen: false,
    currentImage: null,
    zoom: 1,
    fitMode: 'contain',
    imageList: [],
    currentIndex: -1,
  },
  textViewer: {
    isOpen: false,
    entry: null,
    content: '',
    originalContent: '',
    isEditing: false,
    isSaving: false,
    isLoading: false,
    error: null,
    isDirty: false,
    splitRatio: 0.35,
  },
  contextMenu: {
    isOpen: false,
    x: 0,
    y: 0,
    targetEntry: null,
  },
  clipboard: {
    entries: [],
    operation: null,
  },
  renameDialog: {
    isOpen: false,
    entry: null,
    newName: '',
  },
  newItemDialog: {
    isOpen: false,
    type: 'file',
    name: '',
  },
  deleteConfirm: {
    isOpen: false,
    entries: [],
  },
  quickAccessLocations: [],
  expandedDirs: new Set<string>(),
  treeContents: {},
  highlightedEntry: null,

  // Initialize with project working directory as root
  initialize: async () => {
    const { settings } = get()

    // Get the project root from the terminal store
    const root = useTerminalStore.getState().globalWorkingDirectory
    set({ rootPath: root })

    // Set the root as the only quick access location
    const projectName = root.split(/[/\\]/).pop() || root
    set({
      quickAccessLocations: [
        { name: projectName, path: root, icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z', isDirectory: true },
      ],
    })

    try {
      // Load root directory contents for tree view
      const dirEntries = await readDir(root)
      const entries = await buildEntries(root, dirEntries)

      set({
        currentPath: root,
        entries,
        isLoading: false,
        expandedDirs: new Set([root]),
        treeContents: { [root]: entries },
        settings: { ...settings, lastVisitedPath: root },
      })
    } catch (error) {
      console.error('Failed to initialize file explorer:', error)
      set({ error: 'Failed to initialize file explorer' })
    }
  },

  // Navigate to a directory
  navigateTo: async (path: string) => {
    const { currentPath, historyBack, settings, rootPath } = get()

    // Block navigation above root
    if (rootPath && !isWithinRoot(path, rootPath)) {
      return
    }

    set({ isLoading: true, error: null })

    try {
      const dirEntries = await readDir(path)
      const entries = await buildEntries(path, dirEntries)

      let newHistoryBack = historyBack
      if (currentPath && currentPath !== path) {
        newHistoryBack = [...historyBack, { path: currentPath, timestamp: Date.now() }]
        if (newHistoryBack.length > 50) {
          newHistoryBack = newHistoryBack.slice(-50)
        }
      }

      set({
        currentPath: path,
        entries,
        isLoading: false,
        historyBack: newHistoryBack,
        historyForward: [],
        selectedEntries: new Set(),
        searchQuery: '',
        settings: { ...settings, lastVisitedPath: path },
      })
    } catch (error) {
      console.error('Failed to navigate to:', path, error)
      set({
        isLoading: false,
        error: `Failed to open directory: ${error}`,
      })
    }
  },

  navigateUp: async () => {
    const { currentPath, rootPath, navigateTo } = get()
    if (!currentPath) return
    // Already at root, can't go higher
    if (rootPath && normalizePath(currentPath) === normalizePath(rootPath)) return
    try {
      const parentPath = await dirname(currentPath)
      if (parentPath && parentPath !== currentPath && (!rootPath || isWithinRoot(parentPath, rootPath))) {
        await navigateTo(parentPath)
      }
    } catch (error) {
      console.error('Failed to navigate up:', error)
    }
  },

  navigateBack: async () => {
    const { historyBack, historyForward, currentPath, rootPath } = get()
    if (historyBack.length === 0) return

    const lastEntry = historyBack[historyBack.length - 1]
    // Block if target is outside root
    if (rootPath && !isWithinRoot(lastEntry.path, rootPath)) return
    const newHistoryBack = historyBack.slice(0, -1)
    const newHistoryForward = [
      { path: currentPath, timestamp: Date.now() },
      ...historyForward,
    ]

    set({ historyBack: newHistoryBack, historyForward: newHistoryForward })

    set({ isLoading: true, error: null })
    try {
      const dirEntries = await readDir(lastEntry.path)
      const entries = await buildEntries(lastEntry.path, dirEntries)

      set({
        currentPath: lastEntry.path,
        entries,
        isLoading: false,
        selectedEntries: new Set(),
        searchQuery: '',
      })
    } catch (error) {
      set({ isLoading: false, error: `Failed to navigate back: ${error}` })
    }
  },

  navigateForward: async () => {
    const { historyForward, historyBack, currentPath, rootPath } = get()
    if (historyForward.length === 0) return

    const nextEntry = historyForward[0]
    // Block if target is outside root
    if (rootPath && !isWithinRoot(nextEntry.path, rootPath)) return
    const newHistoryForward = historyForward.slice(1)
    const newHistoryBack = [
      ...historyBack,
      { path: currentPath, timestamp: Date.now() },
    ]

    set({ historyBack: newHistoryBack, historyForward: newHistoryForward })

    set({ isLoading: true, error: null })
    try {
      const dirEntries = await readDir(nextEntry.path)
      const entries = await buildEntries(nextEntry.path, dirEntries)

      set({
        currentPath: nextEntry.path,
        entries,
        isLoading: false,
        selectedEntries: new Set(),
        searchQuery: '',
      })
    } catch (error) {
      set({ isLoading: false, error: `Failed to navigate forward: ${error}` })
    }
  },

  refresh: async () => {
    const { expandedDirs } = get()
    const freshContents: Record<string, FileEntry[]> = {}

    for (const dir of expandedDirs) {
      try {
        const dirEntries = await readDir(dir)
        const entries = await buildEntries(dir, dirEntries)
        freshContents[dir] = entries
      } catch (error) {
        console.error('Failed to refresh dir:', dir, error)
        // Keep existing contents if refresh fails
        const existing = get().treeContents[dir]
        if (existing) {
          freshContents[dir] = existing
        }
      }
    }

    // Merge fresh contents into current state rather than replacing entirely
    set((state) => ({
      treeContents: { ...state.treeContents, ...freshContents },
      isLoading: false,
    }))
  },

  pickDirectory: async () => {
    const { rootPath } = get()
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Directory',
        defaultPath: rootPath || undefined,
      })
      if (selected && typeof selected === 'string') {
        if (rootPath && !isWithinRoot(selected, rootPath)) {
          set({ error: 'Cannot navigate outside the project directory' })
          return
        }
        await get().navigateTo(selected)
      }
    } catch (error) {
      console.error('Failed to pick directory:', error)
    }
  },

  // Selection actions
  selectEntry: (path: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedEntries)
      newSelection.add(path)
      return { selectedEntries: newSelection }
    })
  },

  deselectEntry: (path: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedEntries)
      newSelection.delete(path)
      return { selectedEntries: newSelection }
    })
  },

  toggleSelection: (path: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedEntries)
      if (newSelection.has(path)) {
        newSelection.delete(path)
      } else {
        newSelection.add(path)
      }
      return { selectedEntries: newSelection }
    })
  },

  selectAll: () => {
    const { expandedDirs, getTreeEntriesFiltered, rootPath } = get()
    const allPaths: string[] = []
    const collectPaths = (dirPath: string) => {
      const entries = getTreeEntriesFiltered(dirPath)
      for (const entry of entries) {
        allPaths.push(entry.path)
        if (entry.isDirectory && expandedDirs.has(entry.path)) {
          collectPaths(entry.path)
        }
      }
    }
    if (rootPath) collectPaths(rootPath)
    set({ selectedEntries: new Set(allPaths) })
  },

  clearSelection: () => {
    set({ selectedEntries: new Set() })
  },

  // Search
  setSearchQuery: (query: string) => {
    set({ searchQuery: query })
  },

  // View settings actions
  setViewMode: (mode: ViewMode) => {
    set((state) => ({
      settings: { ...state.settings, viewMode: mode },
    }))
  },

  setSortConfig: (field: SortField) => {
    set((state) => {
      const currentSort = state.settings.sortConfig
      const direction =
        currentSort.field === field
          ? currentSort.direction === 'asc' ? 'desc' : 'asc'
          : 'asc'
      return {
        settings: {
          ...state.settings,
          sortConfig: { field, direction },
        },
      }
    })
  },

  toggleHiddenFiles: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        showHiddenFiles: !state.settings.showHiddenFiles,
      },
    }))
  },

  setThumbnailSize: (size: number) => {
    set((state) => ({
      settings: { ...state.settings, thumbnailSize: size },
    }))
  },

  toggleSidebar: () => {
    set((state) => ({
      settings: { ...state.settings, showSidebar: !state.settings.showSidebar },
    }))
  },

  // Image viewer actions
  openImageViewer: (entry: FileEntry) => {
    // Find sibling images in the same directory via tree contents
    const { treeContents } = get()
    // Find which directory contains this entry
    let siblingEntries: FileEntry[] = []
    for (const [, contents] of Object.entries(treeContents)) {
      if (contents.some(e => e.path === entry.path)) {
        siblingEntries = contents
        break
      }
    }
    const imageList = siblingEntries.filter(isImageFile)
    const currentIndex = imageList.findIndex(img => img.path === entry.path)

    set({
      imageViewer: {
        isOpen: true,
        currentImage: entry,
        zoom: 1,
        fitMode: 'contain',
        imageList,
        currentIndex,
      },
    })
  },

  closeImageViewer: () => {
    set({
      imageViewer: {
        isOpen: false,
        currentImage: null,
        zoom: 1,
        fitMode: 'contain',
        imageList: [],
        currentIndex: -1,
      },
    })
  },

  nextImage: () => {
    set((state) => {
      const { imageViewer } = state
      if (imageViewer.imageList.length === 0) return state
      const nextIndex = (imageViewer.currentIndex + 1) % imageViewer.imageList.length
      return {
        imageViewer: {
          ...imageViewer,
          currentIndex: nextIndex,
          currentImage: imageViewer.imageList[nextIndex],
          zoom: 1,
        },
      }
    })
  },

  prevImage: () => {
    set((state) => {
      const { imageViewer } = state
      if (imageViewer.imageList.length === 0) return state
      const prevIndex =
        imageViewer.currentIndex === 0
          ? imageViewer.imageList.length - 1
          : imageViewer.currentIndex - 1
      return {
        imageViewer: {
          ...imageViewer,
          currentIndex: prevIndex,
          currentImage: imageViewer.imageList[prevIndex],
          zoom: 1,
        },
      }
    })
  },

  setZoom: (zoom: number) => {
    set((state) => ({
      imageViewer: {
        ...state.imageViewer,
        zoom: Math.max(0.1, Math.min(5, zoom)),
      },
    }))
  },

  zoomIn: () => {
    const { imageViewer, setZoom } = get()
    setZoom(imageViewer.zoom * 1.25)
  },

  zoomOut: () => {
    const { imageViewer, setZoom } = get()
    setZoom(imageViewer.zoom / 1.25)
  },

  resetZoom: () => {
    set((state) => ({
      imageViewer: { ...state.imageViewer, zoom: 1 },
    }))
  },

  toggleFitMode: () => {
    set((state) => {
      const modes: Array<'contain' | 'cover' | 'actual'> = ['contain', 'cover', 'actual']
      const currentIndex = modes.indexOf(state.imageViewer.fitMode)
      const nextIndex = (currentIndex + 1) % modes.length
      return {
        imageViewer: {
          ...state.imageViewer,
          fitMode: modes[nextIndex],
          zoom: 1,
        },
      }
    })
  },

  // Text viewer/editor actions
  openTextViewer: async (entry: FileEntry) => {
    const { textViewer: prevViewer } = get()
    const splitRatio = prevViewer.splitRatio || 0.35

    if (entry.size > MAX_TEXT_FILE_SIZE) {
      set({
        textViewer: {
          isOpen: true,
          entry,
          content: '',
          originalContent: '',
          isEditing: false,
          isSaving: false,
          isLoading: false,
          error: `File is too large to view (${(entry.size / 1024 / 1024).toFixed(1)} MB). Max: 5 MB.`,
          isDirty: false,
          splitRatio,
        },
      })
      return
    }

    set({
      textViewer: {
        isOpen: true,
        entry,
        content: '',
        originalContent: '',
        isEditing: false,
        isSaving: false,
        isLoading: true,
        error: null,
        isDirty: false,
        splitRatio,
      },
    })

    try {
      const content = await readTextFile(entry.path)
      set({
        textViewer: {
          isOpen: true,
          entry,
          content,
          originalContent: content,
          isEditing: false,
          isSaving: false,
          isLoading: false,
          error: null,
          isDirty: false,
          splitRatio,
        },
      })
    } catch (error) {
      set((state) => ({
        textViewer: {
          ...state.textViewer,
          isLoading: false,
          error: `Failed to read file: ${error}`,
        },
      }))
    }
  },

  closeTextViewer: () => {
    set((state) => ({
      textViewer: {
        isOpen: false,
        entry: null,
        content: '',
        originalContent: '',
        isEditing: false,
        isSaving: false,
        isLoading: false,
        error: null,
        isDirty: false,
        splitRatio: state.textViewer.splitRatio || 0.35,
      },
    }))
  },

  setTextContent: (content: string) => {
    set((state) => ({
      textViewer: {
        ...state.textViewer,
        content,
        isDirty: content !== state.textViewer.originalContent,
      },
    }))
  },

  toggleEditing: () => {
    set((state) => ({
      textViewer: {
        ...state.textViewer,
        isEditing: !state.textViewer.isEditing,
      },
    }))
  },

  saveTextFile: async () => {
    const { textViewer } = get()
    if (!textViewer.entry || !textViewer.isDirty) return

    set((state) => ({
      textViewer: { ...state.textViewer, isSaving: true, error: null },
    }))

    try {
      await writeTextFile(textViewer.entry.path, textViewer.content)
      set((state) => ({
        textViewer: {
          ...state.textViewer,
          originalContent: state.textViewer.content,
          isDirty: false,
          isSaving: false,
        },
      }))
      // Refresh to update file size/mtime
      get().refresh()
    } catch (error) {
      set((state) => ({
        textViewer: {
          ...state.textViewer,
          isSaving: false,
          error: `Failed to save: ${error}`,
        },
      }))
    }
  },

  setSplitRatio: (ratio: number) => {
    set((state) => ({
      textViewer: {
        ...state.textViewer,
        splitRatio: Math.max(0.15, Math.min(0.7, ratio)),
      },
    }))
  },

  popOutEditor: async () => {
    const { textViewer, closeTextViewer } = get()
    if (!textViewer.entry) return
    // The Editor plugin's pane (plugins/editor; .env files open behind its warning gate).
    const { openFileInEditor } = await import('../plugins/commands')
    await openFileInEditor(textViewer.entry.path)
    closeTextViewer()
  },

  // Context menu actions
  openContextMenu: (x: number, y: number, entry: FileEntry | null) => {
    set({
      contextMenu: { isOpen: true, x, y, targetEntry: entry },
    })
  },

  closeContextMenu: () => {
    set({
      contextMenu: { isOpen: false, x: 0, y: 0, targetEntry: null },
    })
  },

  // File operations
  createNewFile: async (name: string) => {
    const { currentPath, refreshDir } = get()
    if (!name.trim()) return

    try {
      const filePath = await join(currentPath, name.trim())
      const fileExists = await exists(filePath)
      if (fileExists) {
        set({ error: `"${name}" already exists` })
        return
      }
      await writeTextFile(filePath, '')
      await refreshDir(currentPath)
    } catch (error) {
      set({ error: `Failed to create file: ${error}` })
    }
  },

  createNewFolder: async (name: string) => {
    const { currentPath, refreshDir } = get()
    if (!name.trim()) return

    try {
      const folderPath = await join(currentPath, name.trim())
      const folderExists = await exists(folderPath)
      if (folderExists) {
        set({ error: `"${name}" already exists` })
        return
      }
      await mkdir(folderPath)
      await refreshDir(currentPath)
    } catch (error) {
      set({ error: `Failed to create folder: ${error}` })
    }
  },

  renameEntry: async (entry: FileEntry, newName: string) => {
    if (!newName.trim() || newName === entry.name) return

    try {
      const parentDir = await dirname(entry.path)
      const newPath = await join(parentDir, newName.trim())
      const targetExists = await exists(newPath)
      if (targetExists) {
        set({ error: `"${newName}" already exists` })
        return
      }
      await rename(entry.path, newPath)
      await get().refreshDir(parentDir)
    } catch (error) {
      set({ error: `Failed to rename: ${error}` })
    }
  },

  deleteEntries: async (entries: FileEntry[]) => {
    try {
      const parentDirs = new Set<string>()
      for (const entry of entries) {
        const parent = await dirname(entry.path)
        parentDirs.add(parent)
        await remove(entry.path, { recursive: entry.isDirectory })
      }
      // Refresh affected directories
      for (const dir of parentDirs) {
        await get().refreshDir(dir)
      }
    } catch (error) {
      set({ error: `Failed to delete: ${error}` })
    }
  },

  copyToClipboard: (entries: FileEntry[]) => {
    set({ clipboard: { entries, operation: 'copy' } })
  },

  cutToClipboard: (entries: FileEntry[]) => {
    set({ clipboard: { entries, operation: 'cut' } })
  },

  paste: async () => {
    const { clipboard, currentPath } = get()
    if (!clipboard.operation || clipboard.entries.length === 0) return

    try {
      for (const entry of clipboard.entries) {
        const destPath = await join(currentPath, entry.name)

        // Check if destination exists and generate unique name
        let finalDest = destPath
        let counter = 1
        while (await exists(finalDest)) {
          const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : ''
          const base = ext ? entry.name.slice(0, -(ext.length)) : entry.name
          finalDest = await join(currentPath, `${base} (${counter})${ext}`)
          counter++
        }

        if (entry.isDirectory) {
          // For directories, we'd need recursive copy which isn't directly available
          // For cut, we can use rename (move)
          if (clipboard.operation === 'cut') {
            await rename(entry.path, finalDest)
          } else {
            // Directory copy not directly supported by Tauri fs plugin
            set({ error: 'Directory copy is not yet supported. Use cut instead.' })
            return
          }
        } else {
          if (clipboard.operation === 'cut') {
            await rename(entry.path, finalDest)
          } else {
            await copyFile(entry.path, finalDest)
          }
        }
      }

      // Clear clipboard after cut
      if (clipboard.operation === 'cut') {
        set({ clipboard: { entries: [], operation: null } })
      }

      await get().refreshDir(currentPath)
    } catch (error) {
      set({ error: `Failed to paste: ${error}` })
    }
  },

  openWithSystem: async (entry: FileEntry) => {
    try {
      await openPath(entry.path)
    } catch (error) {
      set({ error: `Failed to open: ${error}` })
    }
  },

  revealInExplorer: async (entry: FileEntry) => {
    try {
      await revealItemInDir(entry.path)
    } catch (error) {
      set({ error: `Failed to reveal in explorer: ${error}` })
    }
  },

  // Dialog actions
  openRenameDialog: (entry: FileEntry) => {
    set({
      renameDialog: { isOpen: true, entry, newName: entry.name },
    })
  },

  closeRenameDialog: () => {
    set({
      renameDialog: { isOpen: false, entry: null, newName: '' },
    })
  },

  openNewItemDialog: (type: 'file' | 'folder') => {
    set({
      newItemDialog: { isOpen: true, type, name: '' },
    })
  },

  closeNewItemDialog: () => {
    set({
      newItemDialog: { isOpen: false, type: 'file', name: '' },
    })
  },

  openDeleteConfirm: (entries: FileEntry[]) => {
    set({
      deleteConfirm: { isOpen: true, entries },
    })
  },

  closeDeleteConfirm: () => {
    set({
      deleteConfirm: { isOpen: false, entries: [] },
    })
  },

  // Bookmark actions
  addBookmark: (name: string, path: string, isDirectory?: boolean) => {
    const { rootPath } = get()
    if (rootPath && !isWithinRoot(path, rootPath)) return
    set((state) => {
      const existing = state.settings.bookmarks.find(b => b.path === path)
      if (existing) return state
      const icon = isDirectory !== false
        ? 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'
        : 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
      return {
        settings: {
          ...state.settings,
          bookmarks: [
            ...state.settings.bookmarks,
            { name, path, icon, isDirectory: isDirectory !== false },
          ],
        },
      }
    })
  },

  removeBookmark: (path: string) => {
    set((state) => ({
      settings: {
        ...state.settings,
        bookmarks: state.settings.bookmarks.filter(b => b.path !== path),
      },
    }))
  },

  // Helpers
  getImageSrc: (path: string) => {
    return convertFileSrc(path)
  },

  getSortedEntries: () => {
    const { entries, settings } = get()
    const { sortConfig } = settings

    return [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }

      let comparison = 0
      switch (sortConfig.field) {
        case 'name':
          comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
          break
        case 'size':
          comparison = a.size - b.size
          break
        case 'mtime':
          comparison = a.mtime - b.mtime
          break
        case 'type':
          comparison = a.extension.localeCompare(b.extension)
          break
      }

      return sortConfig.direction === 'asc' ? comparison : -comparison
    })
  },

  getFilteredEntries: () => {
    const { getSortedEntries, settings, searchQuery } = get()
    let sorted = getSortedEntries()

    if (!settings.showHiddenFiles) {
      sorted = sorted.filter(entry => !isHiddenFile(entry.name))
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      sorted = sorted.filter(entry => entry.name.toLowerCase().includes(query))
    }

    return sorted
  },

  getSelectedFileEntries: () => {
    const { treeContents, selectedEntries } = get()
    // Search all loaded tree contents for selected entries
    const allEntries: FileEntry[] = []
    for (const entries of Object.values(treeContents)) {
      allEntries.push(...entries)
    }
    return allEntries.filter(e => selectedEntries.has(e.path))
  },

  // Tree view actions
  toggleDir: async (path: string) => {
    const { expandedDirs, rootPath } = get()
    if (rootPath && !isWithinRoot(path, rootPath)) return

    const newExpanded = new Set(expandedDirs)

    if (newExpanded.has(path)) {
      // Collapse
      newExpanded.delete(path)
      set({ expandedDirs: newExpanded })
    } else {
      // Expand - always read from disk for fresh contents
      newExpanded.add(path)
      try {
        const dirEntries = await readDir(path)
        const entries = await buildEntries(path, dirEntries)
        set((state) => ({
          expandedDirs: newExpanded,
          treeContents: { ...state.treeContents, [path]: entries },
        }))
      } catch (error) {
        console.error('Failed to load directory:', path, error)
        set({ error: `Failed to open directory: ${error}` })
      }
    }
  },

  expandToPath: async (targetPath: string) => {
    const { rootPath, treeContents } = get()
    if (!rootPath) return

    // Build ancestor chain from target up to root
    const ancestors: string[] = []
    let current = targetPath
    while (true) {
      try {
        const parent = await dirname(current)
        if (!parent || parent === current) break
        if (rootPath && !isWithinRoot(parent, rootPath)) break
        ancestors.unshift(parent)
        current = parent
        if (normalizePath(parent) === normalizePath(rootPath)) break
      } catch {
        break
      }
    }

    const newExpanded = new Set(get().expandedDirs)
    const newTreeContents: Record<string, FileEntry[]> = { ...treeContents }

    // Expand each ancestor and load its contents
    for (const ancestor of ancestors) {
      newExpanded.add(ancestor)
      if (!newTreeContents[ancestor]) {
        try {
          const dirEntries = await readDir(ancestor)
          const entries = await buildEntries(ancestor, dirEntries)
          newTreeContents[ancestor] = entries
        } catch (e) {
          console.error(`Failed to load dir: ${ancestor}`, e)
        }
      }
    }

    // Also check if target itself is a directory, and if so expand it too
    try {
      const targetStat = await stat(targetPath)
      if (targetStat.isDirectory) {
        newExpanded.add(targetPath)
        if (!newTreeContents[targetPath]) {
          const dirEntries = await readDir(targetPath)
          const entries = await buildEntries(targetPath, dirEntries)
          newTreeContents[targetPath] = entries
        }
      }
    } catch {
      // Target might be a file, that's fine
    }

    set({
      expandedDirs: newExpanded,
      treeContents: newTreeContents,
      highlightedEntry: targetPath,
    })

    // Auto-clear highlight after a few seconds
    setTimeout(() => {
      if (get().highlightedEntry === targetPath) {
        set({ highlightedEntry: null })
      }
    }, 3000)
  },

  collapseAll: () => {
    const { rootPath } = get()
    // Keep only root expanded
    set({ expandedDirs: new Set(rootPath ? [rootPath] : []) })
  },

  setHighlightedEntry: (path: string | null) => {
    set({ highlightedEntry: path })
  },

  getTreeEntriesFiltered: (dirPath: string) => {
    const { treeContents, settings, searchQuery } = get()
    let entries = treeContents[dirPath] || []

    // Sort: directories first, then alphabetically by name
    entries = [...entries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    // Filter hidden files
    if (!settings.showHiddenFiles) {
      entries = entries.filter(entry => !isHiddenFile(entry.name))
    }

    // Filter by search — only filter files, keep directories visible for navigation
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      entries = entries.filter(entry => entry.isDirectory || entry.name.toLowerCase().includes(query))
    }

    return entries
  },

  refreshDir: async (dirPath: string) => {
    const { expandedDirs } = get()
    if (!expandedDirs.has(dirPath)) return

    try {
      const dirEntries = await readDir(dirPath)
      const entries = await buildEntries(dirPath, dirEntries)
      // Use updater form to avoid overwriting concurrent treeContents changes
      set((state) => ({
        treeContents: { ...state.treeContents, [dirPath]: entries },
      }))
    } catch (error) {
      console.error('Failed to refresh dir:', dirPath, error)
    }
  },

  loadImageAsBlob: async (path: string) => {
    const bytes = await readFile(path)
    // Determine mime type from extension
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
    }
    const mime = mimeMap[ext] || 'image/png'
    const blob = new Blob([bytes], { type: mime })
    return URL.createObjectURL(blob)
  },
}))
