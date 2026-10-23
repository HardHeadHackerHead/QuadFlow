import { useMemo, useState, useRef, useEffect } from 'react'

// ==================== Types ====================

export interface GraphNode {
  id: string
  label: string
  sublabel?: string
  status: string
  statusColor: string  // tailwind bg class like 'bg-green-500'
  dependsOn: string[]  // IDs of nodes this depends on
}

export interface DependencyGraphProps {
  nodes: GraphNode[]
  title?: string
  onNodeClick?: (id: string) => void
}

// ==================== Layout Constants ====================

const NODE_WIDTH = 160
const NODE_HEIGHT = 50
const COLUMN_GAP = 80
const ROW_GAP = 24
const PADDING = 24

// ==================== Layout Algorithm ====================

interface LayoutNode extends GraphNode {
  col: number
  row: number
  x: number
  y: number
}

function computeLayout(nodes: GraphNode[]): LayoutNode[] {
  if (nodes.length === 0) return []

  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  const placed = new Map<string, number>() // id -> column

  // Filter dependsOn to only include IDs that exist in nodes
  const validDeps = (n: GraphNode) => n.dependsOn.filter(id => nodeMap.has(id))

  // Topological sort-based layering
  // Nodes with no dependencies (or all deps outside the graph) go to column 0
  let remaining = new Set(nodes.map(n => n.id))
  let col = 0
  const maxIterations = nodes.length + 1

  for (let i = 0; i < maxIterations && remaining.size > 0; i++) {
    const batch: string[] = []
    for (const id of remaining) {
      const node = nodeMap.get(id)!
      const deps = validDeps(node)
      if (deps.every(d => placed.has(d) || !remaining.has(d))) {
        batch.push(id)
      }
    }

    // If no nodes can be placed (circular dependency), force-place remaining
    if (batch.length === 0) {
      for (const id of remaining) {
        placed.set(id, col)
      }
      break
    }

    for (const id of batch) {
      placed.set(id, col)
      remaining.delete(id)
    }
    col++
  }

  // Group by column
  const columns = new Map<number, string[]>()
  for (const [id, c] of placed) {
    if (!columns.has(c)) columns.set(c, [])
    columns.get(c)!.push(id)
  }

  // Assign positions
  const layoutNodes: LayoutNode[] = []
  for (const [colIdx, ids] of columns) {
    ids.forEach((id, rowIdx) => {
      const node = nodeMap.get(id)!
      layoutNodes.push({
        ...node,
        col: colIdx,
        row: rowIdx,
        x: PADDING + colIdx * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + rowIdx * (NODE_HEIGHT + ROW_GAP),
      })
    })
  }

  return layoutNodes
}

// ==================== Arrow Path ====================

