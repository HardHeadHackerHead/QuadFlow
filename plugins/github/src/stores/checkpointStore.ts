import { create } from 'zustand'
import type { JsonValue, PluginContext } from '@quadflow/plugin-api'
import type { Checkpoint, CheckpointDiffSummary } from '../types'
import type { GitHubServices } from '../services'

interface CheckpointStore {
  // State
  checkpoints: Checkpoint[]
  isLoading: boolean
  isActioning: boolean
  error: string | null
  diffPreviews: Record<string, CheckpointDiffSummary>

  // Actions - all accept optional dir override
  loadCheckpoints: (dir?: string) => Promise<void>
  createCheckpoint: (name: string, description?: string, dir?: string) => Promise<Checkpoint | null>
  restoreCheckpoint: (id: string, createSafety?: boolean, dir?: string) => Promise<boolean>
  deleteCheckpoint: (id: string, dir?: string) => Promise<boolean>
  loadDiffPreview: (id: string, dir?: string) => Promise<CheckpointDiffSummary | null>
  clearError: () => void
}

// Checkpoint records live in the plugin's storage (project scope), one key per checkpoint
// (`checkpoint:<id>`); the git tag is the real checkpoint, this is its metadata.
export const CHECKPOINT_PREFIX = 'checkpoint:'

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function createCheckpointStore(ctx: PluginContext, github: GitHubServices) {
  async function listCheckpoints(projectPath: string): Promise<Checkpoint[]> {
    const keys = await ctx.storage.keys(CHECKPOINT_PREFIX, 'project')
    const all = (await Promise.all(keys.map((k) => ctx.storage.get<Checkpoint>(k, 'project')))).filter((c): c is Checkpoint => !!c)
    return all.filter((c) => samePath(c.projectPath, projectPath)).sort((a, b) => b.createdAt - a.createdAt)
  }

  async function saveCheckpoint(data: Omit<Checkpoint, 'id' | 'createdAt' | 'description'> & { description?: string }): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      ...data,
      id: Math.random().toString(36).substring(2) + Date.now().toString(36),
      description: data.description || null,
      createdAt: Date.now(),
    }
    await ctx.storage.set(CHECKPOINT_PREFIX + checkpoint.id, checkpoint as unknown as JsonValue, 'project')
    return checkpoint
  }

  const getDefaultCwd = (): string => ctx.project.current()?.root ?? ''

  return create<CheckpointStore>((set, get) => ({
  checkpoints: [],
  isLoading: false,
  isActioning: false,
  error: null,
  diffPreviews: {},

  loadCheckpoints: async (dir?: string) => {
    const cwd = dir || getDefaultCwd()
    if (!cwd) return

    set({ isLoading: true, error: null })
    try {
      const checkpoints = await listCheckpoints(cwd)
      set({ checkpoints, isLoading: false })
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load checkpoints',
      })
    }
  },

  createCheckpoint: async (name: string, description?: string, dir?: string) => {
    const cwd = dir || getDefaultCwd()
    if (!cwd) {
      set({ error: 'No working directory set' })
      return null
    }

    set({ isActioning: true, error: null })
    try {
      // Build the tag name and check for duplicates
      const tagName = github.buildCheckpointTagName(name)
      const exists = await github.checkpointTagExists(cwd, tagName)
      if (exists) {
        set({ isActioning: false, error: `A checkpoint with the tag "${tagName}" already exists` })
        return null
      }

      // Check for uncommitted changes and auto-commit if needed
      const hadUncommitted = await github.autoCommitForCheckpoint(cwd, name)

      // Get current state
      const commitSha = await github.getHeadSha(cwd)
      const branch = await github.getCurrentBranch(cwd)
      const filesChanged = hadUncommitted ? await github.getChangedFileCount(cwd) : 0

      // Create the annotated tag
      await github.createCheckpointTag(cwd, tagName, `QuadFlow checkpoint: ${name}`)

      // Persist to database
      const checkpoint = await saveCheckpoint({
        name,
        description,
        commitSha,
        branch,
        tagName,
        filesChanged,
        hadUncommittedChanges: hadUncommitted,
        projectPath: cwd,
      })

      set((state) => ({
        checkpoints: [checkpoint, ...state.checkpoints],
        isActioning: false,
      }))

      return checkpoint
    } catch (err) {
      set({
        isActioning: false,
        error: err instanceof Error ? err.message : 'Failed to create checkpoint',
      })
      return null
    }
  },

  restoreCheckpoint: async (id: string, createSafety = true, dir?: string) => {
    const cwd = dir || getDefaultCwd()
    if (!cwd) {
      set({ error: 'No working directory set' })
      return false
    }

    const checkpoint = get().checkpoints.find((c) => c.id === id)
    if (!checkpoint) {
      set({ error: 'Checkpoint not found' })
      return false
    }

    set({ isActioning: true, error: null })
    try {
      // Create a safety checkpoint before restoring
      if (createSafety) {
        const safetyName = `safety-before-restore-${checkpoint.name}`
        const safetyTag = github.buildCheckpointTagName(safetyName)
        const safetyExists = await github.checkpointTagExists(cwd, safetyTag)

        if (!safetyExists) {
          // Auto-commit any pending changes before safety snapshot
          await github.autoCommitForCheckpoint(cwd, safetyName)
          const safetySha = await github.getHeadSha(cwd)
          const safetyBranch = await github.getCurrentBranch(cwd)

          await github.createCheckpointTag(cwd, safetyTag, `QuadFlow safety checkpoint before restoring to: ${checkpoint.name}`)

          const safetyCheckpoint = await saveCheckpoint({
            name: safetyName,
            description: `Auto-created safety checkpoint before restoring to "${checkpoint.name}"`,
            commitSha: safetySha,
            branch: safetyBranch,
            tagName: safetyTag,
            filesChanged: 0,
            hadUncommittedChanges: false,
            projectPath: cwd,
          })

          set((state) => ({
            checkpoints: [safetyCheckpoint, ...state.checkpoints],
          }))
        }
      }

      // Hard-reset to the checkpoint
      await github.restoreToCheckpoint(cwd, checkpoint.tagName)

      set({ isActioning: false })
      return true
    } catch (err) {
      set({
        isActioning: false,
        error: err instanceof Error ? err.message : 'Failed to restore checkpoint',
      })
      return false
    }
  },

  deleteCheckpoint: async (id: string, dir?: string) => {
    const cwd = dir || getDefaultCwd()
    const checkpoint = get().checkpoints.find((c) => c.id === id)
    if (!checkpoint) {
      set({ error: 'Checkpoint not found' })
      return false
    }

    set({ isActioning: true, error: null })
    try {
      // Delete the git tag
      if (cwd) {
        try {
          await github.deleteCheckpointTag(cwd, checkpoint.tagName)
        } catch {
          // Tag may already be gone - that's fine
        }
      }

      // Delete from database
      await ctx.storage.delete(CHECKPOINT_PREFIX + id, 'project')

      set((state) => ({
        checkpoints: state.checkpoints.filter((c) => c.id !== id),
        isActioning: false,
        diffPreviews: (() => {
          const { [id]: _, ...rest } = state.diffPreviews
          return rest
        })(),
      }))

      return true
    } catch (err) {
      set({
        isActioning: false,
        error: err instanceof Error ? err.message : 'Failed to delete checkpoint',
      })
      return false
    }
  },

  loadDiffPreview: async (id: string, dir?: string) => {
    const cwd = dir || getDefaultCwd()
    if (!cwd) return null

    const checkpoint = get().checkpoints.find((c) => c.id === id)
    if (!checkpoint) return null

    try {
      const diff = await github.getCheckpointDiff(cwd, checkpoint.tagName)
      set((state) => ({
        diffPreviews: { ...state.diffPreviews, [id]: diff },
      }))
      return diff
    } catch {
      return null
    }
  },

  clearError: () => set({ error: null }),
}))
}
