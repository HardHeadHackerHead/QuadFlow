// Mosaic layout type definitions for flexible terminal layouts

// Re-export MosaicNode types from react-mosaic-component
export type { MosaicNode, MosaicBranch, MosaicDirection } from 'react-mosaic-component'

// Layout state for the terminal store
export interface LayoutState {
  layoutTree: import('react-mosaic-component').MosaicNode<string> | null
  minimizedTerminals: string[]
}

// Saved layout format for database persistence
export interface SavedLayout {
  layoutTree: string | null // JSON stringified MosaicNode
  minimizedTerminals: string[] // Array of terminal IDs
}