function getArrowPath(from: LayoutNode, to: LayoutNode): string {
  const x1 = from.x + NODE_WIDTH
  const y1 = from.y + NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + NODE_HEIGHT / 2

  const dx = x2 - x1
  const cpOffset = Math.max(dx * 0.4, 30)

  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`
}

function getArrowColor(sourceStatus: string): string {
  if (sourceStatus === 'completed' || sourceStatus === 'done') return '#22c55e' // green-500
  if (sourceStatus === 'in_progress') return '#eab308' // yellow-500
  return '#6b7280' // gray-500
}

// ==================== Status Dot Color (CSS) ====================

// Convert tailwind bg class to a hex color for SVG rendering
function statusColorToHex(statusColor: string): string {
  const map: Record<string, string> = {
    'bg-green-500': '#22c55e',
    'bg-green-400': '#4ade80',
    'bg-red-500': '#ef4444',
    'bg-red-400': '#f87171',
    'bg-yellow-500': '#eab308',
    'bg-yellow-400': '#facc15',
    'bg-blue-500': '#3b82f6',
    'bg-blue-400': '#60a5fa',
    'bg-orange-500': '#f97316',
    'bg-orange-400': '#fb923c',
    'bg-gray-500': '#6b7280',
    'bg-gray-400': '#9ca3af',
    'bg-purple-500': '#a855f7',
    'bg-purple-400': '#c084fc',
    'bg-teal-500': '#14b8a6',
    'bg-teal-400': '#2dd4bf',
  }
  return map[statusColor] || '#6b7280'
}

// ==================== Component ====================

export default function DependencyGraph({ nodes, title, onNodeClick }: DependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)

  const layoutNodes = useMemo(() => computeLayout(nodes), [nodes])

  // Compute SVG dimensions
  const svgWidth = useMemo(() => {
    if (layoutNodes.length === 0) return 300
    return Math.max(...layoutNodes.map(n => n.x + NODE_WIDTH)) + PADDING
  }, [layoutNodes])

  const svgHeight = useMemo(() => {
    if (layoutNodes.length === 0) return 100
    return Math.max(...layoutNodes.map(n => n.y + NODE_HEIGHT)) + PADDING
  }, [layoutNodes])

  const nodeMap = useMemo(() => new Map(layoutNodes.map(n => [n.id, n])), [layoutNodes])

  // Compute edges: for each node, draw arrows FROM its dependencies TO it
  const edges = useMemo(() => {
    const result: { from: LayoutNode; to: LayoutNode; color: string }[] = []
    for (const node of layoutNodes) {
      for (const depId of node.dependsOn) {
        const depNode = nodeMap.get(depId)
        if (depNode) {
          result.push({
            from: depNode,
            to: node,
            color: getArrowColor(depNode.status),
          })
        }
      }
    }
    return result
  }, [layoutNodes, nodeMap])

  // Auto-scroll to show content
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = 0
      containerRef.current.scrollTop = 0
    }
  }, [nodes])

  if (nodes.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-vibe-muted">
        No dependency relationships to display.
      </div>
    )
  }

  // Truncate text to fit node width
  const truncate = (text: string, maxLen: number) =>
    text.length > maxLen ? text.slice(0, maxLen - 1) + '\u2026' : text

  return (
    <div className="space-y-2">
      {title && (
        <div className="text-xs font-medium text-vibe-muted">{title}</div>
      )}
      <div
        ref={containerRef}
        className="overflow-auto rounded-lg border border-vibe-border bg-vibe-bg-lighter"
        style={{ maxHeight: 400 }}
      >
        <svg
          width={svgWidth}
          height={svgHeight}
          className="select-none"
        >
          {/* Arrowhead marker definitions */}
          <defs>
            <marker
              id="arrowhead-green"
              markerWidth="8"
              markerHeight="6"
              refX="8"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#22c55e" />
            </marker>
            <marker
              id="arrowhead-yellow"
              markerWidth="8"
              markerHeight="6"
              refX="8"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#eab308" />
            </marker>
            <marker
              id="arrowhead-gray"
              markerWidth="8"
              markerHeight="6"
              refX="8"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#6b7280" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge, i) => {
            const markerId =
              edge.color === '#22c55e' ? 'arrowhead-green' :
              edge.color === '#eab308' ? 'arrowhead-yellow' :
              'arrowhead-gray'

            const isHighlighted = hoveredNode === edge.from.id || hoveredNode === edge.to.id

            return (
              <path
                key={`edge-${i}`}
                d={getArrowPath(edge.from, edge.to)}
                fill="none"
                stroke={edge.color}
                strokeWidth={isHighlighted ? 2 : 1.5}
                strokeOpacity={isHighlighted ? 1 : 0.6}
                markerEnd={`url(#${markerId})`}
                className="transition-all duration-150"
              />
            )
          })}

          {/* Nodes */}
          {layoutNodes.map((node) => {
            const isHovered = hoveredNode === node.id
            const dotColor = statusColorToHex(node.statusColor)

            return (
              <g
                key={node.id}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredNode(node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={() => onNodeClick?.(node.id)}
              >
                {/* Node background */}
                <rect
                  x={node.x}
                  y={node.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={8}
                  ry={8}
                  style={{ fill: isHovered ? 'rgb(var(--qf-bg-elevated))' : 'rgb(var(--qf-surface))', stroke: isHovered ? 'rgb(var(--qf-primary))' : 'rgb(var(--qf-border-strong))' }}
                  strokeWidth={isHovered ? 1.5 : 1}
                  className="transition-all duration-150"
                />

                {/* Status dot */}
                <circle
                  cx={node.x + 14}
                  cy={node.y + NODE_HEIGHT / 2 - (node.sublabel ? 4 : 0)}
                  r={4}
                  fill={dotColor}
                />

                {/* Label text */}
                <text
                  x={node.x + 26}
                  y={node.y + NODE_HEIGHT / 2 - (node.sublabel ? 4 : 0)}
                  style={{ fill: 'rgb(var(--qf-text))' }}
                  fontSize={12}
                  fontWeight={500}
                  dominantBaseline="central"
                >
                  {truncate(node.label, 16)}
                </text>

                {/* Sublabel */}
                {node.sublabel && (
                  <text
                    x={node.x + 26}
                    y={node.y + NODE_HEIGHT / 2 + 12}
                    style={{ fill: 'rgb(var(--qf-text-muted))' }}
                    fontSize={10}
                    dominantBaseline="central"
                  >
                    {truncate(node.sublabel, 20)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
