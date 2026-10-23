import { useCallback, useRef, useEffect, useState, useMemo, type RefObject } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useProjectSidebarStore, type ProjectSortBy } from '../../stores/projectSidebarStore'
import { useProjectStore } from '../../stores/projectStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSwitchProject } from '../../hooks/useSwitchProject'
import { relativeTime } from '../../lib/timeUtils'
import { terminalApi } from '../../lib/tauri-api'
import { getLiveTerminalCountsByProject } from '../../lib/appData'
import type { Project } from '../../types'

const SORT_LABELS: Record<ProjectSortBy, string> = {
  name: 'Name',
  recent: 'Recent',
  created: 'Created',
}
const SORT_CYCLE: ProjectSortBy[] = ['recent', 'name', 'created']

export function ProjectSectionControls() {
  const { sortBy, setSortBy, sortDir, toggleSortDir } = useProjectSidebarStore()

  const cycleSortBy = () => {
    const idx = SORT_CYCLE.indexOf(sortBy)
    setSortBy(SORT_CYCLE[(idx + 1) % SORT_CYCLE.length])
  }

  return (
    <>
      <button
        onClick={cycleSortBy}
        className="flex items-center gap-1 px-1 py-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
        title="Click to cycle sort field"
      >
        <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
        </svg>
        <span className="text-[10px]">{SORT_LABELS[sortBy]}</span>
      </button>
      <button
        onClick={toggleSortDir}
        className="p-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
        title={`Direction: ${sortDir === 'asc' ? 'Ascending' : 'Descending'}`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {sortDir === 'asc' ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          )}
        </svg>
      </button>
    </>
  )
}

interface ProjectRowProps {
  project: Project
  isActive: boolean
  isHidden: boolean
  isSwitching: boolean
  termCount: number
  needsAttention: boolean
  renamingId: string | null
  renameValue: string
  renameRef: RefObject<HTMLInputElement>
  setRenameValue: (v: string) => void
  handleRename: () => void
  setRenamingId: (id: string | null) => void
  handleSwitch: (project: Project) => void
  setContextMenu: (menu: { x: number; y: number; projectId: string } | null) => void
}

