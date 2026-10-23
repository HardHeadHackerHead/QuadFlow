import { useRef, useEffect } from 'react'
import { ScoredCommand } from '../../lib/commandRegistry'

interface CommandPaletteItemProps {
  scored: ScoredCommand
  selected: boolean
  onExecute: () => void
  onHover: () => void
}

function HighlightedTitle({ title, indices }: { title: string; indices: number[] }) {
  if (indices.length === 0) {
    return <span>{title}</span>
  }

  const indexSet = new Set(indices)
  const parts: { text: string; highlighted: boolean }[] = []
  let current = ''
  let currentHighlighted = false

  for (let i = 0; i < title.length; i++) {
    const isHighlighted = indexSet.has(i)
    if (i === 0) {
      currentHighlighted = isHighlighted
      current = title[i]
    } else if (isHighlighted === currentHighlighted) {
      current += title[i]
    } else {
      parts.push({ text: current, highlighted: currentHighlighted })
      current = title[i]
      currentHighlighted = isHighlighted
    }
  }
  if (current) {
    parts.push({ text: current, highlighted: currentHighlighted })
  }

  return (
    <span>
      {parts.map((part, i) =>
        part.highlighted ? (
          <span key={i} className="text-vibe-primary font-semibold">{part.text}</span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  )
}

export default function CommandPaletteItem({ scored, selected, onExecute, onHover }: CommandPaletteItemProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { command, matchIndices } = scored

  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' })
    }
  }, [selected])

  return (
    <div
      ref={ref}
      className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-vibe-primary/10 border-l-2 border-vibe-primary'
          : 'border-l-2 border-transparent hover:bg-vibe-border/30'
      }`}
      onClick={onExecute}
      onMouseEnter={onHover}
    >
      {/* Icon */}
      {command.icon && (
        <span className="flex-shrink-0 text-vibe-muted w-5 h-5 flex items-center justify-center">
          {command.icon}
        </span>
      )}

      {/* Title + subtitle */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-sm text-vibe-text truncate">
          <HighlightedTitle title={command.title} indices={matchIndices} />
        </span>
        {command.subtitle && (
          <span className="text-xs text-vibe-muted truncate max-w-[200px]">
            {command.subtitle}
          </span>
        )}
      </div>

      {/* Shortcut badge */}
      {command.shortcut && (
        <span className="flex-shrink-0 px-1.5 py-0.5 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-muted">
          {command.shortcut}
        </span>
      )}
    </div>
  )
}
