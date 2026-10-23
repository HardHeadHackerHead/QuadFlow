import { invoke } from '@tauri-apps/api/core'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import {
  ToolConfig,
  TerminalEnvironment,
  CreateTerminalOptions,
  TerminalInfo,
  TerminalExitPayload,
  OsInfo,
} from '../types'

// OS info (cached; preloaded at startup by main.tsx)
let osInfoCache: OsInfo | null = null
let osInfoPromise: Promise<OsInfo> | null = null

export const osApi = {
  getInfo: (): Promise<OsInfo> => {
    if (!osInfoPromise) {
      osInfoPromise = invoke<OsInfo>('get_os_info')
        .then((info) => {
          osInfoCache = info
          return info
        })
        .catch((e) => {
          osInfoPromise = null
          throw e
        })
    }
    return osInfoPromise
  },
  getCachedInfo: (): OsInfo | null => osInfoCache,
}

// Terminal ids are reused (workspace switches re-create a PTY under the same
// id). Each spawn has a generation; exit events from an older generation than
// the one we are creating/attached to are stale and must not reach listeners.
const terminalKnownGeneration = new Map<string, number>()
const terminalGenerationFloor = new Map<string, number>()

// Terminal API
export const terminalApi = {
  create: async (options: CreateTerminalOptions): Promise<TerminalInfo> => {
    if (options.id) {
      // Until the backend answers, anything from the previous spawn is stale.
      const known = terminalKnownGeneration.get(options.id)
      if (known !== undefined) terminalGenerationFloor.set(options.id, known + 1)
    }
    const result = await invoke<TerminalInfo>('create_terminal', { options })
    if (typeof result.generation === 'number') {
      terminalKnownGeneration.set(result.id, result.generation)
      terminalGenerationFloor.set(result.id, result.generation)
    }
    return {
      ...result,
      cwd: result.cwd || options.cwd || '',
    }
  },

  write: async (id: string, data: string): Promise<void> => {
    await invoke('write_terminal', { id, data })
  },

  resize: async (id: string, cols: number, rows: number): Promise<void> => {
    await invoke('resize_terminal', { id, cols, rows })
  },

  kill: async (id: string): Promise<void> => {
    await invoke('kill_terminal', { id })
  },

  getInfo: async (id: string): Promise<TerminalInfo> => {
    return await invoke<TerminalInfo>('get_terminal_info', { id })
  },

  list: async (): Promise<TerminalInfo[]> => {
    return await invoke<TerminalInfo[]>('list_terminals')
  },

  onData: (terminalId: string, callback: (data: string) => void): Promise<UnlistenFn> => {
    return listen<string>(`terminal:data:${terminalId}`, (event) => {
      callback(event.payload)
    })
  },

  onExit: (
    terminalId: string,
    callback: (payload: TerminalExitPayload) => void,
  ): Promise<UnlistenFn> => {
    return listen<TerminalExitPayload>(`terminal:exit:${terminalId}`, (event) => {
      const floor = terminalGenerationFloor.get(terminalId)
      const generation = event.payload?.generation
      if (floor !== undefined && typeof generation === 'number' && generation < floor) {
        return // exit of a previous spawn that shared this id
      }
      callback(event.payload)
    })
  },
}

// =====================================================================
// Diagnostics API
// =====================================================================
//
// Talks to `src-tauri/src/diagnostics.rs`. One-stop surface for crash
// reporting + bug-report bundle creation. Wired from `main.tsx` to
// install global JS error handlers, and from any UI component that
// wants to leave a breadcrumb (e.g. "user clicked Patch button").
export interface DiagnosticsBreadcrumb {
  ts: string
  level: string
  category: string
  message: string
  fields?: Record<string, unknown>
}

export interface FrontendErrorPayload {
  kind: 'error' | 'promise' | 'console_error'
  message: string
  source?: string | null
  line?: number | null
  column?: number | null
  stack?: string | null
  url?: string | null
}

