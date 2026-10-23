/**
 * Workspace controller: saving, switching and restoring workspaces/projects.
 *
 * Every save is ONE core transaction (`workspaces_save`: layout + terminals +
 * tiles). On top of it this module enforces the shell-side invariants that the
 * old code broke (bug audit, DL-10):
 *
 * - A save always targets the workspace id captured *synchronously* with the
 *   snapshot; nothing is written back to "whatever is active after the await".
 * - A workspace is only saved while its state is fully loaded into the stores
 *   (`loadedWorkspaceId`). A half-restored or torn-down workspace is never
 *   saved, so a debounced save can never write an empty list into another one.
 * - Transitions (switch workspace / switch project / startup) run one at a
 *   time; each bumps a generation counter. A queued transition that was
 *   superseded is skipped, and a running one stops at its next await
 *   (`isStale`). Pending debounced saves are cancelled when a transition
 *   starts, and scheduling is suppressed while it runs.
 * - Global-scope terminals/tools (pinned to a global workspace) belong to no
 *   workspace: they are not saved into one, and not killed on switch.
 * - `flushSave()` (window close) is awaited.
 */
import { useSessionStore } from '../stores/sessionStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useToolStore } from '../stores/toolStore'
import { useProjectStore } from '../stores/projectStore'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useProjectSidebarStore } from '../stores/projectSidebarStore'
import { getTerminalBuffer } from './terminalRegistry'
import { terminalApi } from './tauri-api'
import { applyDefaultWorkspace } from './workspaceTemplates'
import * as appData from './appData'
import type { JsonValue } from '../generated/bindings'
import type { Project, Session, SessionTerminal, SessionToolInstance, TerminalState } from '../types'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let loadedWorkspaceId: string | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let suppressDepth = 0
let generation = 0
let transitionChain: Promise<unknown> = Promise.resolve()
let saveChain: Promise<void> = Promise.resolve()

/** The workspace whose state is completely loaded into the stores (or null). */
export function getLoadedWorkspaceId(): string | null {
  return loadedWorkspaceId
}

/** Declare that the stores now hold the full state of `id` (e.g. after building it from a template). */
export function markWorkspaceLoaded(id: string | null): void {
  loadedWorkspaceId = id
}

export function isTransitioning(): boolean {
  return suppressDepth > 0
}

export function cancelPendingSave(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function toSessionTerminal(t: TerminalState, minimized: string[]): SessionTerminal {
  return {
    id: t.id,
    title: t.title,
    titleSource: t.titleSource,
    originalPrompt: t.originalPrompt,
    workingDirectory: t.workingDirectory,
    gridPosition: t.gridPosition,
    status: t.status,
    bufferContent: getTerminalBuffer(t.id) ?? undefined,
    agent: t.agent ?? null,
    role: t.role,
    customRoleLabel: t.customRoleLabel,
    isMinimized: minimized.includes(t.id),
    isLocked: t.isLocked,
    createdAt: t.createdAt,
  }
}

interface Snapshot {
  workspaceId: string
  terminals: SessionTerminal[]
  tools: SessionToolInstance[]
  layoutTree: string | null
  globalTerminals: (SessionTerminal & { globalWorkspaceId?: string })[]
}

/** Capture the stores synchronously (no await between reads). */
function takeSnapshot(workspaceId: string): Snapshot {
  const term = useTerminalStore.getState()
  const tools = useToolStore.getState()
  const minimized = term.minimizedTerminals
  const all = term.getTerminalsArray()
  return {
    workspaceId,
    terminals: all.filter((t) => t.scope !== 'global').map((t) => toSessionTerminal(t, minimized)),
    tools: tools.getToolInstancesArray()
      .filter((t) => t.scope !== 'global')
      .map((t) => ({
        id: t.id,
        configId: t.configId,
        title: t.title,
        status: t.status,
        terminalId: t.terminalId,
        isMinimized: tools.minimizedTools.includes(t.id),
        isLocked: t.isLocked,
        isFlyoutInstance: t.isFlyoutInstance,
        commandLaunched: t.commandLaunched,
        metadata: t.metadata ? JSON.stringify(t.metadata) : undefined,
      })),
    layoutTree: term.getSerializedLayoutTree(),
    globalTerminals: all
      .filter((t) => t.scope === 'global')
      .map((t) => ({ ...toSessionTerminal(t, minimized), globalWorkspaceId: t.globalWorkspaceId })),
  }
}

let lastGlobalTerminals: string | null = null

function enqueueSave(snap: Snapshot): Promise<void> {
  const run = async () => {
    await useSessionStore.getState().saveSessionState(snap.workspaceId, snap.terminals, snap.tools, snap.layoutTree)
    const globals = JSON.stringify(snap.globalTerminals)
    if (globals !== lastGlobalTerminals) {
      await appData.setSetting('shell', 'globalTerminals', snap.globalTerminals as unknown as JsonValue)
      lastGlobalTerminals = globals
    }
  }
  const p = saveChain.then(run, run)
  saveChain = p.catch((e) => console.error('[workspace] save failed:', e))
  return p
}

/** Save the active workspace now, if its state is fully loaded. */
function saveNow(): Promise<void> {
  const active = useSessionStore.getState().activeSession
  if (!active || loadedWorkspaceId !== active.id) return saveChain
  return enqueueSave(takeSnapshot(active.id))
}

/**
 * Save the current workspace state (manual Save button, auto-save). Skipped
 * during a switch and when the stores do not hold a fully loaded workspace.
 */
export async function saveWorkspaceState(): Promise<void> {
  if (isTransitioning()) return
  await saveNow()
}

/** Debounced auto-save (respects the session auto-save settings). */
export function scheduleSave(): void {
  if (isTransitioning()) return
  const active = useSessionStore.getState().activeSession
  if (!active || loadedWorkspaceId !== active.id) return
  useSessionStore.getState().markDirty()
  const s = useAppSettingsStore.getState().session
  if (!s.autoSaveEnabled) return
  cancelPendingSave()
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void saveWorkspaceState()
  }, s.autoSaveIntervalMs)
}

