import { create } from 'zustand'
import { resolveDefaultWorkingDir } from '../lib/core'
import { TerminalEnvironment, AIModelOption, ToolbarSection, ContextModuleStatus } from '../types'
import { getAgentContext, resetAgentContext, setAgentContextModule, useAgentModelsStore } from '../lib/core/agents'
import { LayoutPresetType, LAYOUT_PRESETS } from '../lib/layoutUtils'
import { detectEnvironments, listEnvironments, saveCustomEnvironments } from '../lib/environmentUtils'
import { applyTheme } from '@quadflow/ui'
import { onDataChanged } from '../lib/core'
import * as appData from '../lib/appData'
import type { AgentApprovalMode, JsonValue } from '../generated/bindings'

// Available mono fonts
export const MONO_FONTS = [
  { name: 'JetBrains Mono', value: 'JetBrains Mono, monospace' },
  { name: 'Fira Code', value: 'Fira Code, monospace' },
  { name: 'Cascadia Code', value: 'Cascadia Code, monospace' },
  { name: 'Source Code Pro', value: 'Source Code Pro, monospace' },
  { name: 'Consolas', value: 'Consolas, monospace' },
  { name: 'Monaco', value: 'Monaco, monospace' },
  { name: 'Menlo', value: 'Menlo, monospace' },
  { name: 'Ubuntu Mono', value: 'Ubuntu Mono, monospace' },
  { name: 'Courier New', value: 'Courier New, monospace' },
] as const

// Cursor styles supported by xterm
export type CursorStyle = 'bar' | 'block' | 'underline'

// Bell mode options
export type BellStyle = 'none' | 'visual' | 'sound' | 'both'

// Terminal settings
export interface TerminalFontSettings {
  fontSize: number
  fontFamily: string
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollbackLines: number
  bellStyle: BellStyle
  copyOnSelect: boolean
  rightClickPaste: boolean
  /** Copy joins lines that were only broken by wrapping (soft wraps and TUI hard wraps). */
  joinWrappedLines: boolean
  useWebGL: boolean
  terminalPadding: number // 0-16 px
  confirmClose: boolean
  flashTaskbarOnAttention: boolean
  streamerMode: boolean
}

// Accent color presets
export const ACCENT_COLORS = {
  purple: { name: 'Purple', value: '#7c3aed', hover: '#8b5cf6' },
  cyan: { name: 'Cyan', value: '#06b6d4', hover: '#22d3ee' },
  green: { name: 'Green', value: '#22c55e', hover: '#4ade80' },
  amber: { name: 'Amber', value: '#f59e0b', hover: '#fbbf24' },
  red: { name: 'Red', value: '#ef4444', hover: '#f87171' },
  pink: { name: 'Pink', value: '#ec4899', hover: '#f472b6' },
  blue: { name: 'Blue', value: '#3b82f6', hover: '#60a5fa' },
  orange: { name: 'Orange', value: '#f97316', hover: '#fb923c' },
} as const

export type AccentColorKey = keyof typeof ACCENT_COLORS

// Glow intensity options
export type GlowIntensity = 'off' | 'subtle' | 'normal' | 'intense'

// Theme settings
export interface ThemeSettings {
  mode: 'dark' | 'light' | 'system'
  accentColor: string
  uiScale: number // 80-120 as percentage
  panelBorderRadius: number // 0-16 px
  panelGap: number // 1-8 px
  glowIntensity: GlowIntensity
  reduceMotion: boolean
  attentionGlowColor: string // Color for attention/needs-attention glow (default orange #f97316)
  idleGlowColor: string // Color for idle terminal glow (default blue #3b82f6)
  idleTimeoutSeconds: number // Seconds before a terminal is considered idle (10-300, default 60)
  idleGlowEnabled: boolean // Whether idle glow is enabled (default true)
}

// Editor settings (placeholder for future)
export interface EditorSettings {
  fontSize: number
  tabSize: number
  wordWrap: boolean
}

// MCP (Model Context Protocol) settings
export interface McpSettings {
  autoEnableOnStartup: boolean
  lastConfiguredPath: string | null
  isConfigured: boolean
}

// Session settings
export interface SessionSettings {
  defaultWorkingDirectory: string
  restoreOnStartup: boolean
  autoSaveEnabled: boolean
  autoSaveIntervalMs: number // milliseconds, 500-10000
}

// File browser display mode
export type FileBrowserMode = 'sidebar' | 'tool'

// Toolbar settings
export interface ToolbarSettings {
  defaultSplitDirection: 'row' | 'column'
  tabTitleMaxLength: number // 15-50 characters
  fileBrowserMode: FileBrowserMode // 'sidebar' = always attached panel, 'tool' = pinnable tool pane
  clickToPromote: boolean // In main+bottom/sidebar layouts, click a pane to swap it to main
}

// Agent settings (namespace `agents`; read by the core launch flow too)
export interface AIAgentSettings {
  startupDelayMs: number // delay before delivering the prompt when a provider has no ready pattern
  autoSubmitPrompt: boolean // press Enter after delivering the prompt (default false)
  autoCloseIssueTerminals: boolean // auto-close issue terminals when done (default true)
  defaultProvider: string | null // provider id used when a launch names none (null = first installed)
}

// Environment settings
export interface EnvironmentSettings {
  terminalEnvironments: TerminalEnvironment[]
  defaultEnvironmentId: string | undefined
  hasAutoDetected: boolean
}

// Layout preset settings
export interface LayoutPresetSettings {
  order: LayoutPresetType[]                           // user-defined cycle/display order
  enabled: Record<LayoutPresetType, boolean>          // which presets are active
  pinned: LayoutPresetType[]                          // presets pinned to toolbar
  pinnedSection: Record<LayoutPresetType, ToolbarSection>  // which toolbar section
  gridConfig: { rows: number; cols: number }          // configurable grid dimensions
}

