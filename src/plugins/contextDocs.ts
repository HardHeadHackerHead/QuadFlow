/**
 * Agent context docs contributed by plugins (plugin-system.md §9.3).
 *
 * The core context registry already includes every active plugin's
 * `agentContextDocs`. On plugin enable, docs marked `default: true` are only
 * *suggested* for the active project — one toast per doc with an "Add"
 * action — never silently written into a (possibly git-tracked) context file.
 */
import { toast } from '@quadflow/ui'
import { getAgentContext, setAgentContextModule } from '../lib/core/agents'
import { useProjectStore } from '../stores/projectStore'
import { ensureToaster } from './hostApi/hostLayer'
import type { PluginInfo_Serialize } from '../generated/bindings'

/** Context-module id of a plugin doc: `<pluginId>` or `<pluginId>.<docId>`. */
export function pluginDocModuleId(pluginId: string, docId: string): string {
  return docId === pluginId ? pluginId : `${pluginId}.${docId}`
}

/** After enabling `pluginId`: offer its default docs for the active project. */
export async function suggestPluginContextDocs(pluginId: string, manifest: PluginInfo_Serialize['manifest']): Promise<void> {
  const docs = (manifest?.contributes?.agentContextDocs ?? []).filter((d) => d.default)
  const root = useProjectStore.getState().activeProject?.workingDirectory
  if (docs.length === 0 || !root) return
  let state
  try {
    state = await getAgentContext(root)
  } catch (e) {
    console.warn('[plugins] could not read the agent context:', e)
    return
  }
  for (const d of docs) {
    const id = pluginDocModuleId(pluginId, d.id)
    const mod = state.modules.find((m) => m.module.id === id)
    if (!mod || mod.enabled) continue
    // The toast stack is mounted lazily (first plugin toast); make sure it exists.
    ensureToaster()
    toast({
      message: `Add ${d.title} docs to this project's agent context?`,
      duration: 12_000,
      action: {
        label: 'Add',
        onClick: () => {
          setAgentContextModule(root, id, true).then(
            () => toast({ kind: 'success', message: `Added ${d.title} to the agent context` }),
            (e: unknown) => toast({ kind: 'error', message: `Could not add ${d.title}: ${e instanceof Error ? e.message : String(e)}` }),
          )
        },
      },
    })
  }
}
