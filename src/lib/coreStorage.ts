/**
 * zustand `persist` storage backed by core settings (namespace `shell`, key
 * `store:<name>`) instead of localStorage (data-layer.md §7.2). Async: the
 * persisted state is rehydrated shortly after the store is created.
 */
import { createJSONStorage, type StateStorage } from 'zustand/middleware'
import * as appData from './appData'
import type { JsonValue } from '../generated/bindings'

const NS = 'shell'
const keyOf = (name: string) => `store:${name}`

const coreStateStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const v = await appData.getSetting<JsonValue>(NS, keyOf(name))
      return v === undefined ? null : JSON.stringify(v)
    } catch {
      return null
    }
  },
  setItem: async (name, value) => {
    try {
      await appData.setSetting(NS, keyOf(name), JSON.parse(value) as JsonValue)
    } catch (e) {
      console.error(`[coreStorage] save ${name} failed:`, e)
    }
  },
  removeItem: async (name) => {
    try { await appData.deleteSetting(NS, keyOf(name)) } catch { /* ignore */ }
  },
}

export const coreJSONStorage = createJSONStorage(() => coreStateStorage)
