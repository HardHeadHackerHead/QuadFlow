import { create } from 'zustand'
import { TitleSettings } from '../types'

/**
 * Shell settings of automatic terminal titles. Who generates a title is
 * decided per call in `src/lib/titles.ts`; local models are the optional
 * `local-titles` plugin and keep their own settings.
 */
interface TitleSettingsStore {
  settings: TitleSettings
  loadSettings: () => void
  setEnabled: (enabled: boolean) => void
  updateSettings: (updates: Partial<TitleSettings>) => void
}

const STORAGE_KEY = 'quadflow-title-settings'

export const DEFAULT_TITLE_SETTINGS: TitleSettings = {
  enabled: false,
  min_words: 3,
  max_words: 6,
  api_model: '',
  summaryPollIntervalSeconds: 60,
}

function pick(raw: Record<string, unknown>): Partial<TitleSettings> {
  const out: Partial<TitleSettings> = {}
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.min_words === 'number') out.min_words = raw.min_words
  if (typeof raw.max_words === 'number') out.max_words = raw.max_words
  if (typeof raw.api_model === 'string') out.api_model = raw.api_model
  if (typeof raw.summaryPollIntervalSeconds === 'number') out.summaryPollIntervalSeconds = raw.summaryPollIntervalSeconds
  return out
}

function save(settings: TitleSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch (error) {
    console.error('Failed to save title settings:', error)
  }
}

export const useTitleSettingsStore = create<TitleSettingsStore>((set, get) => ({
  settings: { ...DEFAULT_TITLE_SETTINGS },

  loadSettings: () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        set({ settings: { ...DEFAULT_TITLE_SETTINGS, ...pick(JSON.parse(stored)) } })
        return
      }
    } catch (error) {
      console.error('Failed to load title settings:', error)
    }
    set({ settings: { ...DEFAULT_TITLE_SETTINGS } })
  },

  setEnabled: (enabled: boolean) => {
    const settings = { ...get().settings, enabled }
    set({ settings })
    save(settings)
  },

  updateSettings: (updates: Partial<TitleSettings>) => {
    const settings = { ...get().settings, ...updates }
    set({ settings })
    save(settings)
  },
}))

if (typeof window !== 'undefined') {
  useTitleSettingsStore.getState().loadSettings()
}