// A pane definition within the default workspace layout
export interface DefaultWorkspacePane {
  id: string           // placeholder ID used in the saved layout tree (e.g. 'pane-0')
  type: 'agent' | 'terminal' | 'tool' | 'empty'
  toolConfigId?: string // for tool panes — which tool config to open
  isLocked?: boolean    // whether this pane was locked
}

// Default workspace settings (what opens when switching to a project with no saved workspaces)
export interface DefaultWorkspaceSettings {
  layoutTree: string | null  // serialized MosaicNode with placeholder pane IDs
  panes: DefaultWorkspacePane[]
}

/**
 * Per-provider agent defaults, keyed by provider id. Persisted as
 * `agents.<field>.<providerId>` rows; `customModels` / `defaultModel` are read
 * by `agents_models` in the core (agent-providers.md §6.4).
 */
export interface AgentDefaultsSettings {
  customModels: Record<string, AIModelOption[]>
  defaultModel: Record<string, string | null>
  defaultEffort: Record<string, string | null>
  defaultApprovalMode: Record<string, AgentApprovalMode | null>
}

// All app settings
export interface AppSettingsState {
  // Terminal
  terminal: TerminalFontSettings

  // Theme (placeholder)
  theme: ThemeSettings

  // Editor (placeholder)
  editor: EditorSettings

  // MCP settings
  mcp: McpSettings

  // Session settings
  session: SessionSettings

  // AI Agent settings
  aiAgent: AIAgentSettings

  // Environment settings
  environments: EnvironmentSettings

  // Per-provider agent defaults
  agentDefaults: AgentDefaultsSettings

  // Toolbar settings
  toolbar: ToolbarSettings

  // Layout preset settings
  layoutPresets: LayoutPresetSettings

  // Default workspace settings
  defaultWorkspace: DefaultWorkspaceSettings

  // Runtime context-module state for active project (not persisted).
  contextModules: ContextModuleStatus[]

  // UI visibility
  showSettingsModal: boolean
  /** Tab to show when the modal opens next (`plugin:<id>/<pageId>`; `ui.openSettings`). */
  settingsModalTab: string | null
}

interface AppSettingsActions {
  // Modal
  setShowSettingsModal: (show: boolean) => void
  openSettingsModalAt: (tab: string) => void

  // Terminal settings
  setTerminalFontSize: (size: number) => void
  setTerminalFontFamily: (family: string) => void
  setTerminalLineHeight: (height: number) => void
  setTerminalCursorStyle: (style: CursorStyle) => void
  setTerminalCursorBlink: (blink: boolean) => void
  setTerminalScrollbackLines: (lines: number) => void
  setTerminalBellStyle: (style: BellStyle) => void
  setTerminalCopyOnSelect: (enabled: boolean) => void
  setTerminalRightClickPaste: (enabled: boolean) => void
  setTerminalJoinWrappedLines: (enabled: boolean) => void
  setTerminalUseWebGL: (enabled: boolean) => void
  setTerminalPadding: (padding: number) => void
  setConfirmClose: (confirm: boolean) => void
  setFlashTaskbarOnAttention: (flash: boolean) => void
  setStreamerMode: (enabled: boolean) => void

  // Theme settings
  setThemeMode: (mode: 'dark' | 'light' | 'system') => void
  setAccentColor: (color: string) => void
  setUiScale: (scale: number) => void
  setPanelBorderRadius: (radius: number) => void
  setPanelGap: (gap: number) => void
  setGlowIntensity: (intensity: GlowIntensity) => void
  setReduceMotion: (reduce: boolean) => void
  setAttentionGlowColor: (color: string) => void
  setIdleGlowColor: (color: string) => void
  setIdleTimeoutSeconds: (seconds: number) => void
  setIdleGlowEnabled: (enabled: boolean) => void
  applyThemeToDOM: () => void

  // Editor settings (placeholder implementations)
  setEditorFontSize: (size: number) => void
  setEditorTabSize: (size: number) => void
  setEditorWordWrap: (wrap: boolean) => void

  // Batch updates
  updateTerminalSettings: (settings: Partial<TerminalFontSettings>) => void
  updateThemeSettings: (settings: Partial<ThemeSettings>) => void
  updateEditorSettings: (settings: Partial<EditorSettings>) => void

