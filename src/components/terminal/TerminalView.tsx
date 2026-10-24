import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { terminalApi } from '../../lib/tauri-api'
import { useTerminalStore } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import {
  acquireLiveTerminal,
  releaseLiveTerminal,
  fitLiveTerminal,
  resyncViewport,
  handleTerminalContextMenu,
  type LiveTerminal,
} from './liveTerminals'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  terminalId: string
}

/**
 * A terminal tile's view. The xterm itself lives in `liveTerminals` for as long
 * as its PTY: this component only shows it, keeps it fitted, and parks it on
 * unmount (project/workspace switch, minimize), so scrollback survives.
 */
export default function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The GUI harness (scripts/ui/xterm.mjs) finds the xterm through this ref.
  const terminalRef = useRef<Terminal | null>(null)
  const liveRef = useRef<LiveTerminal | null>(null)
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const [isIssueDragOver, setIsIssueDragOver] = useState(false)
  const [issueDragLabel, setIssueDragLabel] = useState('')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const owner = {}
    const { live: t, adopted } = acquireLiveTerminal(terminalId, container, owner)
    liveRef.current = t
    terminalRef.current = t.terminal

    let frame: number | null = null
    // Hidden (0-size) since the last fit: re-sync the viewport when shown again.
    let needsResync = adopted
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        if (!fitLiveTerminal(t)) {
          needsResync = true // not laid out (hidden): never fit to 0, wait for the next resize
          return
        }
        if (needsResync) {
          needsResync = false
          resyncViewport(t.terminal)
        }
      })
    }
    schedule()
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(container)

    t.terminal.focus()

    return () => {
      resizeObserver.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      releaseLiveTerminal(t, owner)
      if (liveRef.current === t) liveRef.current = null
      if (terminalRef.current === t.terminal) terminalRef.current = null
    }
  }, [terminalId])

  const handleClick = () => {
    terminalRef.current?.focus()
    // Clear attention flag when terminal is clicked/focused
    const terminal = useTerminalStore.getState().terminals.get(terminalId)
    if (terminal?.needsAttention) {
      useTerminalStore.getState().setTerminalAttention(terminalId, false)
    }
  }

  // Right-click: copy the selection, or paste when nothing is selected.
  const handleContextMenu = (e: React.MouseEvent) => {
    if (liveRef.current) handleTerminalContextMenu(liveRef.current, e)
  }

  // File & issue drag-and-drop handlers
  // Uses native capture-phase listeners so they fire before react-dnd's handlers
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const isFile = (dt: DataTransfer) => dt.types.includes('application/quadflow-file')
    const isIssue = (dt: DataTransfer) => dt.types.includes('application/quadflow-issue')

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return
      if (isFile(e.dataTransfer)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setIsFileDragOver(true)
      } else if (isIssue(e.dataTransfer)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setIsIssueDragOver(true)
      }
    }
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return
      if (isFile(e.dataTransfer) || isIssue(e.dataTransfer)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onDragLeave = (e: DragEvent) => {
      if (el.contains(e.relatedTarget as Node)) return
      setIsFileDragOver(false)
      setIsIssueDragOver(false)
      setIssueDragLabel('')
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsFileDragOver(false)
      setIsIssueDragOver(false)
      setIssueDragLabel('')

      // Handle file drop
      try {
        const rawFile = e.dataTransfer?.getData('application/quadflow-file')
        if (rawFile) {
          const file = JSON.parse(rawFile) as { name: string; path: string; isDirectory: boolean }
          if (file.path) {
            const filePath = file.path.replace(/\\/g, '/')
            terminalApi.write(terminalId, `@${filePath} `)
            terminalRef.current?.focus()
          }
          return
        }
      } catch { /* Ignore malformed data */ }

      // Handle issue drop
      try {
        const rawIssue = e.dataTransfer?.getData('application/quadflow-issue')
        if (!rawIssue) return
        // Payload of the Issues plugin's card drag handle (plugins/issues): `ref` is `CODE-n`.
        const issue = JSON.parse(rawIssue) as { id: string; title: string; ref?: string }

        // Build the /issue-to-prompt command
        const issueRef = issue.ref || issue.id
        const command = `/issue-to-prompt ${issueRef}`

        // Check if terminal is idle — auto-execute if so, otherwise just pre-fill
        const termState = useTerminalStore.getState().terminals.get(terminalId)
        const idle = termState?.isIdle ?? false
        terminalApi.write(terminalId, idle ? `${command}\r` : command)
        terminalRef.current?.focus()

        // Link the terminal to this issue
        useTerminalStore.getState().updateTerminal(terminalId, {
          linkedIssueId: issue.id,
          originalPrompt: command,
          autoCloseOnComplete: true,
        })
      } catch { /* Ignore malformed data */ }
    }

    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('dragleave', onDragLeave, true)
    el.addEventListener('drop', onDrop, true)
    el.addEventListener('dragenter', onDragEnter, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('dragleave', onDragLeave, true)
      el.removeEventListener('drop', onDrop, true)
      el.removeEventListener('dragenter', onDragEnter, true)
    }
  }, [terminalId])

  return (
    <div className="h-full w-full relative">
      <div
        ref={containerRef}
        className="h-full w-full terminal-container"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ padding: `${useAppSettingsStore.getState().terminal.terminalPadding}px` }}
      />
      {isFileDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 bg-teal-500/10 border-2 border-dashed border-teal-400/60 rounded-lg">
          <div className="bg-vibe-surface/90 backdrop-blur-sm px-4 py-2 rounded-lg border border-teal-400/40 shadow-lg">
            <span className="text-sm font-medium text-teal-300">Drop to insert @file reference</span>
          </div>
        </div>
      )}
      {isIssueDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 bg-purple-500/10 border-2 border-dashed border-purple-400/60 rounded-lg">
          <div className="bg-vibe-surface/90 backdrop-blur-sm px-4 py-2 rounded-lg border border-purple-400/40 shadow-lg flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="text-sm font-medium text-purple-300">
              {issueDragLabel ? `Drop to work on ${issueDragLabel}` : 'Drop to work on issue'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
