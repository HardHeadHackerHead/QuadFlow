import { useEffect } from 'react'
import { useGitHubStore } from '../model'

interface RepoSelectorProps {
  onChange?: (repoId: string) => void
}

export default function RepoSelector({ onChange }: RepoSelectorProps) {
  const { repositories, selectedRepoId, defaultRepository, autoDetectedRepo, setSelectedRepo } = useGitHubStore()

  const currentId = selectedRepoId || defaultRepository?.id || ''

  useEffect(() => {
    // If no repo is selected and we have repos, select the default
    if (!selectedRepoId && !autoDetectedRepo && defaultRepository) {
      setSelectedRepo(defaultRepository.id)
    }
  }, [selectedRepoId, autoDetectedRepo, defaultRepository, setSelectedRepo])

  // If auto-detected repo is active (not in connected repos list), show it as a label
  if (autoDetectedRepo && !selectedRepoId) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm">
        <svg className="w-3.5 h-3.5 text-teal-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <span className="truncate">{autoDetectedRepo.fullName}</span>
        <span className="text-xs text-vibe-muted flex-shrink-0">(detected)</span>
      </div>
    )
  }

  if (repositories.length === 0) {
    return (
      <div className="text-sm text-vibe-muted px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg">
        No GitHub remote detected. Add a git remote or connect a repository.
      </div>
    )
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const repoId = e.target.value
    setSelectedRepo(repoId)
    onChange?.(repoId)
  }

  return (
    <select
      value={currentId}
      onChange={handleChange}
      className="w-full px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm text-vibe-text focus:outline-none focus:border-teal-500"
    >
      {repositories.map((repo) => (
        <option key={repo.id} value={repo.id}>
          {repo.fullName}{repo.isDefault ? ' (default)' : ''}
        </option>
      ))}
    </select>
  )
}