  // Context-module management.
  // Toggles which quadflow-core module docs are injected into the agent context files.
  loadContextModules: (projectDir: string) => Promise<void>
  toggleContextModule: (projectDir: string, module: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
  resetContextModules: (projectDir: string) => Promise<{ success: boolean; error?: string }>

  // Session settings
  setDefaultWorkingDirectory: (dir: string) => void
  setRestoreOnStartup: (enabled: boolean) => void
  setAutoSaveEnabled: (enabled: boolean) => void
  setAutoSaveInterval: (ms: number) => void

  // AI Agent settings
  updateAIAgentSettings: (settings: Partial<AIAgentSettings>) => void

  // Per-provider agent defaults
  addCustomModel: (providerId: string, model: AIModelOption) => void
  removeCustomModel: (providerId: string, modelId: string) => void
  /** Patch a custom model, or add an override entry for a catalog model. */
  updateCustomModel: (providerId: string, modelId: string, patch: Partial<Pick<AIModelOption, 'shortLabel' | 'contextWindow'>>) => void
  setAgentDefault: <K extends 'defaultModel' | 'defaultEffort' | 'defaultApprovalMode'>(field: K, providerId: string, value: AgentDefaultsSettings[K][string]) => void

  // Toolbar settings
  toggleSplitDirection: () => void
  setTabTitleMaxLength: (length: number) => void
  setFileBrowserMode: (mode: FileBrowserMode) => void
  setClickToPromote: (enabled: boolean) => void
  // Layout preset settings
  setLayoutPresetOrder: (order: LayoutPresetType[]) => void
  setLayoutPresetEnabled: (type: LayoutPresetType, enabled: boolean) => void
  toggleLayoutPresetPinned: (type: LayoutPresetType) => void
  setGridConfig: (rows: number, cols: number) => void
  reorderPinnedLayoutPresets: (order: LayoutPresetType[]) => void
  updateLayoutPresetPinSection: (type: LayoutPresetType, section: ToolbarSection) => void
  getEnabledLayoutPresets: () => LayoutPresetType[]
  getHiddenLayoutPresets: () => LayoutPresetType[]
  getPinnedLayoutPresets: () => LayoutPresetType[]

  // Default workspace settings
  updateDefaultWorkspace: (settings: Partial<DefaultWorkspaceSettings>) => void

  // Environment settings
  setTerminalEnvironments: (envs: TerminalEnvironment[]) => void
  setDefaultEnvironmentId: (id: string | undefined) => void
  setHasAutoDetected: (flag: boolean) => void
  runDetectEnvironments: () => Promise<void>

  // Persistence (core settings, data-layer.md §7.2)
  loadSettings: () => Promise<void>
  saveSettings: () => void
  resetToDefaults: () => void
  exportSettings: () => void
  importSettings: (file: File) => Promise<{ success: boolean; error?: string }>
}

type AppSettingsStore = AppSettingsState & AppSettingsActions

const DEFAULT_TERMINAL_SETTINGS: TerminalFontSettings = {
  fontSize: 14,
  fontFamily: 'JetBrains Mono, monospace',
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollbackLines: 10000,
  bellStyle: 'none',
  copyOnSelect: false,
  rightClickPaste: true,
  joinWrappedLines: true,
  useWebGL: true,
  terminalPadding: 4,
  confirmClose: false,
  flashTaskbarOnAttention: true,
  streamerMode: false,
}

const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: 'dark',
  accentColor: '#7c3aed', // vibe-primary purple
  uiScale: 100,
  panelBorderRadius: 8,
  panelGap: 3,
  glowIntensity: 'normal',
  reduceMotion: false,
  attentionGlowColor: '#f97316', // orange
  idleGlowColor: '#3b82f6', // blue
  idleTimeoutSeconds: 60,
  idleGlowEnabled: true,
}

const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
}

const DEFAULT_MCP_SETTINGS: McpSettings = {
  autoEnableOnStartup: false,
  lastConfiguredPath: null,
  isConfigured: false,
}

const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  defaultWorkingDirectory: '',
  restoreOnStartup: true,
  autoSaveEnabled: true,
  autoSaveIntervalMs: 1000,
}

const DEFAULT_AI_AGENT_SETTINGS: AIAgentSettings = {
  startupDelayMs: 6000,
  autoSubmitPrompt: false,
  autoCloseIssueTerminals: true,
  defaultProvider: null,
}

const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  terminalEnvironments: [],
  defaultEnvironmentId: undefined,
  hasAutoDetected: false,
}

const DEFAULT_AGENT_DEFAULTS = (): AgentDefaultsSettings => ({
  customModels: {},
  defaultModel: {},
  defaultEffort: {},
  defaultApprovalMode: {},
})

const DEFAULT_TOOLBAR_SETTINGS: ToolbarSettings = {
  defaultSplitDirection: 'row',
  tabTitleMaxLength: 25,
  fileBrowserMode: 'sidebar',
  clickToPromote: false,
}

const DEFAULT_WORKSPACE_SETTINGS: DefaultWorkspaceSettings = {
  layoutTree: null,
  panes: [],
}

const ALL_PRESET_TYPES: LayoutPresetType[] = LAYOUT_PRESETS.map(p => p.type)

const DEFAULT_LAYOUT_PRESET_SETTINGS: LayoutPresetSettings = {
  order: [...ALL_PRESET_TYPES],
  enabled: Object.fromEntries(ALL_PRESET_TYPES.map(t => [t, true])) as Record<LayoutPresetType, boolean>,
  pinned: [],
  pinnedSection: Object.fromEntries(ALL_PRESET_TYPES.map(t => [t, 'right' as ToolbarSection])) as Record<LayoutPresetType, ToolbarSection>,
  gridConfig: { rows: 0, cols: 0 },  // 0,0 = auto (use default balanced layout)
}

/** Catalog models of a provider as loaded from the core (for override entries). */
function coreModels(providerId: string): { id: string; label: string }[] {
  return (useAgentModelsStore.getState().models[providerId] ?? []).filter((m) => m.source === 'catalog')
}

// ---------------------------------------------------------------------------
// Persistence: core settings rows (namespace, key) → JSON value. One row per
// field; sections that share a namespace use a key prefix. No localStorage.
// ---------------------------------------------------------------------------

type PersistedSection =
  | 'terminal' | 'theme' | 'editor' | 'session' | 'aiAgent' | 'agentDefaults'
  | 'environments' | 'toolbar' | 'layoutPresets' | 'defaultWorkspace'

/** `agents.<field>.<providerId>` rows of the `agentDefaults` section. */
const AGENT_DEFAULT_KEY = /^(customModels|defaultModel|defaultEffort|defaultApprovalMode)\.([a-z][a-z0-9-]{1,31})$/

