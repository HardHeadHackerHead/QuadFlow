import { useCallback, useRef, useEffect, useState } from 'react'
import { shortcut } from '../../lib/platformKeys'
import { useSidebarStore } from '../../stores/sidebarStore'
import { useProjectSidebarStore } from '../../stores/projectSidebarStore'
import { useProjectStore } from '../../stores/projectStore'
import ProjectSection from '../sidebar/ProjectSection'
import WorkspaceSection from '../sidebar/WorkspaceSection'

const COLLAPSED_WIDTH = 6

export default function ProjectSidebar() {
  const fileBrowserSide = useSidebarStore(s => s.side)
  const side = fileBrowserSide === 'left' ? 'right' : 'left'

  const {
    isOpen, isCollapsed, width, searchQuery, dividerPercent, workspacesOnTop,
    toggleCollapse, setWidth, setSearchQuery, setDividerPercent, toggleWorkspacesOnTop,
  } = useProjectSidebarStore()

  const { activeProject, loadProjects } = useProjectStore()

  const [hoveringCollapsed, setHoveringCollapsed] = useState(false)

  // Width resize refs
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // Divider drag refs
  const containerRef = useRef<HTMLDivElement>(null)
  const isDividerDragging = useRef(false)
  const dividerStartY = useRef(0)
  const dividerStartPct = useRef(0)

  useEffect(() => {
    if (isOpen) loadProjects()
  }, [isOpen, loadProjects])

  // Width resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  // Divider drag handler
  const handleDividerStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDividerDragging.current = true
    dividerStartY.current = e.clientY
    dividerStartPct.current = dividerPercent
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [dividerPercent])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing.current) {
        const delta = side === 'left'
          ? e.clientX - startX.current
          : startX.current - e.clientX
        setWidth(startWidth.current + delta)
      }
      if (isDividerDragging.current && containerRef.current) {
        const containerHeight = containerRef.current.getBoundingClientRect().height
        if (containerHeight > 0) {
          const deltaY = e.clientY - dividerStartY.current
          const deltaPct = (deltaY / containerHeight) * 100
          setDividerPercent(dividerStartPct.current + deltaPct)
        }
      }
    }
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      if (isDividerDragging.current) {
        isDividerDragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [side, setWidth, setDividerPercent])

  const sideToggle = () => {
    useSidebarStore.getState().setSide(fileBrowserSide === 'left' ? 'right' : 'left')
  }

  if (!isOpen) return null

  // Collapsed state
  if (isCollapsed) {
    return (
      <div
        className={`flex-shrink-0 cursor-pointer transition-all duration-150 ${
          side === 'left' ? 'border-r' : 'border-l'
        } ${
          hoveringCollapsed
            ? 'border-teal-500/60 bg-teal-500/10'
            : 'border-vibe-border/50 bg-transparent'
        }`}
        style={{ width: COLLAPSED_WIDTH, minWidth: COLLAPSED_WIDTH }}
        onClick={toggleCollapse}
        onMouseEnter={() => setHoveringCollapsed(true)}
        onMouseLeave={() => setHoveringCollapsed(false)}
        title={`Expand sidebar (${shortcut('Shift', 'B')})`}
      >
        <div className="h-full flex items-center justify-center">
          <div className={`w-1 h-8 rounded-full transition-colors duration-150 ${
            hoveringCollapsed ? 'bg-teal-500/50' : 'bg-vibe-border/30'
          }`} />
        </div>
      </div>
    )
  }

  const resizeEdge = side === 'left' ? 'right-0' : 'left-0'

  return (
    <div
      className={`relative flex-shrink-0 h-full min-h-0 bg-vibe-bg ${
        side === 'left' ? 'border-r' : 'border-l'
      } border-vibe-border flex flex-col overflow-hidden`}
      style={{
        width,
        minWidth: width,
        transition: isResizing.current ? 'none' : 'width 200ms ease-out',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-vibe-surface border-b border-vibe-border flex-shrink-0">
        <svg className="w-3.5 h-3.5 text-teal-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="text-xs font-medium text-vibe-text truncate flex-1">
          {activeProject?.name || 'No Project'}
        </span>

        {/* Swap sections */}
        <button
          onClick={toggleWorkspacesOnTop}
          className="p-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
          title={workspacesOnTop ? 'Move projects to top' : 'Move workspaces to top'}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </button>

        {/* Side toggle */}
        <button
          onClick={sideToggle}
          className="p-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
          title={`Move to ${side === 'left' ? 'right' : 'left'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {side === 'left' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            )}
          </svg>
        </button>

        {/* Collapse */}
        <button
          onClick={toggleCollapse}
          className="p-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
          title="Collapse sidebar"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {side === 'left' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7" />
            )}
          </svg>
        </button>
      </div>

      {/* Search — filters both sections */}
      <div className="px-2 py-1.5 border-b border-vibe-border flex-shrink-0">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Filter..."
          className="w-full px-2 py-1 bg-vibe-bg border border-vibe-border rounded text-xs text-vibe-text placeholder-vibe-muted focus:outline-none focus:border-teal-500/50"
        />
      </div>

      {/* Two-pane body with draggable divider */}
      <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Top pane */}
        <div
          className="overflow-y-auto flex flex-col flex-shrink-0"
          style={{ height: `${dividerPercent}%` }}
        >
          {workspacesOnTop
            ? <WorkspaceSection searchQuery={searchQuery} />
            : <ProjectSection searchQuery={searchQuery} />}
        </div>

        {/* Draggable divider */}
        <div
          className="flex-shrink-0 h-1 cursor-row-resize hover:bg-teal-500/30 active:bg-teal-500/50 transition-colors bg-vibe-border/30"
          onMouseDown={handleDividerStart}
        />

        {/* Bottom pane */}
        <div
          className="overflow-y-auto flex flex-col min-h-0"
          style={{ height: `${100 - dividerPercent}%` }}
        >
          {workspacesOnTop
            ? <ProjectSection searchQuery={searchQuery} />
            : <WorkspaceSection searchQuery={searchQuery} />}
        </div>
      </div>

      {/* Width resize handle */}
      <div
        className={`absolute top-0 ${resizeEdge} w-1 h-full cursor-col-resize hover:bg-teal-500/30 active:bg-teal-500/50 transition-colors z-10`}
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}
