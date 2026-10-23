import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { useToolStore } from '../../stores/toolStore'
import { removeTerminalFromTree } from '../../lib/layoutUtils'
import { ToolConfig } from '../../types'
import { ToolIcon, activateTool, canOpenInPane, groupToolConfigs, isActionContribution, useAvailableToolConfigs, type ToolContribution } from '../../plugins/tools'

const INNER_RING_MAX = 8
const OUTER_RING_MAX = 14
const MAX_BUBBLES = INNER_RING_MAX + OUTER_RING_MAX // 16 total before "More..."
const INNER_RADIUS = 65
const OUTER_RADIUS = 120
const BUBBLE_SIZE = 44
const STAGGER_DELAY_MS = 25

interface BubbleItem {
  id: string
  label: string
  config: ToolConfig | null
  color?: string
  configId: string
}

function getBubblePosition(index: number, total: number, radius: number): { x: number; y: number } {
  const angleStep = (2 * Math.PI) / total
  const angle = -Math.PI / 2 + index * angleStep
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  }
}

interface RingItem {
  item: BubbleItem
  ring: number // 0 = inner, 1 = outer
  indexInRing: number
  totalInRing: number
  globalIndex: number // for stagger delay
}

/** Tools that can fill an empty tile: pane-capable tiles and toolbar items (their command gets the tile id). */
const fitsEmptyTile = (_c: ToolConfig, contribution: ToolContribution) =>
  isActionContribution(contribution) || canOpenInPane(contribution)

function useBubbleItems(): BubbleItem[] {
  const quickLaunch = useAvailableToolConfigs((t, c) => t.quickLaunch && fitsEmptyTile(t, c))

  return useMemo(() => {
    const items: BubbleItem[] = quickLaunch.slice(0, MAX_BUBBLES).map(tool => ({
      id: tool.id,
      label: tool.name,
      config: tool,
      color: tool.color,
      configId: tool.id,
    }))

    // Always append "More..."
    items.push({
      id: '__more__',
      label: 'More',
      config: null,
      configId: '',
    })

    return items
  }, [quickLaunch])
}

function useRingLayout(items: BubbleItem[]): RingItem[] {
  return useMemo(() => {
    const toolItems = items.filter(i => i.id !== '__more__')
    const moreItem = items.find(i => i.id === '__more__')
    const result: RingItem[] = []

    if (toolItems.length <= INNER_RING_MAX) {
      // Everything fits in the inner ring (+ More button)
      const totalInRing = toolItems.length + (moreItem ? 1 : 0)
      toolItems.forEach((item, i) => {
        result.push({ item, ring: 0, indexInRing: i, totalInRing, globalIndex: i })
      })
      if (moreItem) {
        result.push({ item: moreItem, ring: 0, indexInRing: toolItems.length, totalInRing, globalIndex: toolItems.length })
      }
    } else {
      // Split across two rings
      const innerItems = toolItems.slice(0, INNER_RING_MAX)
      const outerItems = toolItems.slice(INNER_RING_MAX)
      const outerTotal = outerItems.length + (moreItem ? 1 : 0)

      innerItems.forEach((item, i) => {
        result.push({ item, ring: 0, indexInRing: i, totalInRing: INNER_RING_MAX, globalIndex: i })
      })
      outerItems.forEach((item, i) => {
        result.push({ item, ring: 1, indexInRing: i, totalInRing: outerTotal, globalIndex: INNER_RING_MAX + i })
      })
      if (moreItem) {
        result.push({ item: moreItem, ring: 1, indexInRing: outerItems.length, totalInRing: outerTotal, globalIndex: INNER_RING_MAX + outerItems.length })
      }
    }

    return result
  }, [items])
}