/** Cancel the debounce and save immediately; resolves when the write is done. */
export async function flushSave(): Promise<void> {
  cancelPendingSave()
  await saveNow()
  await saveChain
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionCtx {
  /** A newer transition was requested: stop at the next await. */
  isStale: () => boolean
}

/** Run `fn` exclusively; returns false if it was superseded before it started. */
export function runTransition(label: string, fn: (ctx: TransitionCtx) => Promise<void>): Promise<boolean> {
  const my = ++generation
  cancelPendingSave()
  const ctx: TransitionCtx = { isStale: () => my !== generation }
  const run = async (): Promise<boolean> => {
    if (ctx.isStale()) return false
    suppressDepth++
    cancelPendingSave()
    try {
      await fn(ctx)
      return !ctx.isStale()
    } catch (e) {
      console.error(`[workspace] ${label} failed:`, e)
      return false
    } finally {
      suppressDepth--
    }
  }
  const p = transitionChain.then(run, run)
  transitionChain = p.catch(() => {})
  return p
}

/** Kill the current workspace's PTYs (never global-scope ones) and clear the stores. */
async function teardownCurrent(opts: { killTerminals: boolean }): Promise<void> {
  loadedWorkspaceId = null
  const terminals = useTerminalStore.getState().getTerminalsArray().filter((t) => t.scope !== 'global')
  if (opts.killTerminals) {
    for (const t of terminals) {
      try { await terminalApi.kill(t.id) } catch { /* already gone */ }
    }
  }
  useTerminalStore.getState().clearTerminals()
  useToolStore.getState().clearToolInstances()
  if (opts.killTerminals && terminals.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Load a workspace from the core into the (already cleared) stores. */
async function restoreInto(session: Session, workingDir: string, ctx: TransitionCtx): Promise<void> {
  const state = await useSessionStore.getState().loadSessionState(session.id)
  if (ctx.isStale()) return
  if (state.tools.length > 0) {
    await useToolStore.getState().restoreToolInstances(state.tools, ctx.isStale)
    if (ctx.isStale()) return
  }
  const toolStore = useToolStore.getState()
  const toolPaneIds = Array.from(toolStore.toolInstances.values())
    .filter((t) => t.scope !== 'global' && !t.isFlyoutInstance && !toolStore.minimizedTools.includes(t.id))
    .map((t) => t.id)
  if (state.terminals.length > 0 || toolPaneIds.length > 0 || state.layoutTree) {
    await useTerminalStore.getState().restoreTerminals(state.terminals, workingDir, state.layoutTree, toolPaneIds, ctx.isStale)
    if (ctx.isStale()) return
  }
  loadedWorkspaceId = session.id
}

async function resolveSession(sessionId: string): Promise<Session | undefined> {
  let s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  if (!s) {
    await useSessionStore.getState().loadSessions()
    s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  }
  return s
}

/** Save the current workspace, then switch to `sessionId` and restore it. */
export function switchWorkspace(sessionId: string, opts: { save?: boolean } = {}): Promise<boolean> {
  return runTransition('switchWorkspace', async (ctx) => {
    const sessionStore = useSessionStore.getState()
    if (sessionStore.activeSession?.id === sessionId && loadedWorkspaceId === sessionId) return
    const target = await resolveSession(sessionId)
    if (!target || ctx.isStale()) return
    if (opts.save !== false) await saveNow()
    if (ctx.isStale()) return
    await teardownCurrent({ killTerminals: true })
    await useSessionStore.getState().setActiveSession(target)
    if (ctx.isStale()) return
    const workingDir = useProjectStore.getState().activeProject?.workingDirectory || target.workingDirectory
    await restoreInto(target, workingDir, ctx)
  })
}

/**
 * Save the current workspace, create a new one in the active project, make it
 * active and populate it with `build` (template, default layout, blank).
 */
export function createWorkspaceAndActivate(name: string, build: (workingDir: string) => Promise<void>): Promise<boolean> {
  return runTransition('createWorkspace', async (ctx) => {
    const project = useProjectStore.getState().activeProject
    if (!project) return
    await saveNow()
    if (ctx.isStale()) return
    await teardownCurrent({ killTerminals: true })
    const session = await useSessionStore.getState().createSession(name, project.workingDirectory, '2x2', project.id)
    await useSessionStore.getState().setActiveSession(session)
    if (ctx.isStale()) return
    await build(project.workingDirectory)
    if (ctx.isStale()) return
    loadedWorkspaceId = session.id
    await saveNow()
  })
}

/** Rebuild the active workspace from `build` (no save of the old layout). */
export function resetActiveWorkspace(build: (workingDir: string) => Promise<void>): Promise<boolean> {
  return runTransition('resetWorkspace', async (ctx) => {
    const project = useProjectStore.getState().activeProject
    const session = useSessionStore.getState().activeSession
    if (!project || !session) return
    await teardownCurrent({ killTerminals: true })
    await build(project.workingDirectory)
    if (ctx.isStale()) return
    loadedWorkspaceId = session.id
    await saveNow()
  })
}

/** Activate a project's most relevant workspace (or create one) and restore it. */
async function enterProject(
  project: Project,
  ctx: TransitionCtx,
  opts: { restore: boolean; applyDefaultOnCreate: boolean; newName: string },
): Promise<void> {
  await useSessionStore.getState().loadSessions()
  if (ctx.isStale()) return
  const active = await appData.getActiveWorkspace(project.id)
  if (ctx.isStale()) return
  const sessions = useSessionStore.getState().sessions.filter((s) => s.projectId === project.id)
  const target = (active && sessions.find((s) => s.id === active.id)) || sessions[0]
  if (target) {
    await useSessionStore.getState().setActiveSession(target)
    if (ctx.isStale()) return
    if (opts.restore) {
      await restoreInto(target, project.workingDirectory, ctx)
    } else {
      loadedWorkspaceId = target.id
    }
    return
  }
  // No workspaces for this project yet — create one from the default workspace setting.
  const created = await useSessionStore.getState().createSession(opts.newName, project.workingDirectory, '2x2', project.id)
  await useSessionStore.getState().setActiveSession(created)
  if (ctx.isStale()) return
  if (opts.applyDefaultOnCreate) {
    await applyDefaultWorkspace(useAppSettingsStore.getState().defaultWorkspace, project.workingDirectory)
    if (ctx.isStale()) return
  }
  loadedWorkspaceId = created.id
  await saveNow()
}

/**
 * Save the current workspace, switch the active project and restore its workspace.
 * A project without workspaces gets the default workspace template unless
 * `applyDefault: false` (onboarding opens a first project empty).
 */
export function switchProject(project: Project, opts: { applyDefault?: boolean } = {}): Promise<boolean> {
  return runTransition('switchProject', async (ctx) => {
    await saveNow()
    if (ctx.isStale()) return
    const keepAlive = useProjectSidebarStore.getState().keepTerminalsAlive
    await teardownCurrent({ killTerminals: !keepAlive })
    const opened = await useProjectStore.getState().setActiveProject(project)
    if (ctx.isStale()) return
    await enterProject(opened, ctx, { restore: true, applyDefaultOnCreate: opts.applyDefault ?? true, newName: 'Workspace 1' })
  })
}

/**
 * App startup: tool configs, global dock, active project (or the default
 * working dir), then its active workspace. Every store read happens after the
 * preceding await (the old code used a pre-await snapshot of the project store).
 */
export function initializeWorkspaces(steps: {
  loadToolConfigs: () => Promise<void>
  loadGlobalWorkspace: () => Promise<void>
  onRestored?: (workingDir: string) => void
}): Promise<boolean> {
  return runTransition('startup', async (ctx) => {
    await steps.loadToolConfigs()
    try {
      await steps.loadGlobalWorkspace()
    } catch (e) {
      console.error('[workspace] global workspace load failed:', e)
    }
    await useProjectStore.getState().loadActiveProject()
    if (ctx.isStale()) return
    let project = useProjectStore.getState().activeProject
    const sessionSettings = useAppSettingsStore.getState().session
    if (!project) {
      const found = await useProjectStore.getState().findOrCreateProject(sessionSettings.defaultWorkingDirectory)
      if (ctx.isStale()) return
      project = found
    }
    // (Re-)activate: initializes the project folder and sets the working dir.
    project = await useProjectStore.getState().setActiveProject(project)
    if (ctx.isStale()) return
    // First start: an empty 'Default Workspace' (no agent is launched).
    await enterProject(project, ctx, { restore: sessionSettings.restoreOnStartup, applyDefaultOnCreate: false, newName: 'Default Workspace' })
    if (!ctx.isStale()) steps.onRestored?.(project.workingDirectory)
  })
}
