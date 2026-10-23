import { useState, useEffect, useCallback } from 'react'
import { shortcut } from '../../lib/platformKeys'
import { useAppSettingsStore, ACCENT_COLORS, MONO_FONTS, CursorStyle, BellStyle, GlowIntensity } from '../../stores/appSettingsStore'
import { TerminalEnvironment, TerminalEnvironmentType, ScriptShell } from '../../types'
import { getEnvironmentIcon } from '../../lib/environmentUtils'
import { useTitleSettingsStore } from '../../stores/titleSettingsStore'
import { useAgentModels } from '../../hooks/useAIModels'
import { AIModelOption, TitleSettings } from '../../types'
import { listTitleGenerators, type TitleGeneratorInfo } from '../../lib/titles'
import type { AgentApprovalMode, AgentProviderInfo } from '../../generated/bindings'
import { APPROVAL_MODE_INFO, SYSTEM_DEFAULT_MODEL_ID, providerColor, useAgentProviders, useAgentProvidersStore } from '../../agents/providers'
import { cliInstallApi, CliInstallStatus } from '../../lib/tauri-api'
import { chatCore, type ChatEndpointInfo } from '../../lib/core/chat'
import { useOverlayRegistration } from '../../stores/overlayStore'
import PluginsSettingsPage from './plugins/PluginsSettingsPage'
import PluginSettingsPageHost from './plugins/PluginSettingsPageHost'
import PluginIcon from '../../plugins/PluginIcon'
import { ensurePluginRegistry, usePluginRegistry } from '../../plugins/registry'
import { Icon } from '@quadflow/ui'
import { useImportV1Store } from '../../onboarding/importV1Store'

/** Built-in tabs, or `plugin:<pluginId>/<pageId>` for a plugin's settings page. */
type SettingsTab = 'general' | 'terminal' | 'ai-agents' | 'integrations' | 'plugins' | 'advanced' | `plugin:${string}`

