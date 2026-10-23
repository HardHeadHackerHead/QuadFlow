// Shared type definitions for QuadFlow
import type { AgentBinding } from '../generated/bindings'

// Re-export layout types
export * from './layout'

// Stored Prompt type
export interface StoredPrompt {
  id: string
  name: string
  content: string
  category?: string
  createdAt: number
  updatedAt: number
}

// Agent providers come from plugins (`agents_providers`); the shell refers to
// them only by provider id (agent-providers.md §5). A model option as shown in
// pickers and settings:
export interface AIModelOption {
  id: string          // Model id passed to the agent CLI (validated by the core)
  label: string
  shortLabel?: string
  contextWindow?: number
  isDefault?: boolean
}

// Agent roles — real software team job specializations
export type AgentRole = 'scrum_master' | 'tech_lead' | 'product_owner' | 'frontend' | 'backend' | 'fullstack' | 'devops' | 'database' | 'qa' | 'security' | 'docs' | 'research' | 'custom'

export const AGENT_ROLE_CONFIG: Record<AgentRole, { label: string; color: string; description: string }> = {
  scrum_master: {
    label: 'Scrum Master',
    color: 'from-purple-500 to-pink-500',
    description: 'Runs sprints, assigns issues, tracks progress, removes blockers'
  },
  tech_lead: {
    label: 'Tech Lead',
    color: 'from-indigo-500 to-purple-500',
    description: 'Makes architectural decisions, reviews critical code, guides direction'
  },
  product_owner: {
    label: 'Product Owner',
    color: 'from-rose-500 to-pink-500',
    description: 'Defines requirements, prioritizes backlog, validates deliverables'
  },
  frontend: {
    label: 'Frontend Dev',
    color: 'from-cyan-500 to-blue-500',
    description: 'UI components, styling, accessibility, state management'
  },
  backend: {
    label: 'Backend Dev',
    color: 'from-green-500 to-emerald-500',
    description: 'APIs, server logic, business rules, service architecture'
  },
  fullstack: {
    label: 'Full Stack Dev',
    color: 'from-teal-500 to-green-500',
    description: 'Works across the entire stack, frontend to database'
  },
  devops: {
    label: 'DevOps',
    color: 'from-orange-500 to-amber-500',
    description: 'CI/CD, Docker, deployment, infrastructure, build systems'
  },
  database: {
    label: 'Database Eng',
    color: 'from-yellow-500 to-orange-500',
    description: 'Schema design, migrations, query optimization, data modeling'
  },
  qa: {
    label: 'QA Engineer',
    color: 'from-amber-500 to-yellow-500',
    description: 'Tests, edge cases, acceptance criteria validation, regression'
  },
  security: {
    label: 'Security Eng',
    color: 'from-red-500 to-rose-500',
    description: 'Vulnerability audits, auth review, OWASP top 10, dependency scanning'
  },
  docs: {
    label: 'Tech Writer',
    color: 'from-sky-500 to-blue-500',
    description: 'Documentation, READMEs, API docs, architecture decision records'
  },
  research: {
    label: 'Researcher',
    color: 'from-blue-500 to-indigo-500',
    description: 'Investigates codebases, evaluates libraries, gathers context'
  },
  custom: {
    label: 'Custom',
    color: 'from-gray-500 to-slate-500',
    description: 'Custom role with user-defined purpose'
  },
}

export interface Terminal {
  id: string
  title: string
  titleSource?: TitleSource
  originalPrompt: string | null
  summary: string | null
  workingDirectory: string
  gridPosition: number
  status: 'active' | 'closed' | 'error'
  createdAt: number
}

