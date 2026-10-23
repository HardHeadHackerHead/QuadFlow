import { create } from 'zustand'
import type { Issue_Serialize, JsonValue, PluginContext } from '@quadflow/plugin-api'
import type * as gh from '../services'
import type { GitHubServices } from '../services'

/**
 * GitHub Store (one per plugin context, see ../model.ts)
 *
 * Manages the GitHub integration: auth (token in `ctx.secrets`), connected repositories
 * (plugin storage, global scope, key `repositories`), repo data through the REST API, and
 * the issue linkage in each issue's `ext.github` (via `ctx.data.issues`).
 *
 * Multi-repo support: discovers sub-repos in a project directory and scopes
 * GitHub data (branches, PRs, commits, releases) per sub-repo. Top-level fields
 * mirror the active sub-repo for backward compatibility with existing views.
 */

export interface ConnectedRepository {
  id: string
  owner: string
  name: string
  fullName: string
  isDefault: boolean
  lastSyncedAt?: number
  createdAt: number
}

/** `ext.github` on an issue (data-layer.md §6.3). */
export interface GithubExt {
  repoId?: string
  /** GitHub's node id */
  id?: string
  number?: number
  url?: string
  syncStatus?: 'local' | 'synced' | 'pending' | 'conflict'
  lastSyncedAt?: number
  /** GitHub comment ids already imported as issue comments. */
  importedCommentIds?: string[]
}

export function issueGithubExt(i: Pick<Issue_Serialize, 'ext'>): GithubExt | undefined {
  return (i.ext?.github ?? undefined) as GithubExt | undefined
}

/** The fields of a local issue the GitHub sync reads. */
export interface Issue {
  id: string
  number: number
  title: string
  body?: string
  status: string
  labels: string[]
  githubRepoId?: string
  githubNumber?: number
  githubUrl?: string
  syncStatus?: GithubExt['syncStatus']
}

export function toSyncIssue(i: Issue_Serialize): Issue {
  const ext = issueGithubExt(i)
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body ?? undefined,
    status: i.status,
    labels: i.labels ?? [],
    githubRepoId: ext?.repoId,
    githubNumber: ext?.number,
    githubUrl: ext?.url,
    syncStatus: ext?.syncStatus,
  }
}

/** Plugin storage key (global scope) of the connected repositories. */
export const REPOS_KEY = 'repositories'

function newRepoId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

// Sync result types
export interface SyncResult {
  success: boolean
  error?: string
  githubIssue?: gh.GitHubIssue
}

export interface ImportResult {
  success: boolean
  imported: number
  skipped: number
  errors: string[]
}

// Per-sub-repo scoped data
export interface SubRepoState {
  dir: string
  label: string
  isRoot: boolean
  localGitInfo: gh.LocalGitInfo | null
  autoDetectedRepo: ConnectedRepository | null
  selectedRepoId: string | null
  branches: gh.GitHubBranch[]
  pullRequests: gh.GitHubPullRequest[]
  commits: gh.GitHubCommit[]
  releases: gh.GitHubRelease[]
  isLoadingBranches: boolean
  isLoadingPRs: boolean
  isLoadingCommits: boolean
  isLoadingReleases: boolean
}

function createEmptySubRepoState(dir: string, label: string, isRoot: boolean): SubRepoState {
  return {
    dir, label, isRoot,
    localGitInfo: null,
    autoDetectedRepo: null,
    selectedRepoId: null,
    branches: [],
    pullRequests: [],
    commits: [],
    releases: [],
    isLoadingBranches: false,
    isLoadingPRs: false,
    isLoadingCommits: false,
    isLoadingReleases: false,
  }
}

export interface GitHubState {
  // Authentication state (from gh CLI)
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  // Token status (was: gh CLI installed)
  ghInstalled: boolean | null // null = not checked yet

  // User info
  user: gh.GitHubUser | null
  username: string | null

  // Project working directory
  workingDirectory: string | null

  // Local git info for current project (mirrors active sub-repo)
  localGitInfo: gh.LocalGitInfo | null

  // Connected repositories
  repositories: ConnectedRepository[]
  defaultRepository: ConnectedRepository | null

  // Selected repo for tab views (mirrors active sub-repo)
  selectedRepoId: string | null

