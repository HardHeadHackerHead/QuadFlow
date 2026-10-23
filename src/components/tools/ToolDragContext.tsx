import { useState, createContext, useContext } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useToolStore } from '../../stores/toolStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { ToolIcon } from '../../plugins/tools'
import { ToolConfig, ToolbarSection } from '../../types'
import { LAYOUT_PRESETS, LayoutPresetType } from '../../lib/layoutUtils'

// Drag state context shared between dropdown and toolbar
interface ToolDragState {
  activeId: string | null
  activeConfig: ToolConfig | null
  activeLayoutPreset: LayoutPresetType | null
  source: 'dropdown' | 'toolbar' | 'layout-dropdown' | 'layout-toolbar' | 'workspace-toolbar' | null
  overArea: 'dropdown' | 'toolbar' | 'layout-dropdown' | 'layout-toolbar' | 'workspace-toolbar' | null
}

const ToolDragStateContext = createContext<ToolDragState>({
  activeId: null,
  activeConfig: null,
  activeLayoutPreset: null,
  source: null,
  overArea: null,
})

export function useToolDragState() {
  return useContext(ToolDragStateContext)
}

// Helper: determine which area a droppable/sortable id belongs to
function getArea(id: string): 'dropdown' | 'toolbar' | 'layout-dropdown' | 'layout-toolbar' | 'workspace-toolbar' | null {
  if (typeof id === 'string') {
    if (id.startsWith('workspace-toolbar-')) return 'workspace-toolbar'
    if (id.startsWith('layout-dropdown-')) return 'layout-dropdown'
    if (id.startsWith('layout-toolbar-')) return 'layout-toolbar'
    if (id.startsWith('dropdown-')) return 'dropdown'
    if (id.startsWith('toolbar-')) return 'toolbar'
    if (id === 'toolbar-droppable') return 'toolbar'
    if (id.startsWith('section-drop-')) return 'toolbar'
  }
  return null
}

// Helper: extract the target section from a droppable/sortable ID
function getTargetSection(id: string, toolConfigs: Map<string, ToolConfig>): ToolbarSection {
  // Section drop zones: section-drop-left, section-drop-center, section-drop-right
  if (id.startsWith('section-drop-')) {
    return id.slice('section-drop-'.length) as ToolbarSection
  }
  // Toolbar items: toolbar-{configId} — look up the tool's current section
  if (id.startsWith('toolbar-')) {
    const configId = id.slice('toolbar-'.length)
    const config = toolConfigs.get(configId)
    return config?.pinSection || 'right'
  }
  return 'right'
}

// Strip prefix from sortable IDs to get the raw tool config ID or preset type
function stripPrefix(id: string): string {
  if (id.startsWith('workspace-toolbar-')) return id.slice('workspace-toolbar-'.length)
  if (id.startsWith('layout-dropdown-')) return id.slice('layout-dropdown-'.length)
  if (id.startsWith('layout-toolbar-')) return id.slice('layout-toolbar-'.length)
  if (id.startsWith('dropdown-')) return id.slice('dropdown-'.length)
  if (id.startsWith('toolbar-')) return id.slice('toolbar-'.length)
  return id
}


interface ToolDragContextProps {
  children: React.ReactNode
}

