import { useState, useRef, useEffect } from 'react'
import { useOverlayRegistration } from '../../stores/overlayStore'
import logoImage from '../../assets/logo.png'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore, countPaneTools } from '../../stores/toolStore'
import AgentLaunchDialog from '../../agents/AgentLaunchDialog'
import ToolsDropdown from '../tools/ToolsDropdown'
import QuickAccessTools from '../tools/QuickAccessTools'
import ToolDragContext from '../tools/ToolDragContext'
import ToolConfigModal from '../tools/ToolConfigModal'
import ToolFlyoutPanel from '../tools/ToolFlyoutPanel'
import LayoutPresetDropdown from './LayoutPresetDropdown'
import AppSettingsModal from '../settings/AppSettingsModal'
import SettingsMenu from './SettingsMenu'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useProjectSidebarStore } from '../../stores/projectSidebarStore'
import { LAYOUT_PRESETS, getTerminalIdsFromTree } from '../../lib/layoutUtils'
import CliStatusFlyout from './CliStatusFlyout'

export default function Toolbar() {
  const {
    terminals,
    minimizedTerminals,
    resetLayout,
    cycleLayoutPreset,
    currentLayoutPreset,
  } = useTerminalStore()

  const { toolInstances, minimizedTools } = useToolStore()
  const { setShowSettingsModal: setShowAppSettings, toolbar, toggleSplitDirection } = useAppSettingsStore()

  const [showOverflowMenu, setShowOverflowMenu] = useState(false)
  const overflowMenuRef = useRef<HTMLDivElement>(null)

  // Register overlays so native webviews (YouTube Shorts) hide when toolbar menus are open
  useOverlayRegistration('toolbar-overflow-menu', showOverflowMenu)

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(event.target as Node)) {
        setShowOverflowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const currentPreset = LAYOUT_PRESETS.find(p => p.type === currentLayoutPreset) || LAYOUT_PRESETS[0]

  return (
    <ToolDragContext>
    <div className="flex items-center gap-1 sm:gap-2 px-2 py-1.5 bg-vibe-surface border-b border-vibe-border min-w-0">
      {/* Left section: Logo + combined Settings/Profile menu + Left pinned tools */}
      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
        <img src={logoImage} alt="QuadFlow" className="w-5 h-5 sm:w-6 sm:h-6 rounded" />
        <span className="font-semibold text-vibe-text text-sm hidden md:block">QuadFlow</span>
        {/* Settings dropdown */}
        <SettingsMenu />
        <ToolsDropdown />
        <QuickAccessTools section="left" />
      </div>

      {/* Center section: flexible tool zone */}
      <div className="flex-1 min-w-0 flex items-center justify-center gap-1">
        <QuickAccessTools section="center" />
      </div>

      {/* Right tool zone: right pinned tools */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <QuickAccessTools section="right" />
      </div>

      {/* Separator between tool zones and fixed controls */}
      <div className="w-px h-5 bg-vibe-border flex-shrink-0 hidden sm:block" />

      {/* Right fixed controls: CLI status, Split, Layout, Window Count */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* CLI install status — shows whether `quadflow` is on PATH and
            whether the on-PATH version matches this app. */}
        <CliStatusFlyout onOpenSettings={() => setShowAppSettings(true)} />

        {/* Split Direction Toggle */}
        <button
          onClick={toggleSplitDirection}
          className={`hidden sm:flex items-center justify-center w-8 h-8 rounded border transition-colors ${
            toolbar.defaultSplitDirection === 'column'
              ? 'bg-vibe-primary/10 border-vibe-primary/50 text-vibe-primary'
              : 'bg-vibe-surface border-vibe-border text-vibe-muted hover:bg-vibe-border/50 hover:text-vibe-text'
          }`}
          title={`Split: ${toolbar.defaultSplitDirection === 'row' ? 'Horizontal' : 'Vertical'}`}
        >
          {toolbar.defaultSplitDirection === 'row' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16M4 4h16v16H4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12h16M4 4h16v16H4z" />
            </svg>
          )}
        </button>

        {/* Layout Preset Dropdown - left click cycles, right click opens menu
            (Global Workspaces moved into the right-side ProjectSidebar.) */}
        <LayoutPresetDropdown />

        {/* Window Count - compact (terminals + tools), click to diagnose */}
        <button
          onClick={() => {
            const layoutTree = useTerminalStore.getState().layoutTree
            const treeIds = new Set(getTerminalIdsFromTree(layoutTree))
            const allTerminals = Array.from(terminals.values())
            const allTools = Array.from(toolInstances.values())

            const termInTree = allTerminals.filter(t => treeIds.has(t.id))
            const termOrphan = allTerminals.filter(t => !treeIds.has(t.id) && !minimizedTerminals.includes(t.id))
            const toolInTree = allTools.filter(t => treeIds.has(t.id))
            const toolOrphan = allTools.filter(t => !treeIds.has(t.id) && !minimizedTools.includes(t.id) && !t.isFlyoutInstance)
            const toolFlyout = allTools.filter(t => t.isFlyoutInstance)

            console.group('Window Count Diagnostic')
            console.log(`Total count: ${terminals.size + countPaneTools(toolInstances)} (${terminals.size} terminals + ${countPaneTools(toolInstances)} tools)`)
            console.log(`Layout tree IDs: [${[...treeIds].join(', ')}]`)
            console.log('')
            console.log(`Terminals in tree: ${termInTree.length}`, termInTree.map(t => ({ id: t.id, title: t.title, provider: t.agent?.providerId })))
            console.log(`Terminals minimized: ${minimizedTerminals.length}`, minimizedTerminals)
            console.log(`Terminals ORPHANED: ${termOrphan.length}`, termOrphan.map(t => ({ id: t.id, title: t.title, provider: t.agent?.providerId, status: t.status, createdAt: new Date(t.createdAt).toLocaleString() })))
            console.log('')
            console.log(`Tools in tree: ${toolInTree.length}`, toolInTree.map(t => ({ id: t.id, title: t.title, configId: t.configId })))
            console.log(`Tools minimized: ${minimizedTools.length}`, minimizedTools)
            console.log(`Tools flyout: ${toolFlyout.length}`, toolFlyout.map(t => ({ id: t.id, title: t.title, configId: t.configId })))
            console.log(`Tools ORPHANED: ${toolOrphan.length}`, toolOrphan.map(t => ({ id: t.id, title: t.title, configId: t.configId, status: t.status })))
            console.log('')
            console.log('Flyout registry:', Object.fromEntries(useToolStore.getState().flyoutInstances))
            console.groupEnd()
          }}
          className="hidden sm:block text-xs text-vibe-muted whitespace-nowrap px-1 hover:text-vibe-text cursor-pointer"
          title={`${terminals.size} terminal(s) and ${countPaneTools(toolInstances)} tool(s) open${(minimizedTerminals.length + minimizedTools.length) > 0 ? `, ${minimizedTerminals.length + minimizedTools.length} minimized` : ''}. Click to log a layout diagnostic to the dev console.`}
        >
          {terminals.size + countPaneTools(toolInstances)}
          {(minimizedTerminals.length + minimizedTools.length) > 0 && (
            <span className="text-yellow-500">/{minimizedTerminals.length + minimizedTools.length}</span>
          )}
        </button>

        {/* Overflow Menu for small screens */}
        <div className="relative sm:hidden" ref={overflowMenuRef}>
          <button
            onClick={() => setShowOverflowMenu(!showOverflowMenu)}
            className="flex items-center justify-center w-8 h-8 bg-vibe-surface border border-vibe-border text-vibe-text rounded hover:bg-vibe-border/50 transition-colors"
            title="More options"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>

          {/* Overflow Menu Dropdown */}
          {showOverflowMenu && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
              <button
                onClick={() => {
                  useProjectSidebarStore.getState().open()
                  setShowOverflowMenu(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Project & Workspaces
              </button>
              <div className="border-t border-vibe-border my-1" />
              <div className="px-3 py-1 text-xs text-vibe-muted">Layout</div>
              <button
                onClick={() => { cycleLayoutPreset(); setShowOverflowMenu(false); }}
                disabled={terminals.size === 0 && countPaneTools(toolInstances) === 0}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d={currentPreset.icon} />
                </svg>
                {currentPreset.name}
                <span className="text-xs text-vibe-muted ml-auto">tap to cycle</span>
              </button>
              <button
                onClick={() => { resetLayout(); setShowOverflowMenu(false); }}
                disabled={terminals.size === 0 && countPaneTools(toolInstances) === 0}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Reset Layout
              </button>
              <div className="border-t border-vibe-border my-1" />
              <div className="px-3 py-2 text-xs text-vibe-muted">
                {terminals.size} terminal{terminals.size !== 1 ? 's' : ''}
                {minimizedTerminals.length > 0 && (
                  <span className="text-yellow-500"> ({minimizedTerminals.length} min)</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <ToolConfigModal />
      <ToolFlyoutPanel />
      <AppSettingsModal />
      <AgentLaunchDialog />
    </div>
    </ToolDragContext>
  )
}
