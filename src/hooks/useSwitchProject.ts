import { useCallback } from 'react'
import { useProjectStore } from '../stores/projectStore'
import { settingsApi } from '../lib/tauri-api'
import { switchProject } from '../lib/workspaceSave'
import type { Project } from '../types'

/**
 * Project switching for UI components. The whole flow (save current workspace,
 * tear down, activate project, restore its workspace) is one exclusive,
 * generation-checked transition in lib/workspaceSave.ts.
 */
export function useSwitchProject() {
  const findOrCreateProject = useProjectStore((s) => s.findOrCreateProject)

  const switchToProject = useCallback(async (project: Project) => {
    await switchProject(project)
  }, [])

  const handleOpenFolder = useCallback(async () => {
    const dir = await settingsApi.pickDirectory()
    if (!dir) return
    const project = await findOrCreateProject(dir)
    await switchProject(project)
  }, [findOrCreateProject])

  return { switchToProject, handleOpenFolder }
}