  // Auto-detected repo from current project's git remote (mirrors active sub-repo)
  autoDetectedRepo: ConnectedRepository | null

  // GitHub data (mirrors active sub-repo)
  branches: gh.GitHubBranch[]
  pullRequests: gh.GitHubPullRequest[]
  commits: gh.GitHubCommit[]
  releases: gh.GitHubRelease[]

  // Loading states (mirrors active sub-repo)
  isLoadingBranches: boolean
  isLoadingPRs: boolean
  isLoadingCommits: boolean
  isLoadingReleases: boolean

  // Multi-repo discovery
  discoveredRepos: gh.DiscoveredRepo[]
  subRepoStates: Record<string, SubRepoState>
  activeSubRepoDir: string | null

  // Cached full repo metadata (isPrivate, description, url, …) keyed by fullName
  repoDetails: Record<string, gh.GitHubRepository>
}

interface GitHubStore extends GitHubState {
  // Auth actions
  initialize: () => Promise<void>
  checkAuth: () => Promise<{ authenticated: boolean; error?: string }>

  // Repository actions
  loadUserRepositories: () => Promise<gh.GitHubRepository[]>
  addRepository: (repo: gh.GitHubRepository) => Promise<ConnectedRepository>
  removeRepository: (id: string) => Promise<void>
  setDefaultRepository: (id: string) => Promise<void>
  updateRepositorySyncTime: (id: string) => Promise<void>

  // Issue sync actions
  pushIssueToGitHub: (issue: Issue, repoId?: string) => Promise<SyncResult>
  importIssuesFromGitHub: (repoId: string, onProgress?: (imported: number, total: number) => void) => Promise<ImportResult>
  fetchGitHubIssues: (repoId: string) => Promise<gh.GitHubIssue[]>
  syncIssueComments: (issue: Issue) => Promise<{ success: boolean; error?: string }>

  // Repo selection
  setSelectedRepo: (repoId: string | null) => void
  getSelectedRepo: () => ConnectedRepository | null

  // Repo detail lookup (isPrivate, description, url)
  loadRepoDetails: (fullName: string, force?: boolean) => Promise<void>

  // Branch actions
  loadBranches: (repoId?: string) => Promise<void>
  createBranch: (name: string, fromBranch?: string) => Promise<boolean>
  deleteBranch: (name: string) => Promise<boolean>

  // PR actions
  loadPullRequests: (state?: string) => Promise<void>
  createPullRequest: (data: { title: string; body?: string; head: string; base?: string; draft?: boolean }) => Promise<string | null>
  mergePullRequest: (number: number, method?: 'merge' | 'squash' | 'rebase') => Promise<boolean>
  closePullRequest: (number: number) => Promise<boolean>

  // Commit actions
  loadCommits: (branch?: string, limit?: number) => Promise<void>

  // Release actions
  loadReleases: () => Promise<void>
  createRelease: (data: { tag: string; title?: string; notes?: string; draft?: boolean; prerelease?: boolean }) => Promise<string | null>

  // Local git / project actions
  setWorkingDirectory: (dir: string) => void
  refreshLocalGitInfo: () => Promise<void>

  // Repo management
  createRepositoryFromProject: (name: string, options?: { description?: string; isPrivate?: boolean; push?: boolean }) => Promise<string | null>
  deleteRepository: (nameWithOwner: string) => Promise<boolean>

  // Multi-repo actions
  discoverSubRepos: () => Promise<void>
  setActiveSubRepo: (dir: string) => void

  // Token
  setToken: (token: string) => Promise<{ success: boolean; error?: string }>
  importGhCliToken: () => Promise<{ success: boolean; error?: string }>
  signOut: () => Promise<void>

  // Error handling
  clearError: () => void
}

/** Build a ConnectedRepository from git remote info + connected repos list */
function buildAutoDetectedRepo(info: gh.LocalGitInfo, repositories: ConnectedRepository[]): { selectedRepoId: string | null; autoDetectedRepo: ConnectedRepository | null } {
  if (info.nameWithOwner) {
    const existingRepo = repositories.find(
      (r) => r.fullName.toLowerCase() === info.nameWithOwner!.toLowerCase()
    )
    if (existingRepo) {
      return { selectedRepoId: existingRepo.id, autoDetectedRepo: null }
    }
    const parts = info.nameWithOwner.split('/')
    return {
      selectedRepoId: null,
      autoDetectedRepo: {
        id: `auto-detected-${info.nameWithOwner}`,
        owner: parts[0],
        name: parts[1] || parts[0],
        fullName: info.nameWithOwner,
        isDefault: false,
        createdAt: Date.now(),
      },
    }
  }
  return { selectedRepoId: null, autoDetectedRepo: null }
}

