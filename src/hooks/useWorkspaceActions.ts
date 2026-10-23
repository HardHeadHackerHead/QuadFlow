import { useState, useMemo, useCallback } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useProjectStore } from '../stores/projectStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useToolStore } from '../stores/toolStore'
import { useAppSettingsStore, DefaultWorkspacePane } from '../stores/appSettingsStore'
import { switchWorkspace as switchWorkspaceTransition, createWorkspaceAndActivate, resetActiveWorkspace } from '../lib/workspaceSave'
import {
  WorkspaceTemplate,
  applyWorkspaceTemplate,
  applyDefaultWorkspace,
  getWorkspaceTemplates,
  saveWorkspaceTemplates,
  resetWorkspaceTemplates,
} from '../lib/workspaceTemplates'
import { LAYOUT_PRESETS, LayoutPresetType, createEmptyTileId, isEmptyTile } from '../lib/layoutUtils'
import { isToolLeaf } from '../lib/layoutIds'

export function useWorkspaceActions() {
  const { sessions, activeSession, updateSession, deleteSession, loadSessions, toggleWorkspacePinned } = useSessionStore()
  const { activeProject } = useProjectStore()
  const { getTerminalsArray, getSerializedLayoutTree } = useTerminalStore()
  const { toolConfigs } = useToolStore()
  const { defaultWorkspace, updateDefaultWorkspace } = useAppSettingsStore()

  const [templates, setTemplates] = useState<WorkspaceTemplate[]>(() => getWorkspaceTemplates())
  const [defaultSaved, setDefaultSaved] = useState(false)

  // Filter workspaces to current project
  const projectWorkspaces = useMemo(() => {
    if (!activeProject) return sessions
    return sessions.filter(s => s.projectId === activeProject.id)
  }, [sessions, activeProject])

  // Summary text for the saved default workspace
  const defaultSummary = useMemo(() => {
    const dw = defaultWorkspace
    if (!dw.panes.length) return 'Solo Agent'
    const agents = dw.panes.filter(p => p.type === 'agent').length
    const terms = dw.panes.filter(p => p.type === 'terminal').length
    const tools = dw.panes.filter(p => p.type === 'tool')
    const parts: string[] = []
    if (agents > 0) parts.push(`${agents} agent${agents > 1 ? 's' : ''}`)
    if (terms > 0) parts.push(`${terms} term${terms > 1 ? 's' : ''}`)
    if (tools.length > 0) {
      const toolLabels = tools.map(t => {
        const config = toolConfigs.get(t.toolConfigId || '')
        return config?.name || t.toolConfigId || 'Tool'
      })
      parts.push(toolLabels.join(' + '))
    }
    return parts.join(', ') || 'Empty'
  }, [defaultWorkspace, toolConfigs])

  // Reload templates (e.g. when sidebar opens)
  const reloadTemplates = useCallback(() => {
    setTemplates(getWorkspaceTemplates())
  }, [])

  // Switching / creating / resetting run as exclusive transitions in the
  // workspace controller (save current → tear down → activate → restore).
  const switchWorkspace = useCallback(async (sessionId: string) => {
    await switchWorkspaceTransition(sessionId)
  }, [])

  const nextName = useCallback((name?: string) => name?.trim() || `Workspace ${projectWorkspaces.length + 1}`, [projectWorkspaces.length])

  const createFromTemplate = useCallback(async (template: WorkspaceTemplate, name?: string) => {
    if (!activeProject) return
    await createWorkspaceAndActivate(nextName(name), (dir) => applyWorkspaceTemplate(template, dir))
  }, [activeProject, nextName])

  const launchDefault = useCallback(async (name?: string) => {
    if (!activeProject) return
    await createWorkspaceAndActivate(nextName(name), (dir) => applyDefaultWorkspace(defaultWorkspace, dir))
  }, [activeProject, nextName, defaultWorkspace])

  const launchBlank = useCallback(async (name?: string) => {
    if (!activeProject) return
    await createWorkspaceAndActivate(nextName(name), async () => {
      useTerminalStore.getState().setLayoutTree(createEmptyTileId())
    })
  }, [activeProject, nextName])

  const resetWorkspace = useCallback(async () => {
    if (!activeProject || !activeSession) return
    await resetActiveWorkspace((dir) => applyDefaultWorkspace(defaultWorkspace, dir))
  }, [activeProject, activeSession, defaultWorkspace])

  const renameWorkspace = useCallback(async (id: string, newName: string) => {
    if (newName.trim()) {
      await updateSession(id, { name: newName.trim() })
    }
  }, [updateSession])

  const deleteWorkspace = useCallback(async (id: string) => {
    if (activeSession?.id === id) return
    await deleteSession(id)
  }, [activeSession, deleteSession])

  const togglePin = useCallback(async (sessionId: string) => {
    await toggleWorkspacePinned(sessionId)
  }, [toggleWorkspacePinned])

  // Save current layout as default
  const saveCurrentAsDefault = useCallback(() => {
    const treeJson = getSerializedLayoutTree()
    if (!treeJson) return

    const tree = JSON.parse(treeJson)
    const terminals = getTerminalsArray()
    const toolStoreState = useToolStore.getState()

    const panes: DefaultWorkspacePane[] = []
    const realToPlaceholder = new Map<string, string>()
    let agentIdx = 0, termIdx = 0, toolIdx = 0, emptyIdx = 0

    function walkLeaves(node: unknown) {
      if (typeof node === 'string') {
        if (isEmptyTile(node)) {
          const placeholderId = `empty-${emptyIdx++}`
          panes.push({ id: placeholderId, type: 'empty' })
          realToPlaceholder.set(node, placeholderId)
        } else if (isToolLeaf(node)) {
          const toolInstance = toolStoreState.toolInstances.get(node)
          const configId = toolInstance?.configId ?? ''
          const placeholderId = `tool:default-${toolIdx++}`
          panes.push({ id: placeholderId, type: 'tool', toolConfigId: configId, isLocked: toolInstance?.isLocked })
          realToPlaceholder.set(node, placeholderId)
        } else {
          const terminal = terminals.find(t => t.id === node)
          if (terminal?.agent) {
            const placeholderId = `agent-${agentIdx++}`
            panes.push({ id: placeholderId, type: 'agent', isLocked: terminal.isLocked })
            realToPlaceholder.set(node, placeholderId)
          } else {
            const placeholderId = `terminal-${termIdx++}`
            panes.push({ id: placeholderId, type: 'terminal', isLocked: terminal?.isLocked })
            realToPlaceholder.set(node, placeholderId)
          }
        }
      } else if (node && typeof node === 'object') {
        const n = node as { first: unknown; second: unknown }
        walkLeaves(n.first)
        walkLeaves(n.second)
      }
    }
    walkLeaves(tree)

    function replaceIds(node: unknown): unknown {
      if (typeof node === 'string') return realToPlaceholder.get(node) ?? node
      if (node && typeof node === 'object') {
        const n = node as { direction: string; first: unknown; second: unknown; splitPercentage?: number }
        return { ...n, first: replaceIds(n.first), second: replaceIds(n.second) }
      }
      return node
    }
    const placeholderTree = replaceIds(tree)

    updateDefaultWorkspace({ layoutTree: JSON.stringify(placeholderTree), panes })
    setDefaultSaved(true)
    setTimeout(() => setDefaultSaved(false), 1500)
  }, [getSerializedLayoutTree, getTerminalsArray, updateDefaultWorkspace])

  // Template editing helpers
  const handleResetTemplates = useCallback(() => {
    resetWorkspaceTemplates()
    setTemplates(getWorkspaceTemplates())
  }, [])

  const updateTemplate = useCallback((id: string, updates: Partial<WorkspaceTemplate>) => {
    setTemplates(prev => {
      const updated = prev.map(t => {
        if (t.id !== id) return t
        const merged = { ...t, ...updates }
        const totalPanes = merged.agentCount + merged.terminalCount + merged.tiles.length
        if (totalPanes <= 1) {
          merged.layoutPreset = 'focus'
        } else if (totalPanes === 2) {
          if (merged.layoutPreset === 'focus') merged.layoutPreset = 'columns'
        } else if (totalPanes === 3) {
          if (merged.layoutPreset === 'focus' || merged.layoutPreset === 'columns') merged.layoutPreset = 'mainSidebar'
        } else {
          if (merged.layoutPreset === 'focus' || merged.layoutPreset === 'columns' || merged.layoutPreset === 'rows') merged.layoutPreset = 'grid'
        }
        return merged
      })
      saveWorkspaceTemplates(updated)
      return updated
    })
  }, [])

  const deleteTemplate = useCallback((id: string) => {
    setTemplates(prev => {
      if (prev.length <= 1) return prev
      const updated = prev.filter(t => t.id !== id)
      saveWorkspaceTemplates(updated)
      return updated
    })
  }, [])

  const addTemplate = useCallback(() => {
    const newTemplate: WorkspaceTemplate = {
      id: `custom-${Date.now()}`,
      name: 'New Template',
      description: 'Custom workspace',
      layoutPreset: 'focus',
      agentCount: 1,
      terminalCount: 0,
      tiles: [],
    }
    setTemplates(prev => {
      const updated = [...prev, newTemplate]
      saveWorkspaceTemplates(updated)
      return updated
    })
  }, [])

  const cycleLayoutPreset = useCallback((templateId: string, current: LayoutPresetType) => {
    const presetTypes = LAYOUT_PRESETS.map(p => p.type)
    const idx = presetTypes.indexOf(current)
    const next = presetTypes[(idx + 1) % presetTypes.length]
    updateTemplate(templateId, { layoutPreset: next })
  }, [updateTemplate])

  const toggleTemplateTile = useCallback((templateId: string, ref: string) => {
    setTemplates(prev => {
      const template = prev.find(t => t.id === templateId)
      if (!template) return prev
      const tiles = template.tiles.includes(ref)
        ? template.tiles.filter(t => t !== ref)
        : [...template.tiles, ref]
      const updated = prev.map(t => t.id === templateId ? { ...t, tiles } : t)
      saveWorkspaceTemplates(updated)
      return updated
    })
  }, [])

  return {
    // Data
    projectWorkspaces,
    templates,
    defaultSummary,
    defaultSaved,
    defaultWorkspace,
    activeSession,
    loadSessions,
    reloadTemplates,

    // Workspace CRUD
    switchWorkspace,
    createFromTemplate,
    launchDefault,
    launchBlank,
    resetWorkspace,
    renameWorkspace,
    deleteWorkspace,
    togglePin,

    // Default workspace
    saveCurrentAsDefault,

    // Template editing
    updateTemplate,
    deleteTemplate,
    addTemplate,
    cycleLayoutPreset,
    toggleTemplateTile,
    handleResetTemplates,
  }
}
