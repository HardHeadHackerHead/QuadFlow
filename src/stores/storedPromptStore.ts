import { create } from 'zustand'
import { StoredPrompt } from '../types'
import * as appData from '../lib/appData'
import { onDataChanged } from '../lib/core'

interface StoredPromptStore {
  prompts: StoredPrompt[]
  isLoading: boolean

  loadPrompts: (silent?: boolean) => Promise<void>
  addPrompt: (prompt: { name: string; content: string; category?: string }) => Promise<StoredPrompt>
  updatePrompt: (id: string, updates: Partial<{ name: string; content: string; category: string }>) => Promise<void>
  deletePrompt: (id: string) => Promise<void>
  initChangeListener: () => Promise<() => void>
}

export const useStoredPromptStore = create<StoredPromptStore>((set, get) => ({
  prompts: [],
  isLoading: false,

  loadPrompts: async (silent = false) => {
    if (!silent) set({ isLoading: true })
    try {
      const prompts = await appData.listStoredPrompts()
      set({ prompts, isLoading: false })
    } catch (error) {
      console.error('Failed to load stored prompts:', error)
      set({ isLoading: false })
    }
  },

  addPrompt: async (prompt) => {
    const newPrompt = await appData.upsertStoredPrompt(prompt)
    set((state) => ({ prompts: [newPrompt, ...state.prompts] }))
    return newPrompt
  },

  updatePrompt: async (id, updates) => {
    const current = get().prompts.find((p) => p.id === id)
    if (!current) return
    const saved = await appData.upsertStoredPrompt({
      id,
      name: updates.name ?? current.name,
      content: updates.content ?? current.content,
      category: 'category' in updates ? updates.category : current.category,
    })
    set((state) => ({ prompts: state.prompts.map((p) => (p.id === id ? saved : p)) }))
  },

  deletePrompt: async (id) => {
    await appData.deleteStoredPrompt(id)
    set((state) => ({ prompts: state.prompts.filter((p) => p.id !== id) }))
  },

  initChangeListener: async () => {
    // Any window / the CLI may change prompts: reload silently.
    return onDataChanged({ domain: 'stored_prompts' }, () => { void get().loadPrompts(true) })
  },
}))
