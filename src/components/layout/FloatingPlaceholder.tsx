/**
 * FloatingPlaceholder - Shown in the main window when a panel is popped out
 *
 * Displays a message that the panel is in a floating window and provides
 * a button to bring the floating window to focus.
 */

import { useFloatingWindowStore } from '../../stores/floatingWindowStore'

interface FloatingPlaceholderProps {
  panelId: string
  panelType: 'terminal' | 'tool'
  title: string
}

export default function FloatingPlaceholder({ panelId, panelType, title }: FloatingPlaceholderProps) {
  console.log('[FloatingPlaceholder] Rendering for panel:', panelId, 'type:', panelType, 'title:', title)
  const { focusFloatingWindow, popInPanel } = useFloatingWindowStore()

  const handleFocusWindow = async () => {
    try {
      await focusFloatingWindow(panelId)
    } catch (error) {
      console.error('Failed to focus floating window:', error)
    }
  }

  const handlePopIn = async () => {
    try {
      await popInPanel(panelId)
    } catch (error) {
      console.error('Failed to pop in panel:', error)
    }
  }

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-vibe-bg/50 backdrop-blur-sm">
      <div className="text-center p-6 rounded-lg bg-vibe-surface/50 border border-vibe-border max-w-xs">
        {/* Icon */}
        <div className="mb-4">
          <svg
            className="w-12 h-12 mx-auto text-vibe-primary opacity-70"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
            />
          </svg>
        </div>

        {/* Title */}
        <h3 className="text-vibe-text font-medium mb-1 truncate" title={title}>
          {title}
        </h3>

        {/* Status */}
        <p className="text-vibe-muted text-sm mb-4">
          {panelType === 'terminal' ? 'Terminal' : 'Tool'} is in a floating window
        </p>

        {/* Buttons */}
        <div className="flex flex-col gap-2">
          <button
            onClick={handleFocusWindow}
            className="w-full px-4 py-2 bg-vibe-primary text-white rounded-md hover:bg-vibe-primary/80 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            Bring to Front
          </button>

          <button
            onClick={handlePopIn}
            className="w-full px-4 py-2 bg-vibe-surface text-vibe-text border border-vibe-border rounded-md hover:bg-vibe-surface/80 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
              />
            </svg>
            Pop Back In
          </button>
        </div>
      </div>
    </div>
  )
}
