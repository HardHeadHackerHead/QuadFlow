import { syncAgentContext } from '../lib/core/agents'
import { create } from 'zustand'
import { Project, DefaultWorkspaceConfig } from '../types'
import * as appData from '../lib/appData'
import { useTerminalStore } from './terminalStore'
import { scaffoldProjectProviders } from '../agents/providerRegistry'
import { useAppSettingsStore } from './appSettingsStore'
import { resolveDefaultWorkingDir, onDataChanged } from '../lib/core'

/**
 * Working-directory projects (data-layer.md §7 `projects`). Persistence is the
 * core app DB: paths are deduplicated by their normalized root key, and the
 * active project is the core setting `shell.activeProjectId`.
 *
 * `setActiveProject` only activates a project and reloads project-scoped
 * data; switching the terminal layout along with it is the workspace
 * controller's job (`switchProject` in lib/workspaceSave.ts).
 */
interface ProjectState {
  projects: Project[]
  activeProject: Project | null
  isLoading: boolean

  loadProjects: () => Promise<void>
  loadActiveProject: () => Promise<void>
  createProject: (name: string, workingDirectory: string) => Promise<Project>
  setActiveProject: (project: Project) => Promise<Project>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name'>>) => Promise<void>
  setDefaultWorkspaceConfig: (projectId: string, config: DefaultWorkspaceConfig | null) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  findOrCreateProject: (workingDirectory: string) => Promise<Project>
  touchProject: (id: string) => Promise<void>
  initChangeListener: () => () => void
}

function reloadProjectScopedData(project: Project) {
  // Issues / plans / ideas reload in their plugins (collections follow `project.onDidChange`).
  useAppSettingsStore.getState().loadContextModules(project.workingDirectory)
}

function upsert(list: Project[], p: Project): Project[] {
  const rest = list.filter((x) => x.id !== p.id)
  return [p, ...rest]
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProject: null,
  isLoading: false,

  loadProjects: async () => {
    set({ isLoading: true })
    try {
      const projects = await appData.listProjects()
      const activeId = get().activeProject?.id
      set({ projects: projects.map((p) => ({ ...p, isActive: p.id === activeId })), isLoading: false })
    } catch (error) {
      console.error('Failed to load projects:', error)
      set({ isLoading: false })
    }
  },

  loadActiveProject: async () => {
    set({ isLoading: true })
    try {
      const [projects, activeProject] = await Promise.all([appData.listProjects(), appData.getActiveProject()])
      set({ projects, activeProject, isLoading: false })
      if (activeProject) reloadProjectScopedData(activeProject)
    } catch (error) {
      console.error('Failed to load active project:', error)
      set({ projects: [], activeProject: null, isLoading: false })
    }
  },

  createProject: async (name: string, workingDirectory: string) => {
    let project = await appData.registerProject(workingDirectory)
    if (name && name !== project.name) project = await appData.updateProject(project.id, { name })
    set({ projects: upsert(get().projects, project) })
    return project
  },

  setActiveProject: async (project: Project) => {
    // Registers (idempotent), initializes the project folder if needed, and
    // records it as active in the core.
    const opened = await appData.openProject(project.workingDirectory)
    useTerminalStore.getState().setGlobalWorkingDirectory(opened.workingDirectory)
    // The core has activated it: publish it at once. Plugins (`ctx.project.current()`, e.g. the
    // editor resolving an absolute path against the project root) and the UI must not see the
    // previous project, or none at startup, while the provider scaffolds below are written.
    const active = { ...opened, isActive: true }
    set({
      projects: upsert(get().projects.map((p) => ({ ...p, isActive: false })), active),
      activeProject: active,
    })
    // Agent provider scaffolds (manifest `scaffold`): missing files only.
    try {
      await scaffoldProjectProviders(opened.workingDirectory)
    } catch (error) {
      console.error('Failed to scaffold agent provider config:', error)
    }
    // Agent context files (each provider's `contextFile`): managed region from ProjectConfig.agentContext.
    syncAgentContext(opened.workingDirectory).catch((error) => console.error('Failed to sync agent context files:', error))
    reloadProjectScopedData(active)
    return active
  },

  updateProject: async (id, updates) => {
    const updated = await appData.updateProject(id, { name: updates.name })
    const isActive = get().activeProject?.id === id
    const p = { ...updated, isActive }
    set({
      projects: get().projects.map((x) => (x.id === id ? p : x)),
      ...(isActive ? { activeProject: p } : {}),
    })
  },

  setDefaultWorkspaceConfig: async (projectId, config) => {
    const updated = await appData.updateProject(projectId, { defaultWorkspaceConfig: config })
    const isActive = get().activeProject?.id === projectId
    const p = { ...updated, isActive }
    set({
      projects: get().projects.map((x) => (x.id === projectId ? p : x)),
      ...(isActive ? { activeProject: p } : {}),
    })
  },

  deleteProject: async (id) => {
    await appData.removeProject(id)
    const projects = get().projects.filter((p) => p.id !== id)
    set(get().activeProject?.id === id ? { projects, activeProject: null } : { projects })
  },

  findOrCreateProject: async (requestedDirectory: string) => {
    // Never invent a directory here (and never the real home folder in dev):
    // an empty request resolves to the core's default working dir.
    const workingDirectory = requestedDirectory?.trim()
      ? requestedDirectory
      : await resolveDefaultWorkingDir()
    // Dedupe by normalized path happens in the core (`C:\Foo` == `c:/foo/`).
    const project = await appData.registerProject(workingDirectory)
    const known = get().projects.some((p) => p.id === project.id)
    const isActive = get().activeProject?.id === project.id
    const p = { ...project, isActive }
    set({ projects: known ? get().projects.map((x) => (x.id === p.id ? p : x)) : [p, ...get().projects] })
    return p
  },

  touchProject: async (id) => {
    await appData.touchProject(id)
    await get().loadProjects()
  },

  // Refresh the list when another window / the CLI changes the registry.
  initChangeListener: () =>
    onDataChanged({ domain: 'projects' }, () => { void get().loadProjects() }),
}))
