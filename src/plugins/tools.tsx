/**
 * The one tool registry (plugin-system.md §5): everything the shell shows for
 * a tool — icon, menu group, open modes, flyout size, config form, mini
 * widget, what its toolbar button does — is derived from the plugin
 * contribution a tool config points at (`pluginId` + `contributionId`).
 *
 * A config whose plugin is disabled, incompatible, unsupported on this OS or
 * uninstalled has no contribution: it is hidden from menus and its open tiles
 * render `<MissingPluginTile>` through `<TileHost>`.
 */
import { useEffect, useMemo, useState, type ComponentType } from 'react'
import type { JsonValue, MiniWidgetProps } from '@quadflow/plugin-api'
import type { Category, Tile_Serialize, ToolbarItem_Serialize } from '../generated/bindings'
import type { ToolConfig } from '../types'
import { useToolStore } from '../stores/toolStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { insertTerminalFillEmpty, replaceEmptyTile } from '../lib/layoutUtils'
import { ensurePluginRegistry, usePluginRegistry, type PluginContributions, type PluginInfo } from './registry'
import { loadPluginModule, type LoadedPluginModule } from './loader'
import { runPluginCommand } from './commands'
import PluginIcon from './PluginIcon'

export type TileManifest = Tile_Serialize
export type ToolbarItemManifest = ToolbarItem_Serialize
export type ToolMode = 'pane' | 'flyout'

export type ToolContribution =
  | { kind: 'tile'; pluginId: string; id: string; title: string; icon?: string | null; category: Category; tile: TileManifest }
  | { kind: 'toolbar'; pluginId: string; id: string; title: string; icon?: string | null; category: Category; item: ToolbarItemManifest }

// ---- menu groups: a fixed shell table keyed by manifest category (§5.1) ----

export const TOOL_CATEGORIES: { id: Category; label: string }[] = [
  { id: 'project-management', label: 'Project Management' },
  { id: 'development', label: 'Development' },
  { id: 'ai-agents', label: 'AI & Agents' },
  { id: 'media', label: 'Media & Streaming' },
  { id: 'system', label: 'System' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'other', label: 'Custom' },
]

// ---- lookups ----

export function findContribution(
  contributions: PluginContributions | null,
  plugins: PluginInfo[],
  pluginId: string,
  contributionId: string,
): ToolContribution | undefined {
  if (!contributions) return undefined
  const pluginCategory = plugins.find((p) => p.id === pluginId)?.category ?? 'other'
  const tile = contributions.tiles.find((t) => t.pluginId === pluginId && t.contribution.id === contributionId)
  if (tile) {
    const c = tile.contribution
    return { kind: 'tile', pluginId, id: c.id, title: c.title, icon: c.icon, category: c.category ?? pluginCategory, tile: c }
  }
  const item = contributions.toolbarItems.find((t) => t.pluginId === pluginId && t.contribution.id === contributionId)
  if (item) {
    const c = item.contribution
    return { kind: 'toolbar', pluginId, id: c.id, title: c.title, icon: c.icon, category: c.category ?? pluginCategory, item: c }
  }
  return undefined
}

type ToolRef = Pick<ToolConfig, 'pluginId' | 'contributionId'>

/** The contribution behind a config (non-reactive). */
export function getToolContribution(config: ToolRef | null | undefined): ToolContribution | undefined {
  if (!config) return undefined
  const { contributions, plugins } = usePluginRegistry.getState()
  return findContribution(contributions, plugins, config.pluginId, config.contributionId)
}

/** The contribution behind a config (re-renders when the registry changes). */
export function useToolContribution(config: ToolRef | null | undefined): ToolContribution | undefined {
  const contributions = usePluginRegistry((s) => s.contributions)
  const plugins = usePluginRegistry((s) => s.plugins)
  const pluginId = config?.pluginId
  const contributionId = config?.contributionId
  return useMemo(
    () => (pluginId && contributionId ? findContribution(contributions, plugins, pluginId, contributionId) : undefined),
    [contributions, plugins, pluginId, contributionId],
  )
}

/** Configs whose contribution is currently available (active plugin). */
export function useAvailableToolConfigs(filter?: (c: ToolConfig, contribution: ToolContribution) => boolean): ToolConfig[] {
  const toolConfigs = useToolStore((s) => s.toolConfigs)
  const contributions = usePluginRegistry((s) => s.contributions)
  const plugins = usePluginRegistry((s) => s.plugins)
  return useMemo(() => {
    const out: ToolConfig[] = []
    for (const c of toolConfigs.values()) {
      const contribution = findContribution(contributions, plugins, c.pluginId, c.contributionId)
      if (contribution && (!filter || filter(c, contribution))) out.push(c)
    }
    return out.sort((a, b) => a.order - b.order)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolConfigs, contributions, plugins])
}

