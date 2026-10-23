import { useState } from 'react'
import { Modal } from '@quadflow/ui'
import { useGitHubStore } from '../model'
import TokenSetup from './TokenSetup'
import type { ConnectedRepository } from '../stores/githubStore'
import type { GitHubRepository } from '../services'

export default function GitHubSettings() {
  const {
    isAuthenticated,
    isLoading,
    error,
    user,
    username,
    repositories,
    defaultRepository,
    signOut,
    loadUserRepositories,
    addRepository,
    removeRepository,
    setDefaultRepository,
    clearError,
  } = useGitHubStore()

  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [availableRepos, setAvailableRepos] = useState<GitHubRepository[]>([])
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)

  // Note: initialize() is NOT called here because the parent GitHubToolView
  // already calls it on mount. Calling it here would set isLoading=true in the
  // store, causing the parent to unmount all tabs (including this one), and when
  // loading finishes this component remounts and calls initialize again - an
  // infinite loop. The Settings tab is only reachable when already authenticated.


  const handleLoadRepositories = async () => {
    setIsLoadingRepos(true)
    const repos = await loadUserRepositories()
    setAvailableRepos(repos)
    setIsLoadingRepos(false)
    setShowRepoSelector(true)
  }

  const handleAddRepository = async (repo: GitHubRepository) => {
    await addRepository(repo)
    setAvailableRepos(availableRepos.filter((r) => r.id !== repo.id))
  }

  // Filter out already connected repositories
  const filteredAvailableRepos = availableRepos.filter(
    (repo) => !repositories.some((r) => r.fullName === repo.nameWithOwner)
  )

  if (isLoading) {
    return (
      <div className="p-4 bg-vibe-bg-lighter border border-vibe-border rounded-lg">
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 bg-vibe-bg-lighter border border-vibe-border rounded-lg">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <svg className="w-6 h-6 text-vibe-muted" fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
        <div className="flex-1">
          <h3 className="font-medium">GitHub Integration</h3>
          <p className="text-sm text-vibe-muted">
            {isAuthenticated ? 'Sync issues with GitHub repositories' : 'Connect with a personal access token'}
          </p>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-start gap-2">
          <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="flex-1">
            <span className="text-sm text-red-400">{error}</span>
          </div>
          <button
            onClick={clearError}
            className="p-1 text-red-400 hover:text-red-300"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {isAuthenticated && (user || username) ? (
        // Connected state
        <div className="space-y-4">
          {/* User info */}
          <div className="flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.login}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-vibe-bg-lighter flex items-center justify-center">
                <svg className="w-6 h-6 text-vibe-muted" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                </svg>
              </div>
            )}
            <div className="flex-1">
              <p className="font-medium">{user?.name || username || 'GitHub User'}</p>
              <p className="text-sm text-vibe-muted">@{user?.login || username}</p>
            </div>
            <div className="flex items-center gap-1 text-green-400">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
              </svg>
              <span className="text-xs">Connected</span>
            </div>
          </div>

          {/* Connected repositories */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium">Repositories</h4>
              <button
                onClick={handleLoadRepositories}
                disabled={isLoadingRepos}
                className="text-xs text-teal-400 hover:text-teal-300 disabled:opacity-50"
              >
                {isLoadingRepos ? 'Loading...' : '+ Add repository'}
              </button>
            </div>

            {repositories.length === 0 ? (
              <p className="text-sm text-vibe-muted p-3 bg-vibe-bg border border-vibe-border rounded-lg text-center">
                No repositories connected. Add one to start syncing issues.
              </p>
            ) : (
              <div className="space-y-2">
                {repositories.map((repo) => (
                  <RepositoryItem
                    key={repo.id}
                    repo={repo}
                    isDefault={defaultRepository?.id === repo.id}
                    onSetDefault={() => setDefaultRepository(repo.id)}
                    onRemove={() => removeRepository(repo.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Repository selector modal */}
          <Modal open={showRepoSelector} onClose={() => setShowRepoSelector(false)} title="Add Repository" size="md" overlayId="github-add-repo">
            <div className="qf-github max-h-[60vh] flex flex-col">
                {isLoadingRepos ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
                  </div>
                ) : filteredAvailableRepos.length === 0 ? (
                  <p className="text-sm text-vibe-muted text-center py-8">
                    {availableRepos.length === 0
                      ? 'No repositories found'
                      : 'All repositories are already connected'}
                  </p>
                ) : (
                  <div className="flex-1 overflow-y-auto space-y-1">
                    {filteredAvailableRepos.map((repo) => (
                      <button
                        key={repo.id}
                        onClick={() => handleAddRepository(repo)}
                        className="w-full flex items-center gap-3 p-3 bg-vibe-bg-lighter border border-vibe-border rounded-lg hover:border-teal-500 transition-colors text-left"
                      >
                        <svg className="w-5 h-5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{repo.nameWithOwner}</p>
                          {repo.description && (
                            <p className="text-xs text-vibe-muted truncate">{repo.description}</p>
                          )}
                        </div>
                        {repo.isPrivate && (
                          <span className="text-xs px-2 py-0.5 bg-vibe-bg border border-vibe-border rounded">
                            Private
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          </Modal>

          {/* Token */}
          <div className="flex items-center justify-between text-xs text-vibe-muted">
            <span>Signed in with a token stored in your OS keychain.</span>
            <button onClick={() => void signOut()} className="text-red-400 hover:text-red-300" data-testid="github-sign-out">
              Sign out
            </button>
          </div>
        </div>
      ) : (
        // Not connected state
        <TokenSetup />
      )}
    </div>
  )
}

// Repository item component
function RepositoryItem({
  repo,
  isDefault,
  onSetDefault,
  onRemove,
}: {
  repo: ConnectedRepository
  isDefault: boolean
  onSetDefault: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg group">
      <svg className="w-5 h-5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate text-sm">{repo.fullName}</p>
        {repo.lastSyncedAt && (
          <p className="text-xs text-vibe-muted">
            Last synced: {new Date(repo.lastSyncedAt).toLocaleDateString()}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {isDefault ? (
          <span className="text-xs px-2 py-0.5 bg-teal-500/20 text-teal-400 rounded">Default</span>
        ) : (
          <button
            onClick={onSetDefault}
            className="text-xs text-vibe-muted hover:text-teal-400 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Set default
          </button>
        )}
        <button
          onClick={onRemove}
          className="p-1 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Remove repository"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
