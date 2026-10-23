import { useTerminalStore } from '../stores/terminalStore'
import { useToolStore } from '../stores/toolStore'
import { useAppSettingsStore, DefaultWorkspaceSettings } from '../stores/appSettingsStore'
import { terminalApi } from './tauri-api'
import { createLayoutByPreset, createEmptyTileId, LayoutPresetType } from './layoutUtils'
import { launchAgent } from '../agents/launch'
import * as appData from './appData'
import type { JsonValue } from '../generated/bindings'

export interface WorkspaceTemplate {
  id: string
  name: string
  description: string
  layoutPreset: LayoutPresetType
  agentCount: number
  terminalCount: number
  /** Templateable tiles to open, as `<pluginId>/<contributionId>` refs (plugin-system.md §5.1). */
  tiles: string[]
}

export const DEFAULT_WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'solo-agent',
    name: 'Solo Agent',
    description: '1 agent',
    layoutPreset: 'focus',
    agentCount: 1,
    terminalCount: 0,
    tiles: [],
  },
  {
    id: 'pair-coding',
    name: 'Pair Coding',
    description: '2 agents',
    layoutPreset: 'columns',
    agentCount: 2,
    terminalCount: 0,
    tiles: [],
  },
  {
    id: 'agent-tools',
    name: 'Agent + Tools',
    description: 'Agent with Issues & Plans',
    layoutPreset: 'mainSidebar',
    agentCount: 1,
    terminalCount: 0,
    tiles: ['issues/board', 'plans/board'],
  },
  {
    id: 'full-stack',
    name: 'Full Stack',
    description: '2 agents with GitHub & Issues',
    layoutPreset: 'grid',
    agentCount: 2,
    terminalCount: 0,
    tiles: ['github/git', 'issues/board'],
  },
  {
    id: 'blank',
    name: 'Blank',
    description: '1 empty terminal',
    layoutPreset: 'focus',
    agentCount: 0,
    terminalCount: 1,
    tiles: [],
  },
]

// Persisted in core settings (`shell.workspaceTemplates`); read once at
// startup into an in-memory cache so the getters stay synchronous.
const SETTINGS_NS = 'shell'
const SETTINGS_KEY = 'workspaceTemplates'
let cached: WorkspaceTemplate[] | null = null

/** Load the saved templates from the core (call once at startup). */
export async function initWorkspaceTemplates(): Promise<void> {
  try {
    const stored = await appData.getSetting<WorkspaceTemplate[]>(SETTINGS_NS, SETTINGS_KEY)
    cached = Array.isArray(stored) && stored.length > 0
      ? stored.map((t) => ({ ...t, tiles: Array.isArray(t.tiles) ? t.tiles : [] }))
      : null
  } catch (e) {
    console.error('[workspaceTemplates] load failed:', e)
  }
}

/** Saved workspace templates, falling back to defaults */
export function getWorkspaceTemplates(): WorkspaceTemplate[] {
  return cached ? [...cached] : [...DEFAULT_WORKSPACE_TEMPLATES]
}

/** Persist workspace templates */
export function saveWorkspaceTemplates(templates: WorkspaceTemplate[]): void {
  cached = [...templates]
  appData.setSetting(SETTINGS_NS, SETTINGS_KEY, templates as unknown as JsonValue)
    .catch((e) => console.error('[workspaceTemplates] save failed:', e))
}

/** Reset workspace templates back to built-in defaults */
export function resetWorkspaceTemplates(): void {
  cached = null
  appData.deleteSetting(SETTINGS_NS, SETTINGS_KEY).catch((e) => console.error('[workspaceTemplates] reset failed:', e))
}

/**
 * Apply a workspace template: create terminals, agents, tools, and set up the layout.
 */
