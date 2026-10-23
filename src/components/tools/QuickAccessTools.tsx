import { useState, useRef, useEffect, type ReactNode } from 'react'
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { useToolStore } from '../../stores/toolStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { ToolConfig, ToolOpenMode, ToolPinDisplay, ToolbarSection } from '../../types'
import { useToolDragState } from './ToolDragContext'
import PinnedLayoutPresetButton from '../layout/PinnedLayoutPresetButton'
import PinnedWorkspaceButton from '../layout/PinnedWorkspaceButton'
import { useSessionStore } from '../../stores/sessionStore'
import { useProjectStore } from '../../stores/projectStore'
import {
  PluginMiniWidget,
  ToolIcon,
  activateTool,
  canOpenInPane,
  configSchemaOf,
  contributionModes,
  isActionContribution,
  openToolInPane,
  supportsMiniWidget,
  useAvailableToolConfigs,
  useToolContribution,
} from '../../plugins/tools'

const CHECK = (
  <svg className="w-3 h-3 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
  </svg>
)

function CheckItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
    >
      <span className="w-4 h-4 flex items-center justify-center">{checked && CHECK}</span>
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="border-t border-vibe-border my-1" />
      <div className="px-3 py-1 text-xs text-vibe-muted uppercase tracking-wide">{children}</div>
    </>
  )
}