export default function AppSettingsModal() {
  const {
    showSettingsModal,
    setShowSettingsModal,
    terminal,
    theme,
    session,
    setTerminalFontSize,
    setTerminalFontFamily,
    setTerminalLineHeight,
    setTerminalCursorStyle,
    setTerminalCursorBlink,
    setTerminalScrollbackLines,
    setTerminalBellStyle,
    setTerminalCopyOnSelect,
    setTerminalRightClickPaste,
    setTerminalUseWebGL,
    setTerminalPadding,
    setConfirmClose,
    setFlashTaskbarOnAttention,
    setStreamerMode,
    toolbar,
    setTabTitleMaxLength,
    setClickToPromote,
    setAccentColor,
    setUiScale,
    setPanelBorderRadius,
    setPanelGap,
    setGlowIntensity,
    setReduceMotion,
    setAttentionGlowColor,
    setIdleGlowColor,
    setIdleTimeoutSeconds,
    setIdleGlowEnabled,
    resetToDefaults,
    exportSettings,
    importSettings,
    setRestoreOnStartup,
    setAutoSaveEnabled,
    setAutoSaveInterval,
    aiAgent,
    updateAIAgentSettings,
  } = useAppSettingsStore()
  const {
    settings: titleSettings,
    setEnabled: setTitleEnabled,
    updateSettings: updateTitleSettings,
  } = useTitleSettingsStore()

  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  useOverlayRegistration('app-settings-modal', showSettingsModal)
  // Settings pages contributed by active plugins (`contributes.settingsPages`).
  const pluginPages = usePluginRegistry((s) => s.contributions?.settingsPages) ?? []
  useEffect(() => {
    if (showSettingsModal) void ensurePluginRegistry()
  }, [showSettingsModal])
  // Deep links: `ui.openSettings(pageId)` (plugin API 1.4), onboarding → Plugins.
  const requestedTab = useAppSettingsStore((s) => s.settingsModalTab)
  useEffect(() => {
    if (!showSettingsModal || !requestedTab) return
    setActiveTab(requestedTab as SettingsTab)
    useAppSettingsStore.setState({ settingsModalTab: null })
  }, [showSettingsModal, requestedTab])
  // Escape closes the modal, unless a nested dialog/menu or an editing field handled it first.
  useEffect(() => {
    if (!showSettingsModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-settings-nested-dialog]')) return
      setShowSettingsModal(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettingsModal, setShowSettingsModal])

  if (!showSettingsModal) return null

  const pluginTabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = pluginPages.map((p) => ({
    id: `plugin:${p.pluginId}/${p.contribution.id}`,
    label: p.contribution.title,
    icon: <PluginIcon pluginId={p.pluginId} size={16} />,
  }))
  const activePluginPage = activeTab.startsWith('plugin:')
    ? pluginPages.find((p) => `plugin:${p.pluginId}/${p.contribution.id}` === activeTab)
    : undefined

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'general',
      label: 'General',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
        </svg>
      ),
    },
    {
      id: 'terminal',
      label: 'Terminal',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      id: 'ai-agents',
      label: 'AI Agents',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      ),
    },
    {
      id: 'integrations',
      label: 'Integrations',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      id: 'plugins',
      label: 'Plugins',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
        </svg>
      ),
    },
    {
      id: 'advanced',
      label: 'Advanced',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-vibe-surface border border-vibe-border rounded-lg w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-vibe-border bg-vibe-surface">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <h2 className="text-lg font-semibold text-vibe-text">Settings</h2>
          </div>
          <button
            onClick={() => setShowSettingsModal(false)}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-vibe-border bg-vibe-bg">
          <div className="flex overflow-x-auto">
            {[...tabs.slice(0, -2), ...pluginTabs, ...tabs.slice(-2)].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab.id
                    ? 'text-vibe-text'
                    : 'border-transparent text-vibe-muted hover:text-vibe-text hover:border-vibe-border'
                }`}
                style={activeTab === tab.id ? { borderBottomColor: 'var(--accent-color)' } : undefined}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'general' && (
            <GeneralSettings
              theme={theme}
              setAccentColor={setAccentColor}
              setUiScale={setUiScale}
              setPanelBorderRadius={setPanelBorderRadius}
              setPanelGap={setPanelGap}
              setGlowIntensity={setGlowIntensity}
              setReduceMotion={setReduceMotion}
              setAttentionGlowColor={setAttentionGlowColor}
              setIdleGlowColor={setIdleGlowColor}
              setIdleTimeoutSeconds={setIdleTimeoutSeconds}
              setIdleGlowEnabled={setIdleGlowEnabled}
              sessionSettings={session}
              setRestoreOnStartup={setRestoreOnStartup}
              setAutoSaveEnabled={setAutoSaveEnabled}
              setAutoSaveInterval={setAutoSaveInterval}
            />
          )}
          {activeTab === 'terminal' && (
            <TerminalSettings
              terminal={terminal}
              toolbar={toolbar}
              setTerminalFontSize={setTerminalFontSize}
              setTerminalFontFamily={setTerminalFontFamily}
              setTerminalLineHeight={setTerminalLineHeight}
              setTerminalCursorStyle={setTerminalCursorStyle}
              setTerminalCursorBlink={setTerminalCursorBlink}
              setTerminalScrollbackLines={setTerminalScrollbackLines}
              setTerminalBellStyle={setTerminalBellStyle}
              setTerminalCopyOnSelect={setTerminalCopyOnSelect}
              setTerminalRightClickPaste={setTerminalRightClickPaste}
              setTerminalUseWebGL={setTerminalUseWebGL}
              setTerminalPadding={setTerminalPadding}
              setConfirmClose={setConfirmClose}
              setFlashTaskbarOnAttention={setFlashTaskbarOnAttention}
              setStreamerMode={setStreamerMode}
              setTabTitleMaxLength={setTabTitleMaxLength}
              setClickToPromote={setClickToPromote}
            />
          )}
          {activeTab === 'ai-agents' && (
            <AIAgentsSettings aiAgentSettings={aiAgent} updateAIAgentSettings={updateAIAgentSettings} />
          )}
          {activeTab === 'integrations' && (
            <IntegrationsSettings
              titleSettings={titleSettings}
              setTitleEnabled={setTitleEnabled}
              updateTitleSettings={updateTitleSettings}
            />
          )}
          {activePluginPage && <PluginSettingsPageHost key={activeTab} page={activePluginPage} />}
          {activeTab === 'plugins' && <PluginsSettingsPage />}
          {activeTab === 'advanced' && (
            <AdvancedSettings
              resetToDefaults={resetToDefaults}
              exportSettings={exportSettings}
              importSettings={importSettings}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ============== Terminal Settings ==============
interface TerminalSettingsProps {
  terminal: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorStyle: CursorStyle
    cursorBlink: boolean
    scrollbackLines: number
    bellStyle: BellStyle
    copyOnSelect: boolean
    rightClickPaste: boolean
    useWebGL: boolean
    terminalPadding: number
    confirmClose: boolean
    flashTaskbarOnAttention: boolean
    streamerMode: boolean
  }
  toolbar: {
    tabTitleMaxLength: number
    clickToPromote: boolean
  }
  setTerminalFontSize: (size: number) => void
  setTerminalFontFamily: (family: string) => void
  setTerminalLineHeight: (height: number) => void
  setTerminalCursorStyle: (style: CursorStyle) => void
  setTerminalCursorBlink: (blink: boolean) => void
  setTerminalScrollbackLines: (lines: number) => void
  setTerminalBellStyle: (style: BellStyle) => void
  setTerminalCopyOnSelect: (enabled: boolean) => void
  setTerminalRightClickPaste: (enabled: boolean) => void
  setTerminalUseWebGL: (enabled: boolean) => void
  setTerminalPadding: (padding: number) => void
  setConfirmClose: (confirm: boolean) => void
  setFlashTaskbarOnAttention: (flash: boolean) => void
  setStreamerMode: (enabled: boolean) => void
  setTabTitleMaxLength: (length: number) => void
  setClickToPromote: (enabled: boolean) => void
}

function TerminalSettings({
  terminal,
  toolbar,
  setTerminalFontSize,
  setTerminalFontFamily,
  setTerminalLineHeight,
  setTerminalCursorStyle,
  setTerminalCursorBlink,
  setTerminalScrollbackLines,
  setTerminalBellStyle,
  setTerminalCopyOnSelect,
  setTerminalRightClickPaste,
  setTerminalUseWebGL,
  setTerminalPadding,
  setConfirmClose,
  setFlashTaskbarOnAttention,
  setStreamerMode,
  setTabTitleMaxLength,
  setClickToPromote,
}: TerminalSettingsProps) {
  const {
    environments,
    setDefaultEnvironmentId,
    setTerminalEnvironments,
    runDetectEnvironments,
    setHasAutoDetected,
  } = useAppSettingsStore()

  const [isDetecting, setIsDetecting] = useState(false)
  const [showEnvironmentModal, setShowEnvironmentModal] = useState(false)
  const [editingEnvironment, setEditingEnvironment] = useState<TerminalEnvironment | null>(null)

  const handleDetect = async () => {
    setIsDetecting(true)
    try {
      await runDetectEnvironments()
      setHasAutoDetected(true)
    } finally {
      setIsDetecting(false)
    }
  }

  const handleSaveEnvironment = (envData: Omit<TerminalEnvironment, 'id' | 'createdAt' | 'updatedAt' | 'isBuiltIn' | 'isAvailable'>) => {
    const now = Date.now()
    let newEnvironments: TerminalEnvironment[]

    if (editingEnvironment) {
      if (editingEnvironment.isBuiltIn) {
        setShowEnvironmentModal(false)
        setEditingEnvironment(null)
        return
      }
      newEnvironments = environments.terminalEnvironments.map(e =>
        e.id === editingEnvironment.id
          ? { ...e, ...envData, updatedAt: now }
          : e
      )
    } else {
      const newEnv: TerminalEnvironment = {
        ...envData,
        id: Math.random().toString(36).substring(2) + Date.now().toString(36),
        isBuiltIn: false,
        isAvailable: true,
        createdAt: now,
        updatedAt: now,
      }
      newEnvironments = [...environments.terminalEnvironments, newEnv]
    }

    setTerminalEnvironments(newEnvironments)
    setShowEnvironmentModal(false)
    setEditingEnvironment(null)
  }

  const handleDeleteEnvironment = (envId: string) => {
    const env = environments.terminalEnvironments.find(e => e.id === envId)
    if (env?.isBuiltIn) return
    const newEnvironments = environments.terminalEnvironments.filter(e => e.id !== envId)
    setTerminalEnvironments(newEnvironments)
    if (environments.defaultEnvironmentId === envId) {
      setDefaultEnvironmentId(undefined)
    }
  }

  return (
    <div className="space-y-6">
      {/* Default Shell Section */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Default Shell</h3>
        <div className="space-y-4">
          {/* Default Environment Dropdown */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Default Environment</label>
              <p className="text-xs text-vibe-muted">Shell used for new terminals</p>
            </div>
            <select
              value={environments.defaultEnvironmentId || ''}
              onChange={(e) => setDefaultEnvironmentId(e.target.value || undefined)}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary min-w-[180px]"
            >
              <option value="">System Default</option>
              {environments.terminalEnvironments.map((env) => (
                <option key={env.id} value={env.id}>{env.name}</option>
              ))}
            </select>
          </div>

          {/* Detect & Add buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleDetect}
              disabled={isDetecting}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 disabled:opacity-50 transition-colors"
            >
              {isDetecting ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Detecting...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  Detect Environments
                </>
              )}
            </button>
            <button
              onClick={() => {
                setEditingEnvironment(null)
                setShowEnvironmentModal(true)
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Custom
            </button>
            {environments.terminalEnvironments.length > 0 && (
              <span className="flex items-center text-xs text-vibe-muted ml-auto">
                {environments.terminalEnvironments.length} environment{environments.terminalEnvironments.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Environment List */}
          {environments.terminalEnvironments.length > 0 && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {environments.terminalEnvironments.map((env) => (
                <div
                  key={env.id}
                  className={`group flex items-center gap-3 bg-vibe-bg border rounded-lg p-2 transition-colors ${
                    environments.defaultEnvironmentId === env.id
                      ? 'border-amber-500/50 bg-amber-500/5'
                      : 'border-vibe-border hover:border-vibe-border'
                  }`}
                >
                  <div className="flex-shrink-0 p-1 rounded bg-vibe-surface">
                    {getEnvironmentIcon(env.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-vibe-text">{env.name}</span>
                      {env.isBuiltIn && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-vibe-surface text-vibe-muted">Built-in</span>
                      )}
                      {environments.defaultEnvironmentId === env.id && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/30 text-amber-400">Default</span>
                      )}
                    </div>
                    {env.description && (
                      <p className="text-xs text-vibe-muted truncate">{env.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => setDefaultEnvironmentId(environments.defaultEnvironmentId === env.id ? undefined : env.id)}
                      className={`p-1 rounded transition-all ${
                        environments.defaultEnvironmentId === env.id
                          ? 'text-amber-400 hover:text-amber-300'
                          : 'text-vibe-muted opacity-0 group-hover:opacity-100 hover:text-amber-400'
                      }`}
                      title={environments.defaultEnvironmentId === env.id ? 'Remove as default' : 'Set as default'}
                    >
                      <svg className="w-3.5 h-3.5" fill={environments.defaultEnvironmentId === env.id ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                      </svg>
                    </button>
                    {!env.isBuiltIn && (
                      <>
                        <button
                          onClick={() => { setEditingEnvironment(env); setShowEnvironmentModal(true) }}
                          className="p-1 text-vibe-muted opacity-0 group-hover:opacity-100 hover:text-vibe-text rounded transition-all"
                          title="Edit"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteEnvironment(env.id)}
                          className="p-1 text-vibe-muted opacity-0 group-hover:opacity-100 hover:text-red-400 rounded transition-all"
                          title="Delete"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Environment Edit Modal */}
      {showEnvironmentModal && (
        <SettingsEnvironmentEditModal
          environment={editingEnvironment}
          onSave={handleSaveEnvironment}
          onClose={() => { setShowEnvironmentModal(false); setEditingEnvironment(null) }}
        />
      )}

      {/* Font Settings */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Font</h3>
        <div className="space-y-4">
          {/* Font Family */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Font Family</label>
              <p className="text-xs text-vibe-muted">Choose terminal font</p>
            </div>
            <select
              value={terminal.fontFamily}
              onChange={(e) => setTerminalFontFamily(e.target.value)}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
            >
              {MONO_FONTS.map((font) => (
                <option key={font.name} value={font.value}>
                  {font.name}
                </option>
              ))}
            </select>
          </div>

          {/* Font Size */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Font Size</label>
              <p className="text-xs text-vibe-muted">Size of text in all terminals</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTerminalFontSize(terminal.fontSize - 1)}
                disabled={terminal.fontSize <= 8}
                className="w-8 h-8 flex items-center justify-center bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>
              <span className="w-12 text-center text-sm text-vibe-text font-mono">{terminal.fontSize}px</span>
              <button
                onClick={() => setTerminalFontSize(terminal.fontSize + 1)}
                disabled={terminal.fontSize >= 32}
                className="w-8 h-8 flex items-center justify-center bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
          </div>

          {/* Line Height */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Line Height</label>
              <p className="text-xs text-vibe-muted">Spacing between lines</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTerminalLineHeight(Math.round((terminal.lineHeight - 0.1) * 10) / 10)}
                disabled={terminal.lineHeight <= 1}
                className="w-8 h-8 flex items-center justify-center bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                </svg>
              </button>
              <span className="w-12 text-center text-sm text-vibe-text font-mono">{terminal.lineHeight.toFixed(1)}</span>
              <button
                onClick={() => setTerminalLineHeight(Math.round((terminal.lineHeight + 0.1) * 10) / 10)}
                disabled={terminal.lineHeight >= 2}
                className="w-8 h-8 flex items-center justify-center bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Cursor Settings */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Cursor</h3>
        <div className="space-y-4">
          {/* Cursor Style */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Cursor Style</label>
              <p className="text-xs text-vibe-muted">Shape of the cursor</p>
            </div>
            <div className="flex gap-2">
              {(['bar', 'block', 'underline'] as const).map((style) => (
                <button
                  key={style}
                  onClick={() => setTerminalCursorStyle(style)}
                  className={`px-3 py-1.5 rounded border text-sm capitalize transition-colors ${
                    terminal.cursorStyle === style
                      ? 'text-vibe-text'
                      : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:border-vibe-border-bright'
                  }`}
                  style={terminal.cursorStyle === style ? {
                    backgroundColor: 'color-mix(in srgb, var(--accent-color) 20%, transparent)',
                    borderColor: 'var(--accent-color)'
                  } : undefined}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          {/* Cursor Blink */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Cursor Blink</label>
              <p className="text-xs text-vibe-muted">Animate cursor blinking</p>
            </div>
            <ToggleSwitch
              enabled={terminal.cursorBlink}
              onChange={() => setTerminalCursorBlink(!terminal.cursorBlink)}
            />
          </div>
        </div>
      </div>

      {/* Scrollback */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">History</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Scrollback Lines</label>
              <p className="text-xs text-vibe-muted">Lines to keep in history (requires new terminal)</p>
            </div>
            <select
              value={terminal.scrollbackLines}
              onChange={(e) => setTerminalScrollbackLines(parseInt(e.target.value))}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
            >
              <option value={1000}>1,000</option>
              <option value={5000}>5,000</option>
              <option value={10000}>10,000</option>
              <option value={25000}>25,000</option>
              <option value={50000}>50,000</option>
              <option value={100000}>100,000</option>
            </select>
          </div>
        </div>
      </div>

      {/* Behavior */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Behavior</h3>
        <div className="space-y-4">
          {/* Bell Style */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Bell Style</label>
              <p className="text-xs text-vibe-muted">How to notify on terminal bell</p>
            </div>
            <select
              value={terminal.bellStyle}
              onChange={(e) => setTerminalBellStyle(e.target.value as BellStyle)}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
            >
              <option value="none">None</option>
              <option value="visual">Visual Flash</option>
              <option value="sound">Sound</option>
              <option value="both">Both</option>
            </select>
          </div>

          {/* Copy on Select */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Copy on Select</label>
              <p className="text-xs text-vibe-muted">Automatically copy text when selected</p>
            </div>
            <ToggleSwitch
              enabled={terminal.copyOnSelect}
              onChange={() => setTerminalCopyOnSelect(!terminal.copyOnSelect)}
            />
          </div>

          {/* Right-Click Paste */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Right-Click Paste</label>
              <p className="text-xs text-vibe-muted">Paste clipboard contents on right-click</p>
            </div>
            <ToggleSwitch
              enabled={terminal.rightClickPaste}
              onChange={() => setTerminalRightClickPaste(!terminal.rightClickPaste)}
            />
          </div>

          {/* Confirm Close */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Confirm Before Close</label>
              <p className="text-xs text-vibe-muted">Ask for confirmation before closing an active terminal</p>
            </div>
            <ToggleSwitch
              enabled={terminal.confirmClose}
              onChange={() => setConfirmClose(!terminal.confirmClose)}
            />
          </div>

          {/* Flash Taskbar on Attention */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Flash Taskbar on Attention</label>
              <p className="text-xs text-vibe-muted">Flash the taskbar icon when a terminal needs attention</p>
            </div>
            <ToggleSwitch
              enabled={terminal.flashTaskbarOnAttention}
              onChange={() => setFlashTaskbarOnAttention(!terminal.flashTaskbarOnAttention)}
            />
          </div>

          {/* Streamer Mode */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Streamer Mode</label>
              <p className="text-xs text-vibe-muted">Hide API keys, tokens, passwords, and connection strings from terminal output</p>
            </div>
            <ToggleSwitch
              enabled={terminal.streamerMode}
              onChange={() => setStreamerMode(!terminal.streamerMode)}
            />
          </div>

          {/* Click to Promote */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Click to Promote</label>
              <p className="text-xs text-vibe-muted">In Main+Bottom/Sidebar layouts, click a pane to swap it to the main position</p>
            </div>
            <ToggleSwitch
              enabled={toolbar.clickToPromote}
              onChange={() => setClickToPromote(!toolbar.clickToPromote)}
            />
          </div>

        </div>
      </div>

      {/* Display */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Display</h3>
        <div className="space-y-4">
          {/* Terminal Padding */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="text-sm text-vibe-text">Terminal Padding</label>
                <p className="text-xs text-vibe-muted">Internal padding around terminal content</p>
              </div>
              <span className="text-sm text-vibe-text font-mono w-12 text-right">{terminal.terminalPadding}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={16}
              step={2}
              value={terminal.terminalPadding}
              onChange={(e) => setTerminalPadding(parseInt(e.target.value))}
              className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
            />
            <div className="flex justify-between text-xs text-vibe-muted mt-1">
              <span>None</span>
              <span>Spacious</span>
            </div>
          </div>

          {/* Tab Title Max Length */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <label className="text-sm text-vibe-text">Tab Title Length</label>
                <p className="text-xs text-vibe-muted">Maximum characters shown in minimized tab titles</p>
              </div>
              <span className="text-sm text-vibe-text font-mono w-16 text-right">{toolbar.tabTitleMaxLength} chars</span>
            </div>
            <input
              type="range"
              min={15}
              max={50}
              step={5}
              value={toolbar.tabTitleMaxLength}
              onChange={(e) => setTabTitleMaxLength(parseInt(e.target.value))}
              className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
            />
            <div className="flex justify-between text-xs text-vibe-muted mt-1">
              <span>Short</span>
              <span>Long</span>
            </div>
          </div>
        </div>
      </div>

      {/* Performance */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Performance</h3>
        <div className="space-y-4">
          {/* WebGL Rendering */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">WebGL Rendering</label>
              <p className="text-xs text-vibe-muted">Use GPU acceleration for better performance (requires new terminal)</p>
            </div>
            <ToggleSwitch
              enabled={terminal.useWebGL}
              onChange={() => setTerminalUseWebGL(!terminal.useWebGL)}
            />
          </div>
        </div>
      </div>

    </div>
  )
}

// ============== General Settings ==============
interface GeneralSettingsProps {
  theme: { mode: 'dark' | 'light' | 'system'; accentColor: string; uiScale: number; panelBorderRadius: number; panelGap: number; glowIntensity: GlowIntensity; reduceMotion: boolean; attentionGlowColor: string; idleGlowColor: string; idleTimeoutSeconds: number; idleGlowEnabled: boolean }
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
  sessionSettings: {
    defaultWorkingDirectory: string
    restoreOnStartup: boolean
    autoSaveEnabled: boolean
    autoSaveIntervalMs: number
  }
  setRestoreOnStartup: (enabled: boolean) => void
  setAutoSaveEnabled: (enabled: boolean) => void
  setAutoSaveInterval: (ms: number) => void
}

const THEME_MODES = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', icon: 'monitor' },
] as const

function ThemeModeSetting() {
  const mode = useAppSettingsStore((s) => s.theme.mode)
  const setThemeMode = useAppSettingsStore((s) => s.setThemeMode)
  return (
    <div>
      <h3 className="text-sm font-medium text-vibe-text mb-4">Theme</h3>
      <div className="inline-flex rounded-lg border border-vibe-border bg-vibe-surface p-0.5">
        {THEME_MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setThemeMode(m.value)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
              mode === m.value
                ? 'bg-vibe-primary/20 text-vibe-text'
                : 'text-vibe-muted hover:text-vibe-text'
            }`}
          >
            <Icon name={m.icon} className="w-4 h-4" />
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-vibe-muted mt-3">
        System follows your OS light/dark preference.
      </p>
    </div>
  )
}

