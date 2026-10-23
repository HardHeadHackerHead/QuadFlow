import { useSyncExternalStore } from 'react'
import { usePluginContext } from '@quadflow/plugin-api'

/** The active project's root ('' without a project); re-renders on project switches. */
export function useProjectRoot(): string {
  const ctx = usePluginContext()
  return useSyncExternalStore(
    (cb) => ctx.project.onDidChange(cb),
    () => ctx.project.current()?.root ?? '',
  )
}
