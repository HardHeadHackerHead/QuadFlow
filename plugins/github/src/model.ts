/**
 * Per-context state of the GitHub plugin: the bound services and the three stores ported from
 * the shell (GitHub, git status, checkpoints). The pane tile, the flyout tile and the mini
 * widget get the same `ctx`, so they share one model.
 *
 * Views use the hooks below (`useGitHubStore()`, …), which find the model through
 * `usePluginContext()` — the host wraps every tile in a `PluginContextProvider`; the mini
 * widget wraps itself (index.tsx).
 */
import { usePluginContext, type Issue_Serialize, type PluginContext } from '@quadflow/plugin-api'
import { createCollection, type Collection } from '@quadflow/plugin-kit'
import { createServices, type GitHubServices } from './services'
import { createGitHubStore } from './stores/githubStore'
import { createGitStatusStore } from './stores/gitStatusStore'
import { createCheckpointStore } from './stores/checkpointStore'

export interface GitHubModel {
  services: GitHubServices
  github: ReturnType<typeof createGitHubStore>
  gitStatus: ReturnType<typeof createGitStatusStore>
  checkpoints: ReturnType<typeof createCheckpointStore>
  /** The project's issues (live), for the Issues sync tab. */
  issues: Collection<Issue_Serialize>
}

const models = new WeakMap<PluginContext, GitHubModel>()

export function githubModel(ctx: PluginContext): GitHubModel {
  let m = models.get(ctx)
  if (!m) {
    const services = createServices(ctx)
    m = {
      services,
      github: createGitHubStore(ctx, services),
      gitStatus: createGitStatusStore(ctx, services),
      checkpoints: createCheckpointStore(ctx, services),
      issues: createCollection<Issue_Serialize>(ctx, {
        domain: 'issues',
        list: (c, root) => c.data.issues.list({ includeDone: true }, { projectRoot: root }),
        get: (c, id, root) => c.data.issues.get(id, { projectRoot: root }),
        normalize: (i) => i,
        compare: (a, b) => b.number - a.number,
      }),
    }
    models.set(ctx, m)
    const model = m
    // A project switch drops the old project's checkpoints (they are project-scoped).
    ctx.project.onDidChange(() => model.checkpoints.setState({ checkpoints: [], diffPreviews: {}, error: null }))
  }
  return m
}

type GitHubState = ReturnType<GitHubModel['github']['getState']>
type GitStatusState = ReturnType<GitHubModel['gitStatus']['getState']>
type CheckpointState = ReturnType<GitHubModel['checkpoints']['getState']>

export function useGitHubStore(): GitHubState
export function useGitHubStore<T>(sel: (s: GitHubState) => T): T
export function useGitHubStore<T>(sel?: (s: GitHubState) => T) {
  const store = githubModel(usePluginContext()).github
  return sel ? store(sel) : store()
}

export function useGitStatusStore(): GitStatusState
export function useGitStatusStore<T>(sel: (s: GitStatusState) => T): T
export function useGitStatusStore<T>(sel?: (s: GitStatusState) => T) {
  const store = githubModel(usePluginContext()).gitStatus
  return sel ? store(sel) : store()
}

export function useCheckpointStore(): CheckpointState
export function useCheckpointStore<T>(sel: (s: CheckpointState) => T): T
export function useCheckpointStore<T>(sel?: (s: CheckpointState) => T) {
  const store = githubModel(usePluginContext()).checkpoints
  return sel ? store(sel) : store()
}

/** The bound services (what the views imported as `* as github`). */
export function useServices(): GitHubServices {
  return githubModel(usePluginContext()).services
}

/** The active project root (re-renders on project switches). */
export { useProjectRoot } from './useProjectRoot'
