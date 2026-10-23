import { create } from 'zustand'

interface CommandPaletteStore {
  isOpen: boolean
  initialFilter: string
  open: (filter?: string) => void
  close: () => void
  toggle: () => void
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set, get) => ({
  isOpen: false,
  initialFilter: '',

  open: (filter = '') => {
    set({ isOpen: true, initialFilter: filter })
  },

  close: () => {
    set({ isOpen: false, initialFilter: '' })
  },

  toggle: () => {
    const { isOpen } = get()
    if (isOpen) {
      set({ isOpen: false, initialFilter: '' })
    } else {
      set({ isOpen: true, initialFilter: '' })
    }
  },
}))
