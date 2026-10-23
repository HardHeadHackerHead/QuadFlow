import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { useToolStore, countPaneTools } from '../../stores/toolStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { TOOL_COLORS } from '../../lib/toolColors'
import { ToolConfig } from '../../types'
import { ToolIcon, activateTool, contributionLabel, groupToolConfigs, useAvailableToolConfigs } from '../../plugins/tools'
import { usePluginRegistry } from '../../plugins/registry'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { call, commands } from '../../lib/core'

/** Number of plugin updates found by the last source refresh (`plugins_available_updates`, no network). */
function usePluginUpdateCount(...deps: unknown[]): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    let cancelled = false
    call(commands.pluginsAvailableUpdates()).then(
      (u) => !cancelled && setN(u.length),
      () => {},
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return n
}

// Sortable tool item for the dropdown
function SortableToolItem({
  tool,
  onOpen,
  onContextMenu,
  onTogglePin,
}: {
  tool: ToolConfig
  onOpen: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onTogglePin: (id: string) => void
}) {
  const sortableId = `dropdown-${tool.id}`
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: sortableId })

  // Don't apply sorting transforms — the items are rendered in groups with
  // headers/dividers between them, which breaks verticalListSortingStrategy's
  // position calculations and causes all items to visually shuffle during drag.
  // The DragOverlay already provides the ghost preview; we just dim the source.
  const style = {
    opacity: isDragging ? 0.4 : 1,
  }

  const colorStyle = tool.color ? { color: tool.color } : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-2 py-1 hover:bg-vibe-border/50 transition-colors group"
      onContextMenu={(e) => onContextMenu(e, tool.id)}
    >
      {/* Drag handle grip - visible on hover */}
      <div
        {...attributes}
        {...listeners}
        className="flex-shrink-0 flex items-center justify-center w-5 h-5 cursor-grab opacity-0 group-hover:opacity-50 hover:!opacity-100 text-vibe-muted transition-opacity"
        title="Hold to drag"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="3" r="1.5" />
          <circle cx="11" cy="3" r="1.5" />
          <circle cx="5" cy="8" r="1.5" />
          <circle cx="11" cy="8" r="1.5" />
          <circle cx="5" cy="13" r="1.5" />
          <circle cx="11" cy="13" r="1.5" />
        </svg>
      </div>
      <button
        onClick={() => onOpen(tool.id)}
        className="flex-1 flex items-center gap-3 px-2 py-1 text-vibe-text"
        data-tool-config={tool.id}
        data-tool-ref={`${tool.pluginId}/${tool.contributionId}`}
      >
        <span className="flex-shrink-0" style={colorStyle}>
          <ToolIcon config={tool} />
        </span>
        <span className="text-left text-sm whitespace-nowrap" style={colorStyle}>{tool.name}</span>
        {tool.name !== contributionLabel(tool) && (
          <span className="text-xs text-vibe-muted whitespace-nowrap">{contributionLabel(tool)}</span>
        )}
      </button>
      {/* Pin/Unpin button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onTogglePin(tool.id)
        }}
        className={`flex-shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
          tool.pinned
            ? 'text-vibe-primary hover:text-vibe-primary/80'
            : 'text-vibe-muted opacity-0 group-hover:opacity-100 hover:text-vibe-text'
        }`}
        title={tool.pinned ? 'Unpin from quick access' : 'Pin to quick access'}
      >
        {tool.pinned ? (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
          </svg>
        )}
      </button>
    </div>
  )
}

export default function ToolsDropdown() {
  const [isOpen, setIsOpen] = useState(false)
  const [addToolsExpanded, setAddToolsExpanded] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ toolId: string; x: number; y: number } | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const {
    setShowToolConfigModal,
    setEditingToolId,
    toolInstances,
    toggleToolPinned,
    toggleQuickLaunch,
    setToolColor,
    hideToolFromDropdown,
    showToolInDropdown,
    toolConfigs,
  } = useToolStore()

  // Configs whose plugin contribution is available; configs of disabled /
  // other-OS / uninstalled plugins are hidden.
  const available = useAvailableToolConfigs()
  const registryReady = usePluginRegistry((s) => s.status === 'ready')
  const pluginGeneration = usePluginRegistry((s) => s.plugins)
  const updateCount = usePluginUpdateCount(isOpen, pluginGeneration)

  // Register overlay so native webviews (YouTube Shorts) hide when this dropdown is open
  useOverlayRegistration('tools-dropdown', isOpen)

  const enabledTools = available.filter((t) => t.enabled)
  const hiddenTools = available.filter((t) => !t.enabled)
  const hasTools = enabledTools.length > 0 || countPaneTools(toolInstances) > 0

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setContextMenu(null)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Close context menu when clicking outside it
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null)
      }
    }

    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu])

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null)
        } else {
          setIsOpen(false)
        }
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, contextMenu])

  // Reposition context menu if it overflows the viewport
  useLayoutEffect(() => {
    if (contextMenu && contextMenuRef.current) {
      const rect = contextMenuRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      let newTop = contextMenu.y
      let newLeft = contextMenu.x

      if (rect.bottom > viewportHeight) {
        newTop = contextMenu.y - rect.height
      }
      if (rect.right > viewportWidth) {
        newLeft = contextMenu.x - rect.width
      }

      if (newTop !== contextMenu.y || newLeft !== contextMenu.x) {
        contextMenuRef.current.style.top = `${newTop}px`
        contextMenuRef.current.style.left = `${newLeft}px`
      }
    }
  }, [contextMenu])

  const handleOpenTool = async (configId: string) => {
    const config = toolConfigs.get(configId)
    if (!config) return
    setIsOpen(false)
    await activateTool(config, { source: 'menu' })
  }

  const handleContextMenu = (e: React.MouseEvent, toolId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ toolId, x: e.clientX, y: e.clientY })
  }

  const handleConfigureTool = (toolId: string) => {
    setEditingToolId(toolId)
    setShowToolConfigModal(true)
    setContextMenu(null)
    setIsOpen(false)
  }

  const handleSetColor = async (toolId: string, color: string | undefined) => {
    await setToolColor(toolId, color)
    setContextMenu(null)
  }

  const handleTogglePin = async (toolId: string) => {
    await toggleToolPinned(toolId)
    setContextMenu(null)
  }

  const handleToggleQuickLaunch = async (toolId: string) => {
    await toggleQuickLaunch(toolId)
    setContextMenu(null)
  }

  const handleHideTool = async (toolId: string) => {
    await hideToolFromDropdown(toolId)
    setContextMenu(null)
  }

  const handleShowTool = async (toolId: string) => {
    await showToolInDropdown(toolId)
  }

  const handleOpenConfigModal = () => {
    setEditingToolId(null)
    setShowToolConfigModal(true)
    setIsOpen(false)
  }

  // Get the tool for context menu
  const contextMenuTool = contextMenu ? toolConfigs.get(contextMenu.toolId) : null

  // Sortable IDs for the dropdown
  const sortableIds = enabledTools.map(t => `dropdown-${t.id}`)

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Dropdown Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors text-sm ${
          hasTools
            ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white hover:from-teal-600 hover:to-emerald-600'
            : 'bg-vibe-surface border border-vibe-border text-vibe-text hover:bg-vibe-border/50'
        }`}
        title="Tools"
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="hidden xl:inline">Tools</span>
        {updateCount > 0 && (
          <span
            className="min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-[10px] leading-[16px] text-white"
            title={`${updateCount} plugin update${updateCount > 1 ? 's' : ''} available (Settings → Plugins)`}
            data-plugin-updates={updateCount}
          >
            {updateCount}
          </span>
        )}
        <svg
          className={`w-3 h-3 transition-transform flex-shrink-0 ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-auto min-w-[14rem] max-h-[calc(100vh-4rem)] overflow-y-auto bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50">
          {/* Tools List - grouped and sortable */}
          {enabledTools.length > 0 ? (
            <div className="py-1">
              <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                {groupToolConfigs(enabledTools).map((group, i) => (
                  <div key={group.id}>
                    {i > 0 && <div className="border-t border-vibe-border/50 my-0.5" />}
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-vibe-muted uppercase tracking-wider">
                      {group.label}
                    </div>
                    {group.tools.map((tool) => (
                      <SortableToolItem
                        key={tool.id}
                        tool={tool}
                        onOpen={handleOpenTool}
                        onContextMenu={handleContextMenu}
                        onTogglePin={(id) => toggleToolPinned(id)}
                      />
                    ))}
                  </div>
                ))}
              </SortableContext>
            </div>
          ) : (
            <div className="px-4 py-3 text-sm text-vibe-muted">
              {registryReady ? 'No tools visible. Add one below.' : 'Loading tools…'}
            </div>
          )}

          {updateCount > 0 && (
            <button
              onClick={() => {
                setIsOpen(false)
                useAppSettingsStore.getState().setShowSettingsModal(true)
              }}
              className="w-full flex items-center gap-3 px-4 py-2 text-sm text-amber-400 hover:bg-vibe-border/50 border-t border-vibe-border"
            >
              {updateCount} plugin update{updateCount > 1 ? 's' : ''} available — Settings → Plugins
            </button>
          )}

          {/* Divider */}
          <div className="border-t border-vibe-border" />

          {/* Add Tools Section */}
          <div className="py-1">
            <button
              onClick={() => setAddToolsExpanded(!addToolsExpanded)}
              className="w-full flex items-center gap-3 px-4 py-2 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              <span className="text-sm flex-1 text-left">Add Tools</span>
              <svg
                className={`w-3 h-3 transition-transform ${addToolsExpanded ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {addToolsExpanded && (
              <div className="border-t border-vibe-border/50">
                {/* Hidden tools */}
                {hiddenTools.length > 0 ? (
                  <div className="py-1">
                    {hiddenTools.map((tool) => (
                      <div
                        key={tool.id}
                        className="flex items-center gap-1 px-2 py-1.5 hover:bg-vibe-border/50 transition-colors group"
                      >
                        <button
                          onClick={() => handleShowTool(tool.id)}
                          className="flex-1 flex items-center gap-3 px-2 text-vibe-muted hover:text-vibe-text"
                          title={`Show ${tool.name} in dropdown`}
                        >
                          <span className="flex-shrink-0 opacity-60" style={tool.color ? { color: tool.color } : undefined}>
                            <ToolIcon config={tool} />
                          </span>
                          <span className="text-sm" style={tool.color ? { color: tool.color } : undefined}>{tool.name}</span>
                          <svg className="w-3 h-3 ml-auto opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                        {/* Pin/Unpin button for hidden tools */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleToolPinned(tool.id)
                          }}
                          className={`flex-shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
                            tool.pinned
                              ? 'text-vibe-primary hover:text-vibe-primary/80'
                              : 'text-vibe-muted opacity-0 group-hover:opacity-100 hover:text-vibe-text'
                          }`}
                          title={tool.pinned ? 'Unpin from quick access' : 'Pin to quick access'}
                        >
                          {tool.pinned ? (
                            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                            </svg>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-2 text-xs text-vibe-muted">
                    No hidden tools
                  </div>
                )}

                {/* Create Custom Tool */}
                <div className="border-t border-vibe-border/50">
                  <button
                    onClick={handleOpenConfigModal}
                    className="w-full flex items-center gap-3 px-4 py-2 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                    <span className="text-sm">Configure Tools...</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && contextMenuTool && (
        <div
          ref={contextMenuRef}
          className="fixed bg-vibe-surface border border-vibe-border rounded-lg shadow-xl z-[100] py-1 w-56"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          {/* Configure */}
          <button
            onClick={() => handleConfigureTool(contextMenu.toolId)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
            Configure...
          </button>

          {/* Duplicate (another config of the same contribution) */}
          <button
            onClick={async () => {
              const { addToolConfig } = useToolStore.getState()
              await addToolConfig(contextMenuTool.name + ' (Copy)', { pluginId: contextMenuTool.pluginId, contributionId: contextMenuTool.contributionId }, {
                icon: contextMenuTool.icon,
                settings: contextMenuTool.settings ? { ...contextMenuTool.settings } : undefined,
                pinned: false,
                openMode: contextMenuTool.openMode,
                pinDisplay: contextMenuTool.pinDisplay,
                color: contextMenuTool.color,
              })
              setContextMenu(null)
            }}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Duplicate
          </button>

          {/* Color swatches */}
          <div className="border-t border-vibe-border my-1" />
          <div className="px-3 py-1.5">
            <div className="text-xs text-vibe-muted mb-1.5">Color</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* None option */}
              <button
                onClick={() => handleSetColor(contextMenu.toolId, undefined)}
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                  !contextMenuTool.color ? 'border-vibe-text' : 'border-vibe-border hover:border-vibe-text/50'
                }`}
                title="No color"
              >
                {!contextMenuTool.color && (
                  <svg className="w-3 h-3 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6" />
                  </svg>
                )}
              </button>
              {TOOL_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => handleSetColor(contextMenu.toolId, c.value)}
                  className={`w-5 h-5 rounded-full border-2 transition-colors ${
                    contextMenuTool.color === c.value ? 'border-white scale-110' : 'border-transparent hover:border-vibe-text/50'
                  }`}
                  style={{ backgroundColor: c.value }}
                  title={c.name}
                />
              ))}
            </div>
          </div>

          {/* Pin/Unpin */}
          <div className="border-t border-vibe-border my-1" />
          <button
            onClick={() => handleTogglePin(contextMenu.toolId)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            {contextMenuTool.pinned ? (
              <>
                <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Unpin from toolbar
              </>
            ) : (
              <>
                <svg className="w-4 h-4 text-vibe-muted" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                </svg>
                Pin to toolbar
              </>
            )}
          </button>

          {/* Quick Launch */}
          <button
            onClick={() => handleToggleQuickLaunch(contextMenu.toolId)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            {contextMenuTool.quickLaunch ? (
              <>
                <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Remove from Quick Launch
              </>
            ) : (
              <>
                <svg className="w-4 h-4 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Add to Quick Launch
              </>
            )}
          </button>

          {/* Hide */}
          <button
            onClick={() => handleHideTool(contextMenu.toolId)}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18" />
            </svg>
            Hide
          </button>
        </div>
      )}
    </div>
  )
}
