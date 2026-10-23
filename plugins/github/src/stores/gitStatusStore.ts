import { create } from 'zustand'
import type { PluginContext } from '@quadflow/plugin-api'
import type { GitHubServices, GitStatusInfo } from '../services'

export interface DirStatus extends GitStatusInfo {
  isLoading: boolean
  isActioning: boolean
  isGenerating: boolean
  error: string | null
}

const EMPTY_STATUS: DirStatus = {
  branch: '',
  staged: 0,
  modified: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  lastCommitTime: null,
  lastPushTime: null,
  hasRemote: false,
  hasUpstream: false,
  isGitRepo: false,
  isLoading: false,
  isActioning: false,
  isGenerating: false,
  error: null,
}

interface GitStatusStore {
  statuses: Record<string, DirStatus>
  autoGenerateMessage: boolean

  // All actions take explicit dir
  initRepo: (dir: string) => Promise<boolean>
  refresh: (dir: string) => Promise<void>
  refreshAll: (dirs: string[]) => Promise<void>
  stageAll: (dir: string) => Promise<void>
  commit: (dir: string, message: string) => Promise<void>
  push: (dir: string) => Promise<void>
  commitAndPush: (dir: string, message: string) => Promise<void>
  fetch: (dir: string) => Promise<void>
  generateMessage: (dir: string) => Promise<string>
  getStatus: (dir: string) => DirStatus
  setAutoGenerateMessage: (value: boolean) => void
  clearError: (dir: string) => void
}

function updateDir(statuses: Record<string, DirStatus>, dir: string, patch: Partial<DirStatus>): Record<string, DirStatus> {
  const current = statuses[dir] || { ...EMPTY_STATUS }
  return { ...statuses, [dir]: { ...current, ...patch } }
}

export function createGitStatusStore(ctx: PluginContext, svc: GitHubServices) {
  const { getGitStatus, gitStageAll, gitCommit, gitPush, gitFetch, gitInit, generateGitignore, generateCommitMessage } = svc
  const getDefaultDir = (): string => ctx.project.current()?.root ?? ''

  return create<GitStatusStore>((set, get) => ({
  statuses: {},
  autoGenerateMessage: false,

  getStatus: (dir: string) => {
    return get().statuses[dir] || EMPTY_STATUS
  },

  initRepo: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return false

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      const success = await gitInit(cwd)
      if (success) {
        await generateGitignore(cwd)
        await get().refresh(cwd)
      }
      return success
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to initialize git repository' }) }))
      return false
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  refresh: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isLoading: true, error: null }) }))
    try {
      const info: GitStatusInfo = await getGitStatus(cwd)
      set(s => ({
        statuses: updateDir(s.statuses, cwd, {
          ...info,
          isLoading: false,
        }),
      }))
    } catch (err) {
      set(s => ({
        statuses: updateDir(s.statuses, cwd, {
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to get git status',
        }),
      }))
    }
  },

  refreshAll: async (dirs: string[]) => {
    await Promise.all(dirs.map(d => get().refresh(d)))
  },

  stageAll: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      await gitStageAll(cwd)
      await get().refresh(cwd)
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to stage files' }) }))
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  commit: async (dir: string, message: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      await gitCommit(cwd, message)
      await get().refresh(cwd)
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to commit' }) }))
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  push: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      const status = get().getStatus(cwd)
      await gitPush(cwd, !status.hasUpstream ? status.branch : undefined)
      await get().refresh(cwd)
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to push' }) }))
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  commitAndPush: async (dir: string, message: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      const status = get().getStatus(cwd)
      await gitCommit(cwd, message)
      await gitPush(cwd, !status.hasUpstream ? status.branch : undefined)
      await get().refresh(cwd)
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to commit and push' }) }))
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  fetch: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: true, error: null }) }))
    try {
      await gitFetch(cwd)
      await get().refresh(cwd)
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to fetch' }) }))
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isActioning: false }) }))
    }
  },

  generateMessage: async (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) throw new Error('No working directory')

    set(s => ({ statuses: updateDir(s.statuses, cwd, { isGenerating: true, error: null }) }))
    try {
      const message = await generateCommitMessage(cwd)
      return message
    } catch (err) {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { error: err instanceof Error ? err.message : 'Failed to generate commit message' }) }))
      throw err
    } finally {
      set(s => ({ statuses: updateDir(s.statuses, cwd, { isGenerating: false }) }))
    }
  },

  setAutoGenerateMessage: (value: boolean) => set({ autoGenerateMessage: value }),

  clearError: (dir: string) => {
    const cwd = dir || getDefaultDir()
    if (!cwd) return
    set(s => ({ statuses: updateDir(s.statuses, cwd, { error: null }) }))
  },
}))
}
