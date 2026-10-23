import { useState, useEffect } from 'react'
import { useGitHubStore } from '../model'
import type { ConnectedRepository } from '../stores/githubStore'
import type { GitHubRepository } from '../services'
import { useServices } from '../model'
import type { ProjectType } from '../services'

type RepoViewState =
  | { view: 'main' }
  | { view: 'create' }
  | { view: 'connect' }

export default function ReposView() {
  const {
    repositories,
    defaultRepository,
    localGitInfo,
    workingDirectory,
    loadUserRepositories,
    addRepository,
    removeRepository,
    setDefaultRepository,
    createRepositoryFromProject,
    refreshLocalGitInfo,
  } = useGitHubStore()

  const [viewState, setViewState] = useState<RepoViewState>({ view: 'main' })

  // Connect repo browser state
  const [availableRepos, setAvailableRepos] = useState<GitHubRepository[]>([])
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const [searchFilter, setSearchFilter] = useState('')

  // Create repo form
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoDesc, setNewRepoDesc] = useState('')
  const [newRepoPrivate, setNewRepoPrivate] = useState(false)
  const [pushOnCreate, setPushOnCreate] = useState(true)
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    refreshLocalGitInfo()
  }, [refreshLocalGitInfo])

  // Pre-fill repo name from folder name
  useEffect(() => {
    if (workingDirectory && !newRepoName) {
      const parts = workingDirectory.replace(/\\/g, '/').split('/')
      const folderName = parts[parts.length - 1] || ''
      setNewRepoName(folderName.toLowerCase().replace(/\s+/g, '-'))
    }
  }, [workingDirectory, newRepoName])

  const handleCreateRepo = async () => {
    if (!newRepoName.trim()) return
    setIsCreating(true)
    const url = await createRepositoryFromProject(newRepoName.trim(), {
      description: newRepoDesc || undefined,
      isPrivate: newRepoPrivate,
      push: pushOnCreate,
    })
    setIsCreating(false)
    if (url) {
      setNewRepoName('')
      setNewRepoDesc('')
      setNewRepoPrivate(false)
      setViewState({ view: 'main' })
      // Auto-connect the new repo
      const repos = await loadUserRepositories()
      const created = repos.find((r) => r.name === newRepoName.trim())
      if (created) {
        await addRepository(created)
      }
    }
  }

  const handleBrowseRepos = async () => {
    setIsLoadingRepos(true)
    setViewState({ view: 'connect' })
    const repos = await loadUserRepositories()
    setAvailableRepos(repos)
    setIsLoadingRepos(false)
  }

  const handleAddRepository = async (repo: GitHubRepository) => {
    await addRepository(repo)
    setAvailableRepos((prev) => prev.filter((r) => r.id !== repo.id))
  }

  const filteredAvailableRepos = availableRepos
    .filter((repo) => !repositories.some((r) => r.fullName === repo.nameWithOwner))
    .filter((repo) =>
      !searchFilter || repo.nameWithOwner.toLowerCase().includes(searchFilter.toLowerCase())
    )

  // Create repository form (from project)
  if (viewState.view === 'create') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 border-b border-vibe-border p-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewState({ view: 'main' })}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium">Create GitHub Repository</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Show project context */}
          <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
            <p className="text-xs text-vibe-muted mb-1">Creating from project:</p>
            <p className="text-sm font-mono truncate">{workingDirectory}</p>
            {localGitInfo?.isGitRepo ? (
              <p className="text-xs text-green-400 mt-1">Git repository detected</p>
            ) : (
              <p className="text-xs text-yellow-400 mt-1">Not a git repo yet - will be initialized</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Repository Name</label>
            <input
              type="text"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
              placeholder="my-project"
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description (optional)</label>
            <input
              type="text"
              value={newRepoDesc}
              onChange={(e) => setNewRepoDesc(e.target.value)}
              placeholder="A short description"
              className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="private-repo"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
                className="rounded border-vibe-border"
              />
              <label htmlFor="private-repo" className="text-sm">Private repository</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="push-on-create"
                checked={pushOnCreate}
                onChange={(e) => setPushOnCreate(e.target.checked)}
                className="rounded border-vibe-border"
              />
              <label htmlFor="push-on-create" className="text-sm">Push code after creating</label>
            </div>
          </div>
          <button
            onClick={handleCreateRepo}
            disabled={!newRepoName.trim() || isCreating}
            className="w-full py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {isCreating ? 'Creating...' : 'Create Repository'}
          </button>
        </div>
      </div>
    )
  }

  // Connect existing repo browser
  if (viewState.view === 'connect') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 border-b border-vibe-border p-3">
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setViewState({ view: 'main' })}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="font-medium">Connect Repository</span>
          </div>
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filter repositories..."
            className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {isLoadingRepos ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
            </div>
          ) : filteredAvailableRepos.length === 0 ? (
            <p className="text-sm text-vibe-muted text-center py-8">
              {availableRepos.length === 0 ? 'No repositories found' : 'All repositories are already connected'}
            </p>
          ) : (
            filteredAvailableRepos.map((repo) => (
              <button
                key={repo.id}
                onClick={() => handleAddRepository(repo)}
                className="w-full flex items-center gap-3 p-3 bg-vibe-bg-lighter border border-vibe-border rounded-lg hover:border-teal-500 transition-colors text-left"
              >
                <svg className="w-5 h-5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate text-sm">{repo.nameWithOwner}</p>
                  {repo.description && (
                    <p className="text-xs text-vibe-muted truncate">{repo.description}</p>
                  )}
                </div>
                {repo.isPrivate && (
                  <span className="text-xs px-2 py-0.5 bg-vibe-bg border border-vibe-border rounded flex-shrink-0">Private</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  // Main view - project-centric
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">Repository</span>
          <button
            onClick={() => refreshLocalGitInfo()}
            className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
            title="Refresh"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Project info */}
        <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
          <p className="text-xs text-vibe-muted mb-1">Project Directory</p>
          <p className="text-sm font-mono truncate">{workingDirectory || 'No project open'}</p>
        </div>

        {/* Local git status */}
        {localGitInfo?.isGitRepo ? (
          <>
            {/* Git repo info */}
            <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg space-y-2">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                </svg>
                <span className="text-sm font-medium">Git Repository</span>
              </div>

              {localGitInfo.currentBranch && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-vibe-muted">Branch:</span>
                  <span className="font-mono text-teal-400">{localGitInfo.currentBranch}</span>
                </div>
              )}

              {localGitInfo.nameWithOwner ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-vibe-muted">Remote:</span>
                  <span className="font-mono">{localGitInfo.nameWithOwner}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-yellow-400">No GitHub remote</span>
                </div>
              )}

              {localGitInfo.remoteUrl && !localGitInfo.nameWithOwner && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-vibe-muted">Remote URL:</span>
                  <span className="font-mono text-xs truncate">{localGitInfo.remoteUrl}</span>
                </div>
              )}

              {localGitInfo.hasUncommittedChanges && (
                <p className="text-xs text-yellow-400">Uncommitted changes</p>
              )}
            </div>

            {/* If no remote, offer to create one */}
            {!localGitInfo.nameWithOwner && (
              <button
                onClick={() => setViewState({ view: 'create' })}
                className="w-full py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-sm font-medium transition-colors"
              >
                Push to GitHub
              </button>
            )}
          </>
        ) : (
          <>
            {/* Not a git repo */}
            <div className="p-3 bg-vibe-bg border border-vibe-border rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-sm text-vibe-muted">Not a git repository</span>
              </div>
              <p className="text-xs text-vibe-muted">
                Create a GitHub repository to start tracking this project.
              </p>
            </div>
            <button
              onClick={() => setViewState({ view: 'create' })}
              className="w-full py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-sm font-medium transition-colors"
            >
              Create GitHub Repository
            </button>
          </>
        )}

        {/* Gitignore management */}
        {localGitInfo?.isGitRepo && workingDirectory && (
          <GitignoreSection workingDirectory={workingDirectory} />
        )}

        {/* Connected repos section */}
        <div className="pt-2 border-t border-vibe-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-vibe-muted">Connected Repositories</span>
            <button
              onClick={handleBrowseRepos}
              className="text-xs text-teal-400 hover:text-teal-300"
            >
              + Connect
            </button>
          </div>
          {repositories.length === 0 ? (
            <p className="text-xs text-vibe-muted p-2">
              No repositories connected for issue sync and other features.
            </p>
          ) : (
            <div className="space-y-1">
              {repositories.map((repo) => (
                <RepoCard
                  key={repo.id}
                  repo={repo}
                  isDefault={defaultRepository?.id === repo.id}
                  isCurrentProject={localGitInfo?.nameWithOwner === repo.fullName}
                  onSetDefault={() => setDefaultRepository(repo.id)}
                  onRemove={() => removeRepository(repo.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GitignoreSection({ workingDirectory }: { workingDirectory: string }) {
  const github = useServices()
  const [hasFile, setHasFile] = useState<boolean | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [detectedTypes, setDetectedTypes] = useState<ProjectType[]>([])

  useEffect(() => {
    checkGitignore()
  }, [workingDirectory])

  const checkGitignore = async () => {
    const exists = await github.hasGitignore(workingDirectory)
    setHasFile(exists)
    if (exists) {
      const text = await github.readGitignore(workingDirectory)
      setContent(text)
    } else {
      setContent(null)
    }
    const types = await github.detectProjectTypes(workingDirectory)
    setDetectedTypes(types)
  }

  const handleCreate = async () => {
    setIsRegenerating(true)
    const result = await github.regenerateGitignore(workingDirectory)
    if (result) {
      setContent(result)
      setHasFile(true)
    }
    setIsRegenerating(false)
  }

  const handleRegenerate = async () => {
    setIsRegenerating(true)
    const result = await github.regenerateGitignore(workingDirectory)
    if (result) {
      setContent(result)
      setEditContent(result)
    }
    setIsRegenerating(false)
  }

  const handleStartEdit = () => {
    setEditContent(content || '')
    setIsEditing(true)
  }

  const handleSave = async () => {
    setIsSaving(true)
    const success = await github.writeGitignore(workingDirectory, editContent)
    if (success) {
      setContent(editContent)
      setIsEditing(false)
    }
    setIsSaving(false)
  }

  if (hasFile === null) return null

  return (
    <div className="pt-2 border-t border-vibe-border">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-vibe-muted">.gitignore</span>
          {hasFile ? (
            <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-400 rounded">exists</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 bg-yellow-500/10 text-yellow-400 rounded">missing</span>
          )}
        </div>
        {detectedTypes.length > 0 && (
          <span className="text-xs text-vibe-muted">
            {detectedTypes.join(', ')}
          </span>
        )}
      </div>

      {!hasFile ? (
        <button
          onClick={handleCreate}
          disabled={isRegenerating}
          className="w-full py-2 text-sm bg-vibe-bg border border-vibe-border rounded-lg hover:border-teal-500/50 hover:bg-teal-500/10 transition-colors disabled:opacity-50"
        >
          {isRegenerating ? 'Generating...' : 'Generate .gitignore'}
        </button>
      ) : isEditing ? (
        <div className="space-y-2">
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            rows={12}
            className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-xs font-mono text-vibe-text focus:outline-none focus:border-teal-500 resize-y"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex-1 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg font-medium transition-colors"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={handleRegenerate}
              disabled={isRegenerating}
              className="px-3 py-1.5 text-xs bg-vibe-bg border border-vibe-border hover:border-yellow-500/50 text-vibe-muted hover:text-yellow-400 rounded-lg transition-colors disabled:opacity-50"
              title="Regenerate from project type detection (overwrites editor)"
            >
              {isRegenerating ? '...' : 'Regenerate'}
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="px-3 py-1.5 text-xs bg-vibe-bg border border-vibe-border hover:border-vibe-text/30 text-vibe-muted rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-between p-2 bg-vibe-bg border border-vibe-border rounded-lg text-xs text-vibe-muted hover:text-vibe-text transition-colors"
          >
            <span className="font-mono">{content ? `${content.split('\n').length} lines` : 'empty'}</span>
            <div className="flex items-center gap-2">
              <span
                onClick={(e) => { e.stopPropagation(); handleStartEdit() }}
                className="text-teal-400 hover:text-teal-300 cursor-pointer"
              >
                Edit
              </span>
              <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </button>
          {expanded && content && (
            <pre className="mt-1 p-2 bg-vibe-bg border border-vibe-border rounded-lg text-xs font-mono text-vibe-muted overflow-x-auto max-h-48 overflow-y-auto whitespace-pre">
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function RepoCard({
  repo,
  isDefault,
  isCurrentProject,
  onSetDefault,
  onRemove,
}: {
  repo: ConnectedRepository
  isDefault: boolean
  isCurrentProject: boolean
  onSetDefault: () => void
  onRemove: () => void
}) {
  return (
    <div className={`flex items-center gap-3 p-3 bg-vibe-bg border rounded-lg group ${
      isCurrentProject ? 'border-teal-500/30' : 'border-vibe-border'
    }`}>
      <svg className="w-4 h-4 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <div className="flex items-center gap-1.5">
        {isCurrentProject && (
          <span className="text-xs px-1.5 py-0.5 bg-teal-500/10 text-teal-400 rounded">This project</span>
        )}
        {isDefault ? (
          <span className="text-xs px-1.5 py-0.5 bg-teal-500/20 text-teal-400 rounded">Default</span>
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
          title="Remove"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
