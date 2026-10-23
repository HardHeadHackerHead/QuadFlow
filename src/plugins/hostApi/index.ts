/**
 * The trusted host API (plugin-system.md §6, §7.2): `createHostContext(plugin)`
 * builds the `PluginContext` for a plugin running in the host document.
 *
 *  - UI-local groups (project, workspace, events, ui, overlay, commands,
 *    notifications.toast/attention, native.tileGeometry) use shell stores;
 *  - everything privileged goes through `plugin_invoke` / `plugin_subscribe`,
 *    where Rust checks the plugin's granted permissions.
 *
 * `api.has(m)` is true exactly for methods this host serves in this isolation
 * mode: the Rust table's available methods (e.g. `agents.*` only once the
 * agent framework is installed) plus the UI-local ones; `sidecar.*` for plugins
 * that declare a sidecar (`plugin_sidecar_*` commands, ./sidecar.ts).
 */
import type {
  AgentUsageSnapshot,
  ChildWebview,
  DataApi,
  Disposable,
  FsScope,
  JsonValue,
  Logger,
  PluginContext,
  ProjectInfo,
  TerminalHandle,
  ToolConfigInfo,
  ThemeSnapshot,
  TileGeometry,
  WorkspaceInfo,
} from '@quadflow/plugin-api'
import { HostError, PLUGIN_API_VERSION } from '@quadflow/plugin-api'
import { getThemeSnapshot, onThemeChange, toast } from '@quadflow/ui'
import { listen } from '@tauri-apps/api/event'
import { useProjectStore } from '../../stores/projectStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useOverlayStore } from '../../stores/overlayStore'
import { useToolStore } from '../../stores/toolStore'
import type { ToolConfig } from '../../types'
import { rootKeyOf } from '../../lib/core/project'
import type { PluginInfo } from '../registry'
import { hostMethods, loadHostMethods, toHostError, trustedTransport, type HostTransport } from './transport'
import { emitPluginEvent, onHostEvent, onPluginEvent } from './events'
import { anyOverlayOpen, geometryOf, getTile, onTileAdded, onTileClosed, onTileGeometry, overlayRects } from './tiles'
import { ensureToaster, hostConfirm, hostPrompt } from './hostLayer'
import { attachTerminal } from './terminalAttach'
import { getShellBridge } from './shellBridge'
import { applyBinding, placeAgentTerminal } from '../../agents/launch'
import { createSidecarApi } from './sidecar'

export { notifyTileClosed, registerTile, setTileVisible } from './tiles'
export { emitHostEvent } from './events'
export { setShellBridge } from './shellBridge'
export { loadHostMethods } from './transport'

/** UI-local methods implemented in this document (no Rust dispatch). */
const LOCAL_METHODS = [
  'log.debug', 'log.info', 'log.warn', 'log.error',
  'project.current', 'project.onDidChange', 'workspace.current', 'workspace.onDidChange',
  'events.on', 'events.emit', 'events.onPlugin',
  'settings.get', 'settings.onDidChange',
  'notifications.toast', 'notifications.attention',
  'data.issues.displayRef',
  'terminals.attach',
  'commands.register', 'commands.execute',
  'ui.openTile', 'ui.closeTile', 'ui.focusTile', 'ui.onTileClosed', 'ui.getToolConfig', 'ui.updateToolConfigSettings', 'ui.openSettings', 'ui.confirm', 'ui.prompt', 'ui.theme', 'ui.onThemeChange',
  'overlay.isAnyOpen', 'overlay.onChange', 'overlay.register',
  'native.tileGeometry', 'native.onTileGeometry',
]

/** `ctx.sidecar.*`, available to plugins whose manifest declares a sidecar. */
const SIDECAR_METHODS = [
  'sidecar.request', 'sidecar.notify', 'sidecar.onNotification', 'sidecar.status', 'sidecar.onStatus',
  'sidecar.restart', 'sidecar.logs',
]

/** `ui.getToolConfig` view of a tool config (API 1.4). */
function toolConfigInfo(c: ToolConfig): ToolConfigInfo {
  return { id: c.id, name: c.name, contributionId: c.contributionId, settings: (c.settings ?? {}) as Record<string, JsonValue> }
}

/** Rust methods/topics have the public names (`data.ship.run`, `terminals.onData`, …). */
function hasMethod(method: string): boolean {
  return LOCAL_METHODS.includes(method) || hostMethods().has(method)
}

// ---------------------------------------------------------------------------
// bytes <-> base64 (fs.readBytes, http bodies, clipboard images)
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------------------
// project / workspace
// ---------------------------------------------------------------------------

type ProjectConfigOut = NonNullable<ProjectInfo['config']>
const projectConfigs = new Map<string, ProjectConfigOut | null>()

function currentWorkspace(): WorkspaceInfo | null {
  const s = useSessionStore.getState().activeSession
  return s ? { id: s.id, name: s.name } : null
}

function projectInfo(p: { id: string; name: string; workingDirectory: string } | null): ProjectInfo | null {
  if (!p) return null
  const rootKey = rootKeyOf(p.workingDirectory)
  return { id: p.id, name: p.name, root: p.workingDirectory, rootKey, config: projectConfigs.get(rootKey) ?? null }
}

