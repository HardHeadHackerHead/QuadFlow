import { useState, useRef, useEffect } from 'react'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore, countPaneTools } from '../../stores/toolStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { LAYOUT_PRESETS, LayoutPresetType, autoDetectGridDimensions } from '../../lib/layoutUtils'

// Lookup helper
function getPreset(type: LayoutPresetType) {
  return LAYOUT_PRESETS.find(p => p.type === type)!
}

// Grid config selector shown in the grid preset's context menu
function GridConfigSelector({
  rows,
  cols,
  onSelect,
}: {
  rows: number
  cols: number
  onSelect: (r: number, c: number) => void
}) {
  const [hoverR, setHoverR] = useState(0)
  const [hoverC, setHoverC] = useState(0)
  const maxR = 5
  const maxC = 5

  const activeR = hoverR || rows
  const activeC = hoverC || cols

  return (
    <div className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
      <div className="text-xs text-vibe-muted mb-1.5">
        {activeR > 0 && activeC > 0 ? `${activeR} × ${activeC}` : 'Auto'}
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${maxC}, 1fr)` }}>
        {Array.from({ length: maxR * maxC }, (_, i) => {
          const r = Math.floor(i / maxC) + 1
          const c = (i % maxC) + 1
          const isHighlighted = r <= (hoverR || rows) && c <= (hoverC || cols)
          return (
            <button
              key={i}
              className={`w-5 h-4 rounded-sm border transition-colors ${
                isHighlighted
                  ? 'bg-vibe-primary/60 border-vibe-primary'
                  : 'bg-vibe-bg border-vibe-border hover:border-vibe-muted'
              }`}
              onMouseEnter={() => { setHoverR(r); setHoverC(c) }}
              onMouseLeave={() => { setHoverR(0); setHoverC(0) }}
              onClick={() => onSelect(r, c)}
            />
          )
        })}
      </div>
      {rows > 0 && cols > 0 && (
        <button
          className="mt-1.5 text-xs text-vibe-muted hover:text-vibe-text transition-colors"
          onClick={() => onSelect(0, 0)}
        >
          Reset to Auto
        </button>
      )}
    </div>
  )
}

// Sortable preset item in the dropdown
function SortablePresetItem({
  type,
  isActive,
  onSelect,
  onDisable,
  onTogglePin,
  isPinned,
  paneCount,
}: {
  type: LayoutPresetType
  isActive: boolean
  onSelect: () => void
  onDisable: () => void
  onTogglePin: () => void
  isPinned: boolean
  paneCount: number
}) {
  const [showContext, setShowContext] = useState(false)
  const contextRef = useRef<HTMLDivElement>(null)
  const preset = getPreset(type)
  const { layoutPresets, setGridConfig } = useAppSettingsStore()
  const { setLayoutPreset } = useTerminalStore()
  const gridConfig = layoutPresets.gridConfig

  const sortableId = `layout-dropdown-${type}`
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  // Close context menu on outside click
  useEffect(() => {
    if (!showContext) return
    const handler = (e: MouseEvent) => {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setShowContext(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showContext])

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault()
    setShowContext(!showContext)
  }

  const isGrid = type === 'grid'
  const gridLabel = isGrid
    ? gridConfig.rows > 0 && gridConfig.cols > 0
      ? `${gridConfig.rows}×${gridConfig.cols}`
      : paneCount > 0
        ? (() => { const a = autoDetectGridDimensions(paneCount); return `Auto ${a.rows}×${a.cols}` })()
        : 'Auto'
    : null

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <button
        onClick={onSelect}
        onContextMenu={handleRightClick}
        className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors group ${
          isActive
            ? 'bg-vibe-primary/10 text-vibe-primary'
            : 'text-vibe-text hover:bg-vibe-border/50'
        }`}
        {...attributes}
        {...listeners}
      >
        {/* Drag handle */}
        <svg className="w-3.5 h-3.5 text-vibe-muted opacity-0 group-hover:opacity-60 flex-shrink-0 cursor-grab" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm8-16a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
        </svg>
        <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
          <path d={preset.icon} />
        </svg>
        <div className="flex flex-col items-start min-w-0">
          <span className="font-medium">
            {preset.name}
            {gridLabel && <span className="ml-1 text-xs text-vibe-muted font-normal">({gridLabel})</span>}
          </span>
          <span className="text-xs text-vibe-muted">{preset.description}</span>
        </div>
        {isActive && (
          <svg className="w-4 h-4 ml-auto text-vibe-primary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>

      {/* Context menu */}
      {showContext && (
        <div ref={contextRef} className="absolute right-2 top-full mt-0.5 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-[60] py-1" style={{ width: isGrid ? '200px' : '160px' }}>
          {/* Grid config section - only for grid preset */}
          {isGrid && (
            <>
              <div className="px-3 py-1 text-xs text-vibe-muted border-b border-vibe-border">
                Grid Size
              </div>
              <GridConfigSelector
                rows={gridConfig.rows}
                cols={gridConfig.cols}
                onSelect={(r, c) => {
                  setGridConfig(r, c)
                  // Re-apply grid layout with new config
                  setTimeout(() => setLayoutPreset('grid'), 0)
                  setShowContext(false)
                }}
              />
              <div className="border-t border-vibe-border mt-1 pt-1" />
            </>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onDisable(); setShowContext(false) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.293 6.293m3.585 3.585l4.242 4.242m0 0l3.585 3.585M6.293 6.293L3 3m3.293 3.293l4.242 4.242" />
            </svg>
            Disable
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin(); setShowContext(false) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isPinned ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              )}
            </svg>
            {isPinned ? 'Unpin' : 'Pin to Toolbar'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function LayoutPresetDropdown() {
  const [isOpen, setIsOpen] = useState(false)
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const { terminals } = useTerminalStore()
  const { toolInstances } = useToolStore()
  const {
    cycleLayoutPreset,
    setLayoutPreset,
    currentLayoutPreset,
    resetLayout,
  } = useTerminalStore()

  const {
    layoutPresets,
    getEnabledLayoutPresets,
    getHiddenLayoutPresets,
    setLayoutPresetEnabled,
    toggleLayoutPresetPinned,
  } = useAppSettingsStore()

  // Register overlay so native webviews hide when this dropdown is open
  useOverlayRegistration('toolbar-layout-dropdown', isOpen)

  const enabledPresets = getEnabledLayoutPresets()
  const hiddenPresets = getHiddenLayoutPresets()
  const currentPreset = LAYOUT_PRESETS.find(p => p.type === currentLayoutPreset) || LAYOUT_PRESETS[0]

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // Close on escape
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen])

  const handleButtonClick = () => {
    // Left-click cycles through enabled presets
    if (terminals.size > 0 || countPaneTools(toolInstances) > 0) {
      cycleLayoutPreset()
    }
  }

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsOpen(!isOpen)
  }

  const handleSelectPreset = (type: LayoutPresetType) => {
    setLayoutPreset(type)
    setIsOpen(false)
  }

  const handleDisablePreset = (type: LayoutPresetType) => {
    // Don't disable the last enabled preset
    if (enabledPresets.length <= 1) return
    setLayoutPresetEnabled(type, false)
  }

  const handleEnablePreset = (type: LayoutPresetType) => {
    setLayoutPresetEnabled(type, true)
    setHiddenExpanded(false)
  }

  const handleResetLayout = () => {
    resetLayout()
    setIsOpen(false)
  }

  // Sortable IDs for enabled presets
  const sortableIds = enabledPresets.map(t => `layout-dropdown-${t}`)

  const paneCount = terminals.size + countPaneTools(toolInstances)
  const hasNoTerminals = paneCount === 0

  return (
    <div className="relative hidden sm:block" ref={dropdownRef}>
      {/* Main button - left-click cycles, right-click opens dropdown */}
      <button
        onClick={handleButtonClick}
        onContextMenu={handleRightClick}
        disabled={hasNoTerminals}
        className="flex items-center justify-center w-8 h-8 bg-vibe-surface border border-vibe-border text-vibe-text rounded hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title={`${currentPreset.name} - Click to cycle, Right-click for menu`}
      >
        <svg
          className="w-4 h-4 flex-shrink-0"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d={currentPreset.icon} />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
          <div className="px-3 py-1.5 text-xs text-vibe-muted border-b border-vibe-border">
            Layout Presets
          </div>

          {/* Enabled presets - sortable */}
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            {enabledPresets.map((type) => (
              <SortablePresetItem
                key={type}
                type={type}
                isActive={type === currentLayoutPreset}
                onSelect={() => handleSelectPreset(type)}
                onDisable={() => handleDisablePreset(type)}
                onTogglePin={() => toggleLayoutPresetPinned(type)}
                isPinned={layoutPresets.pinned.includes(type)}
                paneCount={paneCount}
              />
            ))}
          </SortableContext>

          {/* Hidden presets section */}
          {hiddenPresets.length > 0 && (
            <>
              <div className="border-t border-vibe-border mt-1">
                <button
                  onClick={() => setHiddenExpanded(!hiddenExpanded)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${hiddenExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Hidden Presets ({hiddenPresets.length})
                </button>
              </div>
              {hiddenExpanded && (
                <div className="py-1">
                  {hiddenPresets.map((type) => {
                    const preset = getPreset(type)
                    return (
                      <button
                        key={type}
                        onClick={() => handleEnablePreset(type)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
                      >
                        <svg className="w-4 h-4 flex-shrink-0 opacity-50" fill="currentColor" viewBox="0 0 24 24">
                          <path d={preset.icon} />
                        </svg>
                        <span>{preset.name}</span>
                        <svg className="w-3 h-3 ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {/* Reset to Grid */}
          <div className="border-t border-vibe-border mt-1 pt-1">
            <button
              onClick={handleResetLayout}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <div className="flex flex-col items-start">
                <span className="font-medium">Reset to Grid</span>
                <span className="text-xs text-vibe-muted">Restore all minimized panels</span>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