export function isToolAvailable(config: ToolRef | null | undefined): boolean {
  return !!getToolContribution(config)
}

/** Toolbar items trigger their command; they never open as panes or flyouts. */
export function isActionContribution(c: ToolContribution | undefined): boolean {
  return c?.kind === 'toolbar'
}

export function contributionModes(c: ToolContribution | undefined): ToolMode[] {
  if (!c || c.kind !== 'tile') return []
  return c.tile.modes?.length ? c.tile.modes : ['pane', 'flyout']
}

export function canOpenInPane(c: ToolContribution | undefined): boolean {
  return contributionModes(c).includes('pane')
}

export function supportsMiniWidget(c: ToolContribution | undefined): boolean {
  if (!c) return false
  return c.kind === 'tile' ? c.tile.miniWidget : c.item.miniWidget
}

export function configSchemaOf(c: ToolContribution | undefined): Record<string, unknown> | null {
  if (!c) return null
  const s = c.kind === 'tile' ? c.tile.configSchema : c.item.configSchema
  return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
}

/** May the user create more configs of this contribution ("Add tool")? */
export function isInstanceMultiple(c: ToolContribution): boolean {
  return c.kind === 'tile' ? c.tile.instanceMultiple : !!c.item.instanceMultiple
}

export function flyoutDefaultSize(c: ToolContribution | undefined): [number, number] {
  const s = c?.kind === 'tile' ? c.tile.flyout?.defaultSize : null
  return s ? [s[0], s[1]] : [480, 400]
}

/** Every available contribution (tiles first), for "Add tool" pickers. */
export function listContributions(): ToolContribution[] {
  const { contributions, plugins } = usePluginRegistry.getState()
  if (!contributions) return []
  return [
    ...contributions.tiles.map((t) => findContribution(contributions, plugins, t.pluginId, t.contribution.id)!),
    ...contributions.toolbarItems.map((t) => findContribution(contributions, plugins, t.pluginId, t.contribution.id)!),
  ]
}

/** Group configs by their contribution's category, in the shell's fixed order. */
export function groupToolConfigs(configs: ToolConfig[]): { id: Category; label: string; tools: ToolConfig[] }[] {
  const groups = new Map<Category, ToolConfig[]>()
  for (const c of configs) {
    const cat = getToolContribution(c)?.category ?? 'other'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(c)
  }
  return TOOL_CATEGORIES.filter((g) => groups.has(g.id)).map((g) => ({ ...g, tools: groups.get(g.id)! }))
}

/** Short type label for a config ("Issues", "TUI Tool", …). */
export function contributionLabel(config: ToolRef): string {
  return getToolContribution(config)?.title ?? `${config.pluginId}/${config.contributionId}`
}

// ---- icon ----

/** Icon of a tool config: its plugin contribution's manifest icon. */
export function ToolIcon({ config, className = 'w-4 h-4', size }: { config: ToolRef; className?: string; size?: number }) {
  return <PluginIcon pluginId={config.pluginId} contributionId={config.contributionId} className={className} size={size} />
}

// ---- opening / activating ----

/** Create a tile instance for `configId` and put it in the layout. Returns its leaf id. */
export async function openToolInPane(
  configId: string,
  opts: { metadata?: Record<string, unknown>; targetLeafId?: string } = {},
): Promise<string | null> {
  const ts = useToolStore.getState()
  try {
    const instanceId = await ts.openTool(configId, opts.metadata)
    const term = useTerminalStore.getState()
    if (opts.targetLeafId) {
      useTerminalStore.setState({ layoutTree: replaceEmptyTile(term.layoutTree, opts.targetLeafId, instanceId), activeTerminalId: instanceId })
    } else {
      const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
      term.setLayoutTree(insertTerminalFillEmpty(term.layoutTree, instanceId, term.activeTerminalId, splitDir))
      term.setActiveTerminal(instanceId)
    }
    return instanceId
  } catch (error) {
    console.error('Failed to open tool:', error)
    return null
  }
}

