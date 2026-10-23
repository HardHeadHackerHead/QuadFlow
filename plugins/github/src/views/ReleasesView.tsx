import { useState, useEffect } from 'react'
import ExternalLink from './ExternalLink'
import { useGitHubStore } from '../model'
import type { GitHubRelease } from '../services'
import { useServices } from '../model'
import RepoSelector from './RepoSelector'

type ReleaseViewState =
  | { view: 'list' }
  | { view: 'detail'; release: GitHubRelease }
  | { view: 'create' }

export default function ReleasesView() {
  const github = useServices()
  const {
    releases,
    isLoadingReleases,
    loadReleases,
    createRelease,
    getSelectedRepo,
  } = useGitHubStore()

  const selectedRepo = getSelectedRepo()

  const [viewState, setViewState] = useState<ReleaseViewState>({ view: 'list' })

  // Create release form
  const [releaseTag, setReleaseTag] = useState('')
  const [releaseTitle, setReleaseTitle] = useState('')
  const [releaseNotes, setReleaseNotes] = useState('')
  const [releaseDraft, setReleaseDraft] = useState(false)
  const [releasePrerelease, setReleasePrerelease] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  // Detail state
  const [detailRelease, setDetailRelease] = useState<GitHubRelease | null>(null)

  useEffect(() => {
    if (selectedRepo) {
      loadReleases()
    }
  }, [selectedRepo?.fullName, loadReleases])

  const handleRepoChange = () => {
    loadReleases()
  }

  const handleViewRelease = async (release: GitHubRelease) => {
    // For now, just show what we have. The list doesn't include body,
    // so fetch the latest release to see if it matches
    const repo = getSelectedRepo()
    if (!repo) return
    const latest = await github.getLatestRelease(repo.fullName)
    if (latest && latest.tagName === release.tagName) {
      setDetailRelease(latest)
    } else {
      setDetailRelease(release)
    }
    setViewState({ view: 'detail', release })
  }

  const handleCreateRelease = async () => {
    if (!releaseTag.trim()) return
    setIsCreating(true)
    const url = await createRelease({
      tag: releaseTag.trim(),
      title: releaseTitle || undefined,
      notes: releaseNotes || undefined,
      draft: releaseDraft,
      prerelease: releasePrerelease,
    })
    setIsCreating(false)
    if (url) {
      setReleaseTag('')
      setReleaseTitle('')
      setReleaseNotes('')
      setReleaseDraft(false)
      setReleasePrerelease(false)
      setViewState({ view: 'list' })
    }
  }

  // Create form
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
            <span className="font-medium">Create Release</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Tag</label>
            <input
              type="text"
              value={releaseTag}
              onChange={(e) => setReleaseTag(e.target.value)}
              placeholder="v1.0.0"
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Title (optional)</label>
            <input
              type="text"
              value={releaseTitle}
              onChange={(e) => setReleaseTitle(e.target.value)}
              placeholder="Release title"
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Release Notes (optional)</label>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              placeholder="Describe the release..."
              rows={6}
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500 resize-none"
            />
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="draft-release"
                checked={releaseDraft}
                onChange={(e) => setReleaseDraft(e.target.checked)}
                className="rounded border-vibe-border"
              />
              <label htmlFor="draft-release" className="text-sm">Draft</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="prerelease"
                checked={releasePrerelease}
                onChange={(e) => setReleasePrerelease(e.target.checked)}
                className="rounded border-vibe-border"
              />
              <label htmlFor="prerelease" className="text-sm">Pre-release</label>
            </div>
          </div>
          <button
            onClick={handleCreateRelease}
            disabled={!releaseTag.trim() || isCreating}
            className="w-full py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {isCreating ? 'Creating...' : 'Create Release'}
          </button>
        </div>
      </div>
    )
  }

  // Detail view
  if (viewState.view === 'detail' && detailRelease) {
    const release = detailRelease
    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 border-b border-vibe-border p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setViewState({ view: 'list' }); setDetailRelease(null) }}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium">{release.name || release.tagName}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs px-2 py-0.5 bg-teal-500/20 text-teal-400 rounded font-mono">{release.tagName}</span>
            {release.isDraft && (
              <span className="text-xs px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">Draft</span>
            )}
            {release.isPrerelease && (
              <span className="text-xs px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded">Pre-release</span>
            )}
          </div>

          {/* Meta */}
          <div className="text-sm text-vibe-muted space-y-1">
            {release.author && <p>Author: <span className="text-vibe-text">@{release.author.login}</span></p>}
            {release.publishedAt && <p>Published: {new Date(release.publishedAt).toLocaleString()}</p>}
          </div>

          {/* Body */}
          {release.body && (
            <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
              <p className="text-sm whitespace-pre-wrap">{release.body}</p>
            </div>
          )}

          {/* URL */}
          {release.url && (
            <ExternalLink href={release.url}
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
          <span className="font-medium">Releases</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadReleases()}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setViewState({ view: 'create' })}
              className="text-xs px-2 py-1 text-teal-400 hover:text-teal-300 border border-teal-500/30 hover:border-teal-500 rounded transition-colors"
            >
              + New Release
            </button>
          </div>
        </div>
        <RepoSelector onChange={handleRepoChange} />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {isLoadingReleases ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
          </div>
        ) : !selectedRepo ? (
          <p className="text-sm text-vibe-muted text-center py-8">
            No GitHub remote detected for this project.
          </p>
        ) : releases.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-8">No releases found.</p>
        ) : (
          releases.map((release) => (
            <button
              key={release.tagName}
              onClick={() => handleViewRelease(release)}
              className="w-full flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg hover:border-teal-500/50 transition-colors text-left"
            >
              <svg className="w-4 h-4 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-teal-400">{release.tagName}</span>
                  <p className="text-sm truncate">{release.name || ''}</p>
                </div>
                {release.publishedAt && (
                  <p className="text-xs text-vibe-muted mt-0.5">
                    {new Date(release.publishedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {release.isDraft && (
                  <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">Draft</span>
                )}
                {release.isPrerelease && (
                  <span className="text-xs px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded">Pre</span>
                )}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