function ProjectRow({
  project, isActive, isHidden, isSwitching, termCount, needsAttention,
  renamingId, renameValue, renameRef, setRenameValue, handleRename, setRenamingId,
  handleSwitch, setContextMenu,
}: ProjectRowProps) {
  return (
    <div
      className={`group px-2 py-1.5 cursor-pointer transition-colors border-l-2 ${
        isActive
          ? 'bg-teal-600/15 border-teal-500'
          : 'border-transparent hover:bg-vibe-border/30'
      } ${isHidden ? 'opacity-50' : ''} ${isSwitching ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={() => handleSwitch(project)}
      onContextMenu={e => {
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY, projectId: project.id })
      }}
    >
      {renamingId === project.id ? (
        <input
          ref={renameRef}
          type="text"
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setRenamingId(null)
          }}
          onBlur={handleRename}
          onClick={e => e.stopPropagation()}
          className="w-full px-1.5 py-0.5 bg-vibe-bg border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-teal-500/50"
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <svg className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-teal-400' : 'text-vibe-muted'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className={`text-xs font-medium truncate flex-1 ${isActive ? 'text-teal-300' : 'text-vibe-text'}`}>
            {project.name}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {needsAttention && (
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse flex-shrink-0" title="Waiting for input" />
            )}
            {termCount > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-400" title={`${termCount} active terminal${termCount !== 1 ? 's' : ''}`}>
                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {termCount}
              </span>
            ) : (
              <span className="text-[10px] text-vibe-muted whitespace-nowrap">
                {relativeTime(project.updatedAt)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface ProjectSectionProps {
  searchQuery: string
}

export default function ProjectSection({ searchQuery }: ProjectSectionProps) {
  const {
    sortBy, sortDir,
    hiddenProjectIds, keepTerminalsAlive,
    toggleProjectHidden, setKeepTerminalsAlive,
  } = useProjectSidebarStore()

  const { projects, activeProject, loadProjects, deleteProject, updateProject, touchProject } = useProjectStore()
  const terminals = useTerminalStore(s => s.terminals)
  const { switchToProject, handleOpenFolder } = useSwitchProject()

  // Per-project terminal counts from the Rust backend (all live PTYs, not just active project)
  const [projectTerminalCounts, setProjectTerminalCounts] = useState<Record<string, number>>({})
  const prevCountsRef = useRef<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const livePtys = await terminalApi.list()
        const liveIds = livePtys.map(p => p.id)
        const counts = await getLiveTerminalCountsByProject(liveIds)
        if (cancelled) return

        // Detect projects that went from 0 terminals → >0 terminals and bump their updatedAt
        const prev = prevCountsRef.current
        for (const projectId of Object.keys(counts)) {
          if ((counts[projectId] || 0) > 0 && (prev[projectId] || 0) === 0) {
            touchProject(projectId)
          }
        }
        prevCountsRef.current = counts

        setProjectTerminalCounts(counts)
      } catch {
        // ignore
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Also refresh counts when the active project's terminals change
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const livePtys = await terminalApi.list()
        const liveIds = livePtys.map(p => p.id)
        const counts = await getLiveTerminalCountsByProject(liveIds)
        if (!cancelled) setProjectTerminalCounts(counts)
      } catch {
        // ignore
      }
    }
    refresh()
    return () => { cancelled = true }
  }, [terminals])

  const activeNeedsAttention = useMemo(() => {
    let any = false
    terminals.forEach(t => { if (t.needsAttention) any = true })
    return any
  }, [terminals])

  const [showHidden, setShowHidden] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; projectId: string } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadProjects() }, [loadProjects])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renamingId])

  const { visibleProjects, hiddenProjects } = useMemo(() => {
    const sortList = (list: typeof projects) => [...list].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'name') cmp = a.name.localeCompare(b.name)
      else if (sortBy === 'recent') cmp = b.updatedAt - a.updatedAt
      else if (sortBy === 'created') cmp = b.createdAt - a.createdAt
      return sortDir === 'asc' ? -cmp : cmp
    })

    let searchFiltered = projects
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      searchFiltered = searchFiltered.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.workingDirectory.toLowerCase().includes(q)
      )
    }

    return {
      visibleProjects: sortList(searchFiltered.filter(p => !hiddenProjectIds.includes(p.id))),
      hiddenProjects: sortList(searchFiltered.filter(p => hiddenProjectIds.includes(p.id))),
    }
  }, [projects, hiddenProjectIds, searchQuery, sortBy, sortDir])

  const handleSwitch = async (project: typeof projects[0]) => {
    if (project.id === activeProject?.id) return
    setSwitchingId(project.id)
    try { await switchToProject(project) } finally { setSwitchingId(null) }
  }

  const handleRename = useCallback(async () => {
    if (renamingId && renameValue.trim()) {
      await updateProject(renamingId, { name: renameValue.trim() })
    }
    setRenamingId(null)
  }, [renamingId, renameValue, updateProject])

  return (
    <>
      {/* Section header */}
      <div className="px-2 pt-3 pb-1 flex items-center justify-between flex-shrink-0 border-t border-vibe-border">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-vibe-muted">
          Projects ({projects.length})
        </div>
        <ProjectSectionControls />
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto">
        {visibleProjects.map(project => (
          <ProjectRow
            key={project.id}
            project={project}
            isActive={project.id === activeProject?.id}
            isHidden={false}
            isSwitching={switchingId === project.id}
            termCount={projectTerminalCounts[project.id] || 0}
            needsAttention={project.id === activeProject?.id && activeNeedsAttention}
            renamingId={renamingId}
            renameValue={renameValue}
            renameRef={renameRef}
            setRenameValue={setRenameValue}
            handleRename={handleRename}
            setRenamingId={setRenamingId}
            handleSwitch={handleSwitch}
            setContextMenu={setContextMenu}
          />
        ))}

        {visibleProjects.length === 0 && hiddenProjects.length === 0 && (
          <div className="px-3 py-4 text-xs text-vibe-muted text-center">
            {searchQuery ? 'No matching projects' : 'No projects yet'}
          </div>
        )}

        {/* Hidden projects section */}
        {hiddenProjects.length > 0 && (
          <>
            <button
              onClick={() => setShowHidden(!showHidden)}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-1 text-left hover:bg-vibe-border/20 transition-colors border-t border-vibe-border/50"
            >
              <svg className={`w-3 h-3 text-vibe-muted flex-shrink-0 transition-transform ${showHidden ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-[10px] text-vibe-muted">
                Hidden ({hiddenProjects.length})
              </span>
            </button>
            {showHidden && hiddenProjects.map(project => (
              <ProjectRow
                key={project.id}
                project={project}
                isActive={project.id === activeProject?.id}
                isHidden={true}
                isSwitching={switchingId === project.id}
                termCount={projectTerminalCounts[project.id] || 0}
                needsAttention={project.id === activeProject?.id && activeNeedsAttention}
                renamingId={renamingId}
                renameValue={renameValue}
                renameRef={renameRef}
                setRenameValue={setRenameValue}
                handleRename={handleRename}
                setRenamingId={setRenamingId}
                handleSwitch={handleSwitch}
                setContextMenu={setContextMenu}
              />
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-vibe-border flex-shrink-0">
        <button
          onClick={() => setKeepTerminalsAlive(!keepTerminalsAlive)}
          className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-vibe-border/30 transition-colors"
          title="Keep terminals alive when switching projects"
        >
          <div className={`w-3 h-3 rounded border flex items-center justify-center flex-shrink-0 ${
            keepTerminalsAlive ? 'bg-teal-500 border-teal-500' : 'border-vibe-border'
          }`}>
            {keepTerminalsAlive && (
              <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
          <span className="text-[10px] text-vibe-muted">Keep terminals alive</span>
        </button>

        <button
          onClick={handleOpenFolder}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-vibe-border/30 transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-xs text-vibe-text">Open Folder...</span>
        </button>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed bg-vibe-surface border border-vibe-border rounded-md shadow-lg z-[100] py-1 min-w-[140px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1 text-xs text-left text-vibe-text hover:bg-vibe-border/50 transition-colors"
            onClick={() => {
              const p = projects.find(p => p.id === contextMenu.projectId)
              if (p) { setRenamingId(p.id); setRenameValue(p.name) }
              setContextMenu(null)
            }}
          >
            Rename
          </button>
          <button
            className="w-full px-3 py-1 text-xs text-left text-vibe-text hover:bg-vibe-border/50 transition-colors"
            onClick={() => { toggleProjectHidden(contextMenu.projectId); setContextMenu(null) }}
          >
            {hiddenProjectIds.includes(contextMenu.projectId) ? 'Unhide' : 'Hide'}
          </button>
          <button
            className="w-full px-3 py-1 text-xs text-left text-vibe-text hover:bg-vibe-border/50 transition-colors"
            onClick={async () => {
              const p = projects.find(p => p.id === contextMenu.projectId)
              if (p) { try { await revealItemInDir(p.workingDirectory) } catch (err) { console.error('Open in Explorer failed:', err) } }
              setContextMenu(null)
            }}
          >
            Open in Explorer
          </button>
          <div className="border-t border-vibe-border my-0.5" />
          <button
            className={`w-full px-3 py-1 text-xs text-left transition-colors ${contextMenu.projectId === activeProject?.id ? 'text-vibe-muted cursor-not-allowed' : 'text-red-400 hover:bg-red-500/10'}`}
            disabled={contextMenu.projectId === activeProject?.id}
            onClick={async () => {
              const p = projects.find(p => p.id === contextMenu.projectId)
              if (p && p.id !== activeProject?.id) { await deleteProject(p.id) }
              setContextMenu(null)
            }}
          >
            {contextMenu.projectId === activeProject?.id ? 'Remove (active)' : 'Remove'}
          </button>
        </div>
      )}
    </>
  )
}