export const diagnosticsApi = {
  /** Reveal logs/crash-reports/bundles folder in File Explorer. */
  openFolder: (): Promise<string> => invoke<string>('open_diagnostics_folder'),

  /**
   * Zip every diagnostic artifact (logs + crash reports + system/build
   * info + breadcrumbs) into a single attachable archive. Reveals the
   * archive in File Explorer and returns its absolute path so the UI
   * can show a copy-to-clipboard / share affordance.
   */
  generateBundle: (): Promise<string> => invoke<string>('generate_diagnostic_bundle'),

  /**
   * Persist a frontend error as a CrashReport JSON. Wired into
   * `window.onerror` and `window.unhandledrejection` from main.tsx so
   * stray uncaught errors don't vanish into the WebView console.
   */
  reportError: (payload: FrontendErrorPayload): Promise<string> =>
    invoke<string>('report_frontend_error', { payload }),

  /**
   * Drop a breadcrumb. Cheap (in-memory ring); call freely from
   * onClick handlers, route changes, etc. The breadcrumbs ride along
   * with every crash report and the diagnostic bundle.
   */
  recordBreadcrumb: (
    level: 'info' | 'warn' | 'error' | 'debug',
    category: string,
    message: string,
    fields?: Record<string, unknown>,
  ): Promise<void> =>
    invoke<void>('record_breadcrumb', { level, category, message, fields }),

  /** Fetch the in-memory breadcrumb ring for a "what just happened" view. */
  getRecent: (): Promise<DiagnosticsBreadcrumb[]> =>
    invoke<DiagnosticsBreadcrumb[]>('get_recent_breadcrumbs'),

  /** Build + system metadata for a "Diagnostics" UI panel. */
  getMetadata: (): Promise<{
    build: Record<string, unknown>
    system: Record<string, unknown>
    log_dir: string | null
  }> => invoke('get_diagnostics_metadata'),
}

/**
 * Install global JS error handlers that mirror every uncaught error and
 * unhandled promise rejection into the diagnostics pipeline. Call once
 * at application boot from `main.tsx`. Idempotent; safe to call again.
 */
let _globalHandlersInstalled = false
export function installGlobalDiagnosticsHandlers(): void {
  if (_globalHandlersInstalled) return
  _globalHandlersInstalled = true

  window.addEventListener('error', (e: ErrorEvent) => {
    diagnosticsApi.reportError({
      kind: 'error',
      message: e.message ?? String(e.error ?? 'unknown error'),
      source: e.filename ?? null,
      line: e.lineno ?? null,
      column: e.colno ?? null,
      stack: e.error?.stack ?? null,
      url: window.location.href,
    }).catch(() => {})
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason as { message?: string; stack?: string } | undefined
    const msg =
      typeof e.reason === 'string'
        ? e.reason
        : r?.message ?? JSON.stringify(e.reason)
    diagnosticsApi.reportError({
      kind: 'promise',
      message: msg,
      source: null,
      line: null,
      column: null,
      stack: r?.stack ?? null,
      url: window.location.href,
    }).catch(() => {})
  })

  // Also tee console.error → breadcrumb so post-mortem we can see what
  // chatty libs were complaining about right before something blew up.
  const orig = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    orig(...args)
    try {
      const msg = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ')
      diagnosticsApi.recordBreadcrumb('error', 'console', msg).catch(() => {})
    } catch {
      // ignore — we never want our diagnostics to break the host.
    }
  }
}

// CLI installation: add the QuadFlow exe directory to the user's PATH so
// `quadflow` is callable from any new terminal. Windows-only for now;
// other platforms return supported: false.
export interface CliInstallStatus {
  /** Both halves of install in place: bin dir on PATH AND shim file present. */
  installed: boolean
  /** Bin dir IS on PATH. */
  bin_on_path: boolean
  /** quadflow.cmd (Windows) / quadflow (Unix) shim file exists in bin_dir. */
  shim_present: boolean
  /** Path the shim would be / is at. */
  shim_path: string
  /** `quadflow` actually resolves on PATH right now (could be a different install). */
  on_path: boolean
  /** Resolved path to THIS app's exe. */
  exe_path: string
  /** What `where quadflow` returns; may differ from exe_path if another quadflow shadows ours. */
  resolved_exe_on_path: string | null
  /** Directory we'd add (or have added) to PATH. */
  bin_dir: string
  /** Output of `quadflow --version` from PATH. */
  version_on_path: string | null
  /** Running app's version (CARGO_PKG_VERSION). */
  app_version: string
  /** version_on_path matches app_version. */
  version_match: boolean
  /** Auto-install supported on this OS (Windows yes, others no for now). */
  supported: boolean
  /** Human-readable note (e.g. "Restart shells to pick up the new PATH"). */
  message: string | null
}

export const cliInstallApi = {
  status: () => invoke<CliInstallStatus>('cli_install_status'),
  install: () => invoke<CliInstallStatus>('cli_install_to_path'),
  /** Promote this build's bin_dir to the FRONT of PATH so `quadflow` resolves to it. */
  switchToThisBuild: () => invoke<CliInstallStatus>('cli_switch_to_this_build'),
  uninstall: () => invoke<CliInstallStatus>('cli_uninstall_from_path'),
}

// Settings API (directory and file picker utilities)
export const settingsApi = {
  pickDirectory: async (): Promise<string | null> => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select Working Directory',
    })
    return selected as string | null
  },

  pickFile: async (): Promise<string | null> => {
    const selected = await open({
      directory: false,
      multiple: false,
      title: 'Select File',
    })
    return selected as string | null
  },
}