const SECTIONS: { section: PersistedSection; ns: string; prefix: string; keys?: Record<string, string>; perProvider?: boolean; defaults: () => Record<string, unknown> }[] = [
  { section: 'terminal', ns: 'terminal', prefix: '', defaults: () => ({ ...DEFAULT_TERMINAL_SETTINGS }) },
  { section: 'environments', ns: 'terminal', prefix: 'environments.', defaults: () => ({ ...DEFAULT_ENVIRONMENT_SETTINGS }) },
  { section: 'theme', ns: 'appearance', prefix: '', defaults: () => ({ ...DEFAULT_THEME_SETTINGS }) },
  { section: 'editor', ns: 'editor', prefix: '', defaults: () => ({ ...DEFAULT_EDITOR_SETTINGS }) },
  { section: 'aiAgent', ns: 'agents', prefix: '', defaults: () => ({ ...DEFAULT_AI_AGENT_SETTINGS }) },
  { section: 'agentDefaults', ns: 'agents', prefix: '', perProvider: true, defaults: () => ({ ...DEFAULT_AGENT_DEFAULTS() }) },
  { section: 'session', ns: 'shell', prefix: 'session.', defaults: () => ({ ...DEFAULT_SESSION_SETTINGS }) },
  { section: 'toolbar', ns: 'shell', prefix: 'toolbar.', defaults: () => ({ ...DEFAULT_TOOLBAR_SETTINGS }) },
  { section: 'layoutPresets', ns: 'shell', prefix: 'layoutPresets.', defaults: () => ({ ...DEFAULT_LAYOUT_PRESET_SETTINGS }) },
  { section: 'defaultWorkspace', ns: 'shell', prefix: 'defaultWorkspace.', defaults: () => ({ ...DEFAULT_WORKSPACE_SETTINGS }) },
]
const NAMESPACES = [...new Set(SECTIONS.map((x) => x.ns))]
const MAPPED_KEYS = new Set(SECTIONS.flatMap((x) => (x.keys ? Object.values(x.keys) : [])))

/**
 * Fields of a section that are not settings rows: the terminal environment list
 * lives in the core's environments domain (DL-6, `environments_*`); only the
 * default environment id stays in `terminal/environments.*`.
 */
function isUnpersistedField(section: PersistedSection, key: string): boolean {
  return section === 'environments' && key === 'terminalEnvironments'
}

/** Whether a settings row belongs to this store (other `shell` keys don't). */
function isTrackedKey(ns: string, key: string): boolean {
  if (MAPPED_KEYS.has(key)) return true
  if (ns === 'agents' && AGENT_DEFAULT_KEY.test(key)) return true
  return SECTIONS.some((s) => s.ns === ns && !s.keys && !s.perProvider && (s.prefix ? key.startsWith(s.prefix) : !key.includes('.')))
}

/** Last value written/read per `ns\u0000key` (JSON), so saves only send changes. */
const persisted = new Map<string, string>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let savesInFlight = 0

function entriesOf(state: AppSettingsState): Map<string, Record<string, JsonValue>> {
  const out = new Map<string, Record<string, JsonValue>>()
  const put = (ns: string, key: string, v: unknown) => {
    if (!out.has(ns)) out.set(ns, {})
    out.get(ns)![key] = (v === undefined ? null : v) as JsonValue
  }
  for (const sec of SECTIONS) {
    const value = state[sec.section] as unknown as Record<string, unknown>
    if (sec.perProvider) {
      for (const [field, byProvider] of Object.entries(value)) {
        for (const [pid, v] of Object.entries((byProvider ?? {}) as Record<string, unknown>)) put(sec.ns, `${field}.${pid}`, v)
      }
      continue
    }
    for (const [k, v] of Object.entries(value)) {
      if (isUnpersistedField(sec.section, k)) continue
      if (sec.keys) {
        if (sec.keys[k]) put(sec.ns, sec.keys[k], v)
        continue
      }
      put(sec.ns, sec.prefix + k, v)
    }
  }
  return out
}

function pickSection(rows: Record<string, unknown>, prefix: string, keys?: Record<string, string>, perProvider?: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (perProvider) {
    const d = DEFAULT_AGENT_DEFAULTS() as unknown as Record<string, Record<string, unknown>>
    for (const [k, v] of Object.entries(rows)) {
      const m = AGENT_DEFAULT_KEY.exec(k)
      if (m && v !== null && v !== undefined) d[m[1]][m[2]] = v
    }
    return d
  }
  if (keys) {
    for (const [field, key] of Object.entries(keys)) if (rows[key] !== undefined) out[field] = rows[key]
    return out
  }
  for (const [k, v] of Object.entries(rows)) {
    if (prefix ? k.startsWith(prefix) : !k.includes('.')) out[prefix ? k.slice(prefix.length) : k] = v
  }
  return out
}

async function readAll(): Promise<Partial<AppSettingsState>> {
  const byNs = new Map<string, Record<string, unknown>>()
  await Promise.all(NAMESPACES.map(async (ns) => { byNs.set(ns, await appData.getSettings(ns)) }))
  for (const [ns, rows] of byNs) for (const [k, v] of Object.entries(rows)) persisted.set(`${ns}\u0000${k}`, JSON.stringify(v))
  const next: Record<string, unknown> = {}
  for (const sec of SECTIONS) {
    const rows = pickSection(byNs.get(sec.ns) ?? {}, sec.prefix, sec.keys, sec.perProvider)
    for (const k of Object.keys(rows)) if (isUnpersistedField(sec.section, k)) delete rows[k]
    next[sec.section] = { ...sec.defaults(), ...rows }
  }
  // Keep the environment list already loaded from the core.
  ;(next.environments as EnvironmentSettings).terminalEnvironments =
    useAppSettingsStore.getState().environments.terminalEnvironments
  return next as Partial<AppSettingsState>
}

async function writeChanges(state: AppSettingsState): Promise<void> {
  for (const [ns, entries] of entriesOf(state)) {
    const changed: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(entries)) {
      const id = `${ns}\u0000${k}`
      const json = JSON.stringify(v)
      const prev = persisted.get(id)
      if (v === null ? prev !== undefined : prev !== json) changed[k] = v
    }
    if (Object.keys(changed).length === 0) continue
    await appData.setSettings(ns, changed)
    for (const [k, v] of Object.entries(changed)) {
      const id = `${ns}\u0000${k}`
      if (v === null) persisted.delete(id)
      else persisted.set(id, JSON.stringify(v))
    }
  }
}