function makeLogger(pluginId: string, t: HostTransport): Logger {
  const tag = `[plugin:${pluginId}]`
  const fwd = (level: string, args: unknown[]) => {
    const json = args.map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`
      try {
        return JSON.parse(JSON.stringify(a ?? null)) as JsonValue
      } catch {
        return String(a)
      }
    })
    void t.invoke(`log.${level}`, { args: json }).catch(() => {})
  }
  return {
    debug: (...a) => (console.debug(tag, ...a), fwd('debug', a)),
    info: (...a) => (console.info(tag, ...a), fwd('info', a)),
    warn: (...a) => (console.warn(tag, ...a), fwd('warn', a)),
    error: (...a) => (console.error(tag, ...a), fwd('error', a)),
  }
}

// ---------------------------------------------------------------------------
// streams → callbacks / promises
// ---------------------------------------------------------------------------

function stream(t: HostTransport, topic: string, params: Record<string, unknown>, cb: (item: JsonValue) => void, log: Logger): Disposable {
  const s = t.subscribe(topic, params, cb)
  s.ready.catch((e) => {
    log.error(`${topic} failed:`, e)
    s.dispose()
  })
  return s.dispose
}

/** A `{event}…{done}|{error}` stream as a promise. */
function streamCall<T, E>(t: HostTransport, topic: string, params: Record<string, unknown>, onEvent: (e: E) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const s = t.subscribe(topic, params, (item) => {
      const m = item as { event?: E; done?: T; error?: unknown }
      if ('event' in m && m.event !== undefined) onEvent(m.event)
      else if ('done' in m) {
        s.dispose()
        resolve(m.done as T)
      } else if ('error' in m) {
        s.dispose()
        reject(toHostError(m.error))
      }
    })
    s.ready.catch((e) => {
      s.dispose()
      reject(toHostError(e))
    })
  })
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const commandHandlers = new Map<string, (args?: JsonValue) => unknown>()

async function executeCommand(id: string, args?: JsonValue): Promise<unknown> {
  const slash = id.indexOf('/')
  if (slash <= 0) throw new HostError('invalid_input', `command id ${JSON.stringify(id)} must be "<plugin>/<command>"`)
  const pluginId = id.slice(0, slash)
  const cmd = id.slice(slash + 1)
  // `core/*` are the built-in `core` plugin's commands (plugins/core): no special case.
  const h = commandHandlers.get(id)
  if (h) return h(args)
  const { loadPluginModule } = await import('../loader')
  const loaded = await loadPluginModule(pluginId)
  const registered = commandHandlers.get(id)
  if (registered) return registered(args)
  const fn = loaded.module.commands?.[cmd]
  if (!fn) throw new HostError('not_found', `plugin ${JSON.stringify(pluginId)} has no command ${JSON.stringify(cmd)}`)
  return fn(loaded.ctx, args)
}

// ---------------------------------------------------------------------------
// the context
// ---------------------------------------------------------------------------

const contexts = new Map<string, Promise<PluginContext>>()

/** The (cached) trusted context of a plugin. Resolves once settings/methods are loaded. */
export function createHostContext(info: PluginInfo): Promise<PluginContext> {
  const key = `${info.id}@${info.version ?? '0.0.0'}`
  let p = contexts.get(key)
  if (!p) {
    p = buildContext(info).catch((e) => {
      contexts.delete(key)
      throw e
    })
    contexts.set(key, p)
  }
  return p
}

export function disposeHostContext(pluginId: string): void {
  for (const k of [...contexts.keys()]) if (k.startsWith(`${pluginId}@`)) contexts.delete(k)
  for (const k of [...commandHandlers.keys()]) if (k.startsWith(`${pluginId}/`)) commandHandlers.delete(k)
}

async function buildContext(info: PluginInfo): Promise<PluginContext> {
  const id = info.id
  const t = trustedTransport(id)
  const log = makeLogger(id, t)
  await loadHostMethods()

  const inv = <T = JsonValue>(method: string, params?: Record<string, unknown>) => t.invoke<T>(method, params)
  const voidInv = async (method: string, params?: Record<string, unknown>) => {
    await t.invoke(method, params)
  }
  const pr = (o?: { projectRoot?: string }) => ({ projectRoot: o?.projectRoot })

  // ---- project config cache (for ProjectInfo.config and displayRef) ----
  const refreshConfig = async (root: string | undefined) => {
    if (!root) return
    try {
      projectConfigs.set(rootKeyOf(root), await inv<ProjectConfigOut>('data.projectConfig.get', { projectRoot: root }))
    } catch {
      projectConfigs.set(rootKeyOf(root), null)
    }
  }
  await refreshConfig(useProjectStore.getState().activeProject?.workingDirectory)
  useProjectStore.subscribe((s, prev) => {
    if (s.activeProject?.id !== prev.activeProject?.id) void refreshConfig(s.activeProject?.workingDirectory)
  })

  // ---- settings snapshot ----
  let settings: Record<string, JsonValue> = {}
  const settingsListeners = new Set<(key: string, value: JsonValue) => void>()
  const applySettings = (next: Record<string, JsonValue>) => {
    const prev = settings
    settings = next
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) settingsListeners.forEach((cb) => cb(k, next[k] ?? null))
    }
  }
  try {
    settings = await inv<Record<string, JsonValue>>('settings.getAll')
  } catch (e) {
    log.warn('settings unavailable:', e)
  }
  onHostEvent('settings.changed', (p) => {
    const ids = ((p as { ids?: string[] } | null)?.ids ?? []) as string[]
    if (ids.some((i) => i.startsWith(`plugin:${id}/`))) {
      void inv<Record<string, JsonValue>>('settings.getAll').then(applySettings, () => {})
    }
  })

  const data: DataApi = {
    ideas: {
      list: (q, o) => inv('data.ideas.list', { query: q, ...pr(o) }),
      get: (ideaId, o) => inv('data.ideas.get', { id: ideaId, ...pr(o) }),
      stats: (o) => inv('data.ideas.stats', pr(o)),
      create: (i, o) => inv('data.ideas.create', { idea: i, ...pr(o) }),
      update: (ideaId, p, o) => inv('data.ideas.update', { id: ideaId, patch: p, ...pr(o) }),
      delete: (ideaId, o) => voidInv('data.ideas.delete', { id: ideaId, ...pr(o) }),
      merge: (ids, keep, o) => inv('data.ideas.merge', { ids, keep, ...pr(o) }),
      addTag: (ideaId, tag, o) => inv('data.ideas.addTag', { id: ideaId, tag, ...pr(o) }),
      removeTag: (ideaId, tag, o) => inv('data.ideas.removeTag', { id: ideaId, tag, ...pr(o) }),
      bulkTag: (ids, tag, o) => inv('data.ideas.bulkTag', { ids, tag, ...pr(o) }),
      addNote: (ideaId, body, o) => inv('data.ideas.addNote', { id: ideaId, body, ...pr(o) }),
      deleteNote: (ideaId, noteId, o) => inv('data.ideas.deleteNote', { id: ideaId, noteId, ...pr(o) }),
      addSuggestion: (ideaId, kind, text, o) => inv('data.ideas.addSuggestion', { id: ideaId, kind, text, ...pr(o) }),
      resolveSuggestion: (ideaId, suggestionId, accept, o) =>
        inv('data.ideas.resolveSuggestion', { id: ideaId, suggestionId, accept, ...pr(o) }),
      deleteSuggestion: (ideaId, suggestionId, o) => inv('data.ideas.deleteSuggestion', { id: ideaId, suggestionId, ...pr(o) }),
      revert: (ideaId, o) => inv('data.ideas.revert', { id: ideaId, ...pr(o) }),
    },
    issues: {
      list: (q, o) => inv('data.issues.list', { query: q, ...pr(o) }),
      get: (ref, o) => inv('data.issues.get', { issueRef: ref, ...pr(o) }),
      create: (i, o) => inv('data.issues.create', { issue: i, ...pr(o) }),
      update: (ref, p, o) => inv('data.issues.update', { issueRef: ref, patch: p, ...pr(o) }),
      setStatus: (ref, status, o) => inv('data.issues.setStatus', { issueRef: ref, status, ...pr(o) }),
      close: (ref, o) => inv('data.issues.close', { issueRef: ref, ...pr(o) }),
      reopen: (ref, o) => inv('data.issues.reopen', { issueRef: ref, ...pr(o) }),
      delete: (ref, o) => voidInv('data.issues.delete', { issueRef: ref, ...pr(o) }),
      addComment: (ref, body, o) => inv('data.issues.addComment', { issueRef: ref, body, ...pr(o) }),
      deleteComment: (ref, commentId, o) => inv('data.issues.deleteComment', { issueRef: ref, commentId, ...pr(o) }),
      toggleCriterion: (ref, criterionId, checked, o) =>
        inv('data.issues.toggleCriterion', { issueRef: ref, criterionId, checked, ...pr(o) }),
      claim: (ref, claim, o) => inv('data.issues.claim', { issueRef: ref, claim, ...pr(o) }),
      heartbeat: (ref, o) => inv('data.issues.heartbeat', { issueRef: ref, ...pr(o) }),
      release: (ref, o) => inv('data.issues.release', { issueRef: ref, ...pr(o) }),
      displayRef: (issue, o) => {
        const root = o?.projectRoot ?? useProjectStore.getState().activeProject?.workingDirectory
        const code = root ? projectConfigs.get(rootKeyOf(root))?.code : undefined
        return code ? `${code}-${issue.number}` : `#${issue.number}`
      },
      labels: {
        list: (o) => inv('data.issues.labels.list', pr(o)),
        upsert: (label, renameFrom, o) => inv('data.issues.labels.upsert', { label, renameFrom, ...pr(o) }),
        delete: (name, o) => inv('data.issues.labels.delete', { name, ...pr(o) }),
      },
      epics: {
        list: (o) => inv('data.issues.epics.list', pr(o)),
        get: (epicId, o) => inv('data.issues.epics.get', { id: epicId, ...pr(o) }),
        create: (epic, o) => inv('data.issues.epics.create', { epic, ...pr(o) }),
        update: (epicId, patch, o) => inv('data.issues.epics.update', { id: epicId, patch, ...pr(o) }),
        delete: (epicId, o) => voidInv('data.issues.epics.delete', { id: epicId, ...pr(o) }),
      },
    },
    plans: {
      list: (q, o) => inv('data.plans.list', { query: q, ...pr(o) }),
      get: (planId, o) => inv('data.plans.get', { planId, ...pr(o) }),
      create: (plan, o) => inv('data.plans.create', { plan, ...pr(o) }),
      update: (planId, patch, o) => inv('data.plans.update', { planId, patch, ...pr(o) }),
      delete: (planId, o) => voidInv('data.plans.delete', { planId, ...pr(o) }),
      stepAdd: (planId, step, o) => inv('data.plans.stepAdd', { planId, step, ...pr(o) }),
      stepUpdate: (planId, stepId, patch, o) => inv('data.plans.stepUpdate', { planId, stepId, patch, ...pr(o) }),
      stepDelete: (planId, stepId, o) => inv('data.plans.stepDelete', { planId, stepId, ...pr(o) }),
      stepsReorder: (planId, stepIds, o) => inv('data.plans.stepsReorder', { planId, stepIds, ...pr(o) }),
      commentAdd: (planId, c, o) => inv('data.plans.commentAdd', { planId, body: c.body, kind: c.kind, ...pr(o) }),
      commentDelete: (planId, commentId, o) => inv('data.plans.commentDelete', { planId, commentId, ...pr(o) }),
      promoteStep: (planId, stepId, o) => inv('data.plans.promoteStep', { planId, stepId, ...pr(o) }),
      promoteAll: (planId, o) => inv('data.plans.promoteAll', { planId, ...pr(o) }),
    },
    discovery: {
      list: (q, o) => inv('data.discovery.list', { query: q, ...pr(o) }),
      get: (dId, o) => inv('data.discovery.get', { id: dId, ...pr(o) }),
      create: (project, o) => inv('data.discovery.create', { project, ...pr(o) }),
      update: (dId, patch, o) => inv('data.discovery.update', { id: dId, patch, ...pr(o) }),
      delete: (dId, o) => voidInv('data.discovery.delete', { id: dId, ...pr(o) }),
      itemAdd: (dId, item, o) => inv('data.discovery.itemAdd', { id: dId, item, ...pr(o) }),
      itemUpdate: (dId, itemId, patch, o) => inv('data.discovery.itemUpdate', { id: dId, itemId, patch, ...pr(o) }),
      itemDelete: (dId, itemId, o) => inv('data.discovery.itemDelete', { id: dId, itemId, ...pr(o) }),
      itemsReorder: (dId, itemIds, o) => inv('data.discovery.itemsReorder', { id: dId, itemIds, ...pr(o) }),
      linked: (dId, o) => inv('data.discovery.linked', { id: dId, ...pr(o) }),
    },
    scripts: {
      list: (q, o) => inv('data.scripts.list', { query: q, ...pr(o) }),
      get: (sId, o) => inv('data.scripts.get', { id: sId, ...pr(o) }),
      create: (input, o) => inv('data.scripts.create', { input, ...pr(o) }),
      update: (sId, patch, o) => inv('data.scripts.update', { id: sId, patch, ...pr(o) }),
      delete: (sId, o) => voidInv('data.scripts.delete', { id: sId, ...pr(o) }),
      resolveCommand: (sId, options, o) => inv('data.scripts.resolveCommand', { id: sId, options, ...pr(o) }),
      groups: {
        list: (o) => inv('data.scripts.groups.list', pr(o)),
        get: (gId, o) => inv('data.scripts.groups.get', { id: gId, ...pr(o) }),
        create: (input, o) => inv('data.scripts.groups.create', { input, ...pr(o) }),
        update: (gId, patch, o) => inv('data.scripts.groups.update', { id: gId, patch, ...pr(o) }),
        delete: (gId, o) => voidInv('data.scripts.groups.delete', { id: gId, ...pr(o) }),
        addMember: (groupId, member, o) => inv('data.scripts.groups.addMember', { groupId, member, ...pr(o) }),
        removeMember: (groupId, scriptId, o) => inv('data.scripts.groups.removeMember', { groupId, scriptId, ...pr(o) }),
      },
      environments: {
        list: () => inv('data.scripts.environments.list'),
        detect: () => inv('data.scripts.environments.detect'),
      },
    },
    ship: {
      configGet: (o) => inv('data.ship.configGet', pr(o)),
      configSave: (config, o) => inv('data.ship.configSave', { config, ...pr(o) }),
      validate: (o) => inv('data.ship.validate', pr(o)),
      status: (o) => inv('data.ship.status', pr(o)),
      readiness: (o) => inv('data.ship.readiness', pr(o)),
      run: (options, onEvent, o) => streamCall(t, 'data.ship.run', { options, ...pr(o) }, onEvent),
      externalComplete: (requestId, result) => voidInv('data.ship.externalComplete', { requestId, result }),
      abort: (runId, o) => inv('data.ship.abort', { runId, ...pr(o) }),
      runs: (o) => inv('data.ship.runs', pr(o)),
      runGet: (runId, o) => inv('data.ship.runGet', { id: runId, ...pr(o) }),
      templates: () => inv('data.ship.templates'),
      init: (options, o) => inv('data.ship.init', { options, ...pr(o) }),
      detect: (o) => inv('data.ship.detect', pr(o)),
      diagnostics: (o) => inv('data.ship.diagnostics', pr(o)),
      readinessOne: (checkId, o) => inv('data.ship.readinessOne', { checkId, ...pr(o) }),
      runFix: (checkId, onLine, o) => streamCall(t, 'data.ship.runFix', { checkId, ...pr(o) }, onLine),
      configDelete: (o) => inv('data.ship.configDelete', pr(o)),
      restoreBackups: (o) => inv('data.ship.restoreBackups', pr(o)),
    },
    chat: {
      conversations: (o) => inv('data.chat.conversations', { projectRootKey: o?.projectRootKey }),
      get: (cId) => inv('data.chat.get', { id: cId }),
      create: (input) => inv('data.chat.create', { input }),
      messages: (cId) => inv('data.chat.messages', { id: cId }),
      send: (cId, content, onEvent) => streamCall(t, 'data.chat.send', { id: cId, content }, onEvent),
      rename: (cId, title) => inv('data.chat.rename', { id: cId, title }),
      delete: (cId) => voidInv('data.chat.delete', { id: cId }),
      settingsGet: () => inv('data.chat.settingsGet'),
      settingsUpdate: (patch) => inv('data.chat.settingsUpdate', { patch }),
      models: (timeoutMs) => inv('data.chat.models', { timeoutMs }),
      ask: (question, o) => inv('data.chat.ask', { question, systemPrompt: o?.systemPrompt, model: o?.model }),
    },
    missions: {
      list: (q, o) => inv('data.missions.list', { status: q?.status, ...pr(o) }),
      get: (missionId, o) => inv('data.missions.get', { missionId, ...pr(o) }),
      create: (mission, o) => inv('data.missions.create', { mission, ...pr(o) }),
      update: (missionId, patch, o) => inv('data.missions.update', { missionId, patch, ...pr(o) }),
      delete: (missionId, o) => voidInv('data.missions.delete', { missionId, ...pr(o) }),
      progress: (missionId, o) => inv('data.missions.progress', { missionId, ...pr(o) }),
      issues: (missionId, o) => inv('data.missions.issues', { missionId, ...pr(o) }),
      memberAdd: (missionId, input, o) => inv('data.missions.memberAdd', { missionId, input, ...pr(o) }),
      memberUpdate: (missionId, memberRef, patch, o) => inv('data.missions.memberUpdate', { missionId, memberRef, patch, ...pr(o) }),
      memberRemove: (missionId, memberRef, o) => voidInv('data.missions.memberRemove', { missionId, memberRef, ...pr(o) }),
      messages: (missionId, query, o) => inv('data.missions.messages', { missionId, query, ...pr(o) }),
      send: (missionId, message, o) => inv('data.missions.send', { missionId, message, ...pr(o) }),
      activity: (missionId, q, o) => inv('data.missions.activity', { missionId, since: q?.since, limit: q?.limit, ...pr(o) }),
      assignIssues: (missionId, issueRefs, o) => inv('data.missions.assignIssues', { missionId, issueRefs, ...pr(o) }),
      claimNextIssue: (missionId, memberRef, o) => inv('data.missions.claimNextIssue', { missionId, memberRef, ...pr(o) }),
      proposalSetStatus: (missionId, proposalId, status, o) => inv('data.missions.proposalSetStatus', { missionId, proposalId, status, ...pr(o) }),
      mergeUpdate: (missionId, entryId, patch, o) => inv('data.missions.mergeUpdate', { missionId, entryId, patch, ...pr(o) }),
      logActivity: (missionId, activity, o) => inv('data.missions.logActivity', { missionId, activity, ...pr(o) }),
      markRead: (missionId, reader, upTo, o) => inv('data.missions.markRead', { missionId, reader, upTo, ...pr(o) }),
      templates: {
        list: (o) => inv('data.missions.templates.list', pr(o)),
        upsert: (template, o) => inv('data.missions.templates.upsert', { template, ...pr(o) }),
        delete: (templateId, o) => voidInv('data.missions.templates.delete', { templateId, ...pr(o) }),
      },
      agentDefinitions: {
        list: () => inv('data.missions.agentDefinitions.list'),
        upsert: (definition) => inv('data.missions.agentDefinitions.upsert', { definition }),
        delete: (defId) => voidInv('data.missions.agentDefinitions.delete', { id: defId }),
      },
    },
    projectConfig: {
      get: (o) => inv('data.projectConfig.get', pr(o)),
      update: (patch, o) => inv('data.projectConfig.update', { patch, ...pr(o) }),
    },
    onDidChange: (filter, cb) =>
      stream(t, 'data.onDidChange', { domain: filter.domain, projectRoot: filter.projectRoot }, (e) => cb(e as never), log),
    watchProject: (projectRoot) => {
      void voidInv('data.watchProject', { projectRoot }).catch((e) => log.warn('watchProject failed:', e))
      // The shell may watch the same project; watchers are not reference-counted yet.
      return () => {}
    },
  }

  const terminalsApi: PluginContext['terminals'] = {
    async spawn(o) {
      const { placement = 'none', ...rest } = o
      const h = await inv<TerminalHandle>('terminals.spawn', { options: rest })
      if (placement !== 'none') getShellBridge().placeTerminal(h, placement)
      return h
    },
    list: () => inv('terminals.list'),
    write: (termId, d) => voidInv('terminals.write', { id: termId, data: d }),
    resize: (termId, cols, rows) => voidInv('terminals.resize', { id: termId, cols, rows }),
    kill: (termId) => voidInv('terminals.kill', { id: termId }),
    onData: (termId, cb) => stream(t, 'terminals.onData', { id: termId }, (c) => cb(String(c)), log),
    onExit: (termId, cb) => stream(t, 'terminals.onExit', { id: termId }, (e) => cb(e as { code: number | null }), log),
    readBuffer: (termId, maxBytes) => inv('terminals.readBuffer', { id: termId, maxBytes }),
    // Rust checks ownership / `terminal:io` and that it exists; the layout switch happens here.
    focus: async (termId) => {
      await voidInv('terminals.focus', { id: termId })
      getShellBridge().focusTerminal(termId)
    },
    attach: (termId, el) =>
      attachTerminal(
        el,
        {
          onData: (cb) => terminalsApi.onData(termId, cb),
          write: (d) => terminalsApi.write(termId, d),
          resize: (c, r) => terminalsApi.resize(termId, c, r),
          readBuffer: () => terminalsApi.readBuffer(termId),
        },
        (e) => log.warn('attached terminal:', e),
      ),
  }

  const fsInv = (method: string, path: string, scope: FsScope | undefined, extra?: Record<string, unknown>) =>
    inv(method, { path, scope, ...extra })

  // Child webviews follow their tile: positioned from tile geometry, hidden
  // whenever the tile is not visible (overlay, hidden flyout, other workspace).
  // With `anchor` (a selector inside the tile) the webview covers that element
  // instead; it is re-queried on every update, so remounts and resizes follow.
  const createChildWebview = async (o: { instanceId: string; url: string; anchor?: string | HTMLElement; userAgent?: string }): Promise<ChildWebview> => {
    const { id: wvId } = await inv<{ id: string }>('native.createChildWebview', { instanceId: o.instanceId, url: o.url, userAgent: o.userAgent })
    let last = ''
    const push = (g: TileGeometry) => {
      let bounds = { ...g.css, visible: g.visible }
      if (o.anchor && g.visible) {
        let anchorEl: Element | null = null
        if (typeof o.anchor === 'string') {
          try {
            anchorEl = getTile(o.instanceId)?.el.querySelector(o.anchor) ?? null
          } catch {
            // invalid selector: treated as missing
          }
        } else if (o.anchor.isConnected) {
          anchorEl = o.anchor
        }
        const r = anchorEl?.getBoundingClientRect()
        bounds = r && r.width >= 1 && r.height >= 1
          ? { x: r.left, y: r.top, width: r.width, height: r.height, visible: true }
          : { ...bounds, visible: false }
      }
      const key = JSON.stringify(bounds)
      if (key === last) return
      last = key
      void voidInv('native.webviewSetBounds', { id: wvId, bounds }).catch(() => {})
    }
    const off = onTileGeometry(o.instanceId, push)
    // The anchor can move inside an unchanged tile (toolbars, view modes).
    const timer = o.anchor ? window.setInterval(() => push(geometryOf(o.instanceId)), 250) : undefined
    return {
      id: wvId,
      navigate: (url) => voidInv('native.webviewNavigate', { id: wvId, url }),
      eval: (js) => voidInv('native.webviewEval', { id: wvId, js }),
      close: async () => {
        off()
        if (timer !== undefined) window.clearInterval(timer)
        await voidInv('native.webviewClose', { id: wvId })
      },
    }
  }

  const noSidecar = (what: string) => () => Promise.reject(new HostError('unsupported', `${what}: this plugin declares no sidecar`))

  const ctx: PluginContext = {
    plugin: { id, version: info.version ?? '0.0.0', isolation: info.isolation },
    api: {
      version: PLUGIN_API_VERSION,
      has: (m) => (m.startsWith('sidecar.') ? !!info.manifest?.sidecar && SIDECAR_METHODS.includes(m) : hasMethod(m)),
    },
    log,
    project: {
      current: () => projectInfo(useProjectStore.getState().activeProject),
      list: () => inv<ProjectInfo[]>('project.list'),
      onDidChange: (cb) =>
        useProjectStore.subscribe((s, prev) => {
          if (s.activeProject?.id !== prev.activeProject?.id) cb(projectInfo(s.activeProject))
        }),
    },
    workspace: {
      current: currentWorkspace,
      onDidChange: (cb) =>
        useSessionStore.subscribe((s, prev) => {
          if (s.activeSession?.id !== prev.activeSession?.id) cb(currentWorkspace())
        }),
    },
    data,
    terminals: terminalsApi,
    agents: {
      providers: () => inv('agents.providers'),
      detect: (providerId) => inv('agents.detect', { providerId }),
      models: (providerId) => inv('agents.models', { providerId }),
      // Rust checks `agents:read` and names the providers with a `usage` hook;
      // the hooks are UI code of their plugins, run (with the cooldown) here.
      usage: async (o) => {
        const ids = await inv<string[]>('agents.usage', { providerId: o?.providerId })
        const { providerUsage } = await import('../../agents/providerRegistry')
        const out: AgentUsageSnapshot[] = []
        for (const providerId of ids) {
          const snap = await providerUsage(providerId, { cooldownSeconds: o?.cooldownSeconds, force: o?.force })
          if (snap) out.push(snap)
        }
        return out
      },
      launch: async ({ closeOnIssueDone, ...options }) => {
        const h = await inv<Awaited<ReturnType<PluginContext['agents']['launch']>>>('agents.launch', { options })
        // The terminal carries the agent's binding (badge, resume on restore);
        // an issue launch links the terminal for auto-close (lib/issueTerminals.ts).
        const issueId = h.binding.issueId
        const extra = issueId
          ? {
              linkedIssueId: issueId,
              autoCloseOnComplete: closeOnIssueDone ?? useAppSettingsStore.getState().aiAgent.autoCloseIssueTerminals,
              ...(options.prompt?.trim() ? { originalPrompt: options.prompt } : {}),
              ...(options.title ? { title: options.title, titleSource: 'manual' as const } : {}),
            }
          : undefined
        if (h.createdTerminal) placeAgentTerminal({ terminalId: h.id, binding: h.binding, cwd: h.cwd }, extra)
        else applyBinding(h.id, h.binding, extra)
        return h
      },
      oneShot: (o) => inv('agents.oneShot', { prompt: o.prompt, cwd: o.cwd, providerId: o.providerId }),
      sessionRoots: () => inv('agents.sessionRoots'),
      // Rust checks `agents:launch`, the path and resolves `"default"`; the hook is UI code of the
      // provider's plugin, run here (like `usage`).
      prepareWorktree: async (providerId, w) => {
        const resolved = await inv<string | null>('agents.prepareWorktree', { providerId, worktreePath: w.worktreePath })
        if (!resolved) return false
        const { providerPrepareWorktree } = await import('../../agents/providerRegistry')
        return providerPrepareWorktree(resolved, w)
      },
      onSessionLinked: (cb) => stream(t, 'agents.onSessionLinked', {}, (e) => cb(e as never), log),
    },
    events: {
      on: (topic, cb) => onHostEvent(topic, cb),
      emit: (topic, payload) => emitPluginEvent(id, topic, payload ?? null),
      onPlugin: (pluginId, topic, cb) => onPluginEvent(pluginId, topic, cb),
    },
    storage: {
      get: async <T,>(key: string, scope?: 'global' | 'project') => {
        const v = await inv<JsonValue>('storage.get', { key, scope })
        return (v === null ? undefined : v) as T | undefined
      },
      set: (key, value, scope) => voidInv('storage.set', { key, value, scope }),
      delete: (key, scope) => voidInv('storage.delete', { key, scope }),
      keys: (prefix, scope) => inv('storage.keys', { prefix, scope }),
    },
    settings: {
      get: <T,>(key: string) => settings[key] as T | undefined,
      getAll: () => ({ ...settings }),
      set: async (key, value) => applySettings(await inv<Record<string, JsonValue>>('settings.set', { key, value })),
      onDidChange: (cb) => {
        settingsListeners.add(cb)
        return () => settingsListeners.delete(cb)
      },
    },
    secrets: {
      get: (name) => inv('secrets.get', { name }),
      set: (name, value) => voidInv('secrets.set', { name, value }),
      delete: (name) => voidInv('secrets.delete', { name }),
    },
    notifications: {
      toast: (n) => {
        ensureToaster()
        toast({
          title: n.title,
          message: n.body ?? '',
          kind: n.kind,
          action: n.action ? { label: n.action.label, onClick: () => void executeCommand(n.action!.command).catch(log.error) } : undefined,
        })
      },
      system: (n) => voidInv('notifications.system', { title: n.title, body: n.body }),
      attention: (instanceId, on) => getTile(instanceId)?.setAttention(on),
    },
    fs: {
      readText: (path, scope) => fsInv('fs.readText', path, scope) as Promise<string>,
      readBytes: async (path, scope) => fromBase64((await fsInv('fs.readBytes', path, scope)) as string),
      writeText: async (path, content, scope) => void (await fsInv('fs.writeText', path, scope, { content })),
      writeBytes: async (path, content, scope) => void (await fsInv('fs.writeBytes', path, scope, { contentBase64: toBase64(content) })),
      list: (path, scope) => fsInv('fs.list', path, scope) as never,
      stat: (path, scope) => fsInv('fs.stat', path, scope) as never,
      remove: async (path, scope, o) => void (await fsInv('fs.remove', path, scope, { recursive: o?.recursive })),
      mkdir: async (path, scope) => void (await fsInv('fs.mkdir', path, scope)),
      watch: (path, scope, cb) => stream(t, 'fs.watch', { path, scope }, (e) => cb(e as { paths: string[] }), log),
    },
    shell: {
      exec: (options) => inv('shell.exec', { options }),
      spawn: async (options, onEvent) => {
        const s = t.subscribe('shell.spawn', { options }, (e) => onEvent(e as never))
        await s.ready
        return { kill: async () => s.dispose() }
      },
      openExternal: (url) => voidInv('shell.openExternal', { url }),
      revealInFileManager: (path, scope) => voidInv('shell.revealInFileManager', { path, scope }),
    },
    http: {
      fetch: async (url, init) => {
        const body = init?.body
        const r = await inv<{ status: number; headers: Record<string, string>; bodyBase64: string }>('http.fetch', {
          url,
          init: {
            method: init?.method,
            headers: init?.headers,
            timeoutMs: init?.timeoutMs,
            ...(body instanceof Uint8Array ? { bodyBase64: toBase64(body) } : { body }),
          },
        })
        const bytes = fromBase64(r.bodyBase64)
        const text = () => new TextDecoder().decode(bytes)
        return { status: r.status, headers: r.headers, body: bytes, text, json: <T,>() => JSON.parse(text()) as T }
      },
    },
    clipboard: {
      readText: () => inv('clipboard.readText'),
      writeText: (text) => voidInv('clipboard.writeText', { text }),
      writeImage: (png) => voidInv('clipboard.writeImage', { pngBase64: toBase64(png) }),
    },
    sidecar: info.manifest?.sidecar
      ? createSidecarApi(id, log.warn)
      : {
          request: noSidecar('sidecar.request'),
          notify: () => log.warn('sidecar.notify: this plugin declares no sidecar'),
          onNotification: () => () => {},
          status: noSidecar('sidecar.status'),
          onStatus: () => () => {},
          restart: noSidecar('sidecar.restart'),
          logs: noSidecar('sidecar.logs'),
        },
    commands: {
      register: (cmdId, handler) => {
        const declared = info.manifest?.contributes?.commands?.some((c) => c.id === cmdId)
        if (!declared) throw new HostError('invalid_input', `command ${JSON.stringify(cmdId)} is not declared in contributes.commands`)
        const key = `${id}/${cmdId}`
        commandHandlers.set(key, handler)
        return () => {
          if (commandHandlers.get(key) === handler) commandHandlers.delete(key)
        }
      },
      execute: <T,>(cmdId: string, args?: JsonValue) => executeCommand(cmdId, args) as Promise<T>,
    },
    ui: {
      openTile: (contributionId, o) =>
        new Promise<string>((resolve, reject) => {
          let done = false
          const off = onTileAdded(id, contributionId, (instanceId) => {
            if (done) return
            done = true
            off()
            resolve(instanceId)
          })
          getShellBridge()
            .openTile(id, contributionId, o?.placement === 'flyout' ? 'flyout' : 'pane', o?.state)
            .then(
              () =>
                setTimeout(() => {
                  if (done) return
                  done = true
                  off()
                  reject(new HostError('internal', `tile ${contributionId} did not open`))
                }, 5000),
              (e) => {
                done = true
                off()
                reject(toHostError(e))
              },
            )
        }),
      closeTile: (instanceId) => getTile(instanceId)?.close(),
      onTileClosed: (cb) => onTileClosed(id, cb),
      getToolConfig: async (configId) => {
        const c = useToolStore.getState().toolConfigs.get(configId)
        return c && c.pluginId === id ? toolConfigInfo(c) : null
      },
      updateToolConfigSettings: async (configId, patch) => {
        const store = useToolStore.getState()
        const c = store.toolConfigs.get(configId)
        if (!c || c.pluginId !== id) throw new HostError('not_found', `tool config ${JSON.stringify(configId)} is not one of ${id}'s`)
        const settings: Record<string, unknown> = { ...(c.settings ?? {}) }
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete settings[k]
          else settings[k] = v
        }
        await store.updateToolConfig(configId, { settings })
        const updated = useToolStore.getState().toolConfigs.get(configId)
        if (!updated) throw new HostError('not_found', `tool config ${JSON.stringify(configId)} is gone`)
        return toolConfigInfo(updated)
      },
      focusTile: (instanceId) => {
        getShellBridge().focusTile(instanceId)
        getTile(instanceId)?.el.focus?.()
      },
      confirm: (o) => hostConfirm(o),
      prompt: (o) => hostPrompt(o),
      openSettings: async (pageId) => {
        if (!info.manifest?.contributes?.settingsPages?.some((p) => p.id === pageId)) {
          throw new HostError('not_found', `plugin ${JSON.stringify(id)} has no settings page ${JSON.stringify(pageId)}`)
        }
        useAppSettingsStore.getState().openSettingsModalAt(`plugin:${id}/${pageId}`)
      },
      pickFile: (o) => inv('ui.pickFile', { directory: o?.directory, multiple: o?.multiple, filters: o?.filters }),
      theme: () => getThemeSnapshot() as ThemeSnapshot,
      onThemeChange: (cb) => onThemeChange((th) => cb(th as ThemeSnapshot)),
    },
    overlay: {
      isAnyOpen: anyOverlayOpen,
      onChange: (cb) => {
        let last = ''
        const fire = () => {
          const s = { anyOpen: anyOverlayOpen(), rects: overlayRects() }
          const k = JSON.stringify(s)
          if (k !== last) {
            last = k
            cb(s)
          }
        }
        fire()
        return useOverlayStore.subscribe(() => requestAnimationFrame(fire))
      },
      register: (overlayId, open) => {
        const key = `plugin:${id}:${overlayId}`
        if (open) useOverlayStore.getState().registerOverlay(key)
        else useOverlayStore.getState().unregisterOverlay(key)
      },
    },
    native: {
      mainWindowHandle: () => inv('native.mainWindowHandle'),
      tileGeometry: (instanceId) => geometryOf(instanceId),
      onTileGeometry: (instanceId, cb) => onTileGeometry(instanceId, cb),
      createChildWebview,
      captureRegion: async (r) => fromBase64(await inv<string>('native.captureRegion', { rect: r })),
      allowSetForeground: (pid) => voidInv('native.allowSetForeground', { pid }),
      openWindow: async (o) => {
        const { id: wId } = await inv<{ id: string }>('native.openWindow', { url: o.url, title: o.title, width: o.width, height: o.height, userAgent: o.userAgent })
        return {
          id: wId,
          navigate: (url) => voidInv('native.webviewNavigate', { id: wId, url }),
          eval: (js) => voidInv('native.webviewEval', { id: wId, js }),
          close: () => voidInv('native.webviewClose', { id: wId }),
        }
      },
      // Rust maps the tile's center (absolute physical px) to a monitor.
      monitorOf: async (instanceId) => {
        if (!getTile(instanceId)) return null
        const g = geometryOf(instanceId).physical
        return inv('native.monitorOf', { x: g.x + g.width / 2, y: g.y + g.height / 2 })
      },
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// notifications.system → Web Notification API (or a toast)
// ---------------------------------------------------------------------------

let notificationsWired = false
/** Listen for `plugin-host:notification` (emitted by Rust after the permission check). */
export function wireSystemNotifications(): void {
  if (notificationsWired) return
  notificationsWired = true
  void listen<{ pluginId: string; title: string; body?: string | null }>('plugin-host:notification', (ev) => {
    const { title, body } = ev.payload
    const show = () => {
      try {
        new Notification(title, { body: body ?? undefined })
        return true
      } catch {
        return false
      }
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && show()) return
    ensureToaster()
    toast({ title, message: body ?? '', kind: 'info' })
  })
}
