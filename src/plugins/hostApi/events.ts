/**
 * `ctx.events` (plugin-system.md §6.5): host topics from the shell stores and
 * a plugin-to-plugin bus (`"<pluginId>:<topic>"`). UI-local; no permission.
 */
import type { Disposable, HostTopic, JsonValue } from '@quadflow/plugin-api'
import { onThemeChange } from '@quadflow/ui'
import { useProjectStore } from '../../stores/projectStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { onDataChanged } from '../../lib/core/events'

type Cb = (payload: JsonValue) => void
const bus = new Map<string, Set<Cb>>()

function on(key: string, cb: Cb): Disposable {
  let s = bus.get(key)
  if (!s) bus.set(key, (s = new Set()))
  s.add(cb)
  return () => s!.delete(cb)
}

function emit(key: string, payload: JsonValue) {
  bus.get(key)?.forEach((cb) => {
    try {
      cb(payload)
    } catch (e) {
      console.error(`[plugins] event handler for ${key} threw`, e)
    }
  })
}

/** Plugin event: `"<pluginId>:<topic>"`. */
export function emitPluginEvent(pluginId: string, topic: string, payload: JsonValue = null) {
  emit(`plugin:${pluginId}:${topic}`, payload)
}
export function onPluginEvent(pluginId: string, topic: string, cb: Cb): Disposable {
  return on(`plugin:${pluginId}:${topic}`, cb)
}

/** Host topic (also emitted by the loader for `plugin.activated` / `plugin.deactivated`). */
export function emitHostEvent(topic: HostTopic, payload: JsonValue = null) {
  emit(`host:${topic}`, payload)
}

let wired = false
function wireHostTopics() {
  if (wired) return
  wired = true
  useProjectStore.subscribe((s, prev) => {
    if (s.activeProject?.id !== prev.activeProject?.id) {
      const p = s.activeProject
      emitHostEvent('project.changed', p ? { id: p.id, name: p.name, root: p.workingDirectory } : null)
    }
  })
  useSessionStore.subscribe((s, prev) => {
    if (s.activeSession?.id !== prev.activeSession?.id) {
      const w = s.activeSession
      emitHostEvent('workspace.changed', w ? { id: w.id, name: w.name } : null)
    }
  })
  useTerminalStore.subscribe((s, prev) => {
    if (s.terminals === prev.terminals) return
    for (const id of s.terminals.keys()) if (!prev.terminals.has(id)) emitHostEvent('terminal.created', { id })
    for (const id of prev.terminals.keys()) if (!s.terminals.has(id)) emitHostEvent('terminal.exited', { id })
  })
  onThemeChange((t) => emitHostEvent('theme.changed', { mode: t.mode, preference: t.preference }))
  onDataChanged({ domain: 'settings' }, (e) => emitHostEvent('settings.changed', { ids: e.ids }))
}

export function onHostEvent(topic: HostTopic, cb: Cb): Disposable {
  wireHostTopics()
  return on(`host:${topic}`, cb)
}
