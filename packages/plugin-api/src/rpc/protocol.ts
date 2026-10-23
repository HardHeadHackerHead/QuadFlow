/**
 * Sandbox RPC protocol (plugin-system.md §8.4): the postMessage messages between
 * a sandboxed plugin frame (`packages/plugin-runtime` + `./client.ts`) and the
 * host bridge (`src/plugins/rpcBridge.ts`), the method table both sides use,
 * and the limits the host enforces.
 *
 * A request names a `PluginContext` method by its dotted path
 * (`data.issues.list`, `ui.confirm`, …) and carries its arguments as an array.
 * The host resolves the path on the plugin's own host context (the same object
 * a trusted plugin gets), so every privileged call ends in the same
 * permission-checked Rust dispatch (`plugin_invoke` / `plugin_subscribe`).
 * Only methods listed in {@link RPC_METHODS} are callable.
 */
import type { HostErrorCode, JsonValue } from '../index'

export const RPC_PROTOCOL = 1 as const

/** Largest message a frame may post (estimated, see {@link estimateSize}). */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
/** Requests (and subscription acks) a frame may have outstanding at once. */
export const MAX_IN_FLIGHT = 200

/**
 * How a method crosses the boundary:
 *  - `call`:   async, resolves with the (structured-clone) result;
 *  - `fire`:   synchronous `void` in the API; sent without waiting;
 *  - `sub`:    `(…args, cb) => Disposable`; the host appends the callback, events arrive as `evt`;
 *  - `stream`: async *and* takes a callback at {@link STREAM_CALLBACK_INDEX}; events arrive as `evt`
 *              with the request id until the `res`.
 */
export type RpcKind = 'call' | 'fire' | 'sub' | 'stream'

const call = (names: string[]) => names.map((n) => [n, 'call'] as const)
const DATA_CALLS = [
  'ideas.list', 'ideas.get', 'ideas.stats', 'ideas.create', 'ideas.update', 'ideas.delete', 'ideas.merge',
  'ideas.addTag', 'ideas.removeTag', 'ideas.bulkTag', 'ideas.addNote', 'ideas.deleteNote', 'ideas.addSuggestion',
  'ideas.resolveSuggestion', 'ideas.deleteSuggestion', 'ideas.revert',
  'issues.list', 'issues.get', 'issues.create', 'issues.update', 'issues.setStatus', 'issues.close', 'issues.reopen',
  'issues.delete', 'issues.addComment', 'issues.deleteComment', 'issues.toggleCriterion', 'issues.claim',
  'issues.heartbeat', 'issues.release', 'issues.labels.list', 'issues.labels.upsert', 'issues.labels.delete',
  'issues.epics.list', 'issues.epics.get', 'issues.epics.create', 'issues.epics.update', 'issues.epics.delete',
  'plans.list', 'plans.get', 'plans.create', 'plans.update', 'plans.delete', 'plans.stepAdd', 'plans.stepUpdate',
  'plans.stepDelete', 'plans.stepsReorder', 'plans.commentAdd', 'plans.commentDelete', 'plans.promoteStep',
  'plans.promoteAll',
  'discovery.list', 'discovery.get', 'discovery.create', 'discovery.update', 'discovery.delete', 'discovery.itemAdd',
  'discovery.itemUpdate', 'discovery.itemDelete', 'discovery.itemsReorder', 'discovery.linked',
  'scripts.list', 'scripts.get', 'scripts.create', 'scripts.update', 'scripts.delete', 'scripts.resolveCommand',
  'scripts.groups.list', 'scripts.groups.get', 'scripts.groups.create', 'scripts.groups.update', 'scripts.groups.delete',
  'scripts.groups.addMember', 'scripts.groups.removeMember', 'scripts.environments.list', 'scripts.environments.detect',
  'ship.configGet', 'ship.configSave', 'ship.validate', 'ship.status', 'ship.readiness', 'ship.externalComplete',
  'ship.abort', 'ship.runs', 'ship.runGet', 'ship.templates', 'ship.init', 'ship.detect', 'ship.diagnostics',
  'ship.readinessOne', 'ship.configDelete', 'ship.restoreBackups',
  'chat.conversations', 'chat.get', 'chat.create', 'chat.messages', 'chat.rename', 'chat.delete', 'chat.settingsGet',
  'chat.settingsUpdate', 'chat.models', 'chat.ask',
  'missions.list', 'missions.get', 'missions.create', 'missions.update', 'missions.delete', 'missions.progress',
  'missions.issues', 'missions.memberAdd', 'missions.memberUpdate', 'missions.memberRemove', 'missions.messages',
  'missions.send', 'missions.activity', 'missions.assignIssues', 'missions.claimNextIssue', 'missions.proposalSetStatus',
  'missions.mergeUpdate', 'missions.logActivity', 'missions.markRead',
  'missions.templates.list', 'missions.templates.upsert', 'missions.templates.delete',
  'missions.agentDefinitions.list', 'missions.agentDefinitions.upsert', 'missions.agentDefinitions.delete',
  'projectConfig.get', 'projectConfig.update',
].map((n) => `data.${n}`)