function GeneralSettings({ theme, setAccentColor, setUiScale, setPanelBorderRadius, setPanelGap, setGlowIntensity, setReduceMotion, setAttentionGlowColor, setIdleGlowColor, setIdleTimeoutSeconds, setIdleGlowEnabled, sessionSettings, setRestoreOnStartup, setAutoSaveEnabled, setAutoSaveInterval }: GeneralSettingsProps) {
  return (
    <div className="space-y-6">
      {/* Theme (light / dark / system) */}
      <ThemeModeSetting />

      {/* Accent Color */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Accent Color</h3>
        <div className="flex flex-wrap gap-3">
          {Object.entries(ACCENT_COLORS).map(([key, color]) => (
            <button
              key={key}
              onClick={() => setAccentColor(color.value)}
              className={`w-10 h-10 rounded-full border-2 transition-all hover:scale-110 ${
                theme.accentColor === color.value
                  ? 'border-vibe-text ring-2 ring-vibe-text/30 scale-110'
                  : 'border-transparent hover:border-vibe-text/50'
              }`}
              style={{ backgroundColor: color.value }}
              title={color.name}
            />
          ))}
        </div>
        <p className="text-xs text-vibe-muted mt-3">
          Selected: <span className="font-medium" style={{ color: theme.accentColor }}>{
            Object.entries(ACCENT_COLORS).find(([, c]) => c.value === theme.accentColor)?.[1].name || 'Custom'
          }</span>
        </p>
      </div>

      {/* UI Scale */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">UI Scale</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Interface Scale</label>
              <p className="text-xs text-vibe-muted">Adjust the overall size of the interface</p>
            </div>
            <span className="text-sm text-vibe-text font-mono w-12 text-right">{theme.uiScale}%</span>
          </div>
          <input
            type="range"
            min={80}
            max={120}
            step={5}
            value={theme.uiScale}
            onChange={(e) => setUiScale(parseInt(e.target.value))}
            className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
          />
          <div className="flex justify-between text-xs text-vibe-muted">
            <span>80%</span>
            <span>100%</span>
            <span>120%</span>
          </div>
        </div>
      </div>

      {/* Panel Border Radius */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Panel Style</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Corner Roundness</label>
              <p className="text-xs text-vibe-muted">Adjust the roundness of panel corners</p>
            </div>
            <span className="text-sm text-vibe-text font-mono w-12 text-right">{theme.panelBorderRadius}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={16}
            step={2}
            value={theme.panelBorderRadius}
            onChange={(e) => setPanelBorderRadius(parseInt(e.target.value))}
            className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
          />
          <div className="flex justify-between text-xs text-vibe-muted">
            <span>Square</span>
            <span>Rounded</span>
          </div>
          {/* Preview */}
          <div className="flex gap-3 mt-4">
            <div
              className="flex-1 h-16 bg-vibe-bg border border-vibe-border flex items-center justify-center text-xs text-vibe-muted"
              style={{ borderRadius: `${theme.panelBorderRadius}px` }}
            >
              Preview
            </div>
            <div
              className="flex-1 h-16 bg-vibe-bg border border-vibe-border flex items-center justify-center text-xs text-vibe-muted"
              style={{ borderRadius: `${theme.panelBorderRadius}px` }}
            >
              Preview
            </div>
          </div>
        </div>
      </div>

      {/* Panel Gap */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Panel Spacing</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Gap Between Panels</label>
              <p className="text-xs text-vibe-muted">Space between terminal and tool tiles</p>
            </div>
            <span className="text-sm text-vibe-text font-mono w-12 text-right">{theme.panelGap}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={8}
            step={1}
            value={theme.panelGap}
            onChange={(e) => setPanelGap(parseInt(e.target.value))}
            className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
          />
          <div className="flex justify-between text-xs text-vibe-muted">
            <span>None</span>
            <span>Spacious</span>
          </div>
        </div>
      </div>

      {/* Active Window Glow */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Active Window Glow</h3>
        <div className="space-y-3">
          <p className="text-xs text-vibe-muted">Intensity of the glow effect on the focused window</p>
          <div className="flex gap-2">
            {([
              { value: 'off' as GlowIntensity, label: 'Off' },
              { value: 'subtle' as GlowIntensity, label: 'Subtle' },
              { value: 'normal' as GlowIntensity, label: 'Normal' },
              { value: 'intense' as GlowIntensity, label: 'Intense' },
            ]).map((option) => (
              <button
                key={option.value}
                onClick={() => setGlowIntensity(option.value)}
                className={`flex-1 px-3 py-2 rounded border text-sm transition-colors ${
                  theme.glowIntensity === option.value
                    ? 'text-vibe-text'
                    : 'bg-vibe-bg border-vibe-border text-vibe-muted hover:border-vibe-border-bright'
                }`}
                style={theme.glowIntensity === option.value ? {
                  backgroundColor: 'color-mix(in srgb, var(--accent-color) 20%, transparent)',
                  borderColor: 'var(--accent-color)'
                } : undefined}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Glow Colors */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Glow Colors</h3>
        <div className="space-y-4">
          {/* Attention glow color */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Attention Glow</label>
              <p className="text-xs text-vibe-muted">Color when a terminal needs your attention</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-vibe-muted font-mono">{theme.attentionGlowColor}</span>
              <input
                type="color"
                value={theme.attentionGlowColor}
                onChange={(e) => setAttentionGlowColor(e.target.value)}
                className="w-8 h-8 rounded border border-vibe-border cursor-pointer bg-transparent"
              />
            </div>
          </div>
          {/* Idle glow color */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Idle Glow</label>
              <p className="text-xs text-vibe-muted">Color when a terminal has been idle</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-vibe-muted font-mono">{theme.idleGlowColor}</span>
              <input
                type="color"
                value={theme.idleGlowColor}
                onChange={(e) => setIdleGlowColor(e.target.value)}
                className="w-8 h-8 rounded border border-vibe-border cursor-pointer bg-transparent"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Idle Detection */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Idle Detection</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Enable Idle Glow</label>
              <p className="text-xs text-vibe-muted">Show a glow on terminals with no output for a while</p>
            </div>
            <ToggleSwitch
              enabled={theme.idleGlowEnabled}
              onChange={() => setIdleGlowEnabled(!theme.idleGlowEnabled)}
            />
          </div>
          {theme.idleGlowEnabled && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-vibe-text">Idle Timeout</label>
                <span className="text-sm text-vibe-text font-mono w-12 text-right">{theme.idleTimeoutSeconds}s</span>
              </div>
              <input
                type="range"
                min={10}
                max={300}
                step={5}
                value={theme.idleTimeoutSeconds}
                onChange={(e) => setIdleTimeoutSeconds(parseInt(e.target.value))}
                className="w-full h-2 bg-vibe-border rounded-lg appearance-none cursor-pointer accent-[var(--accent-color)]"
              />
              <div className="flex justify-between text-xs text-vibe-muted">
                <span>10s</span>
                <span>5min</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Accessibility */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Accessibility</h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Reduce Motion</label>
              <p className="text-xs text-vibe-muted">Minimize animations and transitions</p>
            </div>
            <ToggleSwitch
              enabled={theme.reduceMotion}
              onChange={() => setReduceMotion(!theme.reduceMotion)}
            />
          </div>
        </div>
      </div>

      {/* File Browser */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">File Browser</h3>
        <div className="space-y-3">
          <p className="text-xs text-vibe-muted">
            File browser is available as a sidebar panel. Use {shortcut('B')} to toggle.
          </p>
        </div>
      </div>

      {/* Workspaces */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Workspaces</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Restore on startup</label>
              <p className="text-xs text-vibe-muted">Restore last workspace when QuadFlow launches</p>
            </div>
            <ToggleSwitch
              enabled={sessionSettings.restoreOnStartup}
              onChange={() => setRestoreOnStartup(!sessionSettings.restoreOnStartup)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Auto-save sessions</label>
              <p className="text-xs text-vibe-muted">Automatically save session state when changes occur</p>
            </div>
            <ToggleSwitch
              enabled={sessionSettings.autoSaveEnabled}
              onChange={() => setAutoSaveEnabled(!sessionSettings.autoSaveEnabled)}
            />
          </div>

          {sessionSettings.autoSaveEnabled && (
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm text-vibe-text">Auto-save delay</label>
                <p className="text-xs text-vibe-muted">Wait time after changes before saving</p>
              </div>
              <select
                value={sessionSettings.autoSaveIntervalMs}
                onChange={(e) => setAutoSaveInterval(parseInt(e.target.value))}
                className="px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
              >
                <option value={500}>0.5 seconds</option>
                <option value={1000}>1 second</option>
                <option value={2000}>2 seconds</option>
                <option value={5000}>5 seconds</option>
                <option value={10000}>10 seconds</option>
              </select>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

// ============== Advanced Settings ==============
interface AdvancedSettingsProps {
  resetToDefaults: () => void
  exportSettings: () => void
  importSettings: (file: File) => Promise<{ success: boolean; error?: string }>
}

function AdvancedSettings({
  resetToDefaults,
  exportSettings,
  importSettings,
}: AdvancedSettingsProps) {
  const [importStatus, setImportStatus] = useState<{ success: boolean; error?: string } | null>(null)

  const handleImportClick = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        setImportStatus(null)
        const result = await importSettings(file)
        setImportStatus(result)
        if (result.success) {
          setTimeout(() => setImportStatus(null), 3000)
        }
      }
    }
    input.click()
  }

  return (
    <div className="space-y-6">
      {/* Export/Import */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Settings Backup</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Export Settings</label>
              <p className="text-xs text-vibe-muted">Download all settings as a JSON file</p>
            </div>
            <button
              onClick={exportSettings}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Import Settings</label>
              <p className="text-xs text-vibe-muted">Load settings from a JSON file</p>
            </div>
            <div className="flex items-center gap-2">
              {importStatus && (
                <span className={`text-xs ${importStatus.success ? 'text-green-400' : 'text-red-400'}`}>
                  {importStatus.success ? 'Imported!' : importStatus.error}
                </span>
              )}
              <button
                onClick={handleImportClick}
                className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Import
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* QuadFlow 1.x */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">QuadFlow 1.x</h3>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm text-vibe-text">Import from QuadFlow 1.x</label>
            <p className="text-xs text-vibe-muted">
              Add the projects of an installed QuadFlow 1.x to your projects list. Settings start at the defaults.
            </p>
          </div>
          <button
            onClick={() => {
              useAppSettingsStore.getState().setShowSettingsModal(false)
              void useImportV1Store.getState().open('manual')
            }}
            data-import-v1-open
            className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 transition-colors whitespace-nowrap"
          >
            Import from QuadFlow 1.x…
          </button>
        </div>
      </div>

      {/* Reset */}
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-4">Reset</h3>
        <div className="flex items-center justify-between p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <div>
            <label className="text-sm text-vibe-text">Reset All Settings</label>
            <p className="text-xs text-vibe-muted">Restore all settings to defaults</p>
          </div>
          <button
            onClick={resetToDefaults}
            className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded text-sm hover:bg-red-500/20 transition-colors"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

// ============== CLI on PATH ==============
// Lets the user add the QuadFlow exe directory to their per-user PATH so the
// `quadflow` CLI is callable from any new terminal. Backend writes
// HKCU\Environment\Path on Windows and broadcasts WM_SETTINGCHANGE.
function CliInstallSection() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await cliInstallApi.status())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const onInstall = async () => {
    setBusy(true); setError(null)
    try {
      setStatus(await cliInstallApi.install())
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const onUninstall = async () => {
    setBusy(true); setError(null)
    try {
      setStatus(await cliInstallApi.uninstall())
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <h3 className="text-sm font-medium text-vibe-text">QuadFlow CLI on PATH</h3>
      </div>

      <div className="bg-vibe-bg rounded-lg p-4 space-y-3">
        <p className="text-sm text-vibe-muted">
          Adds the QuadFlow install directory to your user PATH so <code className="font-mono text-vibe-text">quadflow</code> is callable from any new shell.
          {' '}Doesn't require admin — only your user's <code className="font-mono text-vibe-text">HKCU\Environment\Path</code> is touched.
        </p>

        {status && (
          <div className="text-xs text-vibe-muted space-y-1 font-mono">
            <div>Bin dir: <span className="text-vibe-text">{status.bin_dir}</span></div>
            <div>
              Status:{' '}
              <span className={status.installed ? 'text-green-400' : 'text-yellow-400'}>
                {status.installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
            {status.message && <div className="text-vibe-text/80">{status.message}</div>}
          </div>
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}

        <div className="flex items-center gap-2 pt-1">
          {status?.supported === false ? (
            <span className="text-xs text-vibe-muted">Not supported on this platform yet.</span>
          ) : status?.installed ? (
            <button
              onClick={onUninstall}
              disabled={busy}
              className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded text-sm hover:bg-red-500/20 transition-colors disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Remove from PATH'}
            </button>
          ) : (
            <button
              onClick={onInstall}
              disabled={busy}
              className="px-3 py-1.5 bg-vibe-primary/10 border border-vibe-primary/30 text-vibe-primary rounded text-sm hover:bg-vibe-primary/20 transition-colors disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Install CLI to PATH'}
            </button>
          )}
          <button
            onClick={refresh}
            disabled={busy}
            className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 transition-colors disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}

// ============== Integrations Settings ==============
interface IntegrationsSettingsProps {
  titleSettings: TitleSettings
  setTitleEnabled: (enabled: boolean) => void
  updateTitleSettings: (updates: Partial<TitleSettings>) => void
}

function IntegrationsSettings({ titleSettings, setTitleEnabled, updateTitleSettings }: IntegrationsSettingsProps) {
  // Title generators contributed by plugins (e.g. the optional local-titles plugin).
  const [titleGenerators, setTitleGenerators] = useState<TitleGeneratorInfo[]>([])
  useEffect(() => {
    listTitleGenerators().then(setTitleGenerators, () => setTitleGenerators([]))
  }, [])

  // Chat endpoint state (settings namespace `chat`; key in the OS keystore, write-only)
  const [ollamaEndpoint, setOllamaEndpoint] = useState('')
  const [savedEndpoint, setSavedEndpoint] = useState('')
  const [hasOllamaApiKey, setHasOllamaApiKey] = useState(false)
  const [ollamaApiKeyInput, setOllamaApiKeyInput] = useState('')
  const [showOllamaApiKey, setShowOllamaApiKey] = useState(false)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [isLoadingOllamaModels, setIsLoadingOllamaModels] = useState(false)
  const [isDiscoveringEndpoints, setIsDiscoveringEndpoints] = useState(false)
  const [discoveredEndpoints, setDiscoveredEndpoints] = useState<ChatEndpointInfo[]>([])
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [showDiscovery, setShowDiscovery] = useState(false)

  const refreshChatModels = useCallback(async () => {
    setIsLoadingOllamaModels(true)
    try {
      setOllamaModels(await chatCore.listModels())
    } catch { setOllamaModels([]) }
    setIsLoadingOllamaModels(false)
  }, [])

  // Load chat endpoint settings on mount
  useEffect(() => {
    chatCore.getSettings().then((s) => {
      setOllamaEndpoint(s.endpoint)
      setSavedEndpoint(s.endpoint)
      setHasOllamaApiKey(s.hasApiKey)
    }).catch(console.error)
    refreshChatModels()
  }, [refreshChatModels])

  const saveEndpoint = useCallback(async (url: string) => {
    setEndpointError(null)
    try {
      const s = await chatCore.updateSettings({ endpoint: url })
      setOllamaEndpoint(s.endpoint)
      setSavedEndpoint(s.endpoint)
      return true
    } catch (e) {
      setEndpointError(e instanceof Error ? e.message : String(e))
      return false
    }
  }, [])

  const handleOllamaEndpointBlur = useCallback(async () => {
    const trimmed = ollamaEndpoint.trim()
    if (!trimmed || trimmed === savedEndpoint) return
    if (await saveEndpoint(trimmed)) await refreshChatModels()
  }, [ollamaEndpoint, savedEndpoint, saveEndpoint, refreshChatModels])

  const handleOllamaApiKeyBlur = useCallback(async () => {
    const trimmed = ollamaApiKeyInput.trim()
    if (trimmed === '') return
    try {
      await chatCore.setApiKey(trimmed)
      setHasOllamaApiKey(true)
      setOllamaApiKeyInput('')
      setEndpointError(null)
    } catch (e) {
      setEndpointError(e instanceof Error ? e.message : String(e))
    }
  }, [ollamaApiKeyInput])

  const handleClearOllamaApiKey = useCallback(async () => {
    try {
      await chatCore.clearApiKey()
      setHasOllamaApiKey(false)
      setOllamaApiKeyInput('')
    } catch (e) {
      setEndpointError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleDiscoverEndpoints = useCallback(async () => {
    setIsDiscoveringEndpoints(true)
    setDiscoveryError(null)
    setDiscoveredEndpoints([])
    try {
      const result = await chatCore.discoverEndpoints(11434, 3000)
      setDiscoveredEndpoints(result.endpoints)
      if (result.endpoints.length === 0) {
        setDiscoveryError(`No LLM servers found on ${result.scannedSubnet}. Make sure Ollama is running.`)
      }
    } catch (error) {
      setDiscoveryError(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    setIsDiscoveringEndpoints(false)
  }, [])

  const handleSelectEndpoint = useCallback(async (endpoint: ChatEndpointInfo) => {
    if (await saveEndpoint(endpoint.endpointUrl)) {
      setOllamaModels(endpoint.models)
      setShowDiscovery(false)
    }
  }, [saveEndpoint])

  const handleRefreshOllamaModels = refreshChatModels

  return (
    <div className="space-y-6">
      {/* QuadFlow CLI on PATH */}
      <CliInstallSection />

      {/* Ollama / Local LLM */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
          </svg>
          <h3 className="text-sm font-medium text-vibe-text">Ollama / Local LLM</h3>
        </div>

        <div className="bg-vibe-bg rounded-lg p-4 space-y-4">
          <p className="text-sm text-vibe-muted">
            Configure the Ollama endpoint used for Chat. Supports any OpenAI-compatible API (Ollama, LM Studio, OpenRouter, etc.).
          </p>

          {/* Endpoint URL */}
          <div className="space-y-2">
            <label className="text-sm text-vibe-text">Endpoint URL</label>
            <input
              type="text"
              value={ollamaEndpoint}
              onChange={(e) => setOllamaEndpoint(e.target.value)}
              onBlur={handleOllamaEndpointBlur}
              placeholder="http://localhost:11434/v1"
              className="w-full px-3 py-1.5 bg-vibe-surface border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary font-mono"
            />
            <p className="text-xs text-vibe-muted">Saves on blur. OpenAI-compatible endpoint.</p>
            {endpointError && <p className="text-xs text-red-400">{endpointError}</p>}
          </div>

          {/* API Key (optional) */}
          <div className="space-y-2">
            <label className="text-sm text-vibe-text">API Key (optional)</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <input
                  type={showOllamaApiKey ? 'text' : 'password'}
                  value={ollamaApiKeyInput}
                  onChange={(e) => setOllamaApiKeyInput(e.target.value)}
                  onBlur={handleOllamaApiKeyBlur}
                  placeholder={hasOllamaApiKey ? "A key is stored (type to replace)" : "Not required for local Ollama"}
                  className="w-full px-3 py-1.5 bg-vibe-surface border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary font-mono pr-10"
                />
                <button
                  onClick={() => setShowOllamaApiKey(!showOllamaApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-vibe-muted hover:text-vibe-text"
                  title={showOllamaApiKey ? 'Hide' : 'Show'}
                >
                  {showOllamaApiKey ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
              {hasOllamaApiKey && (
                <button
                  onClick={handleClearOllamaApiKey}
                  className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded text-sm hover:bg-red-500/20"
                  title="Clear API key"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Scan Network */}
          <div className="flex items-center justify-between pt-2 border-t border-vibe-border">
            <div>
              <label className="text-sm text-vibe-text">Network Discovery</label>
              <p className="text-xs text-vibe-muted">Scan local network for LLM servers</p>
            </div>
            <button
              onClick={() => {
                setShowDiscovery(!showDiscovery)
                if (!showDiscovery && discoveredEndpoints.length === 0) {
                  handleDiscoverEndpoints()
                }
              }}
              disabled={isDiscoveringEndpoints}
              className="flex items-center gap-2 px-3 py-1.5 bg-vibe-primary/20 text-vibe-primary border border-vibe-primary/30 rounded hover:bg-vibe-primary/30 disabled:opacity-50 transition-colors text-sm"
            >
              {isDiscoveringEndpoints ? (
                <>
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Scanning...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  {showDiscovery ? 'Hide' : 'Scan Network'}
                </>
              )}
            </button>
          </div>

          {/* Discovery Results */}
          {showDiscovery && (
            <div className="space-y-2">
              {discoveryError && (
                <div className="flex items-start gap-2 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm text-yellow-400">
                  <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span>{discoveryError}</span>
                </div>
              )}

              {discoveredEndpoints.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-vibe-muted">
                    Found {discoveredEndpoints.length} server{discoveredEndpoints.length !== 1 ? 's' : ''}:
                  </div>
                  {discoveredEndpoints.map((endpoint, index) => (
                    <div
                      key={index}
                      className={`flex items-center justify-between p-3 bg-vibe-surface border rounded-lg cursor-pointer transition-colors ${
                        ollamaEndpoint === endpoint.endpointUrl
                          ? 'border-vibe-primary bg-vibe-primary/10'
                          : 'border-vibe-border hover:border-vibe-primary/50'
                      }`}
                      onClick={() => handleSelectEndpoint(endpoint)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-vibe-text">
                            {endpoint.hostname || endpoint.host}
                          </span>
                          {endpoint.isLocal && (
                            <span className="text-xs px-1.5 py-0.5 bg-green-500/20 rounded text-green-400">Local</span>
                          )}
                        </div>
                        <div className="text-xs text-vibe-muted mt-0.5">
                          {endpoint.endpointUrl} - {endpoint.models.length} model{endpoint.models.length !== 1 ? 's' : ''} - {endpoint.responseTimeMs}ms
                        </div>
                      </div>
                      {ollamaEndpoint === endpoint.endpointUrl && (
                        <svg className="w-5 h-5 text-vibe-primary flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        </svg>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={handleDiscoverEndpoints}
                    disabled={isDiscoveringEndpoints}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text border border-dashed border-vibe-border rounded-lg hover:border-vibe-primary/50 transition-colors disabled:opacity-50"
                  >
                    <svg className={`w-4 h-4 ${isDiscoveringEndpoints ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Scan Again
                  </button>
                </div>
              )}

              {isDiscoveringEndpoints && discoveredEndpoints.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-vibe-muted">
                  <div className="w-4 h-4 border-2 border-vibe-muted border-t-vibe-primary rounded-full animate-spin" />
                  Scanning local network...
                </div>
              )}
            </div>
          )}

          {/* Available Models */}
          <div className="flex items-center justify-between pt-2 border-t border-vibe-border">
            <div>
              <label className="text-sm text-vibe-text">Available Models</label>
              <p className="text-xs text-vibe-muted">
                {ollamaModels.length > 0 ? `${ollamaModels.length} model${ollamaModels.length !== 1 ? 's' : ''} found` : 'No models loaded'}
              </p>
            </div>
            <button
              onClick={handleRefreshOllamaModels}
              disabled={isLoadingOllamaModels}
              className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 disabled:opacity-50"
            >
              {isLoadingOllamaModels ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          {ollamaModels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {ollamaModels.map((model: string) => (
                <span key={model} className="text-xs px-2 py-0.5 bg-vibe-surface border border-vibe-border rounded text-vibe-text">
                  {model}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Auto Titles */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <h3 className="text-sm font-medium text-vibe-text">Auto Titles</h3>
        </div>

        <div className="bg-vibe-bg rounded-lg p-4 space-y-4 border border-vibe-border">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Auto-title terminals</label>
              <p className="text-xs text-vibe-muted">Generate short titles from the initial prompt</p>
            </div>
            <ToggleSwitch
              enabled={titleSettings.enabled}
              onChange={() => setTitleEnabled(!titleSettings.enabled)}
            />
          </div>

          {/* Who generates titles: plugins, then the agent's session title, then the API */}
          <div className="space-y-1" data-testid="title-generators">
            <label className="text-sm text-vibe-text">Title generators</label>
            <p className="text-xs text-vibe-muted">
              Tried in order: title-generator plugins, the agent&apos;s own session title, then the API model below.
            </p>
            {titleGenerators.length > 0 ? (
              <ul className="text-xs text-vibe-text space-y-0.5 pt-1">
                {titleGenerators.map((g) => (
                  <li key={`${g.pluginId}/${g.id}`} className="flex items-center gap-2">
                    <PluginIcon pluginId={g.pluginId} size={14} />
                    <span>{g.title}</span>
                    <span className="text-vibe-muted">({g.pluginId})</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-vibe-muted/80 pt-1">
                No title-generator plugin installed. Install the optional &quot;Local Titles&quot; plugin (Settings → Plugins) for offline titles from a local model.
              </p>
            )}
          </div>

          {/* API fallback */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <label className="text-sm text-vibe-text">API Model</label>
              <p className="text-xs text-vibe-muted">
                {ollamaModels.length > 0
                  ? 'Chat-endpoint model for titles (empty: no API titles)'
                  : 'No models found - check your endpoint above'}
              </p>
            </div>
            {ollamaModels.length > 0 ? (
              <select
                value={titleSettings.api_model}
                onChange={(e) => updateTitleSettings({ api_model: e.target.value })}
                className="px-3 py-1.5 bg-vibe-surface border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary max-w-[200px]"
              >
                <option value="">None</option>
                {ollamaModels.map((model: string) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={titleSettings.api_model}
                onChange={(e) => updateTitleSettings({ api_model: e.target.value })}
                placeholder="e.g. qwen2.5:7b"
                className="px-3 py-1.5 bg-vibe-surface border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary max-w-[200px]"
              />
            )}
          </div>
          {titleSettings.api_model && !ollamaEndpoint && (
            <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2">
              No API endpoint configured. Set one in the Ollama / Local LLM section above.
            </div>
          )}

          {/* Word limit - applies to every generator */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-vibe-border">
            <label className="text-xs text-vibe-muted">Word limit</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={2}
                max={8}
                value={titleSettings.min_words}
                onChange={(e) => updateTitleSettings({ min_words: Number(e.target.value) })}
                className="w-12 px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text"
              />
              <span className="text-xs text-vibe-muted">-</span>
              <input
                type="number"
                min={3}
                max={12}
                value={titleSettings.max_words}
                onChange={(e) => updateTitleSettings({ max_words: Number(e.target.value) })}
                className="w-12 px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text"
              />
            </div>
          </div>

          {/* Dynamic title polling interval */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-vibe-border">
            <div className="min-w-0">
              <label className="text-xs text-vibe-muted">Summary poll interval</label>
              <p className="text-xs text-vibe-muted/70">How often to check for session summary updates (seconds)</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={15}
                max={300}
                step={15}
                value={titleSettings.summaryPollIntervalSeconds}
                onChange={(e) => updateTitleSettings({ summaryPollIntervalSeconds: Number(e.target.value) })}
                className="w-24 accent-vibe-primary"
              />
              <span className="text-xs text-vibe-text w-8 text-right">{titleSettings.summaryPollIntervalSeconds}s</span>
            </div>
          </div>
        </div>
      </div>

      {/* Context Modules for the QuadFlow CLI */}
      <ContextModulesSection />

    </div>
  )
}

// ============== Context Modules Section ==============
// Per-project toggles for which quadflow-core CLI module docs are injected
// into the project's agent context files (each provider's `contextFile`).
function ContextModulesSection() {
  const { contextModules, toggleContextModule, resetContextModules, loadContextModules } = useAppSettingsStore()
  const [busyModule, setBusyModule] = useState<string | null>(null)
  const [isResetting, setIsResetting] = useState(false)

  // Read the active project directory lazily so we don't pull the terminal
  // store's entire state into this render.
  const getProjectDir = async (): Promise<string | null> => {
    const { useTerminalStore } = await import('../../stores/terminalStore')
    return useTerminalStore.getState().globalWorkingDirectory || null
  }

  // Ensure the list is loaded when the section renders (no-op if already).
  useEffect(() => {
    getProjectDir().then((dir) => {
      if (dir) loadContextModules(dir)
    })
  }, [loadContextModules])

  const handleToggle = async (module: string, enabled: boolean) => {
    const dir = await getProjectDir()
    if (!dir) return
    setBusyModule(module)
    try {
      await toggleContextModule(dir, module, enabled)
    } finally {
      setBusyModule(null)
    }
  }

  const handleReset = async () => {
    const dir = await getProjectDir()
    if (!dir) return
    setIsResetting(true)
    try {
      await resetContextModules(dir)
    } finally {
      setIsResetting(false)
    }
  }

  const enabledCount = contextModules.filter((m) => m.enabled).length

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <svg className="w-5 h-5 text-vibe-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <h3 className="text-sm font-medium text-vibe-text">Context Modules (QuadFlow CLI)</h3>
      </div>
      <div className="bg-vibe-bg rounded-lg p-4 space-y-3">
        <p className="text-sm text-vibe-muted">
          The <code className="bg-vibe-surface px-1 py-0.5 rounded">quadflow</code> CLI is installed for every
          project. Enable modules here to inject their reference docs into this project's
          agent context files (the managed region of each provider's instructions file)
          &mdash; agents then know the module's commands without extra prompting. Disabled
          modules can still be loaded on-demand in a session via
          <code className="ml-1 bg-vibe-surface px-1 py-0.5 rounded">quadflow docs &lt;module&gt;</code>.
        </p>
        {contextModules.length === 0 ? (
          <p className="text-xs text-vibe-muted italic">
            No project selected, or context module state not yet loaded.
          </p>
        ) : (
          <div className="space-y-1.5">
            {contextModules.map((m) => (
              <div
                key={m.name}
                className="flex items-center justify-between py-1.5 border-b border-vibe-border last:border-0"
              >
                <div>
                  <div className="text-sm text-vibe-text capitalize">{m.name}</div>
                  <div className="text-xs text-vibe-muted">
                    <code>quadflow {m.name} --help</code>
                  </div>
                </div>
                <ToggleSwitch
                  enabled={m.enabled}
                  onChange={() => handleToggle(m.name, !m.enabled)}
                  disabled={busyModule === m.name}
                />
              </div>
            ))}
          </div>
        )}
        {contextModules.length > 0 && (
          <div className="flex items-center justify-between pt-2 border-t border-vibe-border">
            <div className="text-xs text-vibe-muted">
              {enabledCount} of {contextModules.length} enabled
            </div>
            <button
              onClick={handleReset}
              disabled={isResetting || enabledCount === 0}
              className="text-xs text-red-400 hover:text-red-300 disabled:text-vibe-muted disabled:cursor-not-allowed transition-colors"
            >
              {isResetting ? 'Resetting…' : 'Disable all'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============== AI Agents Settings ==============
// Everything per provider comes from `agents_providers` (plugins); the values
// are core settings rows `agents.<field>.<providerId>`.
type AIAgentSettings = import('../../stores/appSettingsStore').AIAgentSettings
interface AIAgentsSettingsProps {
  aiAgentSettings: AIAgentSettings
  updateAIAgentSettings: (settings: Partial<AIAgentSettings>) => void
}

function AIAgentsSettings({ aiAgentSettings, updateAIAgentSettings }: AIAgentsSettingsProps) {
  const providers = useAgentProviders()
  const detections = useAgentProvidersStore((s) => s.detections)
  const { agentDefaults, setAgentDefault } = useAppSettingsStore()
  const selectClass = 'px-3 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary'
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-2">Agent Providers</h3>
        <p className="text-sm text-vibe-muted mb-4">
          Providers come from enabled plugins (Settings → Plugins). Pick the default provider and, per provider,
          the default model, effort and approval mode for new sessions.
        </p>
        {providers.length === 0 ? (
          <p className="text-xs text-vibe-muted italic">No agent provider plugin is enabled.</p>
        ) : (
          <div className="flex items-center justify-between mb-4">
            <label className="text-sm text-vibe-text">Default provider</label>
            <select
              value={aiAgentSettings.defaultProvider ?? ''}
              onChange={(e) => updateAIAgentSettings({ defaultProvider: e.target.value || null })}
              className={selectClass}
            >
              <option value="">First installed</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}{detections[p.id] && !detections[p.id].installed ? ' (not installed)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 rounded text-xs font-medium text-white" style={{ backgroundColor: providerColor(p) }}>
                {p.displayName}
              </span>
              {detections[p.id] && (
                <span className="text-xs text-vibe-muted">
                  {detections[p.id].installed ? `v${detections[p.id].version ?? '?'}` : `not installed${p.installHint ? ` — ${p.installHint}` : ''}`}
                </span>
              )}
            </div>
            <div className="bg-vibe-bg rounded-lg p-3 space-y-3 mb-2">
              {p.efforts && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-vibe-text">Default effort</span>
                  <select
                    value={agentDefaults.defaultEffort[p.id] ?? p.efforts.default}
                    onChange={(e) => setAgentDefault('defaultEffort', p.id, e.target.value === p.efforts?.default ? null : e.target.value)}
                    className={selectClass}
                  >
                    {p.efforts.values.map((v) => (
                      <option key={v} value={v}>{v}{v === p.efforts?.default ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              {p.approvalModes.length > 1 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-vibe-text">Default approval mode</span>
                  <select
                    value={agentDefaults.defaultApprovalMode[p.id] ?? 'default'}
                    onChange={(e) => setAgentDefault('defaultApprovalMode', p.id, e.target.value === 'default' ? null : (e.target.value as AgentApprovalMode))}
                    className={selectClass}
                  >
                    {p.approvalModes.map((m) => (
                      <option key={m} value={m}>{APPROVAL_MODE_INFO[m].label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <ProviderModelsSettings provider={p} />
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-sm font-medium text-vibe-text mb-2">Prompt Delivery</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Auto-Submit Prompt</label>
              <p className="text-xs text-vibe-muted">Press Enter after the initial prompt is pasted into the agent</p>
            </div>
            <ToggleSwitch enabled={aiAgentSettings.autoSubmitPrompt} onChange={() => updateAIAgentSettings({ autoSubmitPrompt: !aiAgentSettings.autoSubmitPrompt })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Auto-Close Issue Terminals</label>
              <p className="text-xs text-vibe-muted">Close terminals when linked issue moves to QA/Done and agent exits</p>
            </div>
            <ToggleSwitch enabled={aiAgentSettings.autoCloseIssueTerminals} onChange={() => updateAIAgentSettings({ autoCloseIssueTerminals: !aiAgentSettings.autoCloseIssueTerminals })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-vibe-text">Startup Delay</label>
              <p className="text-xs text-vibe-muted">Wait before pasting the prompt when a provider declares no ready pattern</p>
            </div>
            <select
              value={aiAgentSettings.startupDelayMs}
              onChange={(e) => updateAIAgentSettings({ startupDelayMs: parseInt(e.target.value) })}
              className={selectClass}
            >
              <option value={3000}>3 seconds</option>
              <option value={4000}>4 seconds</option>
              <option value={5000}>5 seconds</option>
              <option value={6000}>6 seconds (default)</option>
              <option value={8000}>8 seconds</option>
              <option value={10000}>10 seconds</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============== Context Window Editor ==============
function ContextWindowEditor({ value, display, onChange }: { value: number; display: string; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')

  if (editing) {
    return (
      <input
        type="number"
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={() => {
          const v = parseInt(editVal)
          if (v > 0) onChange(v * 1000)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = parseInt(editVal)
            if (v > 0) onChange(v * 1000)
            setEditing(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        className="w-16 px-1 py-0.5 bg-vibe-surface border border-vibe-primary rounded text-[10px] text-vibe-text font-mono text-center focus:outline-none"
        placeholder={String(Math.round(value / 1000))}
        autoFocus
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setEditVal(String(Math.round(value / 1000)))
        setEditing(true)
      }}
      className="px-1.5 py-0.5 rounded text-[10px] font-mono text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
      title={`Context window: ${value.toLocaleString()} tokens (click to edit, value in K tokens)`}
    >
      {display}
    </button>
  )
}

// ============== Short Label Editor ==============
function ShortLabelEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')

  if (editing) {
    return (
      <input
        type="text"
        value={editVal}
        onChange={(e) => setEditVal(e.target.value)}
        onBlur={() => {
          const trimmed = editVal.trim()
          if (trimmed) onChange(trimmed)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const trimmed = editVal.trim()
            if (trimmed) onChange(trimmed)
            setEditing(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        className="w-14 px-1 py-0.5 bg-vibe-surface border border-vibe-primary rounded text-[10px] text-vibe-text text-center focus:outline-none"
        placeholder="Abbr"
        maxLength={6}
        autoFocus
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setEditVal(value)
        setEditing(true)
      }}
      className="px-1.5 py-0.5 rounded text-[10px] text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors"
      title={`Short label: ${value || '(none)'} (click to edit)`}
    >
      {value || 'Abbr'}
    </button>
  )
}

// ============== Add Custom Model Form ==============

function ProviderModelsSettings({ provider }: { provider: AgentProviderInfo }) {
  const { agentDefaults, addCustomModel, removeCustomModel, updateCustomModel, setAgentDefault } = useAppSettingsStore()
  const merged = useAgentModels(provider.id)
  // The core merges system-default ++ catalog ++ custom and resolves the default.
  const currentDefault = agentDefaults.defaultModel[provider.id] ?? null
  const effectiveDefault = merged.find(m => m.isDefault)?.id ?? SYSTEM_DEFAULT_MODEL_ID
  const setDefault = (id: string | null) => setAgentDefault('defaultModel', provider.id, id)

  return (
    <div className="mb-4">
      <div className="text-xs text-vibe-muted mb-1">Models</div>
      <div className="bg-vibe-bg rounded-lg p-3 space-y-2">
        {merged.map((m) => {
          const isSystemDefault = m.id === SYSTEM_DEFAULT_MODEL_ID
          const isBuiltIn = m.source !== 'custom'
          const isCustomOnly = !isBuiltIn
          const isDefault = m.id === effectiveDefault
          const ctxWindow = m.contextWindow || 200_000
          const ctxDisplay = ctxWindow >= 1_000_000
            ? `${(ctxWindow / 1_000_000).toFixed(ctxWindow % 1_000_000 === 0 ? 0 : 1)}M`
            : `${Math.round(ctxWindow / 1000)}K`
          return (
            <div key={m.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-vibe-surface/50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-vibe-text truncate">{m.label}</span>
                {isSystemDefault ? (
                  <span className="text-xs text-vibe-muted truncate">Uses CLI configured model</span>
                ) : (
                  <span className="text-xs text-vibe-muted font-mono truncate" title={m.id}>{m.id}</span>
                )}
                {isBuiltIn && !isSystemDefault && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-vibe-border text-vibe-muted flex-shrink-0">{m.kind === 'alias' ? 'alias' : 'catalog'}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {!isSystemDefault && (
                  <ShortLabelEditor
                    value={m.shortLabel || ''}
                    onChange={(v) => updateCustomModel(provider.id, m.id, { shortLabel: v })}
                  />
                )}
                {!isSystemDefault && (
                  <ContextWindowEditor value={ctxWindow} display={ctxDisplay} onChange={(v) => updateCustomModel(provider.id, m.id, { contextWindow: v })} />
                )}
                {isDefault ? (
                  <span className="px-2 py-0.5 rounded text-xs font-medium bg-vibe-primary/20 text-vibe-primary">Default</span>
                ) : (
                  <button onClick={() => setDefault(m.id)} className="px-2 py-0.5 rounded text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 transition-colors">Set Default</button>
                )}
                {isCustomOnly && (
                  <button onClick={() => removeCustomModel(provider.id, m.id)} className="p-0.5 text-vibe-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors" title="Remove custom model">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {currentDefault && (
          <button onClick={() => setDefault(null)} className="text-xs text-vibe-muted hover:text-vibe-text transition-colors">Reset to catalog default</button>
        )}
        <AddCustomModelForm providerId={provider.id} onAdd={addCustomModel} />
      </div>
    </div>
  )
}

function AddCustomModelForm({ providerId, onAdd }: { providerId: string; onAdd: (providerId: string, model: AIModelOption) => void }) {
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [shortLabel, setShortLabel] = useState('')
  const [ctxWindowK, setCtxWindowK] = useState('')
  const [expanded, setExpanded] = useState(false)

  const handleAdd = () => {
    const trimmedId = modelId.trim()
    const trimmedLabel = label.trim()
    if (!trimmedId || !trimmedLabel) return
    if (!/^[A-Za-z0-9._:[\]-]{1,128}$/.test(trimmedId)) {
      alert('Model ids may only contain letters, digits and . _ : [ ] -')
      return
    }
    const ctxValue = parseInt(ctxWindowK) || 200
    const trimmedShort = shortLabel.trim()
    onAdd(providerId, { id: trimmedId, label: trimmedLabel, ...(trimmedShort ? { shortLabel: trimmedShort } : {}), contextWindow: ctxValue * 1000 })
    setModelId('')
    setLabel('')
    setShortLabel('')
    setCtxWindowK('')
    setExpanded(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAdd()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setExpanded(false)
    }
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-xs text-vibe-muted hover:text-vibe-text transition-colors pt-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Add custom model
      </button>
    )
  }

  return (
    <div className="flex items-end gap-2 pt-2 border-t border-vibe-border">
      <div className="flex-1">
        <label className="block text-[10px] text-vibe-muted mb-0.5">Model ID</label>
        <input
          type="text"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. model-id-2026"
          className="w-full px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary font-mono"
          autoFocus
        />
      </div>
      <div className="flex-1">
        <label className="block text-[10px] text-vibe-muted mb-0.5">Display Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. Model 2026"
          className="w-full px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary"
        />
      </div>
      <div className="w-16">
        <label className="block text-[10px] text-vibe-muted mb-0.5">Short Label</label>
        <input
          type="text"
          value={shortLabel}
          onChange={(e) => setShortLabel(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g. S5"
          maxLength={6}
          className="w-full px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary"
        />
      </div>
      <div className="w-20">
        <label className="block text-[10px] text-vibe-muted mb-0.5">Context (K)</label>
        <input
          type="number"
          value={ctxWindowK}
          onChange={(e) => setCtxWindowK(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="200"
          className="w-full px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary font-mono"
        />
      </div>
      <button
        onClick={handleAdd}
        disabled={!modelId.trim() || !label.trim()}
        className="px-2 py-1 text-xs font-medium rounded transition-colors text-white disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: (!modelId.trim() || !label.trim()) ? undefined : 'var(--accent-color)' }}
      >
        Add
      </button>
      <button
        onClick={() => { setExpanded(false); setModelId(''); setLabel(''); setShortLabel(''); setCtxWindowK('') }}
        className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

// ============== Toggle Switch Component ==============
interface ToggleSwitchProps {
  enabled: boolean
  onChange?: () => void
  disabled?: boolean
}

function ToggleSwitch({ enabled, onChange, disabled }: ToggleSwitchProps) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors ${
        enabled ? 'toggle-accent' : 'bg-vibe-border'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      style={enabled ? { backgroundColor: 'var(--accent-color)' } : undefined}
    >
      <div
        className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${
          enabled ? 'left-6' : 'left-1'
        }`}
      />
    </button>
  )
}

// Environment edit modal for Settings panel
interface SettingsEnvironmentEditModalProps {
  environment: TerminalEnvironment | null
  onSave: (data: Omit<TerminalEnvironment, 'id' | 'createdAt' | 'updatedAt' | 'isBuiltIn' | 'isAvailable'>) => void
  onClose: () => void
}

function SettingsEnvironmentEditModal({ environment, onSave, onClose }: SettingsEnvironmentEditModalProps) {
  const [name, setName] = useState(environment?.name || '')
  const [description, setDescription] = useState(environment?.description || '')
  const [envType, setEnvType] = useState<TerminalEnvironmentType>(environment?.type || 'custom')
  const [shell, setShell] = useState<ScriptShell>(environment?.shell || 'default')
  const [initCommands, setInitCommands] = useState(environment?.initCommands?.join('\n') || '')
  const [envVars, setEnvVars] = useState(
    environment?.env ? Object.entries(environment.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const env: Record<string, string> = {}
    envVars.split('\n').filter(line => line.trim()).forEach(line => {
      const eqIndex = line.indexOf('=')
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim()
        const value = line.substring(eqIndex + 1).trim()
        env[key] = value
      }
    })

    const commands = initCommands.split('\n').filter(cmd => cmd.trim())

    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      type: envType,
      shell,
      initCommands: commands.length > 0 ? commands : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    })
  }

  return (
    <div data-settings-nested-dialog className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-vibe-bg border border-vibe-border rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-vibe-border">
          <h2 className="text-lg font-semibold text-vibe-text">
            {environment ? 'Edit Environment' : 'New Custom Environment'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-vibe-muted mb-1">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Rust Dev Environment"
              className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-amber-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-vibe-muted mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Environment for Rust development with cargo"
              className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-amber-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-vibe-muted mb-1">Type</label>
              <select
                value={envType}
                onChange={(e) => setEnvType(e.target.value as TerminalEnvironmentType)}
                className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text focus:outline-none focus:border-amber-500"
              >
                <option value="custom">Custom</option>
                <option value="system-cmd">System CMD</option>
                <option value="system-powershell">System PowerShell</option>
                <option value="system-bash">System Bash</option>
                <option value="vs-native">VS Native Tools</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-vibe-muted mb-1">Shell</label>
              <select
                value={shell}
                onChange={(e) => setShell(e.target.value as ScriptShell)}
                className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text focus:outline-none focus:border-amber-500"
              >
                <option value="default">Default</option>
                <option value="cmd">CMD</option>
                <option value="powershell">PowerShell</option>
                <option value="bash">Bash</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-vibe-muted mb-1">
              Init Commands
              <span className="ml-1 text-xs opacity-75">(run when terminal starts, one per line)</span>
            </label>
            <textarea
              value={initCommands}
              onChange={(e) => setInitCommands(e.target.value)}
              placeholder='call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64'
              rows={3}
              className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-amber-500 font-mono text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-vibe-muted mb-1">
              Environment Variables
              <span className="ml-1 text-xs opacity-75">(one per line: KEY=value)</span>
            </label>
            <textarea
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              placeholder="RUSTFLAGS=-C target-cpu=native"
              rows={3}
              className="w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-amber-500 font-mono text-sm"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-vibe-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-vibe-muted hover:text-vibe-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-vibe-bg-lighter disabled:text-vibe-muted rounded-lg transition-colors"
            >
              {environment ? 'Save Changes' : 'Create Environment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
