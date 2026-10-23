import { useEffect, useState, useRef, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore } from '../../stores/toolStore'
import { useOverlayRegistration } from '../../stores/overlayStore'
import { ToolIcon } from '../../plugins/tools'
import ProviderBadge from '../../agents/ProviderBadge'
import TerminalTileContent from './TerminalTileContent'
import ToolTileContent from '../tools/ToolTileContent'

const DEFAULT_WIDTH = 500
const DEFAULT_HEIGHT = 350
const MIN_WIDTH = 320
const MIN_HEIGHT = 200
const MAX_WIDTH_RATIO = 0.92
const MAX_HEIGHT_RATIO = 0.85

// Persist flyout size across open/close cycles (session-only)
let savedWidth = DEFAULT_WIDTH
let savedHeight = DEFAULT_HEIGHT

type ResizeEdge = 'n' | 'e' | 'w' | 'ne' | 'nw'

interface MinimizedBarFlyoutProps {
  flyoutState: {
    type: 'terminal' | 'tool'
    id: string
    anchorRect: DOMRect
  }
  onClose: () => void
  onRestore: () => void
}

export default function MinimizedBarFlyout({ flyoutState, onClose, onRestore }: MinimizedBarFlyoutProps) {
  const { terminals, setActiveTerminal, setTerminalAttention } = useTerminalStore()
  const { toolInstances, toolConfigs, setToolAttention } = useToolStore()

  const [visible, setVisible] = useState(false)
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT)
  const [panelLeft, setPanelLeft] = useState(0)
  const [panelTop, setPanelTop] = useState(0)
  const [isResizing, setIsResizing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Track current dimensions in refs for saving on resize end (avoids stale closures)
  const currentWidthRef = useRef(panelWidth)
  const currentHeightRef = useRef(panelHeight)
  const resizeRef = useRef<{
    edge: ResizeEdge
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    startLeft: number
    startTop: number
  } | null>(null)

  // Register overlay so native webviews hide when flyout is open
  useOverlayRegistration('minimized-flyout', true)

  // Determine what we're showing
  const terminal = flyoutState.type === 'terminal' ? terminals.get(flyoutState.id) : null
  const toolInstance = flyoutState.type === 'tool' ? toolInstances.get(flyoutState.id) : null
  const toolConfig = toolInstance ? toolConfigs.get(toolInstance.configId) : null

  // Calculate left position centered on anchor, clamped to viewport
  const calculateLeft = useCallback((width: number, anchorRect: DOMRect) => {
    let left = anchorRect.left + anchorRect.width / 2 - width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    return left
  }, [])

  // Initialize panel dimensions and position (use saved size if available)
  useEffect(() => {
    const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
    const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)
    // Use saved dimensions, clamped to current viewport constraints
    const w = Math.min(Math.max(savedWidth, MIN_WIDTH), maxW)
    const h = Math.min(Math.max(savedHeight, MIN_HEIGHT), maxH)
    setPanelWidth(w)
    setPanelHeight(h)
    currentWidthRef.current = w
    currentHeightRef.current = h
    setPanelLeft(calculateLeft(w, flyoutState.anchorRect))
    // Bottom of panel = top of minimized bar (anchorRect.top) - 4px gap
    setPanelTop(flyoutState.anchorRect.top - 4 - h)
  }, [flyoutState.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep dimension refs in sync with state (for use in event handlers)
  useEffect(() => {
    currentWidthRef.current = panelWidth
    currentHeightRef.current = panelHeight
  }, [panelWidth, panelHeight])

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => {
      setVisible(true)
    })
  }, [flyoutState.id])

  // Set active terminal and clear attention when flyout opens
  useEffect(() => {
    if (flyoutState.type === 'terminal' && terminal) {
      setActiveTerminal(flyoutState.id)
      if (terminal.needsAttention) {
        setTerminalAttention(flyoutState.id, false)
      }
    } else if (flyoutState.type === 'tool' && toolInstance) {
      setActiveTerminal(flyoutState.id)
      if (toolInstance.needsAttention) {
        setToolAttention(flyoutState.id, false)
      }
    }
  }, [flyoutState.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Animate out then close
  const handleClose = useCallback(() => {
    setVisible(false)
    setTimeout(() => {
      onClose()
    }, 200)
  }, [onClose])

  // Handle restore: close flyout then restore to layout
  const handleRestore = useCallback(() => {
    setVisible(false)
    setTimeout(() => {
      onRestore()
    }, 150)
  }, [onRestore])

  // Escape key closes
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  // Window resize: reposition/clamp
  useEffect(() => {
    const handleWindowResize = () => {
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)
      setPanelWidth(prev => {
        const newW = Math.min(prev, maxW)
        setPanelLeft(calculateLeft(newW, flyoutState.anchorRect))
        return newW
      })
      setPanelHeight(prev => {
        const newH = Math.min(prev, maxH)
        setPanelTop(flyoutState.anchorRect.top - 4 - newH)
        return newH
      })
    }
    window.addEventListener('resize', handleWindowResize)
    return () => window.removeEventListener('resize', handleWindowResize)
  }, [flyoutState.anchorRect, calculateLeft])

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
      startTop: panelTop,
    }
    setIsResizing(true)
    document.body.classList.add(`flyout-resizing-${edge}`)
  }, [panelWidth, panelHeight, panelLeft, panelTop])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return
      const { edge, startX, startY, startWidth, startHeight, startLeft, startTop } = resizeRef.current
      const maxW = Math.floor(window.innerWidth * MAX_WIDTH_RATIO)
      const maxH = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO)

      // Top edge: grows upward (decrease top, increase height)
      if (edge === 'n' || edge === 'ne' || edge === 'nw') {
        const dy = startY - e.clientY
        const newHeight = Math.min(Math.max(startHeight + dy, MIN_HEIGHT), maxH)
        const newTop = startTop - (newHeight - startHeight)
        setPanelHeight(newHeight)
        setPanelTop(Math.max(8, newTop))
      }

      // Right edge
      if (edge === 'e' || edge === 'ne') {
        const dx = e.clientX - startX
        setPanelWidth(Math.min(Math.max(startWidth + dx, MIN_WIDTH), maxW))
      }

      // Left edge: grows left (decrease left, increase width)
      if (edge === 'w' || edge === 'nw') {
        const dx = startX - e.clientX
        const newWidth = Math.min(Math.max(startWidth + dx, MIN_WIDTH), maxW)
        const widthDelta = newWidth - startWidth
        const newLeft = Math.max(8, startLeft - widthDelta)
        setPanelWidth(newWidth)
        setPanelLeft(newLeft)
      }
    }

    const handleMouseUp = () => {
      if (resizeRef.current) {
        document.body.classList.remove(`flyout-resizing-${resizeRef.current.edge}`)
      }
      resizeRef.current = null
      setIsResizing(false)
      // Save current dimensions for next flyout (use refs for latest values)
      savedWidth = currentWidthRef.current
      savedHeight = currentHeightRef.current
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  const handleBackdropClick = () => {
    if (isResizing) return
    handleClose()
  }

  // Build header info
  const title = terminal?.title || toolInstance?.title || 'Unknown'
  const statusColor = terminal
    ? (terminal.status === 'active' ? 'bg-green-500' : terminal.status === 'error' ? 'bg-red-500' : 'bg-gray-500')
    : toolInstance
    ? (toolInstance.status === 'active' ? 'bg-teal-500' : toolInstance.status === 'error' ? 'bg-red-500' : 'bg-gray-500')
    : 'bg-gray-500'

  if (!terminal && !toolInstance) return null

  return (
    <>
      {/* Transparent backdrop for click-outside dismissal */}
      <div
        className="fixed inset-0 z-[58]"
        onClick={handleBackdropClick}
      />

      {/* Flyout panel - anchored from bottom, flies upward */}
      <div
        ref={panelRef}
        className="fixed z-[59] bg-vibe-surface border border-vibe-border rounded-lg shadow-xl overflow-hidden flex flex-col"
        style={{
          top: `${panelTop}px`,
          left: `${panelLeft}px`,
          width: `${panelWidth}px`,
          height: `${panelHeight}px`,
          transformOrigin: 'bottom center',
          transition: isResizing ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
          transform: visible ? 'scale(1) translateY(0)' : 'scale(0.97) translateY(8px)',
          opacity: visible ? 1 : 0,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-vibe-border bg-vibe-bg/50 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* Status dot */}
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />

            {/* Provider badge for terminals */}
            <ProviderBadge providerId={terminal?.agent?.providerId} className="px-1.5" />

            {/* Tool type badge */}
            {toolConfig && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-gradient-to-r from-teal-500 to-emerald-500 text-white flex-shrink-0">
                <ToolIcon config={toolConfig} className="w-3 h-3" />
                {toolConfig.name}
              </span>
            )}

            {/* Title */}
            <span className="text-sm font-medium text-vibe-text truncate">
              {terminal ? title : ''}
            </span>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Restore to Pane button */}
            <button
              onClick={handleRestore}
              className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
              title="Restore to layout"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </button>

            {/* Close flyout button */}
            <button
              onClick={handleClose}
              className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors"
              title="Close preview"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className={flyoutState.type === 'terminal' ? 'flex-1 min-h-0' : 'flex-1 min-h-0 overflow-auto'}>
          {terminal && <TerminalTileContent terminal={terminal} />}
          {toolInstance && <ToolTileContent instance={toolInstance} config={toolConfig || undefined} />}
        </div>

        {/* Resize handle: top edge (grows upward) */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'n')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '6px',
            cursor: 'ns-resize',
            zIndex: 10,
          }}
          className="group"
        >
          <div className="absolute top-0 left-0 w-full h-[2px] opacity-0 group-hover:opacity-100 bg-vibe-primary/50 transition-opacity" />
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

        {/* Resize handle: left edge */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'w')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '6px',
            height: '100%',
            cursor: 'ew-resize',
            zIndex: 10,
          }}
          className="group"
        >
          <div className="absolute top-0 left-0 w-[2px] h-full opacity-0 group-hover:opacity-100 bg-vibe-primary/50 transition-opacity" />
        </div>

        {/* Resize handle: top-right corner */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'ne')}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: '12px',
            height: '12px',
            cursor: 'nesw-resize',
            zIndex: 11,
          }}
          className="group"
        >
          <div className="absolute top-[2px] right-[2px] w-[8px] h-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-vibe-primary/50">
              <path d="M7 7L1 1M7 4L4 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Resize handle: top-left corner */}
        <div
          onMouseDown={(e) => handleResizeStart(e, 'nw')}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '12px',
            height: '12px',
            cursor: 'nwse-resize',
            zIndex: 11,
          }}
          className="group"
        >
          <div className="absolute top-[2px] left-[2px] w-[8px] h-[8px] opacity-0 group-hover:opacity-100 transition-opacity">
            <svg width="8" height="8" viewBox="0 0 8 8" className="text-vibe-primary/50">
              <path d="M1 7L7 1M1 4L4 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>
    </>
  )
}