export const useAppSettingsStore = create<AppSettingsStore>((set, get) => ({
  // Initial state
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  theme: { ...DEFAULT_THEME_SETTINGS },
  editor: { ...DEFAULT_EDITOR_SETTINGS },
  mcp: { ...DEFAULT_MCP_SETTINGS },
  session: { ...DEFAULT_SESSION_SETTINGS },
  aiAgent: { ...DEFAULT_AI_AGENT_SETTINGS },
  environments: { ...DEFAULT_ENVIRONMENT_SETTINGS },
  agentDefaults: DEFAULT_AGENT_DEFAULTS(),
  toolbar: { ...DEFAULT_TOOLBAR_SETTINGS },
  layoutPresets: { ...DEFAULT_LAYOUT_PRESET_SETTINGS },
  defaultWorkspace: { ...DEFAULT_WORKSPACE_SETTINGS },
  contextModules: [],
  showSettingsModal: false,
  settingsModalTab: null,

  // Modal
  setShowSettingsModal: (show) => set({ showSettingsModal: show }),
  openSettingsModalAt: (tab) => set({ showSettingsModal: true, settingsModalTab: tab }),

  // Terminal settings
  setTerminalFontSize: (size) => {
    set((state) => ({
      terminal: { ...state.terminal, fontSize: Math.max(8, Math.min(32, size)) }
    }))
    get().saveSettings()
  },

  setTerminalFontFamily: (family) => {
    set((state) => ({
      terminal: { ...state.terminal, fontFamily: family }
    }))
    get().saveSettings()
  },

  setTerminalLineHeight: (height) => {
    set((state) => ({
      terminal: { ...state.terminal, lineHeight: Math.max(1, Math.min(2, height)) }
    }))
    get().saveSettings()
  },

  setTerminalCursorStyle: (style) => {
    set((state) => ({
      terminal: { ...state.terminal, cursorStyle: style }
    }))
    get().saveSettings()
  },

  setTerminalCursorBlink: (blink) => {
    set((state) => ({
      terminal: { ...state.terminal, cursorBlink: blink }
    }))
    get().saveSettings()
  },

  setTerminalScrollbackLines: (lines) => {
    set((state) => ({
      terminal: { ...state.terminal, scrollbackLines: Math.max(1000, Math.min(100000, lines)) }
    }))
    get().saveSettings()
  },

  setTerminalBellStyle: (style) => {
    set((state) => ({
      terminal: { ...state.terminal, bellStyle: style }
    }))
    get().saveSettings()
  },

  setTerminalCopyOnSelect: (enabled) => {
    set((state) => ({
      terminal: { ...state.terminal, copyOnSelect: enabled }
    }))
    get().saveSettings()
  },

  setTerminalRightClickPaste: (enabled) => {
    set((state) => ({
      terminal: { ...state.terminal, rightClickPaste: enabled }
    }))
    get().saveSettings()
  },

  setTerminalJoinWrappedLines: (enabled) => {
    set((state) => ({
      terminal: { ...state.terminal, joinWrappedLines: enabled }
    }))
    get().saveSettings()
  },

  setTerminalUseWebGL: (enabled) => {
    set((state) => ({
      terminal: { ...state.terminal, useWebGL: enabled }
    }))
    get().saveSettings()
  },

  setTerminalPadding: (padding) => {
    set((state) => ({
      terminal: { ...state.terminal, terminalPadding: Math.max(0, Math.min(16, padding)) }
    }))
    get().saveSettings()
  },

  setConfirmClose: (confirm) => {
    set((state) => ({
      terminal: { ...state.terminal, confirmClose: confirm }
    }))
    get().saveSettings()
  },

  setFlashTaskbarOnAttention: (flash) => {
    set((state) => ({
      terminal: { ...state.terminal, flashTaskbarOnAttention: flash }
    }))
    get().saveSettings()
  },

  setStreamerMode: (enabled) => {
    set((state) => ({
      terminal: { ...state.terminal, streamerMode: enabled }
    }))
    get().saveSettings()
  },

  // Theme settings
  setThemeMode: (mode) => {
    set((state) => ({
      theme: { ...state.theme, mode }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setAccentColor: (color) => {
    set((state) => ({
      theme: { ...state.theme, accentColor: color }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setUiScale: (scale) => {
    set((state) => ({
      theme: { ...state.theme, uiScale: Math.max(80, Math.min(120, scale)) }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setPanelBorderRadius: (radius) => {
    set((state) => ({
      theme: { ...state.theme, panelBorderRadius: Math.max(0, Math.min(16, radius)) }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setPanelGap: (gap) => {
    set((state) => ({
      theme: { ...state.theme, panelGap: Math.max(0, Math.min(8, gap)) }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setGlowIntensity: (intensity) => {
    set((state) => ({
      theme: { ...state.theme, glowIntensity: intensity }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setReduceMotion: (reduce) => {
    set((state) => ({
      theme: { ...state.theme, reduceMotion: reduce }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setAttentionGlowColor: (color) => {
    set((state) => ({
      theme: { ...state.theme, attentionGlowColor: color }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setIdleGlowColor: (color) => {
    set((state) => ({
      theme: { ...state.theme, idleGlowColor: color }
    }))
    get().saveSettings()
    get().applyThemeToDOM()
  },

  setIdleTimeoutSeconds: (seconds) => {
    set((state) => ({
      theme: { ...state.theme, idleTimeoutSeconds: Math.max(10, Math.min(300, seconds)) }
    }))
    get().saveSettings()
  },

  setIdleGlowEnabled: (enabled) => {
    set((state) => ({
      theme: { ...state.theme, idleGlowEnabled: enabled }
    }))
    get().saveSettings()
  },

  applyThemeToDOM: () => {
    const { theme } = get()
    const root = document.documentElement

    // Marker class kept for the bg-vibe-primary hover rule in index.css
    root.classList.add('use-accent')

    // Accent variables (used by .accent-* helpers and inline styles)
    root.style.setProperty('--accent-color', theme.accentColor)

    // Find the hover variant from ACCENT_COLORS or lighten the color
    const accentEntry = Object.values(ACCENT_COLORS).find(c => c.value === theme.accentColor)
    const hoverColor = accentEntry?.hover || theme.accentColor
    root.style.setProperty('--accent-color-hover', hoverColor)

    // @quadflow/ui theme: data-theme (dark/light/system) + --qf-* tokens.
    // The default purple accent is left to each theme's own --qf-primary
    // (tuned per theme); any other accent overrides it in both themes.
    applyTheme({
      mode: theme.mode,
      accent: theme.accentColor === ACCENT_COLORS.purple.value ? null : { primary: theme.accentColor, hover: hoverColor },
      vars: {
        'attention-glow': theme.attentionGlowColor,
        'idle-glow': theme.idleGlowColor,
        'radius-panel': `${theme.panelBorderRadius}px`,
        'gap-panel': `${theme.panelGap}px`,
        'ui-scale': `${theme.uiScale / 100}`,
      },
    })

    // Apply UI scale
    root.style.setProperty('--ui-scale', `${theme.uiScale / 100}`)
    root.style.fontSize = `${theme.uiScale}%`

    // Apply panel border radius
    root.style.setProperty('--panel-radius', `${theme.panelBorderRadius}px`)

    // Apply panel gap
    root.style.setProperty('--panel-gap', `${theme.panelGap}px`)

    // Apply glow intensity via data attribute
    root.dataset.glow = theme.glowIntensity

    // Apply glow colors
    root.style.setProperty('--attention-glow-color', theme.attentionGlowColor)
    root.style.setProperty('--idle-glow-color', theme.idleGlowColor)

    // Apply reduce motion
    if (theme.reduceMotion) {
      root.classList.add('reduce-motion')
    } else {
      root.classList.remove('reduce-motion')
    }
  },

  // Editor settings
  setEditorFontSize: (size) => {
    set((state) => ({
      editor: { ...state.editor, fontSize: Math.max(8, Math.min(32, size)) }
    }))
    get().saveSettings()
  },

  setEditorTabSize: (size) => {
    set((state) => ({
      editor: { ...state.editor, tabSize: Math.max(1, Math.min(8, size)) }
    }))
    get().saveSettings()
  },

  setEditorWordWrap: (wrap) => {
    set((state) => ({
      editor: { ...state.editor, wordWrap: wrap }
    }))
    get().saveSettings()
  },

  // Batch updates
  updateTerminalSettings: (settings) => {
    set((state) => ({
      terminal: { ...state.terminal, ...settings }
    }))
    get().saveSettings()
  },

  updateThemeSettings: (settings) => {
    set((state) => ({
      theme: { ...state.theme, ...settings }
    }))
    get().saveSettings()
  get().applyThemeToDOM()
  },

  updateEditorSettings: (settings) => {
    set((state) => ({
      editor: { ...state.editor, ...settings }
    }))
    get().saveSettings()
  },

  loadContextModules: async (projectDir: string) => {
    try {
      const ctx = await getAgentContext(projectDir)
      set({
        contextModules: ctx.modules
          .filter((m) => !m.module.implicit)
          .map((m) => ({ name: m.module.id, enabled: m.enabled })),
      })
    } catch (error) {
      console.error('[Context Modules] Failed to list:', error)
      set({ contextModules: [] })
    }
  },

  toggleContextModule: async (projectDir, module, enabled) => {
    try {
      await setAgentContextModule(projectDir, module, enabled)
      // Refresh state so the UI reflects the new enabled-set.
      await get().loadContextModules(projectDir)
      return { success: true }
    } catch (error) {
      console.error('[Context Modules] Toggle failed:', error)
      return { success: false, error: String(error) }
    }
  },

  resetContextModules: async (projectDir) => {
    try {
      await resetAgentContext(projectDir)
      await get().loadContextModules(projectDir)
      return { success: true }
    } catch (error) {
      console.error('[Context Modules] Reset failed:', error)
      return { success: false, error: String(error) }
    }
  },

  // Session settings
  setDefaultWorkingDirectory: (dir) => {
    set((state) => ({
      session: { ...state.session, defaultWorkingDirectory: dir }
    }))
    get().saveSettings()
  },

  setRestoreOnStartup: (enabled) => {
    set((state) => ({
      session: { ...state.session, restoreOnStartup: enabled }
    }))
    get().saveSettings()
  },

  setAutoSaveEnabled: (enabled) => {
    set((state) => ({
      session: { ...state.session, autoSaveEnabled: enabled }
    }))
    get().saveSettings()
  },

  setAutoSaveInterval: (ms) => {
    set((state) => ({
      session: { ...state.session, autoSaveIntervalMs: Math.max(500, Math.min(10000, ms)) }
    }))
    get().saveSettings()
  },

  // AI Agent settings
  updateAIAgentSettings: (settings) => {
    set((state) => ({
      aiAgent: { ...state.aiAgent, ...settings }
    }))
    get().saveSettings()
  },

  // Per-provider agent defaults
  addCustomModel: (providerId, model) => {
    set((state) => {
      const list = state.agentDefaults.customModels[providerId] ?? []
      if (list.some(m => m.id === model.id)) return state
      const entry: AIModelOption = { id: model.id, label: model.label }
      if (model.shortLabel !== undefined) entry.shortLabel = model.shortLabel
      if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
      const d = state.agentDefaults
      return { agentDefaults: { ...d, customModels: { ...d.customModels, [providerId]: [...list, entry] } } }
    })
    get().saveSettings()
  },

  removeCustomModel: (providerId, modelId) => {
    set((state) => {
      const d = state.agentDefaults
      const list = (d.customModels[providerId] ?? []).filter(m => m.id !== modelId)
      const def = d.defaultModel[providerId] === modelId ? null : d.defaultModel[providerId] ?? null
      return {
        agentDefaults: {
          ...d,
          customModels: { ...d.customModels, [providerId]: list },
          defaultModel: { ...d.defaultModel, [providerId]: def },
        },
      }
    })
    get().saveSettings()
  },

  updateCustomModel: (providerId, modelId, patch) => {
    set((state) => {
      const d = state.agentDefaults
      const list = d.customModels[providerId] ?? []
      let next: AIModelOption[]
      if (list.some(m => m.id === modelId)) {
        next = list.map(m => (m.id === modelId ? { ...m, ...patch } : m))
      } else {
        const catalog = coreModels(providerId).find(b => b.id === modelId)
        if (!catalog) return state
        next = [...list, { id: modelId, label: catalog.label, ...patch }]
      }
      return { agentDefaults: { ...d, customModels: { ...d.customModels, [providerId]: next } } }
    })
    get().saveSettings()
  },

  setAgentDefault: (field, providerId, value) => {
    set((state) => {
      const d = state.agentDefaults
      return { agentDefaults: { ...d, [field]: { ...d[field], [providerId]: value } } }
    })
    get().saveSettings()
  },


  // Toolbar settings
  toggleSplitDirection: () => {
    set((state) => ({
      toolbar: {
        ...state.toolbar,
        defaultSplitDirection: state.toolbar.defaultSplitDirection === 'row' ? 'column' : 'row',
      }
    }))
    get().saveSettings()
  },

  setTabTitleMaxLength: (length) => {
    set((state) => ({
      toolbar: { ...state.toolbar, tabTitleMaxLength: Math.max(15, Math.min(50, length)) }
    }))
    get().saveSettings()
  },

  setFileBrowserMode: (mode) => {
    set((state) => ({
      toolbar: { ...state.toolbar, fileBrowserMode: mode }
    }))
    get().saveSettings()
  },

  setClickToPromote: (enabled) => {
    set((state) => ({
      toolbar: { ...state.toolbar, clickToPromote: enabled }
    }))
    get().saveSettings()
  },

  // Layout preset settings
  setLayoutPresetOrder: (order) => {
    set((state) => ({
      layoutPresets: { ...state.layoutPresets, order }
    }))
    get().saveSettings()
  },

  setLayoutPresetEnabled: (type, enabled) => {
    set((state) => {
      const newEnabled = { ...state.layoutPresets.enabled, [type]: enabled }
      // Guard: at least 1 preset must remain enabled
      const enabledCount = Object.values(newEnabled).filter(Boolean).length
      if (enabledCount === 0) return state
      return {
        layoutPresets: { ...state.layoutPresets, enabled: newEnabled }
      }
    })
    get().saveSettings()
  },

  toggleLayoutPresetPinned: (type) => {
    set((state) => {
      const pinned = state.layoutPresets.pinned.includes(type)
        ? state.layoutPresets.pinned.filter(t => t !== type)
        : [...state.layoutPresets.pinned, type]
      return {
        layoutPresets: { ...state.layoutPresets, pinned }
      }
    })
    get().saveSettings()
  },

  setGridConfig: (rows, cols) => {
    set((state) => ({
      layoutPresets: {
        ...state.layoutPresets,
        gridConfig: { rows: Math.max(0, Math.min(6, rows)), cols: Math.max(0, Math.min(6, cols)) },
      }
    }))
    get().saveSettings()
  },

  reorderPinnedLayoutPresets: (order) => {
    set((state) => ({
      layoutPresets: { ...state.layoutPresets, pinned: order }
    }))
    get().saveSettings()
  },

  updateLayoutPresetPinSection: (type, section) => {
    set((state) => ({
      layoutPresets: {
        ...state.layoutPresets,
        pinnedSection: { ...state.layoutPresets.pinnedSection, [type]: section },
      }
    }))
    get().saveSettings()
  },

  getEnabledLayoutPresets: () => {
    const { layoutPresets } = get()
    return layoutPresets.order.filter(t => layoutPresets.enabled[t])
  },

  getHiddenLayoutPresets: () => {
    const { layoutPresets } = get()
    return layoutPresets.order.filter(t => !layoutPresets.enabled[t])
  },

  getPinnedLayoutPresets: () => {
    return get().layoutPresets.pinned
  },

  // Default workspace settings
  updateDefaultWorkspace: (settings) => {
    set((state) => ({
      defaultWorkspace: { ...state.defaultWorkspace, ...settings }
    }))
    get().saveSettings()
  },

  // Environment settings
  setTerminalEnvironments: (envs) => {
    const prev = get().environments.terminalEnvironments
    set((state) => ({
      environments: { ...state.environments, terminalEnvironments: envs }
    }))
    get().saveSettings()
    // Environments live in the core app DB (DL-6): persist custom ones there.
    saveCustomEnvironments(prev, envs)
      .then((list) => set((state) => ({ environments: { ...state.environments, terminalEnvironments: list } })))
      .catch((e) => console.error('[environments] save failed:', e))
  },

  setDefaultEnvironmentId: (id) => {
    set((state) => ({
      environments: { ...state.environments, defaultEnvironmentId: id }
    }))
    get().saveSettings()
  },

  setHasAutoDetected: (flag) => {
    set((state) => ({
      environments: { ...state.environments, hasAutoDetected: flag }
    }))
    get().saveSettings()
  },

  runDetectEnvironments: async () => {
    const merged = await detectEnvironments()
    set((state) => ({
      environments: { ...state.environments, terminalEnvironments: merged }
    }))
    get().saveSettings()
  },

  // Persistence
  loadSettings: async () => {
    try {
      const next = await readAll()
      set(next)
      get().applyThemeToDOM()
    } catch (error) {
      console.error('Failed to load app settings:', error)
    }
  },

  // Debounced (coalesces slider drags); writes only changed keys, one
  // transaction per namespace.
  saveSettings: () => {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      savesInFlight++
      const run = () => writeChanges(get())
      const p = saveChain.then(run, run)
      saveChain = p
        .catch((error) => console.error('Failed to save app settings:', error))
        .finally(() => { savesInFlight-- })
    }, 100)
  },

  resetToDefaults: () => {
    set({
      terminal: { ...DEFAULT_TERMINAL_SETTINGS },
      theme: { ...DEFAULT_THEME_SETTINGS },
      editor: { ...DEFAULT_EDITOR_SETTINGS },
      session: { ...DEFAULT_SESSION_SETTINGS },
      aiAgent: { ...DEFAULT_AI_AGENT_SETTINGS },
      environments: { ...DEFAULT_ENVIRONMENT_SETTINGS },
      agentDefaults: DEFAULT_AGENT_DEFAULTS(),
      toolbar: { ...DEFAULT_TOOLBAR_SETTINGS },
      layoutPresets: { ...DEFAULT_LAYOUT_PRESET_SETTINGS },
      defaultWorkspace: { ...DEFAULT_WORKSPACE_SETTINGS },
    })
    get().saveSettings()
    get().applyThemeToDOM()
  },

  exportSettings: () => {
    const state = get()
    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        terminal: state.terminal,
        theme: state.theme,
        editor: state.editor,
        mcp: state.mcp,
        session: state.session,
        aiAgent: state.aiAgent,
        environments: state.environments,
        agentDefaults: state.agentDefaults,
        toolbar: state.toolbar,
        layoutPresets: state.layoutPresets,
        defaultWorkspace: state.defaultWorkspace,
      }
    }

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `quadflow-settings-${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  },

  importSettings: async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // Validate the import data structure
      if (!data.settings) {
        return { success: false, error: 'Invalid settings file format' }
      }

      // Merge imported settings with defaults (to handle missing fields)
      set({
        terminal: { ...DEFAULT_TERMINAL_SETTINGS, ...data.settings.terminal },
        theme: { ...DEFAULT_THEME_SETTINGS, ...data.settings.theme },
        editor: { ...DEFAULT_EDITOR_SETTINGS, ...data.settings.editor },
        mcp: { ...DEFAULT_MCP_SETTINGS, ...data.settings.mcp },
        session: { ...DEFAULT_SESSION_SETTINGS, ...data.settings.session },
        aiAgent: { ...DEFAULT_AI_AGENT_SETTINGS, ...data.settings.aiAgent },
        environments: { ...DEFAULT_ENVIRONMENT_SETTINGS, ...data.settings.environments },
        agentDefaults: { ...DEFAULT_AGENT_DEFAULTS(), ...data.settings.agentDefaults },
        toolbar: { ...DEFAULT_TOOLBAR_SETTINGS, ...data.settings.toolbar },
        layoutPresets: { ...DEFAULT_LAYOUT_PRESET_SETTINGS, ...data.settings.layoutPresets },
        defaultWorkspace: { ...DEFAULT_WORKSPACE_SETTINGS, ...data.settings.defaultWorkspace },
      })

      get().saveSettings()
      get().applyThemeToDOM()

      return { success: true }
    } catch (error) {
      console.error('Failed to import settings:', error)
      return { success: false, error: 'Failed to parse settings file' }
    }
  },
}))

/**
 * Resolves once persisted settings are loaded from the core (or failed to).
 * Entry points await it before rendering so the first frame uses real settings.
 */
export const appSettingsReady: Promise<void> =
  typeof window === 'undefined'
    ? Promise.resolve()
    : (async () => {
        const store = useAppSettingsStore.getState()
        await store.loadSettings()
        // Apply theme after a small delay to ensure DOM is ready
        setTimeout(() => useAppSettingsStore.getState().applyThemeToDOM(), 0)
        // Fix empty default working directory. The core decides the default
        // (`QUADFLOW_PROJECT_DIR`, or a scratch dir in the dev profile); only
        // the release profile falls back to the user's home folder.
        const currentDir = useAppSettingsStore.getState().session.defaultWorkingDirectory
        if (!currentDir) {
          resolveDefaultWorkingDir().then((dir) => {
            if (dir) useAppSettingsStore.getState().setDefaultWorkingDirectory(dir)
          }).catch(() => {})
        }
        // Environments come from the core app DB; detect on every start so
        // availability (and detected paths) stay current on this machine.
        useAppSettingsStore.getState().runDetectEnvironments().then(() => {
          useAppSettingsStore.getState().setHasAutoDetected(true)
        }).catch((e) => console.error('[environments] detect failed:', e))
        // Another window (or the CLI) changed settings: reload unless we are
        // about to write our own changes.
        onDataChanged({ domain: 'settings' }, (e) => {
          const touched = e.ids.length === 0 || e.ids.some((id) => {
            const slash = id.indexOf('/')
            return isTrackedKey(id.slice(0, slash), id.slice(slash + 1))
          })
          if (!touched || saveTimer !== null || savesInFlight > 0) return
          readAll().then((next) => {
            if (saveTimer !== null || savesInFlight > 0) return
            useAppSettingsStore.setState(next)
            useAppSettingsStore.getState().applyThemeToDOM()
          }).catch(() => {})
        })
        // Environments edited elsewhere (CLI `scripts env-*`, another window).
        onDataChanged({ domain: 'environments' }, () => {
          listEnvironments().then((list) => useAppSettingsStore.setState((state) => ({
            environments: { ...state.environments, terminalEnvironments: list },
          }))).catch(() => {})
        })
      })()
