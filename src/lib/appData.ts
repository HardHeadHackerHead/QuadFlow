/**
 * App-domain data access (data-layer.md §7, DL-10): projects, workspaces,
 * terminals, tiles, global workspaces, tool configs, settings and stored
 * prompts, all through the typed core commands. Maps the core's generated
 * types to the shell's existing TS shapes (`Project`, `Session`, …) so the
 * stores keep their public API. Nothing here touches SQLite or localStorage.
 */
import { call, commands } from './core'
import { checkV1Project } from './core/v1Legacy'
import type {
  Project as CoreProject,
  Workspace as CoreWorkspace,
  WorkspaceTerminal,
  TileInstance,
  ToolConfig as CoreToolConfig,
  ToolConfigPatch_Deserialize,
  JsonValue,
  StoredPrompt as CoreStoredPrompt,
  GlobalWorkspace as CoreGlobalWorkspace,
  AgentBinding,
} from '../generated/bindings'
import type {
  Project,
  Session,
  SessionTerminal,
  SessionToolInstance,
  ToolConfig,
  ToolOpenMode,
  ToolPinDisplay,
  StoredPrompt,
  GlobalWorkspace,
  GlobalWorkspaceFrame,
  DefaultWorkspaceConfig,
} from '../types'
import type { MosaicNode } from 'react-mosaic-component'

// ==================== Projects ====================

export function toProject(p: CoreProject, activeId?: string | null): Project {
  return {
    id: p.id,
    name: p.name,
    workingDirectory: p.root,
    isActive: p.id === activeId,
    defaultWorkspaceConfig: (p.defaultWorkspaceTemplate as DefaultWorkspaceConfig | null) ?? null,
    createdAt: p.createdAt,
    updatedAt: p.lastOpenedAt ?? p.updatedAt,
  }
}

export async function listProjects(): Promise<Project[]> {
  const [list, active] = await Promise.all([call(commands.projectsList()), call(commands.projectsActive())])
  return list.map((p) => toProject(p, active?.id))
}

export async function getActiveProject(): Promise<Project | null> {
  const p = await call(commands.projectsActive())
  return p ? toProject(p, p.id) : null
}

/** Register (dedupes by normalized path), init `.quadflow/` if needed and activate. */
export async function openProject(path: string): Promise<Project> {
  await checkV1Project(path)
  const p = await call(commands.projectsOpen(path, true))
  return toProject(p, p.id)
}

/** Register without activating (dedupes by normalized path). */
export async function registerProject(path: string): Promise<Project> {
  return toProject(await call(commands.projectsRegister(path)))
}

export async function updateProject(
  id: string,
  updates: { name?: string; defaultWorkspaceConfig?: DefaultWorkspaceConfig | null },
): Promise<Project> {
  const patch: { name?: string; defaultWorkspaceTemplate?: JsonValue | null } = {}
  if (updates.name !== undefined) patch.name = updates.name
  if (updates.defaultWorkspaceConfig !== undefined) {
    patch.defaultWorkspaceTemplate = (updates.defaultWorkspaceConfig as unknown as JsonValue) ?? null
  }
  return toProject(await call(commands.projectsUpdate(id, patch)))
}

export async function touchProject(id: string): Promise<void> {
  await call(commands.projectsTouch(id))
}

export async function removeProject(id: string): Promise<void> {
  await call(commands.projectsRemove(id))
}

export async function getLiveTerminalCountsByProject(liveTerminalIds: string[]): Promise<Record<string, number>> {
  if (liveTerminalIds.length === 0) return {}
  return (await call(commands.projectsTerminalCounts(liveTerminalIds))) as Record<string, number>
}

// ==================== Workspaces ====================

function folderName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export function toSession(w: CoreWorkspace, projectRoot: string, activeId?: string | null): Session {
  return {
    id: w.id,
    name: w.name,
    workingDirectory: projectRoot,
    projectName: folderName(projectRoot),
    projectId: w.projectId,
    layout: '2x2',
    layoutTree: w.layoutTree == null ? null : JSON.stringify(w.layoutTree),
    isActive: w.id === activeId,
    pinned: w.pinned,
    pinOrder: w.pinOrder ?? undefined,
    pinSection: w.pinSection,
    createdAt: w.createdAt,
    updatedAt: w.lastActiveAt ?? w.updatedAt,
  }
}