export interface TerminalState extends Terminal {
  pid?: number
  isLoading: boolean
  pendingBufferContent?: string
  /** Agent running in this terminal (`null`/absent = plain shell), agent-providers.md §5.4. */
  agent?: AgentBinding | null
  role?: AgentRole
  customRoleLabel?: string // For custom roles
  needsAttention?: boolean // Whether this terminal needs user attention (e.g., waiting for input)
  lastActivityAt?: number // Timestamp of last terminal output (for idle detection)
  isIdle?: boolean // Whether idle threshold has been exceeded
  hasAutoResumed?: boolean // Runtime only: the agent was (re)started in this PTY, so no resume overlay
  isFloating?: boolean // Whether this terminal is in a floating window
  isLocked?: boolean // Whether this pane is locked (position/size fixed, excluded from layout reordering)
  teamId?: string // Team this terminal belongs to (for Agent Teams)
  teamMemberId?: string // Team member ID for this terminal
  lastKnownSummary?: string // Last session summary used for dynamic title
  autoCloseOnComplete?: boolean // Auto-close terminal when linked issue moves to qa/done and PTY exits
  linkedIssueId?: string // Issue ID this terminal was launched to work on
  hasExited?: boolean // Whether the PTY process has exited
  scope?: 'session' | 'global' // 'global' = pinned to a global workspace; survives project/session switches
  globalWorkspaceId?: string // If scope === 'global', the workspace id this terminal lives in
}

export interface TerminalInfo {
  id: string
  pid?: number
  cwd: string
  /** Spawn generation; a reused id gets a new, higher generation. */
  generation?: number
  /** True when create_terminal attached to an already-running PTY with this id. */
  reattached?: boolean
}

/** Payload of the `terminal:exit:{id}` event. */
export interface TerminalExitPayload {
  generation: number
  exitCode?: number | null
}

export interface OsInfo {
  /** Rust `std::env::consts::OS`: 'windows' | 'macos' | 'linux' | ... */
  platform: string
  /** Windows build number (e.g. 26200); null elsewhere. */
  buildNumber?: number | null
}

export interface CreateTerminalOptions {
  cwd?: string
  cols?: number
  rows?: number
  id?: string
  /** cmd | powershell | pwsh | bash | zsh | sh, or an absolute shell executable path (default: powershell on Windows, $SHELL on Unix) */
  shell?: string
  initCommands?: string[]  // Commands to run after shell initialization (e.g., vcvarsall.bat)
}

export type LayoutType = '1x1' | '2x1' | '1x2' | '2x2' | '3x2'

export const LAYOUT_CONFIGS: Record<LayoutType, { cols: number; rows: number; max: number }> = {
  '1x1': { cols: 1, rows: 1, max: 1 },
  '2x1': { cols: 2, rows: 1, max: 2 },
  '1x2': { cols: 1, rows: 2, max: 2 },
  '2x2': { cols: 2, rows: 2, max: 4 },
  '3x2': { cols: 3, rows: 2, max: 6 },
}

export interface DefaultWorkspaceConfig {
  layoutPreset: string  // LayoutPresetType: 'grid' | 'columns' | 'rows' | 'mainSidebar' | 'mainBottom' | 'focus'
  toolConfigIds: string[]
  terminalCount: number
}

export interface Project {
  id: string
  name: string
  workingDirectory: string
  isActive: boolean
  defaultWorkspaceConfig?: DefaultWorkspaceConfig | null
  createdAt: number
  updatedAt: number
}

export interface Session {
  id: string
  name: string
  workingDirectory: string
  projectName: string // Extracted folder name from workingDirectory
  projectId: string | null // Reference to parent project
  layout: LayoutType
  layoutTree?: string | null // JSON stringified MosaicNode for flexible layout
  isActive: boolean
  pinned?: boolean
  pinOrder?: number
  pinSection?: ToolbarSection
  createdAt: number
  updatedAt: number
}

export interface SessionTerminal {
  id: string
  title: string
  titleSource?: TitleSource
  originalPrompt: string | null
  workingDirectory: string
  gridPosition: number
  status: string
  bufferContent?: string
  agent?: AgentBinding | null
  role?: AgentRole
  customRoleLabel?: string
  isMinimized?: boolean // Whether this terminal is minimized
  needsAttention?: boolean // Whether this terminal needs user attention
  isFloating?: boolean // Whether this terminal is in a floating window
  isLocked?: boolean // Whether this pane is locked
  teamId?: string // Team this terminal belongs to
  teamMemberId?: string // Team member ID
  createdAt?: number // Original terminal creation time
}

