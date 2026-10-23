import { useState, useRef, useEffect } from 'react'
import type { AgentApprovalMode } from '../../generated/bindings'
import { TerminalState } from '../../types'
import { APPROVAL_MODE_INFO, providerColor, providerShortName, useProviderInfo } from '../../agents/providers'
import { relaunchAgent } from '../../agents/launch'
import { usePluginRegistry } from '../../plugins/registry'
import { useContextUsage } from '../../hooks/useContextUsage'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore } from '../../stores/toolStore'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'
import { removeTerminalPreservingLocked } from '../../lib/layoutUtils'
import { confirmTerminalClose } from '../../lib/terminalUtils'
import { generateTitle } from '../../lib/titles'
import { useFloatingWindowStore } from '../../stores/floatingWindowStore'
import { terminalApi } from '../../lib/tauri-api'
import ContextUsageIndicator from './ContextUsageIndicator'
import { runPluginCommand } from '../../plugins/commands'
import StoredPromptsModal from '../terminal/StoredPromptsModal'

// Width breakpoints for progressive element hiding
const BP_COMPACT = 350   // hide model badge, regen title, context usage
const BP_NARROW = 250    // also hide provider badge, pop out, lock, sync dot
const BP_MINIMAL = 180   // also hide drag handle, minimize

interface TerminalTileToolbarProps {
  terminal: TerminalState
  onPaneDragStart?: (tileId: string, e: React.MouseEvent) => void
}