export async function listWorkspaces(projectId?: string | null): Promise<CoreWorkspace[]> {
  return call(commands.workspacesList(projectId ?? null))
}

export async function createWorkspace(projectId: string, name: string): Promise<CoreWorkspace> {
  return call(commands.workspacesCreate({ projectId, name }))
}

export async function activateWorkspace(id: string): Promise<CoreWorkspace> {
  return call(commands.workspacesActivate(id))
}

export async function getActiveWorkspace(projectId: string): Promise<CoreWorkspace | null> {
  return call(commands.workspacesActive(projectId))
}

export async function updateWorkspace(
  id: string,
  updates: Partial<Pick<Session, 'name' | 'pinned' | 'pinOrder' | 'pinSection'>>,
): Promise<CoreWorkspace> {
  const patch: { name?: string; pinned?: boolean; pinOrder?: number | null; pinSection?: 'left' | 'center' | 'right' } = {}
  if (updates.name !== undefined) patch.name = updates.name
  if (updates.pinned !== undefined) patch.pinned = updates.pinned
  if ('pinOrder' in updates) patch.pinOrder = updates.pinOrder ?? null
  if (updates.pinSection !== undefined) patch.pinSection = updates.pinSection
  return call(commands.workspacesUpdate(id, patch))
}

export async function deleteWorkspace(id: string): Promise<void> {
  await call(commands.workspacesDelete(id))
}

// ---- terminal / tile mapping ----

// A terminal's agent is its typed `AgentBinding` (agent-providers.md §5.4),
// persisted as `workspace_terminals.agent`; `hasAutoResumed` is runtime-only.
// The core validates the binding again on restore and launch.
export function toAgentBinding(t: SessionTerminal): AgentBinding | null {
  if (!t.agent) return null
  return { ...t.agent, role: t.agent.role ?? t.role ?? null, roleLabel: t.agent.roleLabel ?? t.customRoleLabel ?? null }
}

function compact(o: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v as JsonValue
  return out
}

export function toWorkspaceTerminal(t: SessionTerminal): WorkspaceTerminal {
  const agent = toAgentBinding(t)
  return {
    id: t.id,
    title: t.title || '',
    titleSource: t.titleSource ?? 'default',
    cwd: t.workingDirectory || '',
    environmentId: null,
    agent,
    state: compact({
      bufferContent: t.bufferContent,
      status: t.status,
      originalPrompt: t.originalPrompt,
    }),
    locked: !!t.isLocked,
    minimized: !!t.isMinimized,
    position: t.gridPosition ?? 0,
    createdAt: t.createdAt ?? Date.now(),
  }
}

export function fromWorkspaceTerminal(w: WorkspaceTerminal): SessionTerminal {
  const state = (w.state ?? {}) as Record<string, unknown>
  return {
    id: w.id,
    title: w.title,
    titleSource: w.titleSource,
    originalPrompt: (state.originalPrompt as string | undefined) ?? null,
    workingDirectory: w.cwd,
    gridPosition: w.position,
    status: (state.status as string | undefined) ?? 'active',
    bufferContent: state.bufferContent as string | undefined,
    isMinimized: w.minimized,
    isLocked: w.locked,
    createdAt: w.createdAt,
    agent: w.agent ?? null,
    role: w.agent?.role ?? undefined,
    customRoleLabel: w.agent?.roleLabel ?? undefined,
  }
}

export function toTile(t: SessionToolInstance): TileInstance {
  let metadata: JsonValue | undefined
  if (t.metadata) {
    try { metadata = JSON.parse(t.metadata) as JsonValue } catch { metadata = undefined }
  }
  return {
    id: t.id,
    toolConfigId: t.configId,
    title: t.title,
    state: compact({
      status: t.status,
      terminalId: t.terminalId,
      isFlyoutInstance: t.isFlyoutInstance,
      commandLaunched: t.commandLaunched,
      metadata,
    }),
    locked: !!t.isLocked,
    minimized: !!t.isMinimized,
    floating: null,
    createdAt: Date.now(),
  }
}

