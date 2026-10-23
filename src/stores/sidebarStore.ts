import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { coreJSONStorage } from '../lib/coreStorage'

interface SidebarState {
  isOpen: boolean
  isCollapsed: boolean
  side: 'left' | 'right'
  width: number

  toggle: () => void
  open: () => void
  close: () => void
  setSide: (side: 'left' | 'right') => void
  setWidth: (width: number) => void
  toggleCollapse: () => void
}

const MIN_WIDTH = 180
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 260

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      isOpen: true,
      isCollapsed: true,
      side: 'left',
      width: DEFAULT_WIDTH,

      toggle: () => set((s) => ({ isOpen: true, isCollapsed: !s.isCollapsed })),
      open: () => set({ isOpen: true, isCollapsed: false }),
      close: () => set({ isOpen: true, isCollapsed: true }),
      setSide: (side) => set({ side }),
      setWidth: (width) => set({ width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)) }),
      toggleCollapse: () => set((s) => ({ isCollapsed: !s.isCollapsed })),
    }),
    {
      name: 'quadflow-sidebar',
      storage: coreJSONStorage,
      partialize: (state) => ({
        isCollapsed: state.isCollapsed,
        side: state.side,
        width: state.width,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<SidebarState>),
        isOpen: true, // Always visible — can only collapse, never hide
      }),
    }
  )
)
