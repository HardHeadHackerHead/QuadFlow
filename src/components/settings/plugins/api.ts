/**
 * Settings → Plugins data access (plugin-system.md §4.3, §11.2, §12).
 * Thin wrappers over the generated plugin / plugin-source commands.
 */
import {
  commands,
  type PluginAvailable_Serialize,
  type PluginInfo_Serialize,
  type PluginInstallPlan,
  type PluginSourceInfo,
  type PluginUninstallResult,
  type PluginUpdateInfo,
} from '../../../generated/bindings'
import { call } from '../../../lib/core'

export type PluginInfoData = PluginInfo_Serialize
export type PluginAvailableData = PluginAvailable_Serialize
export type { PluginInstallPlan, PluginSourceInfo, PluginUninstallResult, PluginUpdateInfo }

export const pluginsApi = {
  list: (includeUnsupported: boolean) => call(commands.pluginsList(includeUnsupported)),
  enable: (id: string) => call(commands.pluginsEnable(id)),
  disable: (id: string) => call(commands.pluginsDisable(id)),
  grant: (id: string, permissions: string[]) => call(commands.pluginsGrant(id, permissions)),
  planInstall: (sourceId: string | null, pluginId: string, version: string | null = null) =>
    call(commands.pluginsInstall(sourceId, pluginId, version)),
  planUpdate: (id: string) => call(commands.pluginsUpdate(id)),
  confirm: (planId: string, granted: string[]) => call(commands.pluginsInstallConfirm(planId, granted)),
  cancel: (planId: string) => call(commands.pluginsInstallCancel(planId)),
  rollback: (id: string) => call(commands.pluginsRollback(id)),
  uninstall: (id: string, deleteData: boolean) => call(commands.pluginsUninstall(id, deleteData)),
  checkUpdates: () => call(commands.pluginsCheckUpdates()),
  availableUpdates: () => call(commands.pluginsAvailableUpdates()),
  sources: () => call(commands.pluginSourcesList()),
  addSource: (url: string) => call(commands.pluginSourcesAdd(url)),
  removeSource: (id: string) => call(commands.pluginSourcesRemove(id)),
  setSourceEnabled: (id: string, enabled: boolean) => call(commands.pluginSourcesSetEnabled(id, enabled)),
  refreshSources: (id: string | null = null) => call(commands.pluginSourcesRefresh(id)),
  browse: (id: string | null = null) => call(commands.pluginSourcesBrowse(id)),
  // Dev mode (plugin-system.md §15.3): unpacked plugin folders.
  devPaths: () => call(commands.pluginsDevPaths()),
  devAdd: (path: string) => call(commands.pluginsDevAdd(path)),
  devRemove: (path: string) => call(commands.pluginsDevRemove(path)),
}

declare global {
  interface Window {
    /** Test hook (GUI harness): replaces the native folder picker of "Load unpacked…". */
    __QF_TEST_PICK_FOLDER__?: () => string | null | Promise<string | null>
  }
}

/** Ask for a plugin folder (native picker; the GUI harness can stub it). */
export async function pickPluginFolder(): Promise<string | null> {
  if (window.__QF_TEST_PICK_FOLDER__) return window.__QF_TEST_PICK_FOLDER__()
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false, title: 'Load unpacked plugin (folder with quadflow-plugin.json)' })
  return typeof picked === 'string' ? picked : null
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}
