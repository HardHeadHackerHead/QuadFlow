import { useState, useRef, useEffect } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useSessionStore } from '../../stores/sessionStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { useToolDragState } from '../tools/ToolDragContext'
import { switchWorkspace } from '../../lib/workspaceSave'
import { Session } from '../../types'

interface PinnedWorkspaceButtonProps {
  session: Session
}

export default function PinnedWorkspaceButton({ session }: PinnedWorkspaceButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { activeSession, toggleWorkspacePinned, updateWorkspacePinSection } = useSessionStore()
  const isActive = activeSession?.id === session.id

  const sortableId = `workspace-toolbar-${session.id}`
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: sortableId })

  const dragState = useToolDragState()
  const isDragActive = dragState.activeId !== null

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  useOverlayRegistration(`pinned-workspace-${session.id}`, showDropdown)

  // Close on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDropdown])

  // Close on escape
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDropdown(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [showDropdown])

  const handleClick = async () => {
    if (isDragActive || isActive) return
    // Saves the current workspace first (the old handler did not).
    await switchWorkspace(session.id)
  }

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isDragActive) {
      setShowDropdown(!showDropdown)
    }
  }

  const handleUnpin = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleWorkspacePinned(session.id)
    setShowDropdown(false)
  }

  const handleMoveSection = (section: 'left' | 'center' | 'right') => {
    updateWorkspacePinSection(session.id, section)
    setShowDropdown(false)
  }

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {isOver && isDragActive && (
        <div className="absolute -left-0.5 top-1 bottom-1 w-0.5 bg-teal-400 rounded-full shadow-[0_0_6px_rgba(20,184,166,0.6)]" />
      )}
      <div ref={dropdownRef}>
        <button
          onClick={handleClick}
          onContextMenu={handleRightClick}
          className={`flex items-center gap-1.5 px-2 h-8 rounded border text-xs transition-colors ${
            isActive
              ? 'bg-vibe-primary/10 border-vibe-primary/50 text-vibe-primary font-medium'
              : 'bg-vibe-surface border-vibe-border text-vibe-muted hover:bg-vibe-border/50 hover:text-vibe-text'
          }`}
          title={`Switch to "${session.name}" (right-click for options)`}
          {...attributes}
          {...listeners}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="truncate max-w-[80px]">{session.name}</span>
        </button>

        {/* Context menu */}
        {showDropdown && (
          <div className="absolute top-full left-0 mt-1 w-44 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
            {/* Section options */}
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-vibe-muted font-semibold">Move to</div>
            {(['left', 'center', 'right'] as const).map((section) => (
              <button
                key={section}
                onClick={(e) => { e.stopPropagation(); handleMoveSection(section) }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  session.pinSection === section
                    ? 'text-vibe-primary bg-vibe-primary/5'
                    : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
                }`}
              >
                {section.charAt(0).toUpperCase() + section.slice(1)}
                {session.pinSection === section && (
                  <svg className="w-3 h-3 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            ))}
            <div className="border-t border-vibe-border my-1" />
            <button
              onClick={handleUnpin}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Unpin
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