// Sortable quick access button. Everything type-specific (what a click does,
// mini widget, open modes, settings) comes from the tool's plugin contribution.
function SortableQuickAccessButton({ tool }: { tool: ToolConfig }) {
  const [showDropdown, setShowDropdown] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const sortableId = `toolbar-${tool.id}`
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
  const isReceivingDrop = isOver && dragState.source === 'dropdown'

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  // Register overlay so native webviews (YouTube Shorts) hide when this dropdown is open
  useOverlayRegistration(`quick-access-${tool.id}`, showDropdown)

  const { toggleToolPinned, toggleQuickLaunch, updateToolConfig, setEditingToolId, setShowToolConfigModal } = useToolStore()

  const contribution = useToolContribution(tool)
  const isActionTool = isActionContribution(contribution)
  const modes = contributionModes(contribution)
  const hasSettings = !!configSchemaOf(contribution)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false)
      }
    }
    if (showDropdown) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDropdown])

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowDropdown(false)
    }
    if (showDropdown) document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showDropdown])

  const handleOpenAsPane = async () => {
    setShowDropdown(false)
    await openToolInPane(tool.id)
  }

  const handleClick = async () => {
    // Don't handle clicks during drag
    if (isDragActive) return
    // Toolbar items run their command; tiles open per their open mode
    // (flyouts anchor to this button).
    await activateTool(tool, { source: 'toolbar', anchorRect: buttonRef.current?.getBoundingClientRect() })
  }

  const handleConfigure = () => {
    setShowDropdown(false)
    setEditingToolId(tool.id)
    setShowToolConfigModal(true)
  }

  const handleUnpin = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await toggleToolPinned(tool.id)
    setShowDropdown(false)
  }

  const handleSetOpenMode = async (mode: ToolOpenMode) => {
    await updateToolConfig(tool.id, { openMode: mode })
    setShowDropdown(false)
  }

  const handleSetPinDisplay = async (display: ToolPinDisplay) => {
    await updateToolConfig(tool.id, { pinDisplay: display })
    setShowDropdown(false)
  }

  const handleStartRename = () => {
    setRenameValue(tool.name)
    setIsRenaming(true)
    setShowDropdown(false)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleFinishRename = async () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== tool.name) {
      await updateToolConfig(tool.id, { name: trimmed })
    }
    setIsRenaming(false)
  }

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isDragActive) {
      setShowDropdown(!showDropdown)
    }
  }

  const isFlyoutMode = !isActionTool && (tool.openMode === 'flyout' ? modes.includes('flyout') : !modes.includes('pane'))
  const showName = tool.pinDisplay === 'icon-and-name'
  const isMiniMode = tool.pinDisplay === 'mini' && supportsMiniWidget(contribution)
  const colorStyle = tool.color ? { color: tool.color } : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative ${isReceivingDrop ? 'ring-2 ring-teal-500/50 rounded' : ''}`}
    >
      {/* Drop indicator line on the left when dragging from dropdown */}
      {isOver && isDragActive && (
        <div className="absolute -left-0.5 top-1 bottom-1 w-0.5 bg-teal-400 rounded-full shadow-[0_0_6px_rgba(20,184,166,0.6)]" />
      )}
      <div ref={dropdownRef}>
        <button
          ref={buttonRef}
          onClick={handleClick}
          onContextMenu={handleRightClick}
          className={`flex items-center justify-center gap-1.5 h-8 rounded transition-colors relative ${
            isMiniMode ? 'px-1.5' : showName ? 'px-2' : 'w-8'
          } bg-vibe-surface border text-vibe-text hover:bg-vibe-border/50 ${tool.color ? '' : 'border-vibe-border hover:border-vibe-primary/50'}`}
          style={tool.color ? { borderColor: tool.color + '80' } : undefined}
          title={`${tool.name} (hold to drag, right-click for options)`}
          data-tool-config={tool.id}
          data-tool-ref={`${tool.pluginId}/${tool.contributionId}`}
          {...attributes}
          {...listeners}
        >
          {isMiniMode ? (
            <PluginMiniWidget config={tool} />
          ) : (
            <>
              <span className="flex" style={colorStyle}>
                <ToolIcon config={tool} className="w-4 h-4 flex-shrink-0" />
              </span>
              {showName && (
                <span className="text-xs whitespace-nowrap" style={colorStyle}>{tool.name}</span>
              )}
              {/* Small chevron indicator for flyout mode */}
              {isFlyoutMode && !showName && (
                <svg className="w-2 h-2 absolute bottom-0.5 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                </svg>
              )}
              {isFlyoutMode && showName && (
                <svg className="w-2.5 h-2.5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </>
          )}
        </button>

        {/* Dropdown menu */}
        {showDropdown && (
          <div className="absolute top-full left-0 mt-1 w-48 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
            {/* Tiles: open in a pane */}
            {!isActionTool && canOpenInPane(contribution) && (
              <button
                onClick={handleOpenAsPane}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open {tool.name}
              </button>
            )}

            {/* Per-config settings (shell, provider, executable, …) from the contribution's configSchema */}
            {hasSettings && (
              <button
                onClick={handleConfigure}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                </svg>
                Configure...
              </button>
            )}

            <SectionLabel>Display</SectionLabel>
            <CheckItem checked={!showName && !isMiniMode} onClick={() => handleSetPinDisplay('icon')}>Icon Only</CheckItem>
            <CheckItem checked={showName} onClick={() => handleSetPinDisplay('icon-and-name')}>Icon & Name</CheckItem>
            {supportsMiniWidget(contribution) && (
              <CheckItem checked={isMiniMode} onClick={() => handleSetPinDisplay('mini')}>Mini Dashboard</CheckItem>
            )}

            {/* Open Mode section - tiles that support both modes */}
            {!isActionTool && modes.length > 1 && (
              <>
                <SectionLabel>Open Mode</SectionLabel>
                <CheckItem checked={!isFlyoutMode} onClick={() => handleSetOpenMode('pane')}>Pane</CheckItem>
                <CheckItem checked={isFlyoutMode} onClick={() => handleSetOpenMode('flyout')}>Flyout</CheckItem>
              </>
            )}

            <div className="border-t border-vibe-border my-1" />
            <button
              onClick={handleStartRename}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Rename
            </button>
            <button
              onClick={async (e) => { e.stopPropagation(); await toggleQuickLaunch(tool.id); setShowDropdown(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {tool.quickLaunch ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                )}
              </svg>
              {tool.quickLaunch ? 'Remove from Quick Launch' : 'Add to Quick Launch'}
            </button>
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

        {/* Inline rename input */}
        {isRenaming && (
          <div className="absolute top-full left-0 mt-1 z-50">
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleFinishRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleFinishRename()
                if (e.key === 'Escape') setIsRenaming(false)
              }}
              className="px-2 py-1 text-xs bg-vibe-surface border border-vibe-primary rounded text-vibe-text focus:outline-none w-32"
              autoFocus
            />
          </div>
        )}
      </div>
    </div>
  )
}

interface QuickAccessToolsProps {
  section: ToolbarSection
}

export default function QuickAccessTools({ section }: QuickAccessToolsProps) {
  // Only configs whose plugin contribution is available (disabled plugins,
  // other-OS tools and uninstalled plugins are hidden).
  const pinned = useAvailableToolConfigs((t) => t.pinned)
  const { layoutPresets, getPinnedLayoutPresets } = useAppSettingsStore()
  const { getPinnedWorkspaces } = useSessionStore()
  const { activeProject } = useProjectStore()
  const pinnedTools = [...pinned]
    .sort((a, b) => (a.pinOrder ?? a.order) - (b.pinOrder ?? b.order))
    .filter(t => (t.pinSection || 'right') === section)

  // Get pinned layout presets for this section
  const pinnedLayoutPresets = getPinnedLayoutPresets().filter(
    type => (layoutPresets.pinnedSection[type] || 'right') === section
  )

  // Get pinned workspaces for this section (filtered to active project)
  const pinnedWorkspaces = getPinnedWorkspaces(activeProject?.id).filter(
    s => (s.pinSection || 'right') === section
  )

  const dragState = useToolDragState()
  const isDragActive = dragState.activeId !== null

  // Droppable zone for this section (accepts drops even when empty)
  const { setNodeRef, isOver } = useDroppable({
    id: `section-drop-${section}`,
  })

  // Sortable IDs for this section (tools + layout presets + workspaces)
  const sortableIds = [
    ...pinnedTools.map(t => `toolbar-${t.id}`),
    ...pinnedLayoutPresets.map(t => `layout-toolbar-${t}`),
    ...pinnedWorkspaces.map(s => `workspace-toolbar-${s.id}`),
  ]

  const hasContent = pinnedTools.length > 0 || pinnedLayoutPresets.length > 0 || pinnedWorkspaces.length > 0

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-1 min-h-[32px] transition-colors rounded ${
        isOver && isDragActive ? 'bg-teal-500/10 ring-1 ring-teal-500/30' : ''
      } ${!hasContent && isDragActive ? 'min-w-[40px]' : ''}`}
    >
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        {pinnedTools.map((tool) => (
          <SortableQuickAccessButton key={tool.id} tool={tool} />
        ))}
        {pinnedLayoutPresets.map((type) => (
          <PinnedLayoutPresetButton key={type} type={type} />
        ))}
        {pinnedWorkspaces.map((session) => (
          <PinnedWorkspaceButton key={session.id} session={session} />
        ))}
      </SortableContext>
      {/* Empty drop indicator */}
      {!hasContent && isDragActive && (
        <div className={`w-8 h-6 rounded border border-dashed flex items-center justify-center transition-colors ${
          isOver ? 'border-teal-400 bg-teal-500/10' : 'border-vibe-border/50'
        }`}>
          <svg className="w-3 h-3 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </div>
      )}
    </div>
  )
}