export type GitHubStoreHook = ReturnType<typeof createGitHubStore>

export function createGitHubStore(ctx: PluginContext, github: GitHubServices) {
  async function loadRepos(): Promise<ConnectedRepository[]> {
    const repos = (await ctx.storage.get<ConnectedRepository[]>(REPOS_KEY, 'global')) ?? []
    return [...repos].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt)
  }

  async function updateRepos(f: (repos: ConnectedRepository[]) => ConnectedRepository[]): Promise<void> {
    await ctx.storage.set(REPOS_KEY, f(await loadRepos()) as unknown as JsonValue, 'global')
  }

  function activeIssuesRoot(): string {
    const root = ctx.project.current()?.root
    if (!root) throw new Error('No active project')
    return root
  }

  /** Merge `patch` into the issue's `ext.github`. */
  async function patchGithubExt(root: string, issueId: string, patch: GithubExt): Promise<void> {
    const current = issueGithubExt(await ctx.data.issues.get(issueId, { projectRoot: root })) ?? {}
    await ctx.data.issues.update(issueId, { ext: { github: { ...current, ...patch } as unknown as JsonValue } }, { projectRoot: root })
  }

  return create<GitHubStore>((set, get) => ({
  // Initial state
  isAuthenticated: false,
  isLoading: true,
  error: null,
  ghInstalled: null,
  user: null,
  username: null,
  workingDirectory: null,
  localGitInfo: null,
  repositories: [],
  defaultRepository: null,
  selectedRepoId: null,
  autoDetectedRepo: null,
  branches: [],
  pullRequests: [],
  commits: [],
  releases: [],
  isLoadingBranches: false,
  isLoadingPRs: false,
  isLoadingCommits: false,
  isLoadingReleases: false,
  discoveredRepos: [],
  subRepoStates: {},
  activeSubRepoDir: null,
  repoDetails: {},

  // Initialize - check gh CLI auth status
  initialize: async () => {
    set({ isLoading: true, error: null })
    try {
      // Check if gh CLI is authenticated
      const authStatus = await github.checkAuthStatus()

      if (authStatus.authenticated) {
        // Get user details
        const user = await github.getAuthenticatedUser()

        // Load connected repositories from database
        const repos = await loadRepos()
        const defaultRepo = repos.find((r) => r.isDefault) || null

        set({
          isAuthenticated: true,
          ghInstalled: true,
          user,
          username: authStatus.user || user?.login || null,
          repositories: repos,
          defaultRepository: defaultRepo,
          isLoading: false,
        })
      } else {
        const repos = await loadRepos().catch(() => [] as ConnectedRepository[])
        set({
          isAuthenticated: false,
          ghInstalled: authStatus.ghInstalled ?? null,
          user: null,
          username: null,
          repositories: repos,
          defaultRepository: repos.find((r) => r.isDefault) || null,
          isLoading: false,
          error: authStatus.error || null,
        })
      }
    } catch (error) {
      ctx.log.error('Failed to initialize GitHub store:', error)
      set({
        isLoading: false,
        isAuthenticated: false,
        ghInstalled: null,
        error: 'Failed to check the GitHub connection.',
      })
    }
  },

  // Check auth status (can be called to refresh)
  checkAuth: async () => {
    const authStatus = await github.checkAuthStatus()

    if (authStatus.authenticated) {
      const user = await github.getAuthenticatedUser()
      set({
        isAuthenticated: true,
        ghInstalled: true,
        user,
        username: authStatus.user || user?.login || null,
        error: null,
      })
    } else {
      set({
        isAuthenticated: false,
        ghInstalled: authStatus.ghInstalled ?? null,
        user: null,
        username: null,
        error: authStatus.error || null,
      })
    }

    return authStatus
  },

  // Load user's repositories from GitHub
  loadUserRepositories: async () => {
    const { isAuthenticated } = get()
    if (!isAuthenticated) return []

    try {
      return await github.listUserRepositories(100)
    } catch (error) {
      ctx.log.error('Failed to load repositories:', error)
      return []
    }
  },

  // Add a repository connection
  addRepository: async (repo: gh.GitHubRepository) => {
    const { repositories } = get()
    const isFirst = repositories.length === 0

    const newRepo: ConnectedRepository = {
      id: newRepoId(),
      owner: repo.owner.login,
      name: repo.name,
      fullName: repo.nameWithOwner,
      isDefault: isFirst, // First repository is default
      createdAt: Date.now(),
    }
    await updateRepos((all) => [
      ...(newRepo.isDefault ? all.map((r) => ({ ...r, isDefault: false })) : all),
      newRepo,
    ])

    set((state) => ({
      repositories: [...state.repositories, newRepo],
      defaultRepository: newRepo.isDefault ? newRepo : state.defaultRepository,
    }))

    return newRepo
  },

  // Remove a repository connection
  removeRepository: async (id: string) => {
    const { repositories, defaultRepository } = get()
    const newRepos = repositories.filter((r) => r.id !== id)

    // If we removed the default, set a new default if any exist
    let newDefault = defaultRepository?.id === id ? null : defaultRepository
    if (!newDefault && newRepos.length > 0) {
      newRepos[0] = { ...newRepos[0], isDefault: true }
      newDefault = newRepos[0]
    }
    const defaultId = newDefault?.id
    await updateRepos((all) => {
      const rest = all.filter((r) => r.id !== id)
      return defaultId ? rest.map((r) => ({ ...r, isDefault: r.id === defaultId })) : rest
    })

    set({
      repositories: newRepos,
      defaultRepository: newDefault,
    })
  },

  // Set a repository as default
  setDefaultRepository: async (id: string) => {
    await updateRepos((all) => all.map((r) => ({ ...r, isDefault: r.id === id })))

    set((state) => ({
      repositories: state.repositories.map((r) => ({
        ...r,
        isDefault: r.id === id,
      })),
      defaultRepository: state.repositories.find((r) => r.id === id) || null,
    }))
  },

  // Update repository sync timestamp
  updateRepositorySyncTime: async (id: string) => {
    const now = Date.now()
    await updateRepos((all) => all.map((r) => (r.id === id ? { ...r, lastSyncedAt: now } : r)))

    set((state) => ({
      repositories: state.repositories.map((r) =>
        r.id === id ? { ...r, lastSyncedAt: now } : r
      ),
      defaultRepository:
        state.defaultRepository?.id === id
          ? { ...state.defaultRepository, lastSyncedAt: now }
          : state.defaultRepository,
    }))
  },

  // Push a local issue to GitHub
  pushIssueToGitHub: async (issue: Issue, repoId?: string) => {
    const { isAuthenticated, repositories, defaultRepository } = get()
    if (!isAuthenticated) return { success: false, error: 'Not signed in to GitHub. Add a token in the Settings tab.' }

    // Find the repository to push to
    const repo = repoId
      ? repositories.find((r) => r.id === repoId)
      : defaultRepository

    if (!repo) return { success: false, error: 'No repository selected' }

    try {
      // Create or update the issue on GitHub
      if (issue.githubNumber && issue.githubRepoId === repo.id) {
        // Update existing GitHub issue
        const githubIssue = await github.updateIssue(
          repo.fullName,
          issue.githubNumber,
          {
            title: issue.title,
            body: issue.body || '',
            state: issue.status === 'done' ? 'closed' : 'open',
          }
        )

        if (!githubIssue) {
          return { success: false, error: 'Failed to update issue on GitHub' }
        }

        // Update local issue with sync status
        await patchGithubExt(activeIssuesRoot(), issue.id, { syncStatus: 'synced', lastSyncedAt: Date.now() })

        // Update sync time
        await get().updateRepositorySyncTime(repo.id)

        return { success: true, githubIssue }
      } else {
        // Create new GitHub issue
        const githubIssue = await github.createIssue(
          repo.fullName,
          {
            title: issue.title,
            body: issue.body || '',
            labels: issue.labels,
          }
        )

        if (!githubIssue) {
          return { success: false, error: 'Failed to create issue on GitHub' }
        }

        // Link the local issue to the GitHub issue
        await patchGithubExt(activeIssuesRoot(), issue.id, {
          repoId: repo.id,
          id: githubIssue.id,
          number: githubIssue.number,
          url: githubIssue.url,
          syncStatus: 'synced',
          lastSyncedAt: Date.now(),
        })

        // Update sync time
        await get().updateRepositorySyncTime(repo.id)

        return { success: true, githubIssue }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to push issue'
      return { success: false, error: message }
    }
  },

  // Fetch GitHub issues for a repository
  fetchGitHubIssues: async (repoId: string) => {
    const { isAuthenticated, repositories } = get()
    if (!isAuthenticated) return []

    const repo = repositories.find((r) => r.id === repoId)
    if (!repo) return []

    try {
      return await github.listRepositoryIssues(repo.fullName, { state: 'all' })
    } catch (error) {
      ctx.log.error('Failed to fetch GitHub issues:', error)
      return []
    }
  },

  // Import issues from GitHub
  importIssuesFromGitHub: async (repoId: string, onProgress?: (imported: number, total: number) => void) => {
    const { isAuthenticated, repositories } = get()
    if (!isAuthenticated) return { success: false, imported: 0, skipped: 0, errors: ['Not authenticated'] }

    const repo = repositories.find((r) => r.id === repoId)
    if (!repo) return { success: false, imported: 0, skipped: 0, errors: ['Repository not found'] }

    try {
      // Fetch all issues from GitHub
      const githubIssues = await github.listRepositoryIssues(repo.fullName, { state: 'all', limit: 100 })

      let imported = 0
      let skipped = 0
      const errors: string[] = []
      const root = activeIssuesRoot()
      const existingIssues = (await ctx.data.issues.list({ includeDone: true }, { projectRoot: root })).items.map(toSyncIssue)
      const existingLabels: { name: string; color: string }[] = await ctx.data.issues.labels.list({ projectRoot: root })

      for (let i = 0; i < githubIssues.length; i++) {
        const ghIssue = githubIssues[i]

        // Check if issue already exists (by github number and repo)
        const exists = existingIssues.some(
          (issue) => issue.githubNumber === ghIssue.number && issue.githubRepoId === repo.id
        )

        if (exists) {
          skipped++
          onProgress?.(imported, githubIssues.length)
          continue
        }

        try {
          // Create missing labels (with GitHub's colors) before the issue uses them
          for (const ghLabel of ghIssue.labels) {
            if (!existingLabels.some((l) => l.name === ghLabel.name)) {
              await ctx.data.issues.labels.upsert({ name: ghLabel.name, color: `#${ghLabel.color}` }, null, { projectRoot: root })
              existingLabels.push({ name: ghLabel.name, color: `#${ghLabel.color}` })
            }
          }

          // Create the local issue, then link it to the GitHub issue
          const newIssue = await ctx.data.issues.create({
            title: ghIssue.title,
            body: ghIssue.body || null,
            priority: 'medium', // Default priority for imported issues
            labels: ghIssue.labels.map((l) => l.name),
            status: ghIssue.state === 'OPEN' ? null : 'done',
          }, { projectRoot: root })
          await ctx.data.issues.update(newIssue.id, { ext: {
            github: {
              repoId: repo.id,
              id: ghIssue.id,
              number: ghIssue.number,
              url: ghIssue.url,
              syncStatus: 'synced',
              lastSyncedAt: Date.now(),
            } as unknown as JsonValue,
          } }, { projectRoot: root })

          imported++
        } catch (err) {
          errors.push(`Could not bring in #${ghIssue.number}: ${err instanceof Error ? err.message : 'Unknown error'}`)
        }

        onProgress?.(imported, githubIssues.length)
      }

      // Update sync time
      await get().updateRepositorySyncTime(repo.id)

      return { success: errors.length === 0, imported, skipped, errors }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Importing issues failed'
      return { success: false, imported: 0, skipped: 0, errors: [message] }
    }
  },

  // Sync comments for an issue
  syncIssueComments: async (issue: Issue) => {
    const { isAuthenticated, repositories } = get()
    if (!isAuthenticated) return { success: false, error: 'Not authenticated' }
    if (!issue.githubRepoId || !issue.githubNumber) {
      return { success: false, error: 'Issue not linked to GitHub' }
    }

    const repo = repositories.find((r) => r.id === issue.githubRepoId)
    if (!repo) return { success: false, error: 'Repository not found' }

    try {
      // Fetch GitHub comments
      const githubComments = await github.listIssueComments(repo.fullName, issue.githubNumber)

      // GitHub comments already imported are recorded in `ext.github.importedCommentIds`
      const root = activeIssuesRoot()
      const ext = issueGithubExt(await ctx.data.issues.get(issue.id, { projectRoot: root })) ?? {}
      const imported = new Set(ext.importedCommentIds ?? [])
      const before = imported.size

      for (const ghComment of githubComments) {
        if (imported.has(ghComment.id)) continue
        await ctx.data.issues.addComment(
          issue.id,
          `**@${ghComment.author.login}** on GitHub (${ghComment.createdAt}):\n\n${ghComment.body}`,
          { projectRoot: root },
        )
        imported.add(ghComment.id)
      }
      if (imported.size !== before) {
        await patchGithubExt(root, issue.id, { importedCommentIds: [...imported] })
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync comments'
      return { success: false, error: message }
    }
  },

  // Repo selection
  setSelectedRepo: (repoId: string | null) => {
    const { activeSubRepoDir, subRepoStates } = get()
    set({ selectedRepoId: repoId })
    // Also update in sub-repo state
    if (activeSubRepoDir && subRepoStates[activeSubRepoDir]) {
      set(s => ({
        subRepoStates: {
          ...s.subRepoStates,
          [activeSubRepoDir]: { ...s.subRepoStates[activeSubRepoDir], selectedRepoId: repoId },
        },
      }))
    }
  },

  getSelectedRepo: () => {
    const { selectedRepoId, repositories, autoDetectedRepo, defaultRepository } = get()
    // 1. If a specific repo is selected and exists in connected repos, use it
    if (selectedRepoId) {
      const selected = repositories.find((r) => r.id === selectedRepoId)
      if (selected) return selected
    }
    // 2. If we auto-detected a repo from git remote, use it
    if (autoDetectedRepo) return autoDetectedRepo
    // 3. Fall back to default connected repo
    return defaultRepository
  },

  loadRepoDetails: async (fullName: string, force = false) => {
    if (!fullName) return
    const { repoDetails, isAuthenticated } = get()
    if (!isAuthenticated) return
    if (!force && repoDetails[fullName]) return
    try {
      const details = await github.getRepository(fullName)
      if (details) {
        set((state) => ({
          repoDetails: { ...state.repoDetails, [fullName]: details },
        }))
      }
    } catch (error) {
      ctx.log.error(`Failed to load repo details for ${fullName}:`, error)
    }
  },

  // Branch actions
  loadBranches: async (repoId?: string) => {
    const repo = repoId
      ? get().repositories.find((r) => r.id === repoId)
      : get().getSelectedRepo()
    if (!repo) return

    set({ isLoadingBranches: true })
    try {
      const branches = await github.listBranches(repo.fullName)
      const { activeSubRepoDir } = get()
      set(s => {
        const update: Partial<GitHubState> = { branches, isLoadingBranches: false }
        if (activeSubRepoDir && s.subRepoStates[activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [activeSubRepoDir]: { ...s.subRepoStates[activeSubRepoDir], branches, isLoadingBranches: false },
          }
        }
        return update
      })
    } catch {
      set(s => {
        const update: Partial<GitHubState> = { branches: [], isLoadingBranches: false }
        if (s.activeSubRepoDir && s.subRepoStates[s.activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [s.activeSubRepoDir]: { ...s.subRepoStates[s.activeSubRepoDir], branches: [], isLoadingBranches: false },
          }
        }
        return update
      })
    }
  },

  createBranch: async (name: string, fromBranch?: string) => {
    const repo = get().getSelectedRepo()
    if (!repo) return false

    const success = await github.createBranch(repo.fullName, name, fromBranch)
    if (success) {
      await get().loadBranches()
    }
    return success
  },

  deleteBranch: async (name: string) => {
    const repo = get().getSelectedRepo()
    if (!repo) return false

    const success = await github.deleteBranch(repo.fullName, name)
    if (success) {
      await get().loadBranches()
    }
    return success
  },

  // PR actions
  loadPullRequests: async (state: string = 'open') => {
    const repo = get().getSelectedRepo()
    if (!repo) return

    set({ isLoadingPRs: true })
    try {
      const pullRequests = await github.listPullRequests(repo.fullName, state)
      const { activeSubRepoDir } = get()
      set(s => {
        const update: Partial<GitHubState> = { pullRequests, isLoadingPRs: false }
        if (activeSubRepoDir && s.subRepoStates[activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [activeSubRepoDir]: { ...s.subRepoStates[activeSubRepoDir], pullRequests, isLoadingPRs: false },
          }
        }
        return update
      })
    } catch {
      set(s => {
        const update: Partial<GitHubState> = { pullRequests: [], isLoadingPRs: false }
        if (s.activeSubRepoDir && s.subRepoStates[s.activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [s.activeSubRepoDir]: { ...s.subRepoStates[s.activeSubRepoDir], pullRequests: [], isLoadingPRs: false },
          }
        }
        return update
      })
    }
  },

  createPullRequest: async (data) => {
    const repo = get().getSelectedRepo()
    if (!repo) return null

    const url = await github.createPullRequest(repo.fullName, data)
    if (url) {
      await get().loadPullRequests()
    }
    return url
  },

  mergePullRequest: async (number: number, method?: 'merge' | 'squash' | 'rebase') => {
    const repo = get().getSelectedRepo()
    if (!repo) return false

    const success = await github.mergePullRequest(repo.fullName, number, method)
    if (success) {
      await get().loadPullRequests()
    }
    return success
  },

  closePullRequest: async (number: number) => {
    const repo = get().getSelectedRepo()
    if (!repo) return false

    const success = await github.closePullRequest(repo.fullName, number)
    if (success) {
      await get().loadPullRequests()
    }
    return success
  },

  // Commit actions
  loadCommits: async (branch?: string, limit?: number) => {
    const repo = get().getSelectedRepo()
    if (!repo) return

    set({ isLoadingCommits: true })
    try {
      const commits = await github.listCommits(repo.fullName, branch, limit)
      const { activeSubRepoDir } = get()
      set(s => {
        const update: Partial<GitHubState> = { commits, isLoadingCommits: false }
        if (activeSubRepoDir && s.subRepoStates[activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [activeSubRepoDir]: { ...s.subRepoStates[activeSubRepoDir], commits, isLoadingCommits: false },
          }
        }
        return update
      })
    } catch {
      set(s => {
        const update: Partial<GitHubState> = { commits: [], isLoadingCommits: false }
        if (s.activeSubRepoDir && s.subRepoStates[s.activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [s.activeSubRepoDir]: { ...s.subRepoStates[s.activeSubRepoDir], commits: [], isLoadingCommits: false },
          }
        }
        return update
      })
    }
  },

  // Release actions
  loadReleases: async () => {
    const repo = get().getSelectedRepo()
    if (!repo) return

    set({ isLoadingReleases: true })
    try {
      const releases = await github.listReleases(repo.fullName)
      const { activeSubRepoDir } = get()
      set(s => {
        const update: Partial<GitHubState> = { releases, isLoadingReleases: false }
        if (activeSubRepoDir && s.subRepoStates[activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [activeSubRepoDir]: { ...s.subRepoStates[activeSubRepoDir], releases, isLoadingReleases: false },
          }
        }
        return update
      })
    } catch {
      set(s => {
        const update: Partial<GitHubState> = { releases: [], isLoadingReleases: false }
        if (s.activeSubRepoDir && s.subRepoStates[s.activeSubRepoDir]) {
          update.subRepoStates = {
            ...s.subRepoStates,
            [s.activeSubRepoDir]: { ...s.subRepoStates[s.activeSubRepoDir], releases: [], isLoadingReleases: false },
          }
        }
        return update
      })
    }
  },

  createRelease: async (data) => {
    const repo = get().getSelectedRepo()
    if (!repo) return null

    const url = await github.createRelease(repo.fullName, data)
    if (url) {
      await get().loadReleases()
    }
    return url
  },

  // Local git / project actions
  setWorkingDirectory: (dir: string) => {
    set({
      workingDirectory: dir,
      // Clear stale data from previous project
      autoDetectedRepo: null,
      selectedRepoId: null,
      localGitInfo: null,
      branches: [],
      pullRequests: [],
      commits: [],
      releases: [],
      // Clear multi-repo state
      discoveredRepos: [],
      subRepoStates: {},
      activeSubRepoDir: null,
    })
  },

  refreshLocalGitInfo: async () => {
    const { workingDirectory, repositories, activeSubRepoDir } = get()
    const dir = activeSubRepoDir || workingDirectory
    if (!dir) {
      set({ localGitInfo: null, autoDetectedRepo: null })
      return
    }
    try {
      const info = await github.getLocalGitInfo(dir)
      const detected = buildAutoDetectedRepo(info, repositories)
      set({
        localGitInfo: info,
        ...detected,
      })

      // Also update sub-repo state if applicable
      if (activeSubRepoDir && get().subRepoStates[activeSubRepoDir]) {
        set(s => ({
          subRepoStates: {
            ...s.subRepoStates,
            [activeSubRepoDir]: {
              ...s.subRepoStates[activeSubRepoDir],
              localGitInfo: info,
              ...detected,
            },
          },
        }))
      }
    } catch {
      set({ localGitInfo: { isGitRepo: false }, autoDetectedRepo: null })
    }
  },

  // Multi-repo discovery
  discoverSubRepos: async () => {
    const { workingDirectory, repositories } = get()
    if (!workingDirectory) return

    try {
      const repos = await github.discoverSubRepos(workingDirectory)
      const subRepoStates: Record<string, SubRepoState> = {}

      for (const repo of repos) {
        const detected = buildAutoDetectedRepo(repo.gitInfo, repositories)
        subRepoStates[repo.path] = {
          ...createEmptySubRepoState(repo.path, repo.label, repo.isRoot),
          localGitInfo: repo.gitInfo,
          ...detected,
        }
      }

      // Auto-select: if there's a root repo, select it; otherwise first child
      const activeDir = repos.length > 0 ? repos[0].path : null

      set({ discoveredRepos: repos, subRepoStates })

      // Set active sub-repo (which mirrors data to top-level)
      if (activeDir) {
        get().setActiveSubRepo(activeDir)
      } else {
        set({ activeSubRepoDir: null })
      }
    } catch (err) {
      ctx.log.error('Failed to discover sub-repos:', err)
    }
  },

  setActiveSubRepo: (dir: string) => {
    const { subRepoStates } = get()
    const sub = subRepoStates[dir]
    if (!sub) return

    // Mirror sub-repo data to top-level fields
    set({
      activeSubRepoDir: dir,
      localGitInfo: sub.localGitInfo,
      autoDetectedRepo: sub.autoDetectedRepo,
      selectedRepoId: sub.selectedRepoId,
      branches: sub.branches,
      pullRequests: sub.pullRequests,
      commits: sub.commits,
      releases: sub.releases,
      isLoadingBranches: sub.isLoadingBranches,
      isLoadingPRs: sub.isLoadingPRs,
      isLoadingCommits: sub.isLoadingCommits,
      isLoadingReleases: sub.isLoadingReleases,
    })
  },

  // Repo management
  createRepositoryFromProject: async (name, options) => {
    const { workingDirectory, activeSubRepoDir } = get()
    const dir = activeSubRepoDir || workingDirectory
    if (!dir) return null
    const url = await github.createRepositoryFromProject(dir, name, options)
    if (url) {
      // Refresh local git info after creating
      await get().refreshLocalGitInfo()
    }
    return url
  },

  deleteRepository: async (nameWithOwner) => {
    return await github.deleteRepository(nameWithOwner)
  },

  setToken: async (value: string) => {
    try {
      await github.setToken(value)
      await get().initialize()
      return { success: true }
    } catch (e) {
      const error = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
      set({ error })
      return { success: false, error }
    }
  },

  importGhCliToken: async () => {
    try {
      return await get().setToken(await github.tokenFromGhCli())
    } catch (e) {
      const error = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)
      set({ error })
      return { success: false, error }
    }
  },

  signOut: async () => {
    await github.clearToken()
    set({ isAuthenticated: false, user: null, username: null, ghInstalled: false, error: null, repoDetails: {} })
  },

  // Clear error
  clearError: () => {
    set({ error: null })
  },
}))
}
