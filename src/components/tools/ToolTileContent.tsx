import { useCallback, useMemo } from 'react'
import type { JsonValue } from '@quadflow/plugin-api'
import { ToolInstance, ToolConfig } from '../../types'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore } from '../../stores/toolStore'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { removeTerminalFromTree } from '../../lib/layoutUtils'
import TileHost from '../../plugins/TileHost'

interface ToolTileContentProps {
  instance: ToolInstance
  config: ToolConfig | undefined
  /** `flyout` when rendered by ToolFlyoutPanel (default: a mosaic pane). */
  mode?: 'pane' | 'flyout'
  visible?: boolean
  /** Close handler for flyouts (panes close by leaving the layout). */
  onClose?: () => void
}

function updateInstance(id: string, isGlobal: boolean, patch: Partial<ToolInstance>) {
  if (!isGlobal) return useToolStore.getState().updateTool(id, patch)
  useGlobalWorkspaceStore.setState((s) => {
    const current = s.globalToolInstances.get(id)
    if (!current) return s
    const globalToolInstances = new Map(s.globalToolInstances)
    globalToolInstances.set(id, { ...current, ...patch })
    return { globalToolInstances }
  })
}

/**
 * Body of a tool tile: the plugin contribution the config points at, rendered
 * by `<TileHost>` (plugin-system.md §5.4) — trusted module, sandbox frame, or
 * `<MissingPluginTile>` when the plugin is disabled / uninstalled.
 */
export default function ToolTileContent({ instance, config, mode = 'pane', visible = true, onClose }: ToolTileContentProps) {
  const { setActiveTerminal } = useTerminalStore()
  const { setToolAttention } = useToolStore()

  const handleFocus = () => {
    if (mode === 'pane') setActiveTerminal(instance.id)
    // Clear attention when tool is focused
    if (instance.needsAttention) {
      setToolAttention(instance.id, false)
    }
  }

  const pluginState = (instance.metadata?.pluginState as JsonValue | undefined) ?? null
  const tileInstance = useMemo(
    () => ({ id: instance.id, title: instance.title, state: pluginState }),
    [instance.id, instance.title, pluginState],
  )
  const tileConfig = useMemo(
    () => (config ? { id: config.id, name: config.name, settings: (config.settings ?? {}) as JsonValue } : null),
    [config],
  )

  const isGlobal = instance.scope === 'global'
  const onSetTitle = useCallback(
    (title: string) => {
      updateInstance(instance.id, isGlobal, { title })
    },
    [instance.id, isGlobal],
  )
  const onSetState = useCallback(
    (state: JsonValue) => {
      const metadata = { ...instance.metadata, pluginState: state }
      updateInstance(instance.id, isGlobal, { metadata })
    },
    [instance.id, instance.metadata, isGlobal],
  )
  const onSetAttention = useCallback((a: boolean) => useToolStore.getState().setToolAttention(instance.id, a), [instance.id])
  const close = useCallback(() => {
    if (onClose) return onClose()
    const term = useTerminalStore.getState()
    term.setLayoutTree(removeTerminalFromTree(term.layoutTree, instance.id))
    useToolStore.getState().closeTool(instance.id)
  }, [instance.id, onClose])

  if (!config || !tileConfig) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted" onClick={handleFocus}>
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p>Tool configuration not found</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full" onClick={handleFocus}>
      <TileHost
        pluginId={config.pluginId}
        contributionId={config.contributionId}
        instance={tileInstance}
        config={tileConfig}
        mode={mode}
        visible={visible}
        onSetTitle={onSetTitle}
        onSetState={onSetState}
        onSetAttention={onSetAttention}
        onClose={close}
      />
    </div>
  )
}
