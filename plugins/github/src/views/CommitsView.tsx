import { useState, useEffect } from 'react'
import ExternalLink from './ExternalLink'
import { useGitHubStore } from '../model'
import type { GitHubCommit } from '../services'
import { useServices } from '../model'
import type { GitHubCommitDetail } from '../services'
import RepoSelector from './RepoSelector'

type CommitViewState =
  | { view: 'list' }
  | { view: 'detail'; commit: GitHubCommitDetail }

export default function CommitsView() {
  const github = useServices()
  const {
    commits,
    isLoadingCommits,
    branches,
    loadCommits,
    loadBranches,
    getSelectedRepo,
  } = useGitHubStore()

  const selectedRepo = getSelectedRepo()

  const [viewState, setViewState] = useState<CommitViewState>({ view: 'list' })
  const [selectedBranch, setSelectedBranch] = useState('')
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)

  useEffect(() => {
    if (selectedRepo) {
      loadCommits()
      loadBranches()
    }
  }, [selectedRepo?.fullName, loadCommits, loadBranches])

  const handleRepoChange = () => {
    setSelectedBranch('')
    loadCommits()
    loadBranches()
  }

  const handleBranchChange = (branch: string) => {
    setSelectedBranch(branch)
    loadCommits(branch || undefined)
  }

  const handleViewCommit = async (commit: GitHubCommit) => {
    const repo = getSelectedRepo()
    if (!repo) return
    setIsLoadingDetail(true)
    const detail = await github.getCommit(repo.fullName, commit.sha)
    setIsLoadingDetail(false)
    if (detail) {
      setViewState({ view: 'detail', commit: detail })
    }
  }

  if (viewState.view === 'detail') {
    const commit = viewState.commit
    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 border-b border-vibe-border p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewState({ view: 'list' })}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium font-mono text-sm">{commit.sha.substring(0, 7)}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Commit message */}
          <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
            <p className="text-sm whitespace-pre-wrap">{commit.message}</p>
          </div>

          {/* Meta */}
          <div className="text-sm text-vibe-muted space-y-1">
            <p>Author: <span className="text-vibe-text">{commit.author}</span>{commit.login ? ` (@${commit.login})` : ''}</p>
            <p>Date: {new Date(commit.date).toLocaleString()}</p>
            <p className="font-mono text-xs">SHA: {commit.sha}</p>
          </div>

          {/* Stats */}
          {commit.stats && (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-green-400">+{commit.stats.additions}</span>
              <span className="text-red-400">-{commit.stats.deletions}</span>
              <span className="text-vibe-muted">{commit.stats.total} changes</span>
            </div>
          )}

          {/* Changed files */}
          {commit.files && commit.files.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Changed Files ({commit.files.length})</h4>
              <div className="space-y-1">
                {commit.files.map((file, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 bg-vibe-bg border border-vibe-border rounded text-xs">
                    <span className={`px-1 rounded ${
                      file.status === 'added' ? 'bg-green-500/20 text-green-400' :
                      file.status === 'removed' ? 'bg-red-500/20 text-red-400' :
                      'bg-yellow-500/20 text-yellow-400'
                    }`}>
                      {file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : 'M'}
                    </span>
                    <span className="font-mono truncate flex-1">{file.filename}</span>
                    <span className="text-green-400">+{file.additions}</span>
                    <span className="text-red-400">-{file.deletions}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* URL */}
          {commit.url && (
            <ExternalLink href={commit.url}
              className="block text-xs text-teal-400 hover:underline"
            >
              View on GitHub →
            </ExternalLink>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-vibe-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">Commits</span>
          <button
            onClick={() => loadCommits(selectedBranch || undefined)}
            className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
        <RepoSelector onChange={handleRepoChange} />
        <select
          value={selectedBranch}
          onChange={(e) => handleBranchChange(e.target.value)}
          className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm text-vibe-text focus:outline-none focus:border-teal-500"
        >
          <option value="">Default branch</option>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>{b.name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {isLoadingCommits || isLoadingDetail ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
          </div>
        ) : !selectedRepo ? (
          <p className="text-sm text-vibe-muted text-center py-8">
            No GitHub remote detected for this project.
          </p>
        ) : commits.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-8">No commits found.</p>
        ) : (
          commits.map((commit) => (
            <button
              key={commit.sha}
              onClick={() => handleViewCommit(commit)}
              className="w-full flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg hover:border-teal-500/50 transition-colors text-left"
            >
              <span className="text-xs font-mono text-teal-400 flex-shrink-0">{commit.sha.substring(0, 7)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{commit.message.split('\n')[0]}</p>
                <p className="text-xs text-vibe-muted mt-0.5">
                  {commit.author}{commit.login ? ` (@${commit.login})` : ''} · {new Date(commit.date).toLocaleDateString()}
                </p>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
