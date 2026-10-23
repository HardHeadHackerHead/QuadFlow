import { useMemo } from 'react'
import { useToolStore } from '../../stores/toolStore'
import { WorkspaceTemplate } from '../../lib/workspaceTemplates'
import { createLayoutByPreset, serializeLayoutTree } from '../../lib/layoutUtils'
import { usePluginRegistry } from '../../plugins/registry'
import { parseLeafId } from '../../lib/layoutIds'

// Minimal typing for parsed MosaicNode trees
interface MosaicParentNode {
  direction: 'row' | 'column'
  first: MosaicNodeTree
  second: MosaicNodeTree
  splitPercentage?: number
}
export type MosaicNodeTree = string | MosaicParentNode

/** Convert a hex color to an rgba string at a given opacity */
export function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r},${g},${b},${opacity})`
}

export const TERMINAL_FILL = 'rgba(99,182,190,0.45)'

/** Recursively render a MosaicNode tree as SVG rectangles */
export function renderTreeRects(
  node: MosaicNodeTree,
  x: number, y: number, w: number, h: number,
  gap: number,
  toolColors: Map<string, string>,
): JSX.Element[] {
  if (typeof node === 'string') {
    let fill = TERMINAL_FILL
    const leaf = parseLeafId(node)
    if (leaf.kind === 'tool') {
      // Template previews use `tool:<configId>`; live tiles (`tool:<ulid>`) get the default tint.
      const color = toolColors.get(leaf.id)
      fill = color ? hexToRgba(color, 0.55) : 'rgba(139,92,246,0.45)'
    }
    return [
      <rect
        key={`${x}-${y}`}
        x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)}
        rx={0.5}
        fill={fill}
      />,
    ]
  }

  const split = (node.splitPercentage ?? 50) / 100
  if (node.direction === 'row') {
    const firstW = w * split - gap / 2
    const secondW = w * (1 - split) - gap / 2
    return [
      ...renderTreeRects(node.first, x, y, firstW, h, gap, toolColors),
      ...renderTreeRects(node.second, x + firstW + gap, y, secondW, h, gap, toolColors),
    ]
  } else {
    const firstH = h * split - gap / 2
    const secondH = h * (1 - split) - gap / 2
    return [
      ...renderTreeRects(node.first, x, y, w, firstH, gap, toolColors),
      ...renderTreeRects(node.second, x, y + firstH + gap, w, secondH, gap, toolColors),
    ]
  }
}

// Tiles offered for template editing: every available contribution with
// `templateable: true` (plugin-system.md §5.1), as `<pluginId>/<id>` refs.
export function useTemplateToolOptions(): { type: string; label: string }[] {
  const contributions = usePluginRegistry((s) => s.contributions)
  return useMemo(
    () => (contributions?.tiles ?? [])
      .filter((t) => t.contribution.templateable)
      .map((t) => ({ type: `${t.pluginId}/${t.contribution.id}`, label: t.contribution.title })),
    [contributions],
  )
}

function tileLabel(ref: string): string {
  const [pluginId, id] = ref.split('/')
  return usePluginRegistry.getState().getTile(pluginId, id)?.contribution.title ?? id ?? ref
}

/** Summary line for a template: "2 agents, 1 terminal, Issues + Plans" */
export function templateSummary(t: WorkspaceTemplate): string {
  const parts: string[] = []
  if (t.agentCount > 0) parts.push(`${t.agentCount} agent${t.agentCount > 1 ? 's' : ''}`)
  if (t.terminalCount > 0) parts.push(`${t.terminalCount} term${t.terminalCount > 1 ? 's' : ''}`)
  if (t.tiles.length > 0) {
    const toolLabels = t.tiles.map(tileLabel)
    parts.push(toolLabels.join(' + '))
  }
  return parts.join(', ') || 'Empty'
}

/** Build a configId → color map from the tool store */
function useToolColors(): Map<string, string> {
  const toolConfigs = useToolStore.getState().toolConfigs
  return useMemo(() => {
    const map = new Map<string, string>()
    toolConfigs.forEach((config, id) => {
      if (config.color) map.set(id, config.color)
    })
    return map
  }, [toolConfigs])
}

/** Mini SVG preview of a saved workspace's actual pane layout */
export function WorkspaceLayoutPreview({ layoutTree, className = '' }: { layoutTree?: string | null; className?: string }) {
  const toolColors = useToolColors()

  const fallback = (
    <svg className={`w-7 h-5 flex-shrink-0 ${className}`} viewBox="0 0 28 20">
      <rect x={1} y={1} width={26} height={18} rx={1} fill="rgba(99,182,190,0.35)" />
    </svg>
  )

  if (!layoutTree) return fallback

  let tree: MosaicNodeTree
  try {
    tree = JSON.parse(layoutTree) as MosaicNodeTree
  } catch {
    return fallback
  }

  return (
    <svg className={`w-7 h-5 flex-shrink-0 ${className}`} viewBox="0 0 28 20">
      {renderTreeRects(tree, 1, 1, 26, 18, 1.5, toolColors)}
    </svg>
  )
}

/** Generate a mini SVG preview from a template's full config */
export function TemplateLayoutPreview({ template, className = '' }: { template: WorkspaceTemplate; className?: string }) {
  const toolConfigs = useToolStore.getState().toolConfigs

  const { treeJson, toolColors } = useMemo(() => {
    const colors = new Map<string, string>()
    const paneIds: string[] = []

    for (let i = 0; i < template.agentCount; i++) paneIds.push(`agent-${i}`)
    for (let i = 0; i < template.terminalCount; i++) paneIds.push(`term-${i}`)

    for (const ref of template.tiles) {
      const config = Array.from(toolConfigs.values()).find(c => `${c.pluginId}/${c.contributionId}` === ref && c.enabled)
      if (config) {
        paneIds.push(`tool:${config.id}`)
        if (config.color) colors.set(config.id, config.color)
      } else {
        paneIds.push(`tool:${ref}`)
      }
    }

    if (paneIds.length === 0) paneIds.push('empty')

    const { layoutTree } = createLayoutByPreset(template.layoutPreset, paneIds)
    return { treeJson: serializeLayoutTree(layoutTree), toolColors: colors }
  }, [template.layoutPreset, template.agentCount, template.terminalCount, template.tiles, toolConfigs])

  if (!treeJson) {
    return (
      <svg className={`w-8 h-6 flex-shrink-0 ${className}`} viewBox="0 0 28 20">
        <rect x={1} y={1} width={26} height={18} rx={1} fill="rgba(99,182,190,0.35)" />
      </svg>
    )
  }

  let tree: MosaicNodeTree
  try {
    tree = JSON.parse(treeJson) as MosaicNodeTree
  } catch {
    return (
      <svg className={`w-8 h-6 flex-shrink-0 ${className}`} viewBox="0 0 28 20">
        <rect x={1} y={1} width={26} height={18} rx={1} fill="rgba(99,182,190,0.35)" />
      </svg>
    )
  }

  return (
    <svg className={`w-8 h-6 flex-shrink-0 ${className}`} viewBox="0 0 28 20">
      {renderTreeRects(tree, 1, 1, 26, 18, 1.5, toolColors)}
    </svg>
  )
}
