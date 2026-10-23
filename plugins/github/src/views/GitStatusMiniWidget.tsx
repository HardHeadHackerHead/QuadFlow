import { useCallback, useEffect, useRef, useState } from 'react'
import { useGitStatusStore } from '../model'
import { useGitHubStore } from '../model'
import { useProjectRoot } from '../model'

function timeAgoShort(isoString: string | null): string {
  if (!isoString) return '\u2014'
  const diffMs = Date.now() - new Date(isoString).getTime()
  if (diffMs < 0) return '0m'
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return '0m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function timeColor(isoString: string | null): string {
  if (!isoString) return 'text-vibe-muted'
  const diffMs = Date.now() - new Date(isoString).getTime()
  const hours = diffMs / 3600000
  if (hours < 1) return 'text-emerald-400'
  if (hours < 4) return 'text-yellow-400'
  return 'text-red-400'
}

function truncateLabel(label: string, max: number): string {
  return label.length > max ? label.slice(0, max - 1) + '\u2026' : label
}

export default function GitStatusMiniWidget() {
  const dir = useProjectRoot()
  const { refresh } = useGitStatusStore()
  useGitStatusStore(s => s.statuses) // re-render on status changes
  const getStatus = useGitStatusStore(s => s.getStatus)
  const rootStatus = useGitStatusStore(s => s.getStatus(dir))

  const discoveredRepos = useGitHubStore(s => s.discoveredRepos)
  const discoverSubRepos = useGitHubStore(s => s.discoverSubRepos)
  const setWorkingDirectory = useGitHubStore(s => s.setWorkingDirectory)
  const ghWorkingDirectory = useGitHubStore(s => s.workingDirectory)

  const [currentIndex, setCurrentIndex] = useState(0)
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [, setTick] = useState(0)

  // Determine if we need multi-repo mode
  const hasMultipleRepos = discoveredRepos.length > 1
  const hasSingleSubRepo = discoveredRepos.length === 1 && !discoveredRepos[0].isRoot
  const useMultiRepo = hasMultipleRepos || hasSingleSubRepo

  // Ensure githubStore working directory is synced and discovery runs
  useEffect(() => {
    if (!dir) return
    // Sync the githubStore working directory if it's stale
    if (ghWorkingDirectory !== dir) {
      setWorkingDirectory(dir)
    }
  }, [dir, ghWorkingDirectory, setWorkingDirectory])

  // Trigger sub-repo discovery when dir changes and root isn't a repo
  useEffect(() => {
    if (!dir) return
    if (!rootStatus.isGitRepo && discoveredRepos.length === 0) {
      discoverSubRepos()
    }
  }, [dir, rootStatus.isGitRepo, discoveredRepos.length, discoverSubRepos])

  // Reset index when repos change
  useEffect(() => {
    setCurrentIndex(0)
  }, [discoveredRepos.length, dir])

  // Advance to next repo
  const advance = useCallback(() => {
    if (discoveredRepos.length <= 1) return
    setCurrentIndex(i => (i + 1) % discoveredRepos.length)
  }, [discoveredRepos.length])

  // Refresh all discovered repo statuses + auto-cycle
  useEffect(() => {
    if (!dir) return

    if (useMultiRepo && discoveredRepos.length > 0) {
      // Refresh all discovered repos
      const refreshAll = () => {
        for (const repo of discoveredRepos) {
          refresh(repo.path)
        }
        setTick(t => t + 1)
      }
      refreshAll()
      refreshRef.current = setInterval(refreshAll, 30000)

      // Auto-cycle every 5s
      if (discoveredRepos.length > 1) {
        cycleRef.current = setInterval(advance, 5000)
      }
    } else {
      // Single root repo — original behavior
      refresh(dir)
      refreshRef.current = setInterval(() => {
        refresh(dir)
        setTick(t => t + 1)
      }, 30000)
    }

    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current)
      if (cycleRef.current) clearInterval(cycleRef.current)
    }
  }, [dir, useMultiRepo, discoveredRepos, refresh, advance])

  // Click to manually advance (resets auto-cycle timer)
  const handleClick = useCallback(() => {
    if (discoveredRepos.length <= 1) return
    advance()
    // Reset auto-cycle timer
    if (cycleRef.current) clearInterval(cycleRef.current)
    cycleRef.current = setInterval(advance, 5000)
  }, [discoveredRepos.length, advance])

  // Multi-repo mode: show cycling widget
  if (useMultiRepo && discoveredRepos.length > 0) {
    const safeIndex = currentIndex < discoveredRepos.length ? currentIndex : 0
    const activeRepo = discoveredRepos[safeIndex]
    const status = getStatus(activeRepo.path)

    const {
      branch, staged, modified, untracked, ahead, behind,
      lastCommitTime, hasUpstream, isGitRepo: repoIsGit,
    } = status

    if (!repoIsGit) {
      return (
        <span
          className="font-mono text-[11px] text-vibe-muted whitespace-nowrap px-1 cursor-pointer"
          onClick={handleClick}
        >
          {truncateLabel(activeRepo.label, 12)}
          {discoveredRepos.length > 1 && (
            <span className="text-vibe-muted/60 ml-1">[{safeIndex + 1}/{discoveredRepos.length}]</span>
          )}
        </span>
      )
    }

    const hasChanges = staged > 0 || modified > 0 || untracked > 0
    const showAheadBehind = hasUpstream && (ahead > 0 || behind > 0)
    const branchDisplay = branch.length > 12 ? branch.slice(0, 11) + '\u2026' : branch
    const repoLabel = truncateLabel(activeRepo.label, 10)

    return (
      <span
        className="font-mono text-[11px] whitespace-nowrap flex items-center gap-0 px-1 cursor-pointer"
        onClick={handleClick}
        title={`${activeRepo.label} (${activeRepo.path}) — click to cycle`}
      >
        {/* Repo label */}
        <span className="text-teal-400/80">{repoLabel}</span>
        <span className="text-vibe-muted mx-0.5">&middot;</span>

        {/* Branch */}
        <span className="text-vibe-text">{'\u2387'} {branchDisplay}</span>

        {/* Time since last commit */}
        <span className="text-vibe-muted mx-0.5">&middot;</span>
        <span className={timeColor(lastCommitTime)}>{timeAgoShort(lastCommitTime)}</span>

        {/* Change counts */}
        <span className="text-vibe-muted mx-0.5">&middot;</span>
        {hasChanges ? (
          <span className="flex items-center gap-0.5">
            {staged > 0 && <span className="text-emerald-400">S{staged}</span>}
            {modified > 0 && <span className="text-yellow-400">{staged > 0 ? ' ' : ''}M{modified}</span>}
            {untracked > 0 && <span className="text-blue-400">{(staged > 0 || modified > 0) ? ' ' : ''}U{untracked}</span>}
          </span>
        ) : (
          <span className="text-emerald-400/70">clean</span>
        )}

        {/* Ahead/behind */}
        {showAheadBehind && (
          <>
            <span className="text-vibe-muted mx-0.5">&middot;</span>
            <span className="text-vibe-text">
              {ahead > 0 && <span className="text-teal-400">&uarr;{ahead}</span>}
              {behind > 0 && <span className="text-orange-400">&darr;{behind}</span>}
            </span>
          </>
        )}

        {/* Position badge */}
        {discoveredRepos.length > 1 && (
          <>
            <span className="text-vibe-muted mx-0.5">&middot;</span>
            <span className="text-vibe-muted/60">[{safeIndex + 1}/{discoveredRepos.length}]</span>
          </>
        )}
      </span>
    )
  }

  // Single root repo — original behavior
  if (!rootStatus.isGitRepo) {
    return (
      <span className="font-mono text-[11px] text-vibe-muted whitespace-nowrap px-1">
        no repo
      </span>
    )
  }

  const {
    branch, staged, modified, untracked, ahead, behind,
    lastCommitTime, hasUpstream,
  } = rootStatus

  const hasChanges = staged > 0 || modified > 0 || untracked > 0
  const showAheadBehind = hasUpstream && (ahead > 0 || behind > 0)
  const branchDisplay = branch.length > 16 ? branch.slice(0, 15) + '\u2026' : branch

  return (
    <span className="font-mono text-[11px] whitespace-nowrap flex items-center gap-0 px-1">
      {/* Branch */}
      <span className="text-vibe-text">{'\u2387'} {branchDisplay}</span>

      {/* Time since last commit */}
      <span className="text-vibe-muted mx-0.5">&middot;</span>
      <span className={timeColor(lastCommitTime)}>{timeAgoShort(lastCommitTime)}</span>

      {/* Change counts */}
      <span className="text-vibe-muted mx-0.5">&middot;</span>
      {hasChanges ? (
        <span className="flex items-center gap-0.5">
          {staged > 0 && <span className="text-emerald-400">S{staged}</span>}
          {modified > 0 && <span className="text-yellow-400">{staged > 0 ? ' ' : ''}M{modified}</span>}
          {untracked > 0 && <span className="text-blue-400">{(staged > 0 || modified > 0) ? ' ' : ''}U{untracked}</span>}
        </span>
      ) : (
        <span className="text-emerald-400/70">clean</span>
      )}

      {/* Ahead/behind */}
      {showAheadBehind && (
        <>
          <span className="text-vibe-muted mx-0.5">&middot;</span>
          <span className="text-vibe-text">
            {ahead > 0 && <span className="text-teal-400">&uarr;{ahead}</span>}
            {behind > 0 && <span className="text-orange-400">&darr;{behind}</span>}
          </span>
        </>
      )}
    </span>
  )
}