// The "More..." expanded tool list
function MoreToolList({ tileId, onBack, onClose }: { tileId: string; onBack: () => void; onClose: () => void }) {
  const enabled = useAvailableToolConfigs((t, c) => t.enabled && fitsEmptyTile(t, c))
  const groupedTools = useMemo(() => groupToolConfigs(enabled), [enabled])

  const handleSelectTool = useCallback(async (tool: ToolConfig) => {
    onClose()
    await handleToolAction(tileId, tool)
  }, [tileId, onClose])

  return (
    <div className="absolute inset-4 flex flex-col bg-vibe-surface/95 backdrop-blur-sm border border-vibe-border/50 rounded-lg overflow-hidden z-10">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vibe-border/30">
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-vibe-border/50 text-vibe-muted hover:text-vibe-text transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-xs text-vibe-muted font-medium uppercase tracking-wide">All Tools</span>
      </div>

      {/* Scrollable tool list */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {groupedTools.map(group => (
          <div key={group.id}>
            <div className="px-3 py-1.5 text-[10px] text-vibe-muted/60 uppercase tracking-wider font-medium">
              {group.label}
            </div>
            {group.tools.map(tool => (
              <button
                key={tool.id}
                onClick={() => handleSelectTool(tool)}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-vibe-text hover:bg-vibe-border/40 transition-colors"
                data-tool-ref={`${tool.pluginId}/${tool.contributionId}`}
              >
                <span style={tool.color ? { color: tool.color } : undefined} className="text-vibe-muted flex-shrink-0 flex">
                  <ToolIcon config={tool} className="w-4 h-4" />
                </span>
                <span className="truncate">{tool.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// Place a tool into a specific empty tile: tiles open there, toolbar items run
// their command with the tile id (a terminal fills it, an agent launcher
// leaves it empty).
async function handleToolAction(tileId: string, tool: ToolConfig) {
  await activateTool(tool, { source: 'empty-tile', mode: 'pane', targetLeafId: tileId })
}

export default function EmptyTileBubbleMenu({ tileId }: { tileId: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const items = useBubbleItems()
  const ringItems = useRingLayout(items)
  const hasOuterRing = ringItems.some(r => r.ring === 1)

  // Measure container for adaptive radius
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      setDimensions({ width: rect.width, height: rect.height })
    }
  }, [isOpen])

  const effectiveRadii = useMemo(() => {
    const minDim = Math.min(dimensions.width, dimensions.height)
    if (minDim === 0) return { inner: INNER_RADIUS, outer: OUTER_RADIUS }
    const maxOuter = (minDim - BUBBLE_SIZE) / 2 - 8
    const outer = Math.min(OUTER_RADIUS, maxOuter)
    const inner = Math.min(INNER_RADIUS, hasOuterRing ? outer * 0.54 : outer)
    return { inner, outer }
  }, [dimensions, hasOuterRing])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setShowMore(false)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
        setShowMore(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const handleToggle = useCallback(() => {
    setIsOpen(prev => {
      if (prev) setShowMore(false)
      return !prev
    })
  }, [])

  const handleSelectBubble = useCallback(async (item: BubbleItem) => {
    if (item.id === '__more__') {
      setShowMore(true)
      return
    }

    setIsOpen(false)
    setShowMore(false)

    const toolConfigs = useToolStore.getState().toolConfigs
    const config = toolConfigs.get(item.configId)
    if (!config) return

    await handleToolAction(tileId, config)
  }, [tileId])

  const handleRemoveEmpty = useCallback(() => {
    const termStore = useTerminalStore.getState()
    const newTree = removeTerminalFromTree(termStore.layoutTree, tileId)
    termStore.setLayoutTree(newTree)
  }, [tileId])

  return (
    <div ref={containerRef} className="empty-tile-content h-full w-full flex items-center justify-center relative group">
      {/* Remove empty space button */}
      <button
        onClick={handleRemoveEmpty}
        className="absolute top-2 right-2 p-1 rounded text-vibe-muted/30 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all z-20"
        title="Remove empty space"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* "More..." full tool list overlay */}
      {showMore && isOpen && (
        <MoreToolList
          tileId={tileId}
          onBack={() => setShowMore(false)}
          onClose={() => { setIsOpen(false); setShowMore(false) }}
        />
      )}

      {/* Center plus/close button */}
      <button
        onClick={handleToggle}
        className={`bubble-center-btn p-3 rounded-full bg-vibe-surface/50 border border-dashed border-vibe-border/40 hover:border-vibe-primary/50 hover:bg-vibe-border/30 transition-all ${isOpen ? 'open' : ''}`}
        title={isOpen ? 'Close menu' : 'Add tool here'}
      >
        <svg className="w-6 h-6 text-vibe-muted/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {/* Bubble items */}
      {!showMore && ringItems.map((ri) => {
        const radius = ri.ring === 0 ? effectiveRadii.inner : effectiveRadii.outer
        const pos = getBubblePosition(ri.indexInRing, ri.totalInRing, radius)
        const isMoreBtn = ri.item.id === '__more__'

        return (
          <button
            key={ri.item.id}
            onClick={() => handleSelectBubble(ri.item)}
            className={`bubble-menu-item absolute flex items-center justify-center bg-vibe-surface/90 border border-vibe-border/50 hover:border-vibe-primary/60 hover:bg-vibe-border/40 backdrop-blur-sm ${isOpen ? 'open' : ''}`}
            style={{
              '--bx': `${pos.x}px`,
              '--by': `${pos.y}px`,
              '--delay': `${ri.globalIndex * STAGGER_DELAY_MS}ms`,
              left: '50%',
              top: '50%',
              marginLeft: -BUBBLE_SIZE / 2,
              marginTop: -BUBBLE_SIZE / 2,
            } as React.CSSProperties}
            title={ri.item.label}
          >
            <span style={ri.item.color ? { color: ri.item.color } : undefined} className="text-vibe-muted flex">
              {isMoreBtn ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              ) : ri.item.config ? (
                <ToolIcon config={ri.item.config} className="w-5 h-5" />
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