export function fromTile(t: TileInstance): SessionToolInstance {
  const s = (t.state ?? {}) as Record<string, unknown>
  return {
    id: t.id,
    configId: t.toolConfigId,
    title: t.title,
    status: (s.status as string | undefined) ?? 'active',
    terminalId: s.terminalId as string | undefined,
    isMinimized: t.minimized,
    isLocked: t.locked,
    isFlyoutInstance: s.isFlyoutInstance as boolean | undefined,
    commandLaunched: s.commandLaunched as boolean | undefined,
    metadata: s.metadata !== undefined ? JSON.stringify(s.metadata) : undefined,
  }
}

export interface LoadedWorkspace {
  layoutTree: string | null
  terminals: SessionTerminal[]
  tools: SessionToolInstance[]
}

export async function loadWorkspace(id: string): Promise<LoadedWorkspace> {
  const st = await call(commands.workspacesLoad(id))
  return {
    layoutTree: st.layoutTree == null ? null : JSON.stringify(st.layoutTree),
    terminals: st.terminals.map(fromWorkspaceTerminal),
    tools: st.tiles.map(fromTile),
  }
}

/** Layout + terminals + tiles of one workspace, written in ONE core transaction. */
export async function saveWorkspace(
  id: string,
  terminals: SessionTerminal[],
  tools: SessionToolInstance[],
  layoutTreeJson: string | null,
): Promise<void> {
  let layoutTree: JsonValue | null = null
  if (layoutTreeJson) {
    try { layoutTree = JSON.parse(layoutTreeJson) as JsonValue } catch { layoutTree = null }
  }
  const r = await call(commands.workspacesSave(id, {
    layoutTree,
    terminals: terminals.map(toWorkspaceTerminal),
    tiles: tools.map(toTile),
  }))
  if (r.skippedTiles.length > 0) {
    console.warn('[appData] tiles not saved (tool config missing):', r.skippedTiles)
  }
}

// ==================== Global workspaces ====================

