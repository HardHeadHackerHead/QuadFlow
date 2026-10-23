import { useEffect, useState } from 'react'
import { useGitHubStore } from '../model'
import { useGitStatusStore } from '../model'
import { useProjectRoot } from '../model'
import StatusView from './StatusView'
import CheckpointsView from './CheckpointsView'
import ReposView from './ReposView'
import BranchesView from './BranchesView'
import PullRequestsView from './PullRequestsView'
import CommitsView from './CommitsView'
import ReleasesView from './ReleasesView'
import GitHubSettings from './GitHubSettings'
import IssuesSyncView from './IssuesSyncView'
import TokenSetup from './TokenSetup'
import RepoHeader from './RepoHeader'

export type ActiveTab = 'status' | 'checkpoints' | 'repos' | 'branches' | 'prs' | 'commits' | 'releases' | 'issues' | 'settings'

const tabs: { id: ActiveTab; label: string; requiresAuth?: boolean }[] = [
  { id: 'status', label: 'Status' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'repos', label: 'Repos', requiresAuth: true },
  { id: 'branches', label: 'Branches', requiresAuth: true },
  { id: 'prs', label: 'PRs', requiresAuth: true },
  { id: 'commits', label: 'Commits', requiresAuth: true },
  { id: 'releases', label: 'Releases', requiresAuth: true },
  { id: 'issues', label: 'Issues', requiresAuth: true },
  { id: 'settings', label: 'Settings' },
]

function GitHubSettingsView() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <span className="font-medium">Settings</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <GitHubSettings />
      </div>
    </div>
  )
}

export default function GitHubToolView({ initialTab = 'status', tabRequest }: { initialTab?: ActiveTab; tabRequest?: { tab: ActiveTab; n: number } | null }) {
  const {
    isAuthenticated,
    isLoading,
    error,
    initialize,
    clearError,
    setWorkingDirectory,
    refreshLocalGitInfo,
    discoveredRepos,
    activeSubRepoDir,
    discoverSubRepos,
    setActiveSubRepo,
  } = useGitHubStore()

  const globalWorkingDirectory = useProjectRoot()
  const gitStatuses = useGitStatusStore(s => s.statuses)

  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab)
  useEffect(() => {
    if (tabRequest) setActiveTab(tabRequest.tab)
  }, [tabRequest])

  // Sync working directory from terminal store
  useEffect(() => {
    if (globalWorkingDirectory) {
      setWorkingDirectory(globalWorkingDirectory)
    }
  }, [globalWorkingDirectory, setWorkingDirectory])

  useEffect(() => {
    initialize()
  }, [initialize])

  // Discover sub-repos when working directory changes
  useEffect(() => {
    if (globalWorkingDirectory) {
      discoverSubRepos()
    }
  }, [globalWorkingDirectory, discoverSubRepos])

  // Refresh local git info once authenticated
  useEffect(() => {
    if (isAuthenticated && globalWorkingDirectory) {
      refreshLocalGitInfo()
    }
  }, [isAuthenticated, globalWorkingDirectory, refreshLocalGitInfo])

  // Determine active directory for Status/Checkpoints
  const activeDir = activeSubRepoDir || globalWorkingDirectory

  // Show outer tabs only when multiple repos discovered
  const showRepoTabs = discoveredRepos.length > 1

  // Check if current tab requires auth
  const currentTabConfig = tabs.find(t => t.id === activeTab)
  const needsAuthForTab = currentTabConfig?.requiresAuth && !isAuthenticated

  // Auth prompt component for tabs that require it
  const AuthPrompt = () => (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-4">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-vibe-muted opacity-50" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          <h3 className="text-base font-medium">GitHub Login Required</h3>
          <p className="text-sm text-vibe-muted mt-1">This tab needs a GitHub token</p>
        </div>

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
            <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-sm text-red-400 flex-1">{error}</span>
            <button onClick={clearError} className="p-0.5 text-red-400 hover:text-red-300">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <TokenSetup />
      </div>
    </div>
  )

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Outer repo tab bar - only when multiple repos */}
      {showRepoTabs && (
        <div className="flex-shrink-0 px-2 pt-2 pb-1 border-b border-vibe-border bg-vibe-bg">
          <div className="flex gap-1 overflow-x-auto">
            {discoveredRepos.map((repo) => {
              const isActive = activeSubRepoDir === repo.path
              const dirStatus = gitStatuses[repo.path]
              const isDirty = dirStatus && (dirStatus.staged > 0 || dirStatus.modified > 0 || dirStatus.untracked > 0)
              return (
                <button
                  key={repo.path}
                  onClick={() => setActiveSubRepo(repo.path)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-teal-500/15 text-teal-400 border border-teal-500/30'
                      : 'bg-vibe-surface text-vibe-muted hover:text-vibe-text border border-transparent hover:border-vibe-border'
                  }`}
                  title={repo.path}
                >
                  {repo.label}
                  {isDirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 flex-shrink-0" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Active repo header - always visible */}
      <RepoHeader />

      {/* Inner tab navigation - always visible */}
      <div className="flex-shrink-0 border-b border-vibe-border">
        <div className="flex overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              data-testid={`github-tab-${tab.id}`}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-teal-500 text-teal-400'
                  : 'border-transparent text-vibe-muted hover:text-vibe-text hover:border-vibe-border'
              }`}
            >
              {tab.label}
              {tab.requiresAuth && !isAuthenticated && (
                <svg className="w-3 h-3 ml-1 inline-block opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Active tab content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <div className="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full" />
          </div>
        ) : needsAuthForTab ? (
          <AuthPrompt />
        ) : (
          <>
            {activeTab === 'status' && <StatusView activeDir={activeDir} />}
            {activeTab === 'checkpoints' && <CheckpointsView activeDir={activeDir} />}
            {activeTab === 'repos' && <ReposView />}
            {activeTab === 'branches' && <BranchesView />}
            {activeTab === 'prs' && <PullRequestsView />}
            {activeTab === 'commits' && <CommitsView />}
            {activeTab === 'releases' && <ReleasesView />}
            {activeTab === 'issues' && <IssuesSyncView />}
            {activeTab === 'settings' && <GitHubSettingsView />}
          </>
        )}
      </div>
    </div>
  )
}
