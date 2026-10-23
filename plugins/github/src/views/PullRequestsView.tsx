import { useState, useEffect } from 'react'
import ExternalLink from './ExternalLink'
import { useGitHubStore } from '../model'
import type { GitHubPullRequest } from '../services'
import { useServices } from '../model'
import RepoSelector from './RepoSelector'

type PRViewState =
  | { view: 'list' }
  | { view: 'detail'; pr: GitHubPullRequest }
  | { view: 'create' }

export default function PullRequestsView() {
  const github = useServices()
  const {
    pullRequests,
    isLoadingPRs,
    branches,
    loadPullRequests,
    loadBranches,
    createPullRequest,
    mergePullRequest,
    closePullRequest,
    getSelectedRepo,
  } = useGitHubStore()

  const selectedRepo = getSelectedRepo()

  const [viewState, setViewState] = useState<PRViewState>({ view: 'list' })
  const [prFilter, setPrFilter] = useState<string>('open')

  // Create PR form
  const [prTitle, setPrTitle] = useState('')
  const [prBody, setPrBody] = useState('')
  const [prHead, setPrHead] = useState('')
  const [prBase, setPrBase] = useState('')
  const [prDraft, setPrDraft] = useState(false)
  const [isCreatingPR, setIsCreatingPR] = useState(false)

  // Detail view state
  const [detailPR, setDetailPR] = useState<GitHubPullRequest | null>(null)
  const [isMerging, setIsMerging] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<'merge' | 'squash' | 'rebase'>('merge')

  useEffect(() => {
    if (selectedRepo) {
      loadPullRequests(prFilter)
    }
  }, [selectedRepo?.fullName, prFilter, loadPullRequests])

  const handleRepoChange = () => {
    loadPullRequests(prFilter)
    loadBranches()
  }

  const handleViewPR = async (pr: GitHubPullRequest) => {
    const repo = getSelectedRepo()
    if (!repo) return
    // Fetch full PR details
    const fullPR = await github.getPullRequest(repo.fullName, pr.number)
    setDetailPR(fullPR || pr)
    setViewState({ view: 'detail', pr: fullPR || pr })
  }

  const handleCreatePR = async () => {
    if (!prTitle.trim() || !prHead) return
    setIsCreatingPR(true)
    const url = await createPullRequest({
      title: prTitle.trim(),
      body: prBody || undefined,
      head: prHead,
      base: prBase || undefined,
      draft: prDraft,
    })
    setIsCreatingPR(false)
    if (url) {
      setPrTitle('')
      setPrBody('')
      setPrHead('')
      setPrBase('')
      setPrDraft(false)
      setViewState({ view: 'list' })
    }
  }

  const handleMergePR = async (number: number) => {
    setIsMerging(true)
    await mergePullRequest(number, mergeMethod)
    setIsMerging(false)
    setViewState({ view: 'list' })
  }

  const handleClosePR = async (number: number) => {
    setIsClosing(true)
    await closePullRequest(number)
    setIsClosing(false)
    setViewState({ view: 'list' })
  }

  const handleOpenCreate = () => {
    loadBranches()
    setViewState({ view: 'create' })
  }

  // Create PR form
  if (viewState.view === 'create') {
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
            <span className="font-medium">Create Pull Request</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="PR title"
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description (optional)</label>
            <textarea
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              placeholder="Describe the changes..."
              rows={4}
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500 resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">Head branch</label>
              <select
                value={prHead}
                onChange={(e) => setPrHead(e.target.value)}
                className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm text-vibe-text focus:outline-none focus:border-teal-500"
              >
                <option value="">Select branch</option>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Base branch</label>
              <select
                value={prBase}
                onChange={(e) => setPrBase(e.target.value)}
                className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm text-vibe-text focus:outline-none focus:border-teal-500"
              >
                <option value="">Default branch</option>
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="draft-pr"
              checked={prDraft}
              onChange={(e) => setPrDraft(e.target.checked)}
              className="rounded border-vibe-border"
            />
            <label htmlFor="draft-pr" className="text-sm">Create as draft</label>
          </div>
          <button
            onClick={handleCreatePR}
            disabled={!prTitle.trim() || !prHead || isCreatingPR}
            className="w-full py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {isCreatingPR ? 'Creating...' : 'Create Pull Request'}
          </button>
        </div>
      </div>
    )
  }

  // PR detail view
  if (viewState.view === 'detail' && detailPR) {
    const pr = detailPR
    const isOpen = pr.state === 'OPEN' || pr.state === 'open'

    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 border-b border-vibe-border p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setViewState({ view: 'list' }); setDetailPR(null) }}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium">#{pr.number} {pr.title}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Status badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded ${
              isOpen ? 'bg-green-500/20 text-green-400' :
              pr.mergedAt ? 'bg-purple-500/20 text-purple-400' :
              'bg-red-500/20 text-red-400'
            }`}>
              {pr.mergedAt ? 'Merged' : isOpen ? 'Open' : 'Closed'}
            </span>
            {pr.isDraft && (
              <span className="text-xs px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded">Draft</span>
            )}
            <span className="text-xs text-vibe-muted">
              {pr.headRefName} → {pr.baseRefName}
            </span>
          </div>

          {/* Author & dates */}
          <div className="text-sm text-vibe-muted space-y-1">
            <p>Author: <span className="text-vibe-text">{pr.author?.login || 'Unknown'}</span></p>
            <p>Created: {new Date(pr.createdAt).toLocaleString()}</p>
            {pr.mergedAt && <p>Merged: {new Date(pr.mergedAt).toLocaleString()}</p>}
            {pr.closedAt && !pr.mergedAt && <p>Closed: {new Date(pr.closedAt).toLocaleString()}</p>}
          </div>

          {/* Body */}
          {pr.body && (
            <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
              <p className="text-sm whitespace-pre-wrap">{pr.body}</p>
            </div>
          )}

          {/* Actions */}
          {isOpen && (
            <div className="space-y-3 pt-2 border-t border-vibe-border">
              <div className="flex items-center gap-2">
                <label className="text-sm text-vibe-muted">Merge method:</label>
                <select
                  value={mergeMethod}
                  onChange={(e) => setMergeMethod(e.target.value as 'merge' | 'squash' | 'rebase')}
                  className="px-2 py-1 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none"
                >
                  <option value="merge">Merge commit</option>
                  <option value="squash">Squash and merge</option>
                  <option value="rebase">Rebase and merge</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleMergePR(pr.number)}
                  disabled={isMerging}
                  className="flex-1 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                >
                  {isMerging ? 'Merging...' : 'Merge'}
                </button>
                <button
                  onClick={() => handleClosePR(pr.number)}
                  disabled={isClosing}
                  className="px-4 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-400 disabled:opacity-50 rounded-lg text-sm transition-colors"
                >
                  {isClosing ? 'Closing...' : 'Close'}
                </button>
              </div>
            </div>
          )}

          {/* URL */}
          {pr.url && (
            <ExternalLink href={pr.url}
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
          <span className="font-medium">Pull Requests</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadPullRequests(prFilter)}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={handleOpenCreate}
              className="text-xs px-2 py-1 text-teal-400 hover:text-teal-300 border border-teal-500/30 hover:border-teal-500 rounded transition-colors"
            >
              + New PR
            </button>
          </div>
        </div>
        <RepoSelector onChange={handleRepoChange} />
        <div className="flex gap-1">
          {['open', 'closed', 'all'].map((state) => (
            <button
              key={state}
              onClick={() => setPrFilter(state)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                prFilter === state
                  ? 'bg-teal-500/20 text-teal-400 border border-teal-500/30'
                  : 'text-vibe-muted hover:text-vibe-text border border-transparent'
              }`}
            >
              {state.charAt(0).toUpperCase() + state.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {isLoadingPRs ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
          </div>
        ) : !selectedRepo ? (
          <p className="text-sm text-vibe-muted text-center py-8">
            No GitHub remote detected for this project.
          </p>
        ) : pullRequests.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-8">No pull requests found.</p>
        ) : (
          pullRequests.map((pr) => {
            const isOpen = pr.state === 'OPEN' || pr.state === 'open'
            return (
              <button
                key={pr.number}
                onClick={() => handleViewPR(pr)}
                className="w-full flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg hover:border-teal-500/50 transition-colors text-left"
              >
                <svg className={`w-4 h-4 flex-shrink-0 ${isOpen ? 'text-green-400' : 'text-red-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-vibe-muted">#{pr.number}</span>
                    <p className="text-sm font-medium truncate">{pr.title}</p>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-vibe-muted">{pr.headRefName} → {pr.baseRefName}</span>
                    {pr.isDraft && <span className="text-xs text-gray-500">Draft</span>}
                  </div>
                </div>
                <span className="text-xs text-vibe-muted flex-shrink-0">
                  {pr.author?.login}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
