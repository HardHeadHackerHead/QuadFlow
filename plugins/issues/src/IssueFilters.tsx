import { useState, useEffect, useRef } from 'react'
import { IssueFilters as IssueFiltersType, IssueLabel, IssuePriority, IssueStatus } from './types'

interface IssueFiltersProps {
  filters: IssueFiltersType
  labels: IssueLabel[]
  onFiltersChange: (filters: Partial<IssueFiltersType>) => void
}

export default function IssueFilters({ filters, labels, onFiltersChange }: IssueFiltersProps) {
  const [localSearch, setLocalSearch] = useState(filters.search)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Sync local search when filters.search changes externally (e.g. clearFilters)
  useEffect(() => {
    setLocalSearch(filters.search)
  }, [filters.search])

  const handleSearchChange = (value: string) => {
    setLocalSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onFiltersChange({ search: value })
    }, 250)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const statusOptions: { value: IssueStatus | 'all'; label: string }[] = [
    { value: 'all', label: 'All statuses' },
    { value: 'backlog', label: 'Backlog' },
    { value: 'todo', label: 'To Do' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'blocked', label: 'Blocked' },
    { value: 'needs_human', label: 'Needs Human' },
  ]

  const priorityOptions: { value: IssuePriority | 'all'; label: string }[] = [
    { value: 'all', label: 'All priorities' },
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
    { value: 'low', label: 'Low' },
  ]

  return (
    <div className="flex flex-col gap-2">
      {/* Status, Priority and search row */}
      <div className="flex items-center gap-2">
        {/* Status dropdown */}
        <select
          value={filters.status}
          onChange={(e) => onFiltersChange({ status: e.target.value as IssueStatus | 'all' })}
          aria-label="Filter by status"
          className="bg-vibe-bg border border-vibe-border rounded-lg px-2 py-1.5 text-xs text-vibe-text focus:outline-none focus:border-teal-500"
        >
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* Priority dropdown */}
        <select
          value={filters.priority}
          onChange={(e) => onFiltersChange({ priority: e.target.value as IssuePriority | 'all' })}
          aria-label="Filter by priority"
          className="bg-vibe-bg border border-vibe-border rounded-lg px-2 py-1.5 text-xs text-vibe-text focus:outline-none focus:border-teal-500"
        >
          {priorityOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* Label filter dropdown */}
        {labels.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const label = e.target.value
              if (label && !filters.labels.includes(label)) {
                onFiltersChange({ labels: [...filters.labels, label] })
              }
            }}
            aria-label="Add label filter"
            className="bg-vibe-bg border border-vibe-border rounded-lg px-2 py-1.5 text-xs text-vibe-text focus:outline-none focus:border-teal-500"
          >
            <option value="">Add label filter...</option>
            {labels
              .filter((l) => !filters.labels.includes(l.name))
              .map((label) => (
                <option key={label.id} value={label.name}>
                  {label.name}
                </option>
              ))}
          </select>
        )}

        {/* Search input */}
        <div className="flex-1 relative">
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-vibe-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search issues..."
            aria-label="Search issues"
            className="w-full bg-vibe-bg border border-vibe-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-teal-500"
          />
        </div>

        {/* Not blocked checkbox */}
        <label className="flex items-center gap-1.5 text-xs text-vibe-muted hover:text-vibe-text cursor-pointer flex-shrink-0">
          <input
            type="checkbox"
            checked={filters.hideBlocked}
            onChange={(e) => onFiltersChange({ hideBlocked: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-vibe-border bg-vibe-bg text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
          />
          Not blocked
        </label>

        {/* Show completed checkbox */}
        <label className="flex items-center gap-1.5 text-xs text-vibe-muted hover:text-vibe-text cursor-pointer flex-shrink-0">
          <input
            type="checkbox"
            checked={filters.showCompleted}
            onChange={(e) => onFiltersChange({ showCompleted: e.target.checked })}
            className="w-3.5 h-3.5 rounded border-vibe-border bg-vibe-bg text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
          />
          Show completed
        </label>
      </div>

      {/* Active label filters */}
      {filters.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filters.labels.map((labelName) => {
            const label = labels.find((l) => l.name === labelName)
            return (
              <button
                key={labelName}
                onClick={() => onFiltersChange({ labels: filters.labels.filter((l) => l !== labelName) })}
                aria-label={`Remove ${labelName} filter`}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-vibe-bg-lighter border border-vibe-border hover:border-red-500 transition-colors"
              >
                {label && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                )}
                {labelName}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
