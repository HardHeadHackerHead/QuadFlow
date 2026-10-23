import { useCallback, useRef, useEffect, useState } from 'react'
import { shortcut } from '../../lib/platformKeys'
import { useSidebarStore } from '../../stores/sidebarStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useFileExplorerStore } from '../../stores/fileExplorerStore'
import SidebarFileTree from './SidebarFileTree'

const COLLAPSED_WIDTH = 6

export default function FileBrowserSidebar() {
  const { isOpen, isCollapsed, side, width, setSide, setWidth, toggleCollapse } = useSidebarStore()
  const globalWorkingDirectory = useTerminalStore(s => s.globalWorkingDirectory)
  const collapseAll = useFileExplorerStore(s => s.collapseAll)
  const [hoveringCollapsed, setHoveringCollapsed] = useState(false)

  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const projectName = globalWorkingDirectory
    ? globalWorkingDirectory.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Project'
    : 'No Project'

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    startX.current = e.clientX
    startWidth.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const delta = side === 'left'
        ? e.clientX - startX.current
        : startX.current - e.clientX
      setWidth(startWidth.current + delta)
    }
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
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
  }, [side, setWidth])

  if (!isOpen) return null

  // Ultra-minimal collapsed state: thin edge strip
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
        title={`Expand file browser (${shortcut('B')})`}
      >
        {/* Subtle center dot indicator */}
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
        {/* Folder icon + name */}
        <svg className="w-3.5 h-3.5 text-teal-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="text-xs font-medium text-vibe-text truncate flex-1" title={globalWorkingDirectory || ''}>
          {projectName}
        </span>

        {/* Collapse all */}
        <button
          onClick={collapseAll}
          className="p-0.5 text-vibe-muted hover:text-vibe-text transition-colors"
          title="Collapse all folders"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>

        {/* Side toggle */}
        <button
          onClick={() => setSide(side === 'left' ? 'right' : 'left')}
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

      {/* Tree content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <SidebarFileTree />
      </div>

      {/* Resize handle */}
      <div
        className={`absolute top-0 ${resizeEdge} w-1 h-full cursor-col-resize hover:bg-teal-500/30 active:bg-teal-500/50 transition-colors z-10`}
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}
