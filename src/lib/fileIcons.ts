// File icon mapping utility for File Explorer
import { FileCategory } from '../types/fileExplorer'

// Extension to category mapping
const EXTENSION_CATEGORIES: Record<string, FileCategory> = {
  // Images
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.bmp': 'image',
  '.avif': 'image',
  '.tiff': 'image',
  '.tif': 'image',

  // Code
  '.js': 'code',
  '.jsx': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.rs': 'code',
  '.go': 'code',
  '.java': 'code',
  '.c': 'code',
  '.cpp': 'code',
  '.cc': 'code',
  '.h': 'code',
  '.hpp': 'code',
  '.cs': 'code',
  '.php': 'code',
  '.swift': 'code',
  '.kt': 'code',
  '.scala': 'code',
  '.vue': 'code',
  '.svelte': 'code',
  '.html': 'code',
  '.htm': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.sass': 'code',
  '.less': 'code',
  '.json': 'code',
  '.xml': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.ps1': 'code',
  '.bat': 'code',
  '.cmd': 'code',
  '.sql': 'code',
  '.graphql': 'code',
  '.gql': 'code',
  '.lua': 'code',
  '.r': 'code',
  '.pl': 'code',
  '.pm': 'code',
  '.ex': 'code',
  '.exs': 'code',
  '.erl': 'code',
  '.hrl': 'code',
  '.hs': 'code',
  '.elm': 'code',
  '.clj': 'code',
  '.cljs': 'code',
  '.cljc': 'code',
  '.lisp': 'code',
  '.scm': 'code',
  '.rkt': 'code',
  '.asm': 'code',
  '.s': 'code',
  '.f': 'code',
  '.f90': 'code',
  '.f95': 'code',
  '.wasm': 'code',

  // Documents
  '.txt': 'document',
  '.md': 'document',
  '.markdown': 'document',
  '.rst': 'document',
  '.rtf': 'document',
  '.doc': 'document',
  '.docx': 'document',
  '.odt': 'document',
  '.pdf': 'document',
  '.xls': 'document',
  '.xlsx': 'document',
  '.ods': 'document',
  '.ppt': 'document',
  '.pptx': 'document',
  '.odp': 'document',
  '.tex': 'document',
  '.org': 'document',
  '.wiki': 'document',

  // Archives
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.bz2': 'archive',
  '.xz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.tgz': 'archive',
  '.tbz2': 'archive',
  '.cab': 'archive',
  '.iso': 'archive',
  '.dmg': 'archive',

  // Audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.aac': 'audio',
  '.m4a': 'audio',
  '.wma': 'audio',
  '.aiff': 'audio',
  '.ape': 'audio',
  '.alac': 'audio',
  '.mid': 'audio',
  '.midi': 'audio',

  // Video
  '.mp4': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.mov': 'video',
  '.wmv': 'video',
  '.flv': 'video',
  '.webm': 'video',
  '.m4v': 'video',
  '.mpg': 'video',
  '.mpeg': 'video',
  '.3gp': 'video',
  '.ogv': 'video',

  // Data
  '.csv': 'data',
  '.tsv': 'data',
  '.db': 'data',
  '.sqlite': 'data',
  '.sqlite3': 'data',
  '.mdb': 'data',
  '.accdb': 'data',
  '.parquet': 'data',
  '.avro': 'data',
  '.ndjson': 'data',
  '.jsonl': 'data',

  // Executables
  '.exe': 'executable',
  '.msi': 'executable',
  '.app': 'executable',
  '.apk': 'executable',
  '.deb': 'executable',
  '.rpm': 'executable',
  '.appimage': 'executable',
  '.dll': 'executable',
  '.so': 'executable',
  '.dylib': 'executable',
}

// Category to icon SVG path mapping
const CATEGORY_ICONS: Record<FileCategory, string> = {
  folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  image: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  document: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  archive: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  audio: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3',
  video: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  data: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
  executable: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
  unknown: 'M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
}

// Category to color mapping
const CATEGORY_COLORS: Record<FileCategory, string> = {
  folder: 'text-amber-400',
  image: 'text-purple-400',
  code: 'text-cyan-400',
  document: 'text-blue-400',
  archive: 'text-orange-400',
  audio: 'text-green-400',
  video: 'text-red-400',
  data: 'text-emerald-400',
  executable: 'text-rose-400',
  unknown: 'text-gray-400',
}

/**
 * Get the file category based on extension
 */
export function getFileCategory(extension: string, isDirectory: boolean): FileCategory {
  if (isDirectory) return 'folder'
  const ext = extension.toLowerCase()
  return EXTENSION_CATEGORIES[ext] || 'unknown'
}

/**
 * Get the SVG path for a file icon based on category
 */
export function getFileIconPath(category: FileCategory): string {
  return CATEGORY_ICONS[category]
}

/**
 * Get the color class for a file category
 */
export function getFileIconColor(category: FileCategory): string {
  return CATEGORY_COLORS[category]
}

/**
 * Get icon info for a file entry
 */
export function getFileIcon(extension: string, isDirectory: boolean): {
  path: string
  color: string
  category: FileCategory
} {
  const category = getFileCategory(extension, isDirectory)
  return {
    path: getFileIconPath(category),
    color: getFileIconColor(category),
    category,
  }
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '-'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unitIndex = 0
  let size = bytes

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  // Show 0 decimals for bytes/KB, 1 for MB+
  const decimals = unitIndex < 2 ? 0 : 1
  return `${size.toFixed(decimals)} ${units[unitIndex]}`
}

/**
 * Format timestamp for display
 */
export function formatFileDate(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } else if (diffDays === 1) {
    return 'Yesterday'
  } else if (diffDays < 7) {
    return `${diffDays} days ago`
  } else {
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
}
