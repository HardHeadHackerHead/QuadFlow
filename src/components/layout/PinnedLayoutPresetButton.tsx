import { useState, useRef, useEffect } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTerminalStore } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { LAYOUT_PRESETS, LayoutPresetType } from '../../lib/layoutUtils'
import { useToolDragState } from '../tools/ToolDragContext'

interface PinnedLayoutPresetButtonProps {
  type: LayoutPresetType
}

export default function PinnedLayoutPresetButton({ type }: PinnedLayoutPresetButtonProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const preset = LAYOUT_PRESETS.find(p => p.type === type)!
  const { setLayoutPreset, currentLayoutPreset } = useTerminalStore()
  const { toggleLayoutPresetPinned } = useAppSettingsStore()
  const isActive = currentLayoutPreset === type

  const sortableId = `layout-toolbar-${type}`
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

  // Register overlay
  useOverlayRegistration(`pinned-layout-${type}`, showDropdown)

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

  const handleClick = () => {
    if (isDragActive) return
    setLayoutPreset(type)
  }

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isDragActive) {
      setShowDropdown(!showDropdown)
    }
  }

  const handleUnpin = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleLayoutPresetPinned(type)
    setShowDropdown(false)
  }

  return (
    <div ref={setNodeRef} style={style} className="relative">
      {/* Drop indicator */}
      {isOver && isDragActive && (
        <div className="absolute -left-0.5 top-1 bottom-1 w-0.5 bg-teal-400 rounded-full shadow-[0_0_6px_rgba(20,184,166,0.6)]" />
      )}
      <div ref={dropdownRef}>
        <button
          onClick={handleClick}
          onContextMenu={handleRightClick}
          className={`flex items-center justify-center w-8 h-8 rounded border transition-colors ${
            isActive
              ? 'bg-vibe-primary/10 border-vibe-primary/50 text-vibe-primary'
              : 'bg-vibe-surface border-vibe-border text-vibe-muted hover:bg-vibe-border/50 hover:text-vibe-text'
          }`}
          title={`${preset.name} (hold to drag, right-click for options)`}
          {...attributes}
          {...listeners}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d={preset.icon} />
          </svg>
        </button>

        {/* Context menu */}
        {showDropdown && (
          <div className="absolute top-full left-0 mt-1 w-36 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
            <button
              onClick={handleUnpin}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