/** Every method a sandboxed frame may ask the host for. Everything else is refused. */
export const RPC_METHODS: Readonly<Record<string, RpcKind>> = Object.freeze(
  Object.fromEntries<RpcKind>([
    ...call(DATA_CALLS),
    ['data.ship.run', 'stream'],
    ['data.ship.runFix', 'stream'],
    ['data.chat.send', 'stream'],
    ['data.onDidChange', 'sub'],
    ['data.watchProject', 'fire'],
    ['log.debug', 'fire'], ['log.info', 'fire'], ['log.warn', 'fire'], ['log.error', 'fire'],
    ['project.list', 'call'],
    ...call(['terminals.spawn', 'terminals.list', 'terminals.write', 'terminals.resize', 'terminals.kill', 'terminals.readBuffer', 'terminals.focus']),
    ['terminals.onData', 'sub'], ['terminals.onExit', 'sub'],
    ...call(['agents.providers', 'agents.detect', 'agents.models', 'agents.usage', 'agents.launch', 'agents.oneShot', 'agents.prepareWorktree', 'agents.sessionRoots']),
    ['agents.onSessionLinked', 'sub'],
    ['events.on', 'sub'], ['events.onPlugin', 'sub'], ['events.emit', 'fire'],
    ...call(['storage.get', 'storage.set', 'storage.delete', 'storage.keys']),
    ['settings.set', 'call'],
    ...call(['secrets.get', 'secrets.set', 'secrets.delete']),
    ['notifications.toast', 'fire'], ['notifications.attention', 'fire'], ['notifications.system', 'call'],
    ...call(['fs.readText', 'fs.readBytes', 'fs.writeText', 'fs.writeBytes', 'fs.list', 'fs.stat', 'fs.remove', 'fs.mkdir']),
    ['fs.watch', 'sub'],
    ...call(['shell.exec', 'shell.openExternal', 'shell.revealInFileManager']),
    ['shell.spawn', 'stream'],
    ['http.fetch', 'call'],
    ...call(['clipboard.readText', 'clipboard.writeText', 'clipboard.writeImage']),
    ...call(['sidecar.request', 'sidecar.status', 'sidecar.restart', 'sidecar.logs']),
    ['sidecar.notify', 'fire'], ['sidecar.onNotification', 'sub'], ['sidecar.onStatus', 'sub'],
    ['commands.register', 'sub'], ['commands.execute', 'call'],
    ...call(['ui.openTile', 'ui.confirm', 'ui.prompt', 'ui.pickFile', 'ui.getToolConfig', 'ui.updateToolConfigSettings', 'ui.openSettings']),
    ['ui.closeTile', 'fire'], ['ui.focusTile', 'fire'], ['ui.onTileClosed', 'sub'],
    ['overlay.register', 'fire'],
  ]),
)

/** Argument position of the event callback of `stream` methods. */
export const STREAM_CALLBACK_INDEX: Readonly<Record<string, number>> = Object.freeze({
  'data.ship.run': 1,
  'data.ship.runFix': 1,
  'data.chat.send': 2,
  'shell.spawn': 1,
})

/**
 * Served inside the frame from state the host pushes (`init` / `ctx`), so they
 * stay synchronous: no request is sent.
 */
export const FRAME_LOCAL_METHODS = [
  'project.current', 'project.onDidChange', 'workspace.current', 'workspace.onDidChange',
  'settings.get', 'settings.getAll', 'settings.onDidChange', 'data.issues.displayRef',
  'ui.theme', 'ui.onThemeChange', 'overlay.isAnyOpen', 'overlay.onChange',
] as const

/**
 * Host-API methods that only exist for trusted plugins (plugin-system.md §7.2:
 * `terminals.attach` and native views need the host DOM; §8.4: no native APIs
 * in the sandbox). `api.has()` is false for them in a frame and calling them
 * rejects / throws `unsupported`.
 */
export const TRUSTED_ONLY_METHODS = [
  'terminals.attach',
  'native.mainWindowHandle',
  'native.tileGeometry',
  'native.onTileGeometry',
  'native.createChildWebview',
  'native.captureRegion',
  'native.allowSetForeground',
  'native.openWindow',
  'native.monitorOf',
] as const

/** Internal host request: kill a `shell.spawn` process (`params: [spawnRequestId]`). */
export const KILL_SPAWN = '$shell.kill'

export interface RpcError {
  code: HostErrorCode
  message: string
  details?: JsonValue
}

export interface RpcTheme {
  mode: 'dark' | 'light'
  preference: 'dark' | 'light' | 'system'
  colors: Record<string, string>
  terminal: Record<string, string>
  scalars: Record<string, string>
}