export default function TerminalTileToolbar({ terminal, onPaneDragStart }: TerminalTileToolbarProps) {
  const {
    activeTerminalId,
    setActiveTerminal,
    removeTerminal,
    minimizeTerminal,
    updateTerminal,
    toggleTerminalLock,
  } = useTerminalStore()
  const { popOutPanel, isFloating } = useFloatingWindowStore()
  const isActive = activeTerminalId === terminal.id
  const isPoppedOut = isFloating(terminal.id)

  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [showStoredPrompts, setShowStoredPrompts] = useState(false)
  const [isTogglingPermissions, setIsTogglingPermissions] = useState(false)
  const [showPinMenu, setShowPinMenu] = useState(false)

  const workspacesList = useGlobalWorkspaceStore(s => s.workspaces)
  const isGlobal = terminal.scope === 'global'
  const inputRef = useRef<HTMLInputElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)
  const [toolbarWidth, setToolbarWidth] = useState(Infinity)

  // Track toolbar width for responsive hiding
  useEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setToolbarWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowOpen) return
    const handleClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [overflowOpen])

  const showCompact = toolbarWidth > BP_COMPACT
  const showNarrow = toolbarWidth > BP_NARROW
  const showMinimal = toolbarWidth > BP_MINIMAL
  // Title generators: plugins → provider sessionTitle → chat API → heuristic (src/lib/titles.ts).
  const canGenerateTitle = !!terminal.originalPrompt?.trim()

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!await confirmTerminalClose(terminal)) return
    // If this terminal is pinned to a global workspace, the leaf id sits in
    // the workspace's sub-tree — strip it there before nuking the terminal,
    // otherwise the global tile would keep rendering a leaf with no backing
    // terminal state.
    if (isGlobal) {
      useGlobalWorkspaceStore.getState().removeLeafFromAnyWorkspace(terminal.id)
    }
    await terminalApi.kill(terminal.id)
    removeTerminal(terminal.id)
  }

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation()
    minimizeTerminal(terminal.id)
  }

  const handleToggleLock = (e: React.MouseEvent) => {
    e.stopPropagation()
    toggleTerminalLock(terminal.id)
  }

  const handlePopOut = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const title = terminal.title || terminal.originalPrompt || 'Terminal'
    await popOutPanel(terminal.id, 'terminal', title)
  }

  // Relaunch the agent with another approval mode, resuming its session (§8.2 `agents_relaunch`).
  const handleSwitchApprovalMode = async (e: React.MouseEvent, mode: AgentApprovalMode) => {
    e.stopPropagation()
    if (!terminal.agent) return
    setIsTogglingPermissions(true)
    try {
      await relaunchAgent(terminal.id, { approvalMode: mode, resume: !!terminal.agent.sessionId })
    } catch (err) {
      console.error('Relaunch failed:', err)
    } finally {
      setIsTogglingPermissions(false)
    }
  }

  const handleFocus = () => {
    setActiveTerminal(terminal.id)
  }

  // Pin / unpin to a global workspace.
  const pinIntoWorkspace = async (workspaceId: string) => {
    // Strip from project layout tree first (only relevant when scope='session').
    if (!isGlobal) {
      const termStore = useTerminalStore.getState()
      const toolStore = useToolStore.getState()
      const lockedIds = new Set<string>()
      termStore.terminals.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
      toolStore.toolInstances.forEach((t) => { if (t.isLocked) lockedIds.add(t.id) })
      const { tree: newTree } = removeTerminalPreservingLocked(
        termStore.layoutTree, terminal.id, lockedIds, [],
      )
      termStore.setLayoutTree(newTree)
    }
    await useGlobalWorkspaceStore.getState().pinTerminalToWorkspace(terminal.id, workspaceId)
  }

  const handleClickPin = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const gs = useGlobalWorkspaceStore.getState()
    if (isGlobal) {
      await gs.unpinTerminal(terminal.id)
      return
    }
    const enabled = Array.from(workspacesList.values()).filter(w => w.enabled)
    if (enabled.length === 1) {
      await pinIntoWorkspace(enabled[0].id)
      return
    }
    setShowPinMenu(true)
  }

  const handlePickWorkspace = async (workspaceId: string) => {
    setShowPinMenu(false)
    await pinIntoWorkspace(workspaceId)
  }

  const handleCreateAndPin = async () => {
    const name = prompt('New workspace name:', `Workspace ${workspacesList.size + 1}`)?.trim()
    if (!name) { setShowPinMenu(false); return }
    const newId = await useGlobalWorkspaceStore.getState().createWorkspace(name)
    setShowPinMenu(false)
    await pinIntoWorkspace(newId)
  }

  const handleTitleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setEditValue(terminal.title || terminal.originalPrompt || '')
    setIsEditing(true)
  }

  const handleTitleSave = () => {
    const trimmedValue = editValue.trim()
    if (trimmedValue) {
      updateTerminal(terminal.id, { title: trimmedValue, titleSource: 'manual' })
    }
    setIsEditing(false)
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTitleSave()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  const handleTitleBlur = () => {
    handleTitleSave()
  }

  const handleRegenerateTitle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const prompt = terminal.originalPrompt?.trim()
    if (!prompt) return

    setIsGeneratingTitle(true)
    try {
      const result = await generateTitle(prompt, { terminalId: terminal.id })
      updateTerminal(terminal.id, { title: result.title, titleSource: 'auto' })
    } catch (err) {
      console.error('Failed to regenerate title:', err)
    } finally {
      setIsGeneratingTitle(false)
    }
  }

  // Agent binding: provider badge, session state, context meter (provider hook).
  const agent = terminal.agent ?? null
  const sessionId = agent?.sessionId ?? null
  const provider = useProviderInfo(agent?.providerId)
  const approvalMode = agent?.approvalMode ?? 'default'
  const elevated = approvalMode === 'bypass' || approvalMode === 'auto'
  const contextUsage = useContextUsage(agent, terminal.workingDirectory)
  // Plugin commands scoped to this provider's terminals (`when: terminal.provider == '<id>'`).
  const contributions = usePluginRegistry((s) => s.contributions)
  const terminalCommands = !agent
    ? []
    : (contributions?.commands ?? []).filter((c) => {
        const m = /terminal\.provider\s*==\s*'([^']+)'/.exec(c.contribution.when ?? '')
        return !!m && m[1] === agent.providerId
      })
  // Plugin context menus for terminals (`contextMenus[].location: "terminal"`, e.g. "Share to
  // Discord"); a `when: terminal.provider == '<id>'` limits one to that provider's terminals.
  const terminalMenus = (contributions?.contextMenus ?? []).filter((c) => {
    if (c.contribution.location !== 'terminal') return false
    const m = /terminal\.provider\s*==\s*'([^']+)'/.exec(c.contribution.when ?? '')
    return !m || m[1] === agent?.providerId
  })

  // Display title: prefer custom title, then original prompt, then default title
  const displayTitle = terminal.title || terminal.originalPrompt || 'Terminal'

  // Return a native element - react-mosaic will wrap with connectDragSource
  return (
    <>
    <div
      ref={toolbarRef}
      className={`flex items-center justify-between ${showNarrow ? 'gap-2 px-2' : 'gap-1 px-1'} py-1.5 bg-vibe-surface border-b select-none ${
        terminal.isLocked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
      } ${
        terminal.isLocked ? 'border-amber-500/50' : (isActive ? 'border-vibe-primary' : 'border-vibe-border')
      }`}
      onClick={handleFocus}
      onMouseDown={(e) => {
        if (terminal.isLocked) return
        if ((e.target as HTMLElement).closest('button')) return
        if ((e.target as HTMLElement).closest('input')) return
        onPaneDragStart?.(terminal.id, e)
      }}
    >
      <div className={`flex items-center ${showNarrow ? 'gap-2' : 'gap-1'} min-w-0 flex-1`}>
        {/* Drag handle indicator - hidden at minimal width */}
        {showMinimal && (
          <div className="flex flex-col gap-0.5 opacity-40 hover:opacity-70 transition-opacity">
            <div className="flex gap-0.5">
              <div className="w-1 h-1 rounded-full bg-vibe-muted" />
              <div className="w-1 h-1 rounded-full bg-vibe-muted" />
            </div>
            <div className="flex gap-0.5">
              <div className="w-1 h-1 rounded-full bg-vibe-muted" />
              <div className="w-1 h-1 rounded-full bg-vibe-muted" />
            </div>
          </div>
        )}

        {/* Status indicator */}
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${
            terminal.status === 'active'
              ? 'bg-green-500'
              : terminal.status === 'error'
              ? 'bg-red-500'
              : 'bg-gray-500'
          }`}
        />

        {/* Provider badge (color / short name from the provider spec) - hidden at narrow width */}
        {showNarrow && agent && (
          <span
            data-testid="terminal-provider-badge"
            className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 flex items-center gap-1 text-white ${
              elevated ? 'bg-gradient-to-r from-amber-500 to-red-500' : ''
            }`}
            style={elevated ? undefined : { backgroundColor: providerColor(provider) }}
            title={`${provider?.displayName ?? agent.providerId}${approvalMode !== 'default' ? ` (${APPROVAL_MODE_INFO[approvalMode].label})` : ''}`}
          >
            {elevated && (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            {providerShortName(provider, agent.providerId)}
            {approvalMode === 'plan' && <span className="opacity-80">· Plan</span>}
          </span>
        )}

        {/* Title/prompt (truncated) - double-click to edit */}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            onBlur={handleTitleBlur}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-vibe-text bg-vibe-bg border border-vibe-primary rounded px-1 py-0.5 flex-1 min-w-0 outline-none"
            placeholder="Terminal title..."
          />
        ) : (
          <span
            className="text-xs text-vibe-muted truncate flex-1 cursor-text hover:text-vibe-text transition-colors"
            title={`${displayTitle} (double-click to edit)`}
            onDoubleClick={handleTitleDoubleClick}
          >
            {displayTitle}
          </span>
        )}

        {/* AI session sync indicator - hidden at narrow width */}
        {showNarrow && agent && agent.syncEnabled !== false && (() => {
          const syncSessionId = sessionId
          const isSynced = !!syncSessionId
          return (
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 cursor-help ${
                isSynced
                  ? 'bg-green-400'
                  : 'bg-orange-400 animate-pulse'
              }`}
              title={
                syncSessionId
                  ? `Synced\n\nSession ID: ${syncSessionId}\nClick to copy`
                  : agent.sessionState === 'unlinked' ? 'No session found' : 'Waiting for session...'
              }
              onClick={(e) => {
                e.stopPropagation()
                if (syncSessionId) {
                  navigator.clipboard.writeText(syncSessionId)
                  console.log(`[Session] Copied to clipboard: ${syncSessionId}`)
                }
              }}
            />
          )
        })()}

        {/* Context window usage (provider `contextUsage` hook) - hidden at compact width */}
        {showCompact && contextUsage.available && (
          <ContextUsageIndicator
            estimatedTokens={contextUsage.estimatedTokens}
            contextWindow={contextUsage.contextWindow}
            percentage={contextUsage.percentage}
            isLoading={contextUsage.isLoading}
          />
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {/* Overflow menu */}
        <div className="relative" ref={overflowRef}>
          <button
            onClick={(e) => { e.stopPropagation(); setOverflowOpen(!overflowOpen) }}
            className={`p-1 rounded transition-colors ${
              overflowOpen
                ? 'text-vibe-text bg-vibe-border/50'
                : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
            }`}
            title="More actions"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          {overflowOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-vibe-surface border border-vibe-border rounded-lg shadow-xl py-1 min-w-[180px]">
              {/* Regenerate title */}
              <button
                onClick={(e) => { handleRegenerateTitle(e); setOverflowOpen(false) }}
                disabled={isGeneratingTitle || !canGenerateTitle}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isGeneratingTitle ? (
                  <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                ) : (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5 19a9 9 0 0014-7 9 9 0 00-9-9" />
                  </svg>
                )}
                Regenerate title
              </button>

              {/* Provider plugin commands for this terminal (e.g. rewind) */}
              {terminalCommands.map((c) => (
                <button
                  key={`${c.pluginId}/${c.contribution.id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOverflowOpen(false)
                    runPluginCommand(c.pluginId, c.contribution.id, {
                      terminalId: terminal.id,
                      sessionId: sessionId ?? null,
                      cwd: terminal.workingDirectory ?? null,
                    }).catch((err) => console.error(`${c.contribution.title} failed:`, err))
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                  {c.contribution.title}
                </button>
              ))}

              {/* Relaunch with another approval mode (the provider's supported modes) */}
              {agent && provider && provider.approvalModes.length > 1 && (
                <>
                  <div className="border-t border-vibe-border my-1" />
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-vibe-muted">
                    {sessionId ? 'Resume with approval mode' : 'Relaunch with approval mode'}
                  </div>
                  {provider.approvalModes.filter((m) => m !== approvalMode).map((m) => (
                    <button
                      key={m}
                      onClick={(e) => { void handleSwitchApprovalMode(e, m); setOverflowOpen(false) }}
                      disabled={isTogglingPermissions}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        m === 'bypass' ? 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10' : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30'
                      }`}
                    >
                      {isTogglingPermissions ? (
                        <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      ) : (
                        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      )}
                      {APPROVAL_MODE_INFO[m].label}
                    </button>
                  ))}
                  <div className="border-t border-vibe-border my-1" />
                </>
              )}

              {/* Pop out */}
              <button
                onClick={(e) => { handlePopOut(e); setOverflowOpen(false) }}
                disabled={isPoppedOut}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                {isPoppedOut ? 'Already floating' : 'Pop out'}
              </button>

              {/* Pin to / unpin from a global workspace */}
              <button
                onClick={(e) => { handleClickPin(e); setOverflowOpen(false) }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  isGlobal
                    ? 'text-cyan-300 hover:text-cyan-300 hover:bg-cyan-500/10'
                    : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30'
                }`}
              >
                {isGlobal ? (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M2 12h20" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                )}
                {isGlobal ? 'Move to project workspace' : 'Pin to global workspace'}
              </button>

              {/* Stored Prompts */}
              <button
                onClick={(e) => { e.stopPropagation(); setShowStoredPrompts(true); setOverflowOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors"
              >
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Stored Prompts
              </button>

              {/* Lock/Unlock */}
              <button
                onClick={(e) => { handleToggleLock(e); setOverflowOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors"
              >
                {terminal.isLocked ? (
                  <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  </svg>
                )}
                {terminal.isLocked ? 'Unlock pane' : 'Lock pane'}
              </button>

              {/* Plugin context menus for terminals */}
              {terminalMenus.length > 0 && <div className="border-t border-vibe-border my-1" />}
              {terminalMenus.map((c) => (
                <button
                  key={`${c.pluginId}/${c.contribution.id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setOverflowOpen(false)
                    runPluginCommand(c.pluginId, c.contribution.command, {
                      terminalId: terminal.id,
                      title: terminal.title || terminal.originalPrompt || 'Terminal',
                      sessionId: sessionId ?? null,
                      cwd: terminal.workingDirectory ?? null,
                    }).catch((err) => console.error(`${c.contribution.title} failed:`, err))
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/30 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                  {c.contribution.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pin to / unpin from a global workspace — visible at non-narrow widths */}
        {showNarrow && (
          <div className="relative">
            <button
              onClick={handleClickPin}
              className={`p-1 rounded transition-colors ${
                isGlobal
                  ? 'text-cyan-300 bg-cyan-500/25 hover:bg-cyan-500/40 ring-1 ring-cyan-400/50'
                  : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
              }`}
              title={isGlobal
                ? 'Move to project workspace (unpin from global)'
                : 'Pin to a global workspace (persist across project switches)'}
            >
              {isGlobal ? (
                /* "Move out" icon: arrow leaving a box → back to project */
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              )}
            </button>
            {showPinMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPinMenu(false)} />
                <div
                  className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-vibe-surface border border-vibe-border rounded shadow-lg py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1 text-xs text-vibe-muted uppercase tracking-wide">
                    Pin to workspace
                  </div>
                  {Array.from(workspacesList.values()).filter(w => w.enabled).map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => handlePickWorkspace(ws.id)}
                      className="w-full text-left px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/50"
                    >
                      {ws.name}
                    </button>
                  ))}
                  <div className="border-t border-vibe-border my-1" />
                  <button
                    onClick={handleCreateAndPin}
                    className="w-full text-left px-3 py-1.5 text-sm text-teal-400 hover:bg-vibe-border/50"
                  >
                    + New workspace…
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Minimize button — hidden for global panes. The minimized strip is
            session-scoped (per project), so a globally-pinned terminal there
            would make no sense; the workspace itself has its own minimize. */}
        {showMinimal && !isGlobal && (
          <button
            onClick={handleMinimize}
            className="p-1 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title="Minimize terminal"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
        )}

        {/* Close button */}
        <button
          onClick={handleClose}
          className="p-1 text-vibe-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
          title="Close terminal"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
    <StoredPromptsModal
      isOpen={showStoredPrompts}
      onClose={() => setShowStoredPrompts(false)}
      targetTerminalId={terminal.id}
    />
    </>
  )
}
