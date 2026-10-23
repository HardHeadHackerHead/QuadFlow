import { useEffect } from 'react'
import { usePluginContext } from '@quadflow/plugin-api'
import { useGitHubStore } from '../model'

export default function RepoHeader() {
  const ctx = usePluginContext()
  const {
    isAuthenticated,
    repoDetails,
    loadRepoDetails,
    getSelectedRepo,
    autoDetectedRepo,
  } = useGitHubStore()

  const selectedRepo = getSelectedRepo()
  const fullName = selectedRepo?.fullName ?? null
  const details = fullName ? repoDetails[fullName] : undefined
  const isAutoDetected = !!(autoDetectedRepo && selectedRepo?.id === autoDetectedRepo.id)

  useEffect(() => {
    if (isAuthenticated && fullName) {
      loadRepoDetails(fullName)
    }
  }, [isAuthenticated, fullName, loadRepoDetails])

  if (!fullName) {
    return (
      <div className="flex-shrink-0 border-b border-vibe-border px-3 py-2 bg-vibe-bg">
        <div className="text-xs text-vibe-muted">
          No GitHub repo detected — add a git remote or connect a repo in the Repos tab.
        </div>
      </div>
    )
  }

  const url = details?.url ?? `https://github.com/${fullName}`
  const description = details?.description ?? null
  const isPrivate = details?.isPrivate

  const handleOpen = async () => {
    try {
      await ctx.shell.openExternal(url)
    } catch (error) {
      ctx.log.error('Failed to open repo URL:', error)
    }
  }

  return (
    <div className="flex-shrink-0 border-b border-vibe-border px-3 py-2 bg-vibe-bg">
      <div className="flex items-center gap-2 min-w-0">
        <svg className="w-4 h-4 text-vibe-text flex-shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
        <span className="text-sm font-medium truncate" title={fullName}>{fullName}</span>

        {isPrivate !== undefined && (
          <span
            className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border flex-shrink-0 flex items-center gap-1 ${
              isPrivate
                ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
                : 'text-vibe-muted border-vibe-border bg-vibe-surface'
            }`}
            title={isPrivate ? 'Private repository' : 'Public repository'}
          >
            {isPrivate ? (
              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            ) : null}
            {isPrivate ? 'Private' : 'Public'}
          </span>
        )}

        {isAutoDetected && (
          <span className="text-[10px] text-vibe-muted flex-shrink-0">(detected)</span>
        )}

        <div className="flex-1" />

        <button
          onClick={handleOpen}
          className="p-1 text-vibe-muted hover:text-teal-400 transition-colors flex-shrink-0"
          title={`Open ${fullName} on GitHub`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>

      {description && (
        <div className="mt-0.5 text-xs text-vibe-muted truncate pl-6" title={description}>
          {description}
        </div>
      )}
    </div>
  )
}