/** `ProjectInfo` / workspace as the frame caches them. */
export interface RpcProject {
  id: string
  name: string
  root: string
  rootKey: string
  config: unknown
}

export interface RpcTileInit {
  contributionId: string
  instance: { id: string; title: string; state: JsonValue }
  config: { id: string; name: string; settings: JsonValue }
  mode: 'pane' | 'flyout'
  visible: boolean
}

export interface RpcInit {
  qf: 1
  kind: 'init'
  role: 'tile' | 'background'
  plugin: { id: string; version: string; isolation: 'sandboxed' | 'trusted' }
  /** `api.version` + the methods `api.has()` is true for in this frame. */
  api: { version: string; methods: string[] }
  /** Command ids declared in the manifest (`commands.register` checks them locally too). */
  commands: string[]
  project: RpcProject | null
  workspace: { id: string; name: string } | null
  settings: Record<string, JsonValue>
  theme: RpcTheme
  overlay: { anyOpen: boolean }
  /** Cache-buster for the plugin entry (dev reloads). */
  bust: string
  tile?: RpcTileInit
}

export type UiOp = 'setTitle' | 'setState' | 'setAttention' | 'close' | 'resize'

/** Frame → host. */
export type ToHost =
  | { qf: 1; kind: 'ready' }
  | { qf: 1; kind: 'req'; id: number; method: string; params?: unknown[] }
  | { qf: 1; kind: 'sub'; id: number; topic: string; params?: unknown[] }
  | { qf: 1; kind: 'unsub'; id: number }
  | { qf: 1; kind: 'ret'; id: number; result?: unknown; error?: RpcError }
  | { qf: 1; kind: 'ui'; op: UiOp; value?: JsonValue }
  /** The frame finished loading (`ready`: tile rendered / `activate()` done) or failed. */
  | { qf: 1; kind: 'status'; state: 'ready' | 'error'; error?: string }

/** Host → frame. */
export type ToFrame =
  | RpcInit
  | { qf: 1; kind: 'res'; id: number; result?: unknown; error?: RpcError }
  /** A subscription / stream event: the callback's arguments. */
  | { qf: 1; kind: 'evt'; id: number; payload: unknown[] }
  | {
      qf: 1
      kind: 'ctx'
      project?: RpcProject | null
      workspace?: { id: string; name: string } | null
      theme?: RpcTheme
      settings?: Record<string, JsonValue>
      overlay?: { anyOpen: boolean }
      visible?: boolean
      mode?: 'pane' | 'flyout'
    }
  /**
   * The host calls into the frame: `$command` (background frame: a manifest
   * command, `args = [commandId, args]`), `$handler` (a `commands.register`
   * handler, `sub` = its subscription id), `$deactivate`. Answered with `ret`.
   */
  | { qf: 1; kind: 'call'; id: number; fn: '$command' | '$handler' | '$deactivate'; sub?: number; args: unknown[] }

export function isRpcMessage(v: unknown): v is { qf: 1; kind: string } {
  return typeof v === 'object' && v !== null && (v as { qf?: unknown }).qf === RPC_PROTOCOL && typeof (v as { kind?: unknown }).kind === 'string'
}

/**
 * Size of a structured-clone value in bytes, estimated (strings as UTF-16,
 * binary by byteLength, 8 per number, keys included). Stops walking once
 * `limit` is exceeded, so a huge message costs at most `limit` work. Cycles and
 * unknown objects count as 8 bytes per node.
 */
export function estimateSize(v: unknown, limit = Number.POSITIVE_INFINITY): number {
  let total = 0
  const seen = new Set<object>()
  const stack: unknown[] = [v]
  while (stack.length > 0 && total <= limit) {
    const x = stack.pop()
    if (typeof x === 'string') total += x.length * 2
    else if (typeof x === 'number' || typeof x === 'bigint') total += 8
    else if (x === null || x === undefined || typeof x === 'boolean') total += 1
    else if (typeof x === 'object') {
      if (seen.has(x)) {
        total += 8
        continue
      }
      seen.add(x)
      if (ArrayBuffer.isView(x)) total += x.byteLength
      else if (x instanceof ArrayBuffer) total += x.byteLength
      else if (x instanceof Blob) total += x.size
      else if (Array.isArray(x)) {
        total += 8
        for (let i = x.length - 1; i >= 0; i--) stack.push(x[i])
      } else if (x instanceof Map) {
        total += 8
        x.forEach((val, key) => stack.push(key, val))
      } else if (x instanceof Set) {
        total += 8
        x.forEach((val) => stack.push(val))
      } else {
        total += 8
        for (const k of Object.keys(x)) {
          total += k.length * 2
          stack.push((x as Record<string, unknown>)[k])
        }
      }
    } else total += 8
  }
  return total
}