// ==================== Title Generation Types ====================

export type TitleSource = 'default' | 'auto' | 'manual'

/**
 * Shell title settings (Settings -> Integrations -> Auto Titles). Who
 * generates a title is decided in src/lib/titles.ts: plugins contributing
 * `titleGenerators` (e.g. local-titles), then the agent provider's
 * `sessionTitle` hook, then the chat API (`api_model`), then a heuristic.
 */
export interface TitleSettings {
  enabled: boolean
  min_words: number
  max_words: number
  /** Chat-endpoint model for the API fallback ('' = no API titles). */
  api_model: string
  summaryPollIntervalSeconds: number // 15-300, default 60
}

export interface TitleGenerateResult {
  title: string
  used_device: string
}

// Tool configuration (persisted). A tool config points at a plugin
// contribution (tile or toolbar item); see src/plugins/tools.tsx.
export type ToolbarSection = 'left' | 'center' | 'right'
export type ToolOpenMode = 'pane' | 'flyout'
export type ToolPinDisplay = 'icon' | 'icon-and-name' | 'mini'

// ==================== Terminal environments ====================

// Scripts and script groups live in the Scripts plugin (plugins/scripts) now.

export type ScriptPlatform = 'windows' | 'macos' | 'linux' | 'all'
/** Shell name or `'default'`. Environments may carry an absolute shell path instead. */
export type ScriptShell = 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'zsh' | 'sh' | 'default'

// Terminal Environment type (for VS Native Tools, Git Bash, custom shells)
export type TerminalEnvironmentType = 'system-cmd' | 'system-powershell' | 'system-bash' | 'vs-native' | 'custom'
export type VSArchitecture = 'x64' | 'x86' | 'arm64'

// Terminal environment preset (defines shell config, init scripts, env vars).
// App-wide shape of the core `TerminalEnvironment` (see
// lib/environmentUtils `toShellEnvironment`); the core app DB is the source.
export interface TerminalEnvironment {
  id: string
  name: string
  description?: string
  type: TerminalEnvironmentType
  /** What to launch a terminal with: the detected shell path when known, else the shell name. */
  shell: ScriptShell
  shellKind?: import('../generated/bindings').ShellKind
  shellPath?: string

  // For VS Native Tools
  vsVersion?: string        // "2022", "2019"
  vsEdition?: string        // "Community", "Professional", "Enterprise", "BuildTools"
  vsArchitecture?: VSArchitecture
  vcvarsPath?: string       // Path to vcvarsall.bat

  // For custom environments
  initCommands?: string[]   // Commands to run on terminal startup
  env?: Record<string, string>  // Environment variables to set

  isBuiltIn: boolean        // Auto-detected vs user-created
  isAvailable: boolean      // Paths exist and environment is usable
  createdAt: number
  updatedAt: number
}

export interface ToolConfig {
  id: string
  name: string
  /** Plugin that provides the contribution (`core` for the shell's terminals / agents / history). */
  pluginId: string
  /** Tile or toolbar-item id inside the plugin manifest. */
  contributionId: string
  icon?: string
  // Convenience views of `settings.executablePath` / `.args` / `.workingDirectory`
  // (TUI, app launcher, terminal); written back into `settings`.
  executablePath?: string
  args?: string[]
  workingDirectory?: string
  /** Created from the manifest `defaultToolConfig` (cannot be deleted, only hidden). */
  builtIn?: boolean
  settings?: Record<string, unknown>
  order: number
  pinOrder?: number  // Independent order for pinned toolbar position
  pinSection?: ToolbarSection  // Which toolbar section this tool is pinned to
  enabled: boolean
  pinned: boolean  // Quick access - shows as button in toolbar
  quickLaunch: boolean  // Shows in empty tile bubble menu (separate from toolbar pinning)
  openMode: ToolOpenMode  // How pinned tool opens: 'pane' (in layout) or 'flyout' (slides from toolbar)
  pinDisplay: ToolPinDisplay  // How pinned button renders: 'icon' (compact) or 'icon-and-name' (shows label)
  color?: string  // Custom color for the tool icon/name display
  flyoutWidth?: number   // Persisted flyout width in px (null = use type default)
  flyoutHeight?: number  // Persisted flyout height in px (null = use type default)
  createdAt: number
  updatedAt: number
}

