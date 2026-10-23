import { useEffect, useState, useRef, useCallback } from 'react'
import { useToolStore } from '../../stores/toolStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { insertTerminalFillEmpty } from '../../lib/layoutUtils'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import ToolTileContent from './ToolTileContent'
import { ToolIcon, canOpenInPane, flyoutDefaultSize, getToolContribution } from '../../plugins/tools'

const MIN_WIDTH = 320
const MIN_HEIGHT = 200
const MAX_WIDTH_RATIO = 0.92
const MAX_HEIGHT_RATIO = 0.85

type ResizeEdge = 'e' | 's' | 'se' | 'sw'

export default function ToolFlyoutPanel() {
  const { activeFlyout, closeFlyout, toolConfigs, flyoutInstances, toolInstances, popFlyoutToPane, updateToolConfig } = useToolStore()
  const { layoutTree, setLayoutTree, activeTerminalId, setActiveTerminal } = useTerminalStore()
  const [visible, setVisible] = useState(false)
  const [closing, setClosing] = useState(false)
  const [panelWidth, setPanelWidth] = useState(480)
  const [panelHeight, setPanelHeight] = useState(400)
  const [panelLeft, setPanelLeft] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{
    edge: ResizeEdge
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    startLeft: number
  } | null>(null)

  const config = activeFlyout ? toolConfigs.get(activeFlyout.configId) : null
  // PTY-backed tiles (TUI): xterm handles its own scrolling.

  // The flyout's tile instance (kept alive across open/close, not in the layout)
  const flyoutInstanceId = activeFlyout ? flyoutInstances.get(activeFlyout.configId) : undefined
  const flyoutInstance = flyoutInstanceId ? toolInstances.get(flyoutInstanceId) : undefined

  // Register overlay so native webviews (YouTube Shorts) hide when flyout is open
  useOverlayRegistration('tool-flyout', !!activeFlyout)

  // Calculate initial left position based on anchor
  const calculateLeft = useCallback((width: number, anchorRect: DOMRect) => {
    let left = anchorRect.left + anchorRect.width / 2 - width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    return left
  }, [])

  // Initialize panel dimensions when flyout opens
  useEffect(() => {
    if (activeFlyout && config) {
      const defaults = flyoutDefaultSize(getToolContribution(config))
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)
      const w = config.flyoutWidth ?? defaults[0]
      const h = config.flyoutHeight ?? defaults[1]
      const clampedW = Math.min(Math.max(w, MIN_WIDTH), maxW)
      setPanelWidth(clampedW)
      setPanelHeight(Math.min(Math.max(h, MIN_HEIGHT), maxH))
      setPanelLeft(calculateLeft(clampedW, activeFlyout.anchorRect))
    }
  }, [activeFlyout?.configId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Animate in when flyout opens
  useEffect(() => {
    if (activeFlyout && config) {
      requestAnimationFrame(() => {
        setVisible(true)
        setClosing(false)
      })
    } else {
      setVisible(false)
      setClosing(false)
    }
  }, [activeFlyout, config])

  // The flyout is open but its tile instance is gone: a workspace restore that finished after
  // the flyout was opened (app startup / reload, workspace switch) cleared the tool instances.
  // Recreate it, or the panel would show its loading spinner forever.
  const recreating = useRef(false)
  useEffect(() => {
    if (!activeFlyout || !config || flyoutInstance || recreating.current) return
    recreating.current = true
    void useToolStore.getState().ensureFlyoutInstance(activeFlyout.configId).finally(() => {
      recreating.current = false
    })
  }, [activeFlyout, config, flyoutInstance])

  // Animate out then close
  const handleClose = useCallback(() => {
    setClosing(true)
    setVisible(false)
    setTimeout(() => {
      closeFlyout()
      setClosing(false)
    }, 200)
  }, [closeFlyout])

  // Escape key closes
  useEffect(() => {
    if (!activeFlyout) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeFlyout, handleClose])

  // Window resize: reposition/clamp instead of closing
  useEffect(() => {
    if (!activeFlyout) return

    const handleWindowResize = () => {
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)
      setPanelWidth(prev => {
        const newW = Math.min(prev, maxW)
        // Recalculate left position with new width
        setPanelLeft(calculateLeft(newW, activeFlyout.anchorRect))
        return newW
      })
      setPanelHeight(prev => Math.min(prev, maxH))
    }

    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [activeFlyout, calculateLeft])

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: panelWidth,
      startHeight: panelHeight,
      startLeft: panelLeft,
    }
    setIsResizing(true)
    document.body.classList.add(`flyout-resizing-${edge}`)
  }, [panelWidth, panelHeight, panelLeft])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return
      const { edge, startX, startY, startWidth, startHeight, startLeft } = resizeRef.current
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)

      if (edge === 'e' || edge === 'se') {
        const dx = e.clientX - startX
        setPanelWidth(Math.min(Math.max(startWidth + dx, MIN_WIDTH), maxW))
      }
      if (edge === 'sw') {
        // Resize from left: width changes inversely with left position
        const dx = e.clientX - startX
        const newWidth = Math.min(Math.max(startWidth - dx, MIN_WIDTH), maxW)
        const widthDelta = startWidth - newWidth
        const newLeft = Math.max(8, Math.min(startLeft + widthDelta, window.innerWidth - MIN_WIDTH - 8))
        setPanelWidth(newWidth)
        setPanelLeft(newLeft)
      }
      if (edge === 's' || edge === 'se' || edge === 'sw') {
        const dy = e.clientY - startY
        setPanelHeight(Math.min(Math.max(startHeight + dy, MIN_HEIGHT), maxH))
      }
    }

    const handleMouseUp = () => {
      if (resizeRef.current) {
        document.body.classList.remove(`flyout-resizing-${resizeRef.current.edge}`)
      }
      resizeRef.current = null
      setIsResizing(false)

      // Persist the final dimensions
      if (activeFlyout) {
        updateToolConfig(activeFlyout.configId, {
          flyoutWidth: panelWidth,
          flyoutHeight: panelHeight,
        })
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, activeFlyout, panelWidth, panelHeight, updateToolConfig])

  if (!activeFlyout && !closing) return null
  if (!config) return null

  const { anchorRect } = activeFlyout!

  // Position below the trigger button
  const top = anchorRect.bottom + 4

  const handlePopToPane = () => {
    if (!activeFlyout) return
    const instanceId = popFlyoutToPane(activeFlyout.configId)
    if (instanceId) {
      const splitDir = useAppSettingsStore.getState().toolbar.defaultSplitDirection
      const newTree = insertTerminalFillEmpty(layoutTree, instanceId, activeTerminalId, splitDir)
      setLayoutTree(newTree)
      setActiveTerminal(instanceId)
    }
  }

  const handleBackdropClick = () => {
    // Don't close if user was resizing (mouseup on backdrop after drag)
    if (isResizing) return
    handleClose()
  }

  const renderContent = () => {
    if (!flyoutInstance) {
      return (
        <div className="flex items-center justify-center h-48 text-vibe-muted">
          <div className="animate-spin w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full" />
        </div>
      )
    }
    return (
      <div style={{ height: '100%' }}>
        <ToolTileContent instance={flyoutInstance} config={config} mode="flyout" visible={visible} onClose={handleClose} />
      </div>
    )
  }

  return (
    <>
      {/* Transparent backdrop for click-outside dismissal */}
      <div
        className="fixed inset-0 z-[60]"
        onClick={handleBackdropClick}
      />

      {/* Flyout panel */}
      <div
        ref={panelRef}
        className="fixed z-[61] bg-vibe-surface border border-vibe-border rounded-lg shadow-xl overflow-hidden"
        style={{
          top: `${top}px`,
          left: `${panelLeft}px`,
          width: `${panelWidth}px`,
          height: `${panelHeight}px`,
          transformOrigin: 'top',
          transition: isResizing ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
          transform: visible ? 'scaleY(1) translateY(0)' : 'scaleY(0.95) translateY(-8px)',
          opacity: visible ? 1 : 0,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-vibe-border bg-vibe-bg/50">
          <div className="flex items-center gap-2 min-w-0">
            <span className="flex-shrink-0" style={config.color ? { color: config.color } : undefined}>
              <ToolIcon config={config} />
            </span>
            <span className="text-sm font-medium text-vibe-text truncate" style={config.color ? { color: config.color } : undefined}>
              {config.name}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {/* Pop to Pane (the flyout's tile instance moves into the layout) */}
            {flyoutInstance && canOpenInPane(getToolContribution(config)) && (
              <button
                onClick={handlePopToPane}
                className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
                title="Pop to pane"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            )}
            <button
              onClick={handleClose}
              className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content - no overflow-auto for PTY tiles (xterm handles its own scrolling) */}
        <div className="overflow-auto" style={{ height: 'calc(100% - 40px)' }}>
          {renderContent()}
        </div>

        {/* Resize handle: right edge */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'e')}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '6px',
            height: '100%',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
          className="group"
        >
          <div className="absolute top-0 right-0 w-[2px] h-full opacity-0 group-hover:opacity-100 bg-vibe-primary/50 transition-opacity" />
        </div>

        {/* Resize handle: bottom edge */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 's')}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: '6px',
            cursor: 'ns-resize',
            zIndex: 10,
          }}
          className="group"
        >
          <div className="absolute bottom-0 left-0 w-full h-[2px] opacity-0 group-hover:opacity-100 bg-vibe-primary/50 transition-opacity" />
        </div>

        {/* Resize handle: bottom-right corner */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'se')}
          style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: '12px',
            height: '12px',
            cursor: 'nwse-resize',
            zIndex: 11,
          }}
          className="group"
        >
          <div className="absolute bottom-[2px] right-[2px] w-[8px] h-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-vibe-primary/50">
              <path d="M7 1L1 7M7 4L4 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Resize handle: bottom-left corner */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'sw')}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '12px',
            height: '12px',
            cursor: 'nesw-resize',
            zIndex: 11,
          }}
          className="group"
        >
          <div className="absolute bottom-[2px] left-[2px] w-[8px] h-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-vibe-primary/50">
              <path d="M1 1L7 7M1 4L4 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>
    </>
  )
}