export interface ActivateOptions {
  /** Where the request came from: a toolbar button may run a tile's primary action. */
  source?: 'toolbar' | 'menu' | 'palette' | 'empty-tile'
  /** Force a mode; default: the config's `openMode`. */
  mode?: ToolMode
  /** Anchor for flyouts and popovers. */
  anchorRect?: DOMRect
  /** Empty tile to fill instead of splitting the active pane. */
  targetLeafId?: string
  /** Initial `instance.state` of a new pane tile (`ui.openTile({ state })`). */
  state?: JsonValue
}

function rectJson(r: DOMRect | undefined): JsonValue {
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
}

/**
 * The single entry point for "the user picked this tool": toolbar items run
 * their command (`{ toolConfigId, anchor, targetLeafId }` as args), tiles
 * open in a pane or flyout.
 */
export async function activateTool(config: ToolConfig, opts: ActivateOptions = {}): Promise<void> {
  await ensurePluginRegistry()
  const c = getToolContribution(config)
  if (!c) {
    console.warn(`[tools] ${config.pluginId}/${config.contributionId} is not available`)
    return
  }
  if (c.kind === 'toolbar') {
    try {
      await runPluginCommand(c.pluginId, c.item.command, {
        toolConfigId: config.id,
        anchor: rectJson(opts.anchorRect),
        targetLeafId: opts.targetLeafId ?? null,
      })
    } catch (error) {
      console.error(`[tools] ${c.pluginId}/${c.item.command} failed:`, error)
    }
    return
  }
  const modes = contributionModes(c)
  let mode: ToolMode = opts.mode ?? (opts.targetLeafId ? 'pane' : config.openMode)
  if (!modes.includes(mode)) mode = modes[0] ?? 'pane'
  if (mode === 'flyout') {
    const anchor = opts.anchorRect ?? new DOMRect(window.innerWidth / 2, 44, 0, 0)
    await useToolStore.getState().openFlyout(config.id, anchor)
    return
  }
  await openToolInPane(config.id, {
    targetLeafId: opts.targetLeafId,
    metadata: opts.state !== undefined && opts.state !== null ? { pluginState: opts.state } : undefined,
  })
}

/** Find or create a config for a contribution (used by palette entries without a config). */
export async function ensureToolConfig(pluginId: string, contributionId: string): Promise<ToolConfig> {
  const ts = useToolStore.getState()
  const existing = Array.from(ts.toolConfigs.values()).find((c) => c.pluginId === pluginId && c.contributionId === contributionId)
  if (existing) return existing
  await ensurePluginRegistry()
  const { contributions, plugins } = usePluginRegistry.getState()
  const c = findContribution(contributions, plugins, pluginId, contributionId)
  if (!c) throw new Error(`${pluginId}/${contributionId} is not available`)
  return ts.addToolConfig(c.title, { pluginId, contributionId }, {})
}

// ---- keeping tool configs in step with the registry ----

let syncInstalled = false

/**
 * Reload tool configs whenever the plugin list changes (enable / disable /
 * install / reload): `tool_configs_list` runs `tool_configs_sync_with_plugins`
 * in core, so newly active contributions get their default configs.
 */
export function installToolConfigSync(): void {
  if (syncInstalled) return
  syncInstalled = true
  let previous = usePluginRegistry.getState().plugins
  usePluginRegistry.subscribe((s) => {
    if (s.plugins === previous) return
    previous = s.plugins
    if (s.status === 'ready') void useToolStore.getState().loadToolConfigs()
  })
}

// ---- mini widgets ----

/** A contribution's mini toolbar widget (`miniWidget: true` + UI module `miniWidgets[id]`). */
export function PluginMiniWidget({ config }: { config: ToolConfig }) {
  const [loaded, setLoaded] = useState<LoadedPluginModule | null>(null)
  const generation = usePluginRegistry((s) => s.generations[config.pluginId] ?? 0)
  useEffect(() => {
    let cancelled = false
    loadPluginModule(config.pluginId).then(
      (m) => !cancelled && setLoaded(m),
      (e) => console.error(`[plugins] mini widget ${config.pluginId}/${config.contributionId}:`, e),
    )
    return () => {
      cancelled = true
    }
  }, [config.pluginId, generation])
  const Widget = loaded?.module.miniWidgets?.[config.contributionId] as ComponentType<MiniWidgetProps> | undefined
  const widgetConfig = useMemo(
    () => ({ id: config.id, name: config.name, settings: (config.settings ?? {}) as JsonValue }),
    [config.id, config.name, config.settings],
  )
  if (!loaded || !Widget) return <ToolIcon config={config} />
  return <Widget ctx={loaded.ctx} config={widgetConfig} />
}
