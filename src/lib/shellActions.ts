/**
 * Small shell actions shared by the command palette, the empty workspace
 * state and onboarding.
 */
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useProjectStore } from '../stores/projectStore'
import { settingsApi, terminalApi } from './tauri-api'
import type { Project } from '../types'

/** New terminal tile in the active project's working directory (default environment). */
export async function openNewTerminal(): Promise<void> {
  const { environments } = useAppSettingsStore.getState()
  const defaultEnv = environments.defaultEnvironmentId
    ? environments.terminalEnvironments.find((e) => e.id === environments.defaultEnvironmentId)
    : undefined
  const shell = defaultEnv?.shell !== 'default' ? (defaultEnv?.shell as 'cmd' | 'powershell' | 'bash' | undefined) : undefined
  const info = await terminalApi.create({
    cwd: useTerminalStore.getState().globalWorkingDirectory,
    shell,
    initCommands: defaultEnv?.initCommands,
  })
  useTerminalStore.getState().addTerminal(info)
}

declare global {
  interface Window {
    /** Test hook (GUI harness): replaces the native folder picker. */
    __QF_TEST_PICK_FOLDER__?: () => string | null | Promise<string | null>
  }
}

/** Native folder picker (the dialog can also create a new folder); the GUI harness can stub it. */
export async function pickProjectFolder(): Promise<string | null> {
  if (window.__QF_TEST_PICK_FOLDER__) return window.__QF_TEST_PICK_FOLDER__()
  return settingsApi.pickDirectory()
}

/**
 * Open a directory as the active project (core `projects_open`, initializing
 * its project folder) and switch the workspace to it. `applyDefault: false`
 * skips the default workspace template (no agent auto-launch) for a project
 * opened for the first time.
 */
export async function openProjectDirectory(dir: string, opts: { applyDefault?: boolean } = {}): Promise<Project> {
  const project = await useProjectStore.getState().findOrCreateProject(dir)
  const { switchProject } = await import('./workspaceSave')
  await switchProject(project, opts)
  return useProjectStore.getState().activeProject ?? project
}

/** Pick a folder and open it; `null` when the picker was cancelled. */
export async function pickAndOpenProject(): Promise<Project | null> {
  const dir = await pickProjectFolder()
  if (!dir) return null
  return openProjectDirectory(dir)
}