// Tool instance (runtime, in layout)
export interface ToolInstance {
  id: string  // layout leaf id `tool:<ulid>` (lib/layoutIds.ts)
  configId: string
  title: string
  status: 'active' | 'closed' | 'error'
  pid?: number  // For TUI tools
  terminalId?: string  // The actual PTY terminal ID for TUI tools
  createdAt: number
  needsAttention?: boolean // Whether this tool needs user attention
  isLocked?: boolean // Whether this pane is locked (position/size fixed, excluded from layout reordering)
  isFloating?: boolean // Whether this tool is in a floating window
  isFlyoutInstance?: boolean // Whether this instance is being used as a flyout (not in layout tree)
  commandLaunched?: boolean // Whether the TUI command has been launched (prevents re-launch on reattach)
  metadata?: Record<string, unknown> // Arbitrary metadata (e.g., filePath for editor panes)
  scope?: 'session' | 'global' // Which store owns this instance ('global' = lives in the global workspace dock)
}

// Global workspaces — first-class tiles inside the project mosaic that
// persist across project switches. Multiple workspaces can exist; each is
// its own module with a sub-mosaic of pinned tools.
import type { MosaicNode } from 'react-mosaic-component'
import { isToolLeaf } from '../lib/layoutIds'

export const PROJECT_MOSAIC_LEAF = '__project__'

export interface GlobalWorkspace {
  id: string                             // raw — tile id is `globalWs:${id}`
  name: string
  enabled: boolean
  minimized: boolean
  layoutTree: MosaicNode<string> | null  // sub-mosaic of tool tile ids
  displayOrder: number
  createdAt: number
  updatedAt: number
}

export interface GlobalWorkspaceFrame {
  frameTree: MosaicNode<string> | null   // top-level mosaic; leaves are __project__ or globalWs:<id>
  globallyEnabled: boolean
}

export function isGlobalWsTile(id: string): boolean {
  return id.startsWith('globalWs:')
}

export function parseGlobalWsTileId(id: string): string | null {
  return isGlobalWsTile(id) ? id.slice('globalWs:'.length) : null
}

export function isProjectMosaicLeaf(id: string): boolean {
  return id === PROJECT_MOSAIC_LEAF
}

export function makeGlobalWsTileId(workspaceId: string): string {
  return `globalWs:${workspaceId}`
}

// Session tool instance (for persistence)
export interface SessionToolInstance {
  id: string
  configId: string
  title: string
  status: string
  terminalId?: string
  isMinimized?: boolean
  needsAttention?: boolean // Whether this tool needs user attention
  isLocked?: boolean // Whether this pane is locked
  isFlyoutInstance?: boolean // Whether this instance is a flyout instance
  commandLaunched?: boolean // Whether the TUI command has been launched
  metadata?: string // JSON-serialized metadata
}

// Helper function: check if a tile ID is a tool (see lib/layoutIds.ts)
export function isTileTool(id: string): boolean {
  return isToolLeaf(id)
}

// Chat types are generated from Rust: see src/lib/core/chat.ts (data-layer.md §7.3).

// ==================== AI Provider Types ====================

// ==================== Context Modules ====================

/**
 * Status of a single QuadFlow context module within a project. A module is
 * "enabled" iff its bundled docs are currently injected into the project's
 * agent context files' managed region.
 */
export interface ContextModuleStatus {
  name: string
  enabled: boolean
}

