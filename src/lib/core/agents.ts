/**
 * Agent framework in the core (agent-providers.md §8.1): providers, models
 * (catalog ∪ custom), session discovery, project context files.
 */
import { create } from 'zustand'
import {
  commands,
  events,
  type AgentContextState,
  type AgentModelInfo,
  type AgentProviderInfo,
  type AgentRestoreEntry,
  type AgentCatalogStatus,
  type ContextSyncReport,
} from '../../generated/bindings'
import { call } from './index'
import { onDataChanged } from './events'

export function listAgentProviders(): Promise<AgentProviderInfo[]> {
  return call(commands.agentsProviders())
}

// ---- models ----

interface AgentModelsState {
  /** providerId → `system-default` ++ catalog ++ custom models. */
  models: Record<string, AgentModelInfo[]>
  load: (providerId: string) => Promise<AgentModelInfo[]>
  reloadAll: () => Promise<void>
}

const inflight = new Map<string, Promise<AgentModelInfo[]>>()

export const useAgentModelsStore = create<AgentModelsState>((set, get) => ({
  models: {},
  load: (providerId) => {
    const existing = inflight.get(providerId)
    if (existing) return existing
    const p = (async () => {
      try {
        const list = await call(commands.agentsModels(providerId))
        set((s) => ({ models: { ...s.models, [providerId]: list } }))
        return list
      } finally {
        inflight.delete(providerId)
      }
    })()
    inflight.set(providerId, p)
    return p
  },
  reloadAll: async () => {
    await Promise.all(Object.keys(get().models).map((id) => get().load(id).catch(() => undefined)))
  },
}))

let modelListenersStarted = false

/** Keep the model lists fresh: catalog updates and `agents/*` settings changes. */
export function initAgentModelListeners(): void {
  if (modelListenersStarted) return
  modelListenersStarted = true
  void events.agentCatalogUpdated.listen(() => void useAgentModelsStore.getState().reloadAll())
  onDataChanged({ domain: 'settings' }, (e) => {
    if (e.ids.some((id) => id.startsWith('agents/customModels.') || id.startsWith('agents/defaultModel.'))) {
      void useAgentModelsStore.getState().reloadAll()
    }
  })
}

export function refreshAgentCatalog(): Promise<AgentCatalogStatus> {
  return call(commands.agentsCatalogRefresh())
}

export function agentCatalogStatus(): Promise<AgentCatalogStatus> {
  return call(commands.agentsCatalogStatus())
}

// ---- sessions ----

export async function restoreAgentSessions(entries: AgentRestoreEntry[]): Promise<void> {
  if (entries.length === 0) return
  await call(commands.agentsRestore(entries))
}

export function agentTerminalClosed(terminalId: string): Promise<null> {
  return call(commands.agentsTerminalClosed(terminalId))
}

// ---- project context (§7) ----

export function getAgentContext(projectRoot: string): Promise<AgentContextState> {
  return call(commands.agentsContextGet(projectRoot))
}

export function setAgentContextModule(projectRoot: string, module: string, enabled: boolean): Promise<AgentContextState> {
  return call(commands.agentsContextSetModule(projectRoot, module, enabled))
}

export function resetAgentContext(projectRoot: string): Promise<AgentContextState> {
  return call(commands.agentsContextReset(projectRoot))
}

export function setAgentContextFiles(projectRoot: string, files: string[]): Promise<AgentContextState> {
  return call(commands.agentsContextSetFiles(projectRoot, files))
}

/** Project open: rewrite managed regions; first open initialises the file list. */
export async function syncAgentContext(projectRoot: string): Promise<ContextSyncReport> {
  return call(commands.agentsContextSync(projectRoot, true))
}