// File API - for reading files from the filesystem
export const fileApi = {
  readFile: async (path: string): Promise<string> => {
    return await invoke<string>('read_file', { path })
  },
}

// Open external links in the system default browser
export const openExternal = async (url: string): Promise<void> => {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

// Window attention API - for notifying user when terminal needs attention
export async function requestWindowAttention(): Promise<void> {
  return invoke('request_attention')
}

// Floating window types
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// Floating window API
export const floatingWindowApi = {
  create: async (
    panelId: string,
    panelType: 'terminal' | 'tool',
    title: string,
    bounds?: { x?: number; y?: number; width?: number; height?: number }
  ): Promise<string> => {
    return await invoke<string>('create_floating_window', {
      panelId,
      panelType,
      title,
      x: bounds?.x ?? null,
      y: bounds?.y ?? null,
      width: bounds?.width ?? null,
      height: bounds?.height ?? null,
    })
  },

  close: async (windowLabel: string): Promise<void> => {
    await invoke('close_floating_window', { windowLabel })
  },

  getBounds: async (windowLabel: string): Promise<WindowBounds> => {
    return await invoke<WindowBounds>('get_window_bounds', { windowLabel })
  },

  focus: async (windowLabel: string): Promise<void> => {
    await invoke('focus_floating_window', { windowLabel })
  },
}

// Chat moved to the core: src/lib/core/chat.ts (typed commands, DL-8).

// ─── Git Worktree API ─────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string
  branch: string
  commit: string
  is_bare: boolean
  is_main: boolean
}

export interface WorktreeStatus {
  path: string
  branch: string
  is_dirty: boolean
  staged_files: string[]
  unstaged_files: string[]
  untracked_files: string[]
  ahead: number
  behind: number
}

export interface MergeResult {
  success: boolean
  conflict_files: string[]
  message: string
}

export const worktreeApi = {
  create: async (
    projectDir: string,
    branchName: string,
    worktreePath: string,
  ): Promise<WorktreeInfo> => {
    return await invoke<WorktreeInfo>('create_worktree', {
      projectDir,
      branchName,
      worktreePath,
    })
  },

  list: async (projectDir: string): Promise<WorktreeInfo[]> => {
    return await invoke<WorktreeInfo[]>('list_worktrees', { projectDir })
  },

  delete: async (
    projectDir: string,
    worktreePath: string,
    force: boolean = false,
    deleteBranch: boolean = false,
  ): Promise<void> => {
    return await invoke<void>('delete_worktree', {
      projectDir,
      worktreePath,
      force,
      deleteBranch,
    })
  },

  getStatus: async (worktreePath: string): Promise<WorktreeStatus> => {
    return await invoke<WorktreeStatus>('get_worktree_status', { worktreePath })
  },

  merge: async (
    projectDir: string,
    sourceBranch: string,
    targetBranch: string,
    commitMessage?: string,
  ): Promise<MergeResult> => {
    return await invoke<MergeResult>('merge_worktree_branch', {
      projectDir,
      sourceBranch,
      targetBranch,
      commitMessage,
    })
  },

  prune: async (projectDir: string): Promise<void> => {
    return await invoke<void>('prune_worktrees', { projectDir })
  },
}

/**
 * Create a terminal from a tool config's settings.
 * Reads shell, workingDirectory, and environmentId from tool.settings,
 * falling back to the global working directory and default environment.
 */
export async function createTerminalFromToolConfig(
  tool: ToolConfig,
  globalWorkingDirectory: string,
  environments: TerminalEnvironment[],
  defaultEnvironmentId: string | undefined,
): Promise<TerminalInfo> {
  const settings = tool.settings || {}

  // Resolve environment: tool-specific > global default > none
  const envId = (settings.environmentId as string) || defaultEnvironmentId
  const env = envId ? environments.find(e => e.id === envId) : undefined

  // Resolve shell: tool-specific > environment > system default
  const toolShell = settings.shell as string | undefined
  let shell: 'cmd' | 'powershell' | 'bash' | undefined
  if (toolShell && toolShell !== 'default') {
    shell = toolShell as 'cmd' | 'powershell' | 'bash'
  } else if (env?.shell && env.shell !== 'default') {
    shell = env.shell as 'cmd' | 'powershell' | 'bash'
  }

  // Resolve working directory: tool-specific > global
  const cwd = (settings.workingDirectory as string) || globalWorkingDirectory

  // Init commands from environment
  const initCommands = env?.initCommands

  return await terminalApi.create({ cwd, shell, initCommands })
}