export default function ToolDragContext({ children }: ToolDragContextProps) {
  const {
    getEnabledTools,
    getPinnedTools,
    reorderToolConfigs,
    reorderPinnedTools,
    toggleToolPinned,
    updateToolConfig,
    toolConfigs,
  } = useToolStore()

  const {
    getEnabledLayoutPresets,
    setLayoutPresetOrder,
    toggleLayoutPresetPinned,
    reorderPinnedLayoutPresets,
    updateLayoutPresetPinSection,
    layoutPresets,
  } = useAppSettingsStore()

  const [dragState, setDragState] = useState<ToolDragState>({
    activeId: null,
    activeConfig: null,
    activeLayoutPreset: null,
    source: null,
    overArea: null,
  })

  // Long-press activation: 250ms delay, 5px tolerance
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      delay: 250,
      tolerance: 5,
    },
  })

  const sensors = useSensors(pointerSensor)

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id)
    const source = getArea(id)
    const configId = stripPrefix(id)

    // Check if this is a layout preset drag or workspace drag
    const isLayoutDrag = source === 'layout-dropdown' || source === 'layout-toolbar'
    const isWorkspaceDrag = source === 'workspace-toolbar'
    const config = (isLayoutDrag || isWorkspaceDrag) ? null : (toolConfigs.get(configId) || null)
    const layoutPreset = isLayoutDrag ? (configId as LayoutPresetType) : null

    setDragState({
      activeId: id,
      activeConfig: config,
      activeLayoutPreset: layoutPreset,
      source,
      overArea: source,
    })
  }

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id
    if (!overId) {
      setDragState(prev => ({ ...prev, overArea: null }))
      return
    }
    const area = getArea(String(overId))
    setDragState(prev => ({ ...prev, overArea: area }))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    setDragState({
      activeId: null,
      activeConfig: null,
      activeLayoutPreset: null,
      source: null,
      overArea: null,
    })

    if (!over) return

    const activeId = String(active.id)
    const overId = String(over.id)
    const sourceArea = getArea(activeId)
    const targetArea = getArea(overId)

    const activeConfigId = stripPrefix(activeId)
    const overConfigId = stripPrefix(overId)

    if (activeConfigId === overConfigId) return

    // ── Layout preset drag cases ──

    // Layout-dropdown-to-layout-dropdown: reorder presets
    if (sourceArea === 'layout-dropdown' && targetArea === 'layout-dropdown') {
      const enabled = getEnabledLayoutPresets()
      const oldIndex = enabled.indexOf(activeConfigId as LayoutPresetType)
      const newIndex = enabled.indexOf(overConfigId as LayoutPresetType)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newEnabled = arrayMove(enabled, oldIndex, newIndex)
        // Rebuild full order: reordered enabled + disabled in their original positions
        const { layoutPresets: lp } = useAppSettingsStore.getState()
        const disabled = lp.order.filter(t => !lp.enabled[t])
        setLayoutPresetOrder([...newEnabled, ...disabled])
      }
    }
    // Layout-dropdown-to-toolbar: pin preset to toolbar
    else if (sourceArea === 'layout-dropdown' && (targetArea === 'toolbar' || targetArea === 'layout-toolbar')) {
      const type = activeConfigId as LayoutPresetType
      if (!layoutPresets.pinned.includes(type)) {
        const targetSection = targetArea === 'toolbar' ? getTargetSection(overId, toolConfigs) : (layoutPresets.pinnedSection[overConfigId as LayoutPresetType] || 'right')
        toggleLayoutPresetPinned(type)
        updateLayoutPresetPinSection(type, targetSection)
      }
    }
    // Layout-toolbar-to-layout-toolbar: reorder pinned presets
    else if (sourceArea === 'layout-toolbar' && targetArea === 'layout-toolbar') {
      const pinned = [...layoutPresets.pinned]
      const oldIndex = pinned.indexOf(activeConfigId as LayoutPresetType)
      const newIndex = pinned.indexOf(overConfigId as LayoutPresetType)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(pinned, oldIndex, newIndex)
        reorderPinnedLayoutPresets(newOrder)
      }
    }
    // Layout-toolbar-to-layout-dropdown: unpin preset
    else if (sourceArea === 'layout-toolbar' && targetArea === 'layout-dropdown') {
      const type = activeConfigId as LayoutPresetType
      if (layoutPresets.pinned.includes(type)) {
        toggleLayoutPresetPinned(type)
      }
    }

    // ── Tool drag cases (original) ──

    // Dropdown-to-dropdown: reorder dropdown
    else if (sourceArea === 'dropdown' && targetArea === 'dropdown') {
      const enabled = getEnabledTools()
      const ids = enabled.map(t => t.id)
      const oldIndex = ids.indexOf(activeConfigId)
      const newIndex = ids.indexOf(overConfigId)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(ids, oldIndex, newIndex)
        reorderToolConfigs(newOrder)
      }
    }
    // Toolbar-to-toolbar: reorder or cross-section move
    else if (sourceArea === 'toolbar' && targetArea === 'toolbar') {
      const targetSection = getTargetSection(overId, toolConfigs)
      const sourceConfig = toolConfigs.get(activeConfigId)
      const sourceSection = sourceConfig?.pinSection || 'right'

      if (overId.startsWith('section-drop-') && sourceSection !== targetSection) {
        // Cross-section move: dropped on an empty section zone
        updateToolConfig(activeConfigId, { pinSection: targetSection })
      } else if (sourceSection !== targetSection) {
        // Cross-section move: dropped on a tool in a different section
        updateToolConfig(activeConfigId, { pinSection: targetSection }).then(() => {
          // Reorder within the new section
          const pinned = useToolStore.getState().getPinnedTools()
            .filter(t => (t.pinSection || 'right') === targetSection)
          const ids = pinned.map(t => t.id)
          const currentIndex = ids.indexOf(activeConfigId)
          const targetIndex = ids.indexOf(overConfigId)
          if (currentIndex !== -1 && targetIndex !== -1) {
            const newOrder = arrayMove(ids, currentIndex, targetIndex)
            reorderPinnedTools(newOrder)
          }
        })
      } else {
        // Within-section reorder
        const pinned = getPinnedTools()
          .filter(t => (t.pinSection || 'right') === sourceSection)
        const ids = pinned.map(t => t.id)
        const oldIndex = ids.indexOf(activeConfigId)
        const newIndex = ids.indexOf(overConfigId)
        if (oldIndex !== -1 && newIndex !== -1) {
          const newOrder = arrayMove(ids, oldIndex, newIndex)
          reorderPinnedTools(newOrder)
        }
      }
    }
    // Dropdown-to-toolbar: pin and insert at position with section
    else if (sourceArea === 'dropdown' && targetArea === 'toolbar') {
      const config = toolConfigs.get(activeConfigId)
      const targetSection = getTargetSection(overId, toolConfigs)
      if (config && !config.pinned) {
        // Pin the tool first, then set section
        toggleToolPinned(activeConfigId).then(() => {
          updateToolConfig(activeConfigId, { pinSection: targetSection }).then(() => {
            // Then reorder to insert at the drop position
            const pinned = useToolStore.getState().getPinnedTools()
              .filter(t => (t.pinSection || 'right') === targetSection)
            const ids = pinned.map(t => t.id)
            const currentIndex = ids.indexOf(activeConfigId)
            const targetIndex = ids.indexOf(overConfigId)
            if (currentIndex !== -1 && targetIndex !== -1) {
              const newOrder = arrayMove(ids, currentIndex, targetIndex)
              reorderPinnedTools(newOrder)
            }
          })
        })
      }
    }
    // Toolbar-to-dropdown: unpin the tool
    else if (sourceArea === 'toolbar' && targetArea === 'dropdown') {
      const config = toolConfigs.get(activeConfigId)
      if (config?.pinned) {
        toggleToolPinned(activeConfigId)
      }
    }

    // ── Workspace toolbar drag cases ──

    // Workspace-to-workspace: reorder pinned workspaces
    else if (sourceArea === 'workspace-toolbar' && targetArea === 'workspace-toolbar') {
      const { getPinnedWorkspaces, reorderPinnedWorkspaces } = useSessionStore.getState()
      const pinned = getPinnedWorkspaces()
      const ids = pinned.map(s => s.id)
      const oldIndex = ids.indexOf(activeConfigId)
      const newIndex = ids.indexOf(overConfigId)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(ids, oldIndex, newIndex)
        reorderPinnedWorkspaces(newOrder)
      }
    }
  }

  const handleDragCancel = () => {
    setDragState({
      activeId: null,
      activeConfig: null,
      activeLayoutPreset: null,
      source: null,
      overArea: null,
    })
  }

  return (
    <ToolDragStateContext.Provider value={dragState}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {children}

        {/* Drag Overlay - ghost preview of dragged tool or layout preset */}
        <DragOverlay dropAnimation={null}>
          {dragState.activeConfig && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-vibe-surface border border-teal-500/50 rounded-lg shadow-xl text-sm text-vibe-text opacity-90 pointer-events-none">
              <span style={dragState.activeConfig.color ? { color: dragState.activeConfig.color } : undefined}>
                <ToolIcon config={dragState.activeConfig} />
              </span>
              <span style={dragState.activeConfig.color ? { color: dragState.activeConfig.color } : undefined}>
                {dragState.activeConfig.name}
              </span>
            </div>
          )}
          {dragState.activeLayoutPreset && (() => {
            const preset = LAYOUT_PRESETS.find(p => p.type === dragState.activeLayoutPreset)
            return preset ? (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-vibe-surface border border-teal-500/50 rounded-lg shadow-xl text-sm text-vibe-text opacity-90 pointer-events-none">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d={preset.icon} />
                </svg>
                <span>{preset.name}</span>
              </div>
            ) : null
          })()}
          {dragState.source === 'workspace-toolbar' && dragState.activeId && (() => {
            const sessionId = stripPrefix(dragState.activeId)
            const session = useSessionStore.getState().sessions.find(s => s.id === sessionId)
            return session ? (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-vibe-surface border border-teal-500/50 rounded-lg shadow-xl text-sm text-vibe-text opacity-90 pointer-events-none">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                <span>{session.name}</span>
              </div>
            ) : null
          })()}
        </DragOverlay>
      </DndContext>
    </ToolDragStateContext.Provider>
  )
}
