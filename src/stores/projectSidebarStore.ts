import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { coreJSONStorage } from '../lib/coreStorage'

export type ProjectSortBy = 'name' | 'recent' | 'created'
export type SortDir = 'asc' | 'desc'

interface ProjectSidebarState {
  isOpen: boolean
  isCollapsed: boolean
  width: number
  searchQuery: string
  dividerPercent: number
  sortBy: ProjectSortBy
  sortDir: SortDir
  hiddenProjectIds: string[]
  keepTerminalsAlive: boolean
  workspacesOnTop: boolean

  toggle: () => void
  open: () => void
  close: () => void
  setWidth: (width: number) => void
  toggleCollapse: () => void
  setSearchQuery: (query: string) => void
  setDividerPercent: (pct: number) => void
  setSortBy: (sortBy: ProjectSortBy) => void
  toggleSortDir: () => void
  hideProject: (id: string) => void
  unhideProject: (id: string) => void
  toggleProjectHidden: (id: string) => void
  setKeepTerminalsAlive: (keep: boolean) => void
  toggleWorkspacesOnTop: () => void
}

const MIN_WIDTH = 180
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 240

export const useProjectSidebarStore = create<ProjectSidebarState>()(
  persist(
    (set) => ({
      isOpen: true,
      isCollapsed: true,
      width: DEFAULT_WIDTH,
      searchQuery: '',
      dividerPercent: 60,
      sortBy: 'recent' as ProjectSortBy,
      sortDir: 'desc' as SortDir,
      hiddenProjectIds: [],
      keepTerminalsAlive: false,
      workspacesOnTop: true,

      toggle: () => set((s) => ({ isOpen: true, isCollapsed: !s.isCollapsed })),
      open: () => set({ isOpen: true, isCollapsed: false }),
      close: () => set({ isOpen: true, isCollapsed: true }),
      setWidth: (width) => set({ width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)) }),
      toggleCollapse: () => set((s) => ({ isCollapsed: !s.isCollapsed })),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setDividerPercent: (pct) => set({ dividerPercent: Math.max(20, Math.min(80, pct)) }),
      setSortBy: (sortBy) => set({ sortBy }),
      toggleSortDir: () => set((s) => ({ sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' })),
      hideProject: (id) => set((s) => ({
        hiddenProjectIds: s.hiddenProjectIds.includes(id) ? s.hiddenProjectIds : [...s.hiddenProjectIds, id],
      })),
      unhideProject: (id) => set((s) => ({
        hiddenProjectIds: s.hiddenProjectIds.filter((hid) => hid !== id),
      })),
      toggleProjectHidden: (id) => set((s) => ({
        hiddenProjectIds: s.hiddenProjectIds.includes(id)
          ? s.hiddenProjectIds.filter((hid) => hid !== id)
          : [...s.hiddenProjectIds, id],
      })),
      setKeepTerminalsAlive: (keepTerminalsAlive) => set({ keepTerminalsAlive }),
      toggleWorkspacesOnTop: () => set((s) => ({ workspacesOnTop: !s.workspacesOnTop })),
    }),
    {
      name: 'quadflow-project-sidebar',
      storage: coreJSONStorage,
      partialize: (state) => ({
        isCollapsed: state.isCollapsed,
        width: state.width,
        dividerPercent: state.dividerPercent,
        workspacesOnTop: state.workspacesOnTop,
        sortBy: state.sortBy,
        sortDir: state.sortDir,
        hiddenProjectIds: state.hiddenProjectIds,
        keepTerminalsAlive: state.keepTerminalsAlive,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<ProjectSidebarState>),
        isOpen: true, // Always visible — can only collapse, never hide
      }),
    }
  )
)
