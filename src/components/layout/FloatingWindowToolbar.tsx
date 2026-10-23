/**
 * FloatingWindowToolbar - Toolbar for floating windows with pop-in button
 */

interface FloatingWindowToolbarProps {
  title: string
  panelType: 'terminal' | 'tool'
  onPopIn: () => void
}

export default function FloatingWindowToolbar({
  title,
  panelType,
  onPopIn,
}: FloatingWindowToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-vibe-surface border-b border-vibe-border select-none">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* Panel type badge */}
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            panelType === 'terminal'
              ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white'
              : 'bg-gradient-to-r from-teal-500 to-cyan-500 text-white'
          }`}
        >
          {panelType === 'terminal' ? 'Terminal' : 'Tool'}
        </span>

        {/* Title */}
        <span className="text-sm text-vibe-text truncate" title={title}>
          {title}
        </span>

        {/* Floating indicator */}
        <span className="text-xs text-vibe-muted px-1.5 py-0.5 bg-vibe-border/50 rounded">
          Floating
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Pop-in button */}
        <button
          onClick={onPopIn}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-vibe-primary/20 text-vibe-primary hover:bg-vibe-primary/30 rounded transition-colors"
          title="Return to main window (Pop In)"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            {/* Pop-in icon - arrow pointing into a box */}
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 19l-7-7 7-7m8 14V5a2 2 0 00-2-2H5"
            />
          </svg>
          <span>Pop In</span>
        </button>
      </div>
    </div>
  )
}
