/**
 * Shell integrations with optional (installable) first-party plugins, e.g. the agent launch
 * dialog's related sessions from `semantic-search`. The shell never imports a plugin: it asks
 * the registry whether the plugin is installed and active, and talks to it only through the
 * plugin's declared commands (`runPluginCommand`).
 */
import { useEffect } from 'react'
import { ensurePluginRegistry, usePluginRegistry } from './registry'

/** True while plugin `id` is installed, enabled and active. */
export function useOptionalPlugin(id: string): boolean {
  useEffect(() => {
    void ensurePluginRegistry()
  }, [])
  return usePluginRegistry((s) => {
    const p = s.plugins.find((x) => x.id === id)
    return !!p && p.enabled && p.status.kind === 'active'
  })
}