export async function applyWorkspaceTemplate(
  template: WorkspaceTemplate,
  workingDirectory: string
): Promise<void> {
  const terminalStore = useTerminalStore.getState()
  const toolStore = useToolStore.getState()
  const appSettings = useAppSettingsStore.getState()

  // Resolve default shell from environment settings
  const environments = appSettings.environments
  const defaultEnv = environments.defaultEnvironmentId
    ? environments.terminalEnvironments.find(e => e.id === environments.defaultEnvironmentId)
    : undefined
  const defaultShell = defaultEnv?.shell !== 'default' ? defaultEnv?.shell as 'cmd' | 'powershell' | 'bash' | undefined : undefined
  const defaultInitCommands = defaultEnv?.initCommands

  const allPaneIds: string[] = []

  // 1. Agent terminals: the default provider with its default model / effort.
  for (let i = 0; i < template.agentCount; i++) {
    try {
      const r = await launchAgent({ projectRoot: workingDirectory, cwd: workingDirectory })
      if (r) allPaneIds.push(r.terminalId)
    } catch (error) {
      console.error('Failed to create agent terminal:', error)
    }
  }

  // 2. Create plain terminals
  for (let i = 0; i < template.terminalCount; i++) {
    try {
      const info = await terminalApi.create({
        cwd: workingDirectory,
        shell: defaultShell,
        initCommands: defaultInitCommands,
      })
      terminalStore.addTerminal(info)
      allPaneIds.push(info.id)
    } catch (error) {
      console.error('Failed to create terminal:', error)
    }
  }

  // 3. Open tiles by resolving contribution refs to tool configs
  for (const ref of template.tiles) {
    // First enabled tool config of this contribution
    const config = Array.from(toolStore.toolConfigs.values()).find(
      c => `${c.pluginId}/${c.contributionId}` === ref && c.enabled
    )
    if (!config) continue
    if (config.openMode === 'flyout') continue
    try {
      const instanceId = await toolStore.openTool(config.id)
      allPaneIds.push(instanceId)
    } catch (error) {
      console.error(`Failed to open tool ${ref}:`, error)
    }
  }

  // 4. Build and set layout tree
  if (allPaneIds.length > 0) {
    const { layoutTree } = createLayoutByPreset(template.layoutPreset, allPaneIds)
    terminalStore.setLayoutTree(layoutTree)
  }
}

/** Replace placeholder IDs in a parsed layout tree with real IDs */
function replaceIdsInTree(node: unknown, idMap: Map<string, string>): unknown {
  if (typeof node === 'string') {
    return idMap.get(node) ?? node
  }
  if (node && typeof node === 'object') {
    const n = node as { direction: string; first: unknown; second: unknown; splitPercentage?: number }
    return {
      ...n,
      first: replaceIdsInTree(n.first, idMap),
      second: replaceIdsInTree(n.second, idMap),
    }
  }
  return node
}

/**
 * Apply a saved default workspace: recreate exact pane layout with preserved sizing.
 * Falls back to a single-agent template if no layout is saved.
 */
export async function applyDefaultWorkspace(
  defaultWs: DefaultWorkspaceSettings,
  workingDirectory: string
): Promise<void> {
  // Fall back to single agent if nothing saved
  if (!defaultWs.layoutTree || defaultWs.panes.length === 0) {
    await applyWorkspaceTemplate({
      id: 'default',
      name: 'Default',
      description: 'Default workspace',
      layoutPreset: 'focus',
      agentCount: 1,
      terminalCount: 0,
      tiles: [],
    }, workingDirectory)
    return
  }

  const terminalStore = useTerminalStore.getState()
  const toolStore = useToolStore.getState()
  const appSettings = useAppSettingsStore.getState()

  // Resolve default shell from environment settings
  const environments = appSettings.environments
  const defaultEnv = environments.defaultEnvironmentId
    ? environments.terminalEnvironments.find(e => e.id === environments.defaultEnvironmentId)
    : undefined
  const defaultShell = defaultEnv?.shell !== 'default' ? defaultEnv?.shell as 'cmd' | 'powershell' | 'bash' | undefined : undefined
  const defaultInitCommands = defaultEnv?.initCommands

  // Create real panes and build placeholder → real ID mapping
  const idMap = new Map<string, string>()

  for (const pane of defaultWs.panes) {
    try {
      if (pane.type === 'agent') {
        const r = await launchAgent({ projectRoot: workingDirectory, cwd: workingDirectory, terminal: { isLocked: pane.isLocked } })
        if (r) idMap.set(pane.id, r.terminalId)
      } else if (pane.type === 'terminal') {
        const info = await terminalApi.create({
          cwd: workingDirectory,
          shell: defaultShell,
          initCommands: defaultInitCommands,
        })
        terminalStore.addTerminal(info)
        if (pane.isLocked) {
          terminalStore.updateTerminal(info.id, { isLocked: true })
        }
        idMap.set(pane.id, info.id)
      } else if (pane.type === 'empty') {
        idMap.set(pane.id, createEmptyTileId())
      } else if (pane.type === 'tool' && pane.toolConfigId) {
        // Check that the tool config still exists and is enabled
        const config = toolStore.toolConfigs.get(pane.toolConfigId)
        if (config && config.enabled && config.openMode !== 'flyout') {
          const instanceId = await toolStore.openTool(pane.toolConfigId)
          if (pane.isLocked) {
            toolStore.updateTool(instanceId, { isLocked: true })
          }
          idMap.set(pane.id, instanceId)
        }
      }
    } catch (error) {
      console.error(`Failed to create pane ${pane.type}:`, error)
    }
  }

  // Parse saved tree and replace placeholder IDs with real IDs
  try {
    const tree = JSON.parse(defaultWs.layoutTree)
    const realTree = replaceIdsInTree(tree, idMap)
    terminalStore.setLayoutTree(realTree as import('react-mosaic-component').MosaicNode<string>)
  } catch (error) {
    console.error('Failed to parse default workspace layout tree:', error)
  }
}
