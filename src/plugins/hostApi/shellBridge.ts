/**
 * Shell operations the host API needs from the layout / tool system
 * (`ui.openTile`, placing plugin terminals, focusing tiles). One small,
 * replaceable seam (`setShellBridge`) between the host API and the shell stores.
 */
import type { JsonValue } from '@quadflow/plugin-api'
import { activateTool, ensureToolConfig } from '../tools'
import { useTerminalStore } from '../../stores/terminalStore'

export interface ShellBridge {
  /**
   * Open a tile contribution; the instance id arrives via TileHost registration.
   * `state` becomes the new pane tile's `instance.state` (flyouts reuse their instance).
   */
  openTile(pluginId: string, contributionId: string, mode: 'pane' | 'flyout', state?: JsonValue): Promise<void>
  /** Show an existing PTY as a terminal tile (it re-attaches by id). */
  placeTerminal(t: { id: string; pid: number | null; cwd: string }, placement: 'tile' | 'split-active' | 'replace-empty'): void
  focusTile(instanceId: string): void
  /** Make a terminal the active one (`terminals.focus`, after the Rust access check). */
  focusTerminal(terminalId: string): void
}

let bridge: ShellBridge = {
  // PL-4: tiles open through the one contribution registry (src/plugins/tools.tsx).
  openTile: async (pluginId, contributionId, mode, state) =>
    activateTool(await ensureToolConfig(pluginId, contributionId), { source: 'palette', mode, state }),
  placeTerminal: (t) => {
    useTerminalStore.getState().addTerminal({ id: t.id, pid: t.pid ?? undefined, cwd: t.cwd })
  },
  focusTile: (instanceId) => useTerminalStore.getState().setActiveTerminal(instanceId),
  focusTerminal: (terminalId) => useTerminalStore.getState().setActiveTerminal(terminalId),
}

export function getShellBridge(): ShellBridge {
  return bridge
}

export function setShellBridge(b: Partial<ShellBridge>): void {
  bridge = { ...bridge, ...b }
}
