import { useEffect, useRef, useCallback, useState } from 'react'
import { MosaicBranch, MosaicNode } from 'react-mosaic-component'
import { useDragPreviewStore, DropPosition, HoveredDropZone } from '../../stores/dragPreviewStore'
import {
  calculateDropZone,
  computePreviewTree,
  getTerminalIdsFromTree,
  findPathToTile,
  removeTerminalFromTree,
  cloneTree,
} from '../../lib/layoutUtils'

interface DropZoneDetectorProps {
  layoutTree: MosaicNode<string> | null
}

interface TileInfo {
  id: string
  bounds: DOMRect
  path: MosaicBranch[]
}

// Debounce delay in ms - prevents jittery updates
const DEBOUNCE_DELAY = 50

export default function DropZoneDetector({ layoutTree }: DropZoneDetectorProps) {
  const {
    isDragging,
    draggedTileId,
    dragSource,
    originalTree,
    hoveredDropZone,
    setHoveredDropZone,
    setPreviewTree,
  } = useDragPreviewStore()

  const lastZoneRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<number | null>(null)
  const [tileInfos, setTileInfos] = useState<TileInfo[]>([])

  // Get all visible tiles and their bounds
  const updateTileInfos = useCallback(() => {
    const infos: TileInfo[] = []
    const tileIds = getTerminalIdsFromTree(layoutTree)

    // Find tiles by their data attributes
    for (const id of tileIds) {
      // Skip the tile being dragged during layout drags (it appears at preview position)
      if (dragSource === 'layout' && id === draggedTileId) continue
      // Find the mosaic-tile container that has our terminal/tool
      const terminalEl = document.querySelector(`[data-terminal-id="${id}"]`)
      const toolEl = document.querySelector(`[data-tool-id="${id}"]`)
      const element = terminalEl || toolEl

      if (element) {
        // Get the parent mosaic-tile container for accurate bounds
        const tileContainer = element.closest('.mosaic-tile')
        if (tileContainer) {
          const rect = tileContainer.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            const path = findPathToTile(layoutTree, id)
            if (path) {
              infos.push({ id, bounds: rect, path })
            }
          }
        }
      }
    }

    setTileInfos(infos)
  }, [layoutTree, dragSource, draggedTileId])

  // Update tile infos when drag starts and periodically during drag
  useEffect(() => {
    if (!isDragging) {
      setTileInfos([])
      return
    }

    // Initial update
    updateTileInfos()

    // Update periodically in case layout shifts
    const interval = setInterval(updateTileInfos, 200)

    return () => clearInterval(interval)
  }, [isDragging, updateTileInfos])

  // Handle mouse move during drag with debouncing
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !draggedTileId || tileInfos.length === 0) return

      const { clientX: x, clientY: y } = e

      // Clear any pending debounce
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      // Debounce the zone detection
      debounceTimerRef.current = window.setTimeout(() => {
        let newZone: HoveredDropZone | null = null

        // Check each tile for drop zone
        for (const tileInfo of tileInfos) {
          const { id, bounds, path } = tileInfo

          // Check if mouse is over this tile
          if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
            const position = calculateDropZone(x, y, bounds)
            if (position) {
              newZone = { path, position, targetTileId: id }
            }
            break
          }
        }

        // Create zone key for comparison
        const zoneKey = newZone
          ? `${newZone.targetTileId}-${newZone.position}`
          : null

        // Only update if zone changed
        if (zoneKey !== lastZoneRef.current) {
          lastZoneRef.current = zoneKey
          setHoveredDropZone(newZone)

          // Compute preview tree when zone changes
          if (newZone && originalTree) {
            const preview = computePreviewTree(
              originalTree,
              draggedTileId,
              newZone,
              dragSource === 'minimized'
            )
            setPreviewTree(preview)
          } else if (dragSource === 'layout' && originalTree && draggedTileId) {
            // For layout drags, keep showing tree with tile removed when no zone hovered
            const removedTree = removeTerminalFromTree(cloneTree(originalTree), draggedTileId)
            setPreviewTree(removedTree)
          } else {
            // No zone hovered, clear preview (snap back to original)
            setPreviewTree(null)
          }
        }
      }, DEBOUNCE_DELAY)
    },
    [isDragging, draggedTileId, dragSource, originalTree, tileInfos, setHoveredDropZone, setPreviewTree]
  )

  // Set up mouse move listener during drag
  useEffect(() => {
    if (!isDragging) {
      lastZoneRef.current = null
      return
    }

    window.addEventListener('mousemove', handleMouseMove)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [isDragging, handleMouseMove])

  // Render drop zone indicators
  if (!isDragging || tileInfos.length === 0) return null

  return (
    <div className="fixed inset-0 pointer-events-none z-[9997]">
      {tileInfos.map((tileInfo) => {
        const { id, bounds } = tileInfo
        const isHovered =
          hoveredDropZone?.targetTileId === id

        return (
          <div
            key={id}
            className="absolute"
            style={{
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            }}
          >
            {/* Drop zone indicators for each edge */}
            <DropZoneIndicator
              position="left"
              isActive={isHovered && hoveredDropZone?.position === 'left'}
              bounds={bounds}
            />
            <DropZoneIndicator
              position="right"
              isActive={isHovered && hoveredDropZone?.position === 'right'}
              bounds={bounds}
            />
            <DropZoneIndicator
              position="top"
              isActive={isHovered && hoveredDropZone?.position === 'top'}
              bounds={bounds}
            />
            <DropZoneIndicator
              position="bottom"
              isActive={isHovered && hoveredDropZone?.position === 'bottom'}
              bounds={bounds}
            />
          </div>
        )
      })}
    </div>
  )
}

interface DropZoneIndicatorProps {
  position: DropPosition
  isActive: boolean
  bounds: DOMRect
}

function DropZoneIndicator({ position, isActive }: DropZoneIndicatorProps) {
  // Match the 50% splitPercentage from insertAtPosition
  const positionStyles: Record<DropPosition, React.CSSProperties> = {
    left: {
      left: 0,
      top: 0,
      width: '50%',
      height: '100%',
    },
    right: {
      right: 0,
      top: 0,
      width: '50%',
      height: '100%',
    },
    top: {
      left: 0,
      top: 0,
      width: '100%',
      height: '50%',
    },
    bottom: {
      left: 0,
      bottom: 0,
      width: '100%',
      height: '50%',
    },
  }

  return (
    <div
      className={`absolute transition-all duration-200 ${
        isActive
          ? 'bg-vibe-primary/25 border-2 border-vibe-primary shadow-lg shadow-vibe-primary/20'
          : 'bg-transparent border border-transparent'
      }`}
      style={{
        ...positionStyles[position],
        borderRadius: 6,
      }}
    >
      {isActive && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="bg-vibe-surface px-3 py-1.5 rounded-md text-xs font-medium text-vibe-primary border border-vibe-primary/50 shadow-lg">
            {position === 'left' && 'Insert Left'}
            {position === 'right' && 'Insert Right'}
            {position === 'top' && 'Insert Above'}
            {position === 'bottom' && 'Insert Below'}
          </div>
        </div>
      )}
    </div>
  )
}
