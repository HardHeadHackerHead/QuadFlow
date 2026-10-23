import { create } from 'zustand'
import { Session, SessionTerminal, SessionToolInstance, LayoutType, ToolbarSection } from '../types'
import * as appData from '../lib/appData'
import { useProjectStore } from './projectStore'

/**
 * Workspaces ("sessions" in the shell) — persisted in the core app DB
 * (data-layer.md §7 `workspaces`, `workspace_terminals`, `tile_instances`).
 *
 * Switching workspaces (save → tear down → activate → restore) is done by the
 * workspace controller in lib/workspaceSave.ts; this store only holds the
 * list and the active workspace and talks to the core.
 */
interface SessionStore {
  sessions: Session[]
  activeSession: Session | null
  isLoading: boolean
  showSessionModal: boolean
  isDirty: boolean
  lastSavedAt: number | null

  // Actions
  loadSessions: () => Promise<void>
  createSession: (name: string, workingDirectory: string, layout: LayoutType, projectId?: string) => Promise<Session>
  setActiveSession: (session: Session) => Promise<void>
  updateSession: (id: string, updates: Partial<Pick<Session, 'name' | 'pinned' | 'pinOrder' | 'pinSection'>>) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  /** Persist a workspace's state (one core transaction). `sessionId` is captured by the caller. */
  saveSessionState: (sessionId: string, terminals: SessionTerminal[], tools: SessionToolInstance[], layoutTree: string | null) => Promise<void>
  loadSessionState: (sessionId: string) => Promise<appData.LoadedWorkspace>
  setShowSessionModal: (show: boolean) => void
  markDirty: () => void
  markClean: () => void

  // Workspace pinning
  toggleWorkspacePinned: (sessionId: string) => Promise<void>
  getPinnedWorkspaces: (projectId?: string | null) => Session[]
  updateWorkspacePinSection: (sessionId: string, section: ToolbarSection) => Promise<void>
  reorderPinnedWorkspaces: (orderedIds: string[]) => Promise<void>
}

function rootOf(projectId: string): string {
  const { projects, activeProject } = useProjectStore.getState()
  return projects.find((p) => p.id === projectId)?.workingDirectory
    ?? (activeProject?.id === projectId ? activeProject.workingDirectory : '')
}

export const useSessionStore = create<SessionStore>((set, get) => {
  /** Replace one session in the list (and the active one if it is the same id). */
  const applyUpdate = (w: Awaited<ReturnType<typeof appData.updateWorkspace>>) => {
    set((state) => {
      const isActive = state.activeSession?.id === w.id
      const s = appData.toSession(w, rootOf(w.projectId), isActive ? w.id : null)
      return {
        sessions: state.sessions.map((x) => (x.id === w.id ? s : x)),
        ...(isActive ? { activeSession: s } : {}),
      }
    })
  }

  return {
    sessions: [],
    activeSession: null,
    isLoading: false,
    showSessionModal: false,
    isDirty: false,
    lastSavedAt: null,

    loadSessions: async () => {
      set({ isLoading: true })
      try {
        const list = await appData.listWorkspaces(null)
        set((state) => {
          const activeId = state.activeSession?.id ?? null
          const sessions = list.map((w) => appData.toSession(w, rootOf(w.projectId), activeId))
          const active = activeId ? sessions.find((s) => s.id === activeId) ?? state.activeSession : null
          return { sessions, activeSession: active, isLoading: false }
        })
      } catch (error) {
        console.error('Failed to load workspaces:', error)
        set({ isLoading: false })
      }
    },

    createSession: async (name, _workingDirectory, _layout, projectId) => {
      const pid = projectId ?? useProjectStore.getState().activeProject?.id
      if (!pid) throw new Error('Cannot create a workspace without an active project')
      const w = await appData.createWorkspace(pid, name)
      const s = appData.toSession(w, rootOf(pid))
      set((state) => ({ sessions: [s, ...state.sessions.filter((x) => x.id !== s.id)] }))
      return s
    },

    setActiveSession: async (session) => {
      const w = await appData.activateWorkspace(session.id)
      const active = appData.toSession(w, rootOf(w.projectId), w.id)
      set((state) => ({
        sessions: [active, ...state.sessions.filter((s) => s.id !== w.id).map((s) => ({ ...s, isActive: false }))],
        activeSession: active,
        isDirty: false,
      }))
    },

    updateSession: async (id, updates) => {
      applyUpdate(await appData.updateWorkspace(id, updates))
    },

    deleteSession: async (id) => {
      await appData.deleteWorkspace(id)
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== id),
        ...(state.activeSession?.id === id ? { activeSession: null } : {}),
      }))
    },

    saveSessionState: async (sessionId, terminals, tools, layoutTree) => {
      await appData.saveWorkspace(sessionId, terminals, tools, layoutTree)
      // Re-read state AFTER the await and touch only the saved workspace: a
      // switch that happened meanwhile must not be undone (the old code wrote
      // the pre-await activeSession back, flipping the active workspace).
      const now = Date.now()
      set((state) => {
        const isActive = state.activeSession?.id === sessionId
        return {
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, layoutTree, updatedAt: now } : s)),
          ...(isActive
            ? { activeSession: { ...state.activeSession!, layoutTree, updatedAt: now }, isDirty: false, lastSavedAt: now }
            : {}),
        }
      })
    },

    loadSessionState: (sessionId) => appData.loadWorkspace(sessionId),

    setShowSessionModal: (show) => set({ showSessionModal: show }),

    markDirty: () => set({ isDirty: true }),

    markClean: () => set({ isDirty: false, lastSavedAt: Date.now() }),

    toggleWorkspacePinned: async (sessionId) => {
      const session = get().sessions.find((s) => s.id === sessionId)
      if (!session) return
      const newPinned = !session.pinned
      const updates: Partial<Session> = { pinned: newPinned }
      if (newPinned) {
        const maxOrder = Math.max(0, ...get().sessions.filter((s) => s.pinned).map((s) => s.pinOrder ?? 0))
        updates.pinOrder = maxOrder + 1
        updates.pinSection = 'right'
      }
      applyUpdate(await appData.updateWorkspace(sessionId, updates))
    },

    getPinnedWorkspaces: (projectId) =>
      get().sessions
        .filter((s) => s.pinned && (!projectId || s.projectId === projectId))
        .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0)),

    updateWorkspacePinSection: async (sessionId, section) => {
      applyUpdate(await appData.updateWorkspace(sessionId, { pinSection: section }))
    },

    reorderPinnedWorkspaces: async (orderedIds) => {
      const known = new Set(get().sessions.map((s) => s.id))
      const results = await Promise.all(
        orderedIds.filter((id) => known.has(id)).map((id, i) => appData.updateWorkspace(id, { pinOrder: i })),
      )
      results.forEach(applyUpdate)
    },
  }
})