function toGlobalWorkspace(w: CoreGlobalWorkspace): GlobalWorkspace {
  return {
    id: w.id,
    name: w.name,
    enabled: w.enabled,
    minimized: w.minimized,
    layoutTree: (w.layoutTree as MosaicNode<string> | null) ?? null,
    displayOrder: w.displayOrder,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
}

export type GlobalToolInstanceRecord = SessionToolInstance & { workspaceId?: string }

export async function loadGlobalWorkspaces(): Promise<{
  workspaces: GlobalWorkspace[]
  instances: GlobalToolInstanceRecord[]
  frame: GlobalWorkspaceFrame
}> {
  const [st, frame] = await Promise.all([
    call(commands.globalWorkspacesList()),
    getSetting<Partial<GlobalWorkspaceFrame>>('shell', 'globalFrame'),
  ])
  return {
    workspaces: st.workspaces.map(toGlobalWorkspace),
    instances: st.tiles.map((t) => ({ ...fromTile(t.tile), workspaceId: t.globalWorkspaceId })),
    frame: {
      frameTree: (frame?.frameTree as MosaicNode<string> | null | undefined) ?? null,
      globallyEnabled: frame?.globallyEnabled ?? true,
    },
  }
}

export async function upsertGlobalWorkspace(w: GlobalWorkspace): Promise<GlobalWorkspace> {
  return toGlobalWorkspace(await call(commands.globalWorkspacesUpsert({
    id: w.id,
    name: w.name,
    enabled: w.enabled,
    minimized: w.minimized,
    layoutTree: (w.layoutTree as unknown as JsonValue) ?? null,
    displayOrder: w.displayOrder,
  })))
}

export async function deleteGlobalWorkspace(id: string): Promise<void> {
  await call(commands.globalWorkspacesDelete(id))
}

export async function saveGlobalFrame(frame: GlobalWorkspaceFrame): Promise<void> {
  await setSetting('shell', 'globalFrame', frame as unknown as JsonValue)
}

export async function saveGlobalToolInstances(instances: GlobalToolInstanceRecord[]): Promise<void> {
  const tiles = instances
    .filter((i) => !!i.workspaceId)
    .map((i) => ({ globalWorkspaceId: i.workspaceId as string, tile: toTile(i) }))
  const r = await call(commands.globalWorkspacesSave(tiles))
  if (r.skippedTiles.length > 0) console.warn('[appData] global tiles not saved:', r.skippedTiles)
}

// ==================== Tool configs ====================

/**
 * Tool configs reference a plugin contribution (`pluginId` + `contributionId`,
 * plugin-system.md §5.2). `executablePath` / `args` / `workingDirectory` are
 * convenience views of the same keys in `settings` (described by the
 * contribution's `configSchema`).
 */
const lastKnown = new Map<string, CoreToolConfig>()

export interface ToolContributionRef {
  pluginId: string
  contributionId: string
}

export function toToolConfig(c: CoreToolConfig): ToolConfig {
  lastKnown.set(c.id, c)
  const settings = (c.settings && typeof c.settings === 'object' && !Array.isArray(c.settings) ? c.settings : {}) as Record<string, unknown>
  return {
    id: c.id,
    name: c.name,
    pluginId: c.pluginId,
    contributionId: c.contributionId,
    icon: c.icon ?? undefined,
    executablePath: typeof settings.executablePath === 'string' ? settings.executablePath : undefined,
    args: Array.isArray(settings.args) ? (settings.args as string[]) : undefined,
    workingDirectory: typeof settings.workingDirectory === 'string' ? settings.workingDirectory : undefined,
    builtIn: c.autoCreated,
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    order: c.sortOrder,
    pinOrder: c.pinOrder ?? undefined,
    pinSection: c.pinSection,
    enabled: c.enabled,
    pinned: c.pinned,
    quickLaunch: c.quickLaunch,
    openMode: c.openMode as ToolOpenMode,
    pinDisplay: c.pinDisplay as ToolPinDisplay,
    color: c.color ?? undefined,
    flyoutWidth: c.flyoutWidth ?? undefined,
    flyoutHeight: c.flyoutHeight ?? undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

function packSettings(
  settings: Record<string, unknown> | undefined,
  fields: { executablePath?: string; args?: string[]; workingDirectory?: string },
): JsonValue {
  const out: Record<string, unknown> = { ...(settings ?? {}) }
  for (const [k, v] of Object.entries(fields)) {
    // undefined = not given (keep what `settings` has); null / '' = clear.
    if (v === undefined) continue
    if (v === null || v === '') delete out[k]
    else out[k] = v
  }
  return compact(out) as JsonValue
}

export async function listToolConfigs(): Promise<ToolConfig[]> {
  return (await call(commands.toolConfigsList())).map(toToolConfig)
}

export type ToolConfigOptions = {
  icon?: string
  executablePath?: string
  args?: string[]
  workingDirectory?: string
  settings?: Record<string, unknown>
  pinned?: boolean
  quickLaunch?: boolean
  openMode?: ToolOpenMode
  pinDisplay?: ToolPinDisplay
  color?: string
}

export async function createToolConfig(name: string, ref: ToolContributionRef, o?: ToolConfigOptions): Promise<ToolConfig> {
  return toToolConfig(await call(commands.toolConfigsCreate({
    pluginId: ref.pluginId,
    contributionId: ref.contributionId,
    name,
    icon: o?.icon ?? null,
    color: o?.color ?? null,
    settings: packSettings(o?.settings, { executablePath: o?.executablePath, args: o?.args, workingDirectory: o?.workingDirectory }),
    pinned: o?.pinned ?? false,
    quickLaunch: o?.quickLaunch ?? false,
    openMode: o?.openMode ?? 'pane',
    pinDisplay: o?.pinDisplay ?? 'icon-and-name',
  })))
}

export type ToolConfigUpdates = Partial<Pick<ToolConfig,
  'name' | 'icon' | 'executablePath' | 'args' | 'workingDirectory' | 'settings' | 'enabled' | 'pinned' |
  'quickLaunch' | 'openMode' | 'pinDisplay' | 'color' | 'pinOrder' | 'pinSection' | 'flyoutWidth' | 'flyoutHeight'>>

export async function updateToolConfig(id: string, u: ToolConfigUpdates): Promise<ToolConfig> {
  const patch: ToolConfigPatch_Deserialize = {}
  if (u.name !== undefined) patch.name = u.name
  if ('icon' in u) patch.icon = u.icon || null
  if ('color' in u) patch.color = u.color || null
  if (u.enabled !== undefined) patch.enabled = u.enabled
  if (u.pinned !== undefined) patch.pinned = u.pinned
  if (u.quickLaunch !== undefined) patch.quickLaunch = u.quickLaunch
  if (u.openMode !== undefined) patch.openMode = u.openMode
  if (u.pinDisplay !== undefined) patch.pinDisplay = u.pinDisplay
  if ('pinOrder' in u) patch.pinOrder = u.pinOrder ?? null
  if (u.pinSection !== undefined) patch.pinSection = u.pinSection
  if ('flyoutWidth' in u) patch.flyoutWidth = u.flyoutWidth ?? null
  if ('flyoutHeight' in u) patch.flyoutHeight = u.flyoutHeight ?? null
  if ('settings' in u || 'executablePath' in u || 'args' in u || 'workingDirectory' in u) {
    const known = lastKnown.get(id)
    const current = known ? toToolConfig(known) : undefined
    // The convenience fields are views of `settings`: only explicit ones override it.
    const explicit = (k: 'executablePath' | 'args' | 'workingDirectory') => (k in u ? (u[k] ?? null) : undefined)
    patch.settings = packSettings('settings' in u ? u.settings : current?.settings, {
      executablePath: explicit('executablePath') as string | undefined,
      args: explicit('args') as string[] | undefined,
      workingDirectory: explicit('workingDirectory') as string | undefined,
    })
  }
  return toToolConfig(await call(commands.toolConfigsUpdate(id, patch)))
}

export async function deleteToolConfig(id: string): Promise<void> {
  await call(commands.toolConfigsDelete(id))
  lastKnown.delete(id)
}

export async function reorderToolConfigs(ids: string[], field: 'sort' | 'pin'): Promise<void> {
  await call(commands.toolConfigsReorder(ids, field))
}

export async function resetBuiltInToolConfigs(): Promise<ToolConfig[]> {
  return (await call(commands.toolConfigsResetBuiltins())).map(toToolConfig)
}

// ==================== Settings ====================

export async function getSettings(namespace: string): Promise<Record<string, unknown>> {
  return (await call(commands.settingsGet(namespace))) as Record<string, unknown>
}

export async function getSetting<T>(namespace: string, key: string): Promise<T | undefined> {
  const all = await getSettings(namespace)
  return all[key] as T | undefined
}

export async function setSetting(namespace: string, key: string, value: JsonValue): Promise<void> {
  await call(commands.settingsSet(namespace, key, value))
}

/** One transaction; `null` deletes a key. */
export async function setSettings(namespace: string, entries: Record<string, JsonValue>): Promise<void> {
  if (Object.keys(entries).length === 0) return
  await call(commands.settingsSetMany(namespace, entries))
}

export async function deleteSetting(namespace: string, key: string): Promise<void> {
  await call(commands.settingsDelete(namespace, key))
}

// ==================== Stored prompts ====================

function toPrompt(p: CoreStoredPrompt): StoredPrompt {
  return { id: p.id, name: p.name, content: p.content, category: p.category ?? undefined, createdAt: p.createdAt, updatedAt: p.updatedAt }
}

export async function listStoredPrompts(): Promise<StoredPrompt[]> {
  return (await call(commands.storedPromptsList())).map(toPrompt)
}

export async function upsertStoredPrompt(input: { id?: string; name: string; content: string; category?: string | null }): Promise<StoredPrompt> {
  return toPrompt(await call(commands.storedPromptsUpsert({
    id: input.id ?? null,
    name: input.name,
    content: input.content,
    category: input.category ?? null,
  })))
}

export async function deleteStoredPrompt(id: string): Promise<void> {
  await call(commands.storedPromptsDelete(id))
}
