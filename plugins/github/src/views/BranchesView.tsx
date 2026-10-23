import { useState, useEffect } from 'react'
import { useGitHubStore } from '../model'
import RepoSelector from './RepoSelector'

export default function BranchesView() {
  const {
    branches,
    isLoadingBranches,
    loadBranches,
    createBranch,
    deleteBranch,
    getSelectedRepo,
  } = useGitHubStore()

  const selectedRepo = getSelectedRepo()

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [fromBranch, setFromBranch] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null)

  useEffect(() => {
    if (selectedRepo) {
      loadBranches()
    }
  }, [selectedRepo?.fullName, loadBranches])

  const handleRepoChange = () => {
    loadBranches()
  }

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return
    setIsCreating(true)
    const success = await createBranch(newBranchName.trim(), fromBranch || undefined)
    setIsCreating(false)
    if (success) {
      setNewBranchName('')
      setFromBranch('')
      setShowCreateForm(false)
    }
  }

  const handleDeleteBranch = async (name: string) => {
    setDeletingBranch(name)
    await deleteBranch(name)
    setDeletingBranch(null)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-vibe-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">Branches</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => loadBranches()}
              className="p-1 text-vibe-muted hover:text-vibe-text transition-colors"
              title="Refresh"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="text-xs px-2 py-1 text-teal-400 hover:text-teal-300 border border-teal-500/30 hover:border-teal-500 rounded transition-colors"
            >
              + New Branch
            </button>
          </div>
        </div>
        <RepoSelector onChange={handleRepoChange} />
      </div>

      {showCreateForm && (
        <div className="flex-shrink-0 border-b border-vibe-border p-3 bg-vibe-bg-lighter space-y-2">
          <input
            type="text"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder="Branch name"
            className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
          />
          <select
            value={fromBranch}
            onChange={(e) => setFromBranch(e.target.value)}
            className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm text-vibe-text focus:outline-none focus:border-teal-500"
          >
            <option value="">From default branch</option>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={handleCreateBranch}
              disabled={!newBranchName.trim() || isCreating}
              className="flex-1 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
            >
              {isCreating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => { setShowCreateForm(false); setNewBranchName(''); setFromBranch('') }}
              className="px-4 py-2 bg-vibe-bg border border-vibe-border hover:border-vibe-text/30 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {isLoadingBranches ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full" />
          </div>
        ) : !selectedRepo ? (
          <p className="text-sm text-vibe-muted text-center py-8">
            No GitHub remote detected for this project.
          </p>
        ) : branches.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-8">No branches found.</p>
        ) : (
          branches.map((branch) => (
            <div
              key={branch.name}
              className="flex items-center gap-3 p-3 bg-vibe-bg border border-vibe-border rounded-lg group"
            >
              <svg className="w-4 h-4 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{branch.name}</p>
                <p className="text-xs text-vibe-muted font-mono truncate">{branch.sha.substring(0, 7)}</p>
              </div>
              <div className="flex items-center gap-2">
                {branch.protected && (
                  <span className="text-xs px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">Protected</span>
                )}
                {!branch.protected && (
                  <button
                    onClick={() => handleDeleteBranch(branch.name)}
                    disabled={deletingBranch === branch.name}
                    className="p-1 text-vibe-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                    title="Delete branch"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
