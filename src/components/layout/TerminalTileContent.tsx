import { TerminalState } from '../../types'
import { useTerminalStore } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import TerminalView from '../terminal/TerminalView'
import TerminalAgentOverlay from '../../agents/TerminalAgentOverlay'

interface TerminalTileContentProps {
  terminal: TerminalState
}

export default function TerminalTileContent({ terminal }: TerminalTileContentProps) {
  const { activeTerminalId, setActiveTerminal, setTerminalAttention, promoteToMain } = useTerminalStore()
  const clickToPromote = useAppSettingsStore((s) => s.toolbar.clickToPromote)
  const isActive = activeTerminalId === terminal.id

  const handleFocus = () => {
    setActiveTerminal(terminal.id)
    if (terminal.needsAttention) {
      setTerminalAttention(terminal.id, false)
    }
    if (clickToPromote) {
      promoteToMain(terminal.id)
    }
  }

  return (
    <div
      className={`h-full w-full flex flex-col overflow-hidden rounded-b-lg border-x border-b transition-colors relative ${
        isActive
          ? 'border-vibe-primary'
          : 'border-vibe-border'
      }`}
      onClick={handleFocus}
    >
      <div className="flex-1 bg-[rgb(var(--qf-term-bg))] min-h-0">
        <TerminalView terminalId={terminal.id} />
      </div>
      <TerminalAgentOverlay terminal={terminal} />
    </div>
  )
}
