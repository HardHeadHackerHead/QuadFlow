// File Explorer and Image Viewer type definitions

// Supported image file extensions
export const IMAGE_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif'
] as const

// Text-viewable file extensions
export const TEXT_EXTENSIONS = [
  // Code
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.cc',
  '.h', '.hpp', '.cs', '.php', '.swift', '.kt', '.scala', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.lua', '.r', '.pl', '.pm',
  '.ex', '.exs', '.erl', '.hrl', '.hs', '.elm', '.clj', '.cljs', '.cljc',
  '.lisp', '.scm', '.rkt', '.asm', '.s', '.f', '.f90', '.f95',
  // Documents
  '.txt', '.md', '.markdown', '.rst', '.rtf', '.tex', '.org', '.wiki',
  '.log', '.ini', '.cfg', '.conf', '.env', '.gitignore', '.dockerignore',
  '.editorconfig', '.prettierrc', '.eslintrc', '.babelrc',
  // Data
  '.csv', '.tsv', '.ndjson', '.jsonl',
] as const

// File categories for icons and grouping
export type FileCategory =
  | 'folder'
  | 'image'
  | 'code'
  | 'document'
  | 'archive'
  | 'audio'
  | 'video'
  | 'data'
  | 'executable'
  | 'unknown'

// Represents a file or directory entry
export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number  // in bytes, 0 for directories
  mtime: number // modification time as unix timestamp
  category: FileCategory
  extension: string // lowercase extension including dot, e.g. '.txt'
}

// View modes for the file list
export type ViewMode = 'list' | 'grid' | 'thumbnails'

// Sort field options
export type SortField = 'name' | 'size' | 'mtime' | 'type'

// Sort configuration
export interface SortConfig {
  field: SortField
  direction: 'asc' | 'desc'
}

// Fit modes for image viewer
export type ImageFitMode = 'contain' | 'cover' | 'actual'

// Image viewer state
export interface ImageViewerState {
  isOpen: boolean
  currentImage: FileEntry | null
  zoom: number  // 1 = 100%, 0.5 = 50%, 2 = 200%
  fitMode: ImageFitMode
  // All images in current directory for navigation
  imageList: FileEntry[]
  currentIndex: number
}

// Text viewer/editor state
export interface TextViewerState {
  isOpen: boolean
  entry: FileEntry | null
  content: string
  originalContent: string
  isEditing: boolean
  isSaving: boolean
  isLoading: boolean
  error: string | null
  isDirty: boolean
  splitRatio: number // 0-1, fraction of width for file list when editor is open
}

// Context menu state
export interface ContextMenuState {
  isOpen: boolean
  x: number
  y: number
  targetEntry: FileEntry | null // null = right-clicked empty space
}

// Clipboard state for copy/cut operations
export interface ClipboardState {
  entries: FileEntry[]
  operation: 'copy' | 'cut' | null
}

// Dialog states
export interface RenameDialogState {
  isOpen: boolean
  entry: FileEntry | null
  newName: string
}

export interface NewItemDialogState {
  isOpen: boolean
  type: 'file' | 'folder'
  name: string
}

export interface DeleteConfirmState {
  isOpen: boolean
  entries: FileEntry[]
}

// Quick access location
export interface QuickAccessLocation {
  name: string
  path: string
  icon: string // SVG path
  isDirectory?: boolean
}

// File explorer settings (persisted)
export interface FileExplorerSettings {
  lastVisitedPath: string
  viewMode: ViewMode
  sortConfig: SortConfig
  showHiddenFiles: boolean
  // Thumbnail size for grid/thumbnail views (px)
  thumbnailSize: number
  // Quick access bookmarks (user-added)
  bookmarks: QuickAccessLocation[]
  // Show quick access sidebar
  showSidebar: boolean
}

// Default settings
export const DEFAULT_FILE_EXPLORER_SETTINGS: FileExplorerSettings = {
  lastVisitedPath: '',
  viewMode: 'list',
  sortConfig: {
    field: 'name',
    direction: 'asc',
  },
  showHiddenFiles: false,
  thumbnailSize: 120,
  bookmarks: [],
  showSidebar: true,
}

// Navigation history entry
export interface NavigationEntry {
  path: string
  timestamp: number
}

// Check if a file is an image based on extension
export function isImageFile(entry: FileEntry): boolean {
  if (entry.isDirectory) return false
  return IMAGE_EXTENSIONS.includes(entry.extension.toLowerCase() as typeof IMAGE_EXTENSIONS[number])
}

// Check if a file can be opened as text
export function isTextFile(entry: FileEntry): boolean {
  if (entry.isDirectory) return false
  const ext = entry.extension.toLowerCase()
  // Check known text extensions
  if (TEXT_EXTENSIONS.includes(ext as typeof TEXT_EXTENSIONS[number])) return true
  // Files without extensions are often text (README, LICENSE, Makefile, etc.)
  if (!ext || ext === '.') return true
  return false
}

// Check if a file is an env/secrets file based on name
export function isEnvFile(entry: FileEntry): boolean {
  if (entry.isDirectory) return false
  const name = entry.name.toLowerCase()
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env')
}

// Check if a filename is hidden (starts with .)
export function isHiddenFile(name: string): boolean {
  return name.startsWith('.')
}

// Max file size for text viewer (5MB)
export const MAX_TEXT_FILE_SIZE = 5 * 1024 * 1024
