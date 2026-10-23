import { useEffect, useRef, useCallback, useState } from 'react'
import { isModKey } from '../../lib/platformKeys'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { terminalApi, requestWindowAttention, openExternal } from '../../lib/tauri-api'
import { registerTerminal, unregisterTerminal } from '../../lib/terminalRegistry'
import { useTerminalStore, terminalActivityMap } from '../../stores/terminalStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { closeIfLinkedIssueFinished } from '../../lib/issueTerminals'
import { shouldTriggerAttention } from '../../lib/attentionDetector'
import { getProviderInfo } from '../../agents/providers'
import { redactSecrets } from '../../lib/secretRedaction'
import { applyPtyPlatformOptions } from '../../lib/xtermPlatform'
import { getTerminalTheme, onTerminalThemeChange } from '../../lib/terminalTheme'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  terminalId: string
}

export default function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const resizeTimeoutRef = useRef<number | null>(null)
  const initializedRef = useRef(false)
  const attentionTimeoutRef = useRef<number | null>(null)
  const recentOutputRef = useRef<string>('')
  const skipNextEnterRef = useRef(false)
  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const [isIssueDragOver, setIsIssueDragOver] = useState(false)
  const [issueDragLabel, setIssueDragLabel] = useState('')

  // Debounced resize handler to prevent flickering
  const handleResize = useCallback(() => {
    if (resizeTimeoutRef.current) {
      cancelAnimationFrame(resizeTimeoutRef.current)
    }
    resizeTimeoutRef.current = requestAnimationFrame(() => {
      if (fitAddonRef.current && terminalRef.current) {
        try {
          fitAddonRef.current.fit()
          const dims = fitAddonRef.current.proposeDimensions()
          if (dims) {
            terminalApi.resize(terminalId, dims.cols, dims.rows)
          }
          // Always scroll to bottom after resize
          terminalRef.current.scrollToBottom()
        } catch {
          // Ignore resize errors
        }
      }
    })
  }, [terminalId])

  useEffect(() => {
    // Prevent double initialization in React StrictMode
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let mounted = true
    let unsubscribeData: (() => void) | null = null
    let unsubscribeExit: (() => void) | null = null
    let unsubscribeSettings: (() => void) | null = null
    let unsubscribeTheme: (() => void) | null = null

    // Get terminal settings from app settings store
    const terminalSettings = useAppSettingsStore.getState().terminal

    // Create terminal instance with optimized settings
    const terminal = new Terminal({
      cursorBlink: terminalSettings.cursorBlink,
      cursorStyle: terminalSettings.cursorStyle,
      fontSize: terminalSettings.fontSize,
      fontFamily: terminalSettings.fontFamily,
      lineHeight: terminalSettings.lineHeight,
      scrollback: terminalSettings.scrollbackLines,
      allowProposedApi: true,
      smoothScrollDuration: 0,
      // windowsPty is applied below from the real OS build (never hardcoded):
      // a fake old build enables xterm's legacy ConPTY wrap heuristics, which
      // put hard newlines at every wrap when copying.
      theme: getTerminalTheme(),
    })
    applyPtyPlatformOptions(terminal)

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_event, url) => {
      openExternal(url)
    })

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)

    terminal.open(containerRef.current)

    // Try to load WebGL addon for better rendering performance (if enabled)
    if (terminalSettings.useWebGL) {
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
        })
        terminal.loadAddon(webglAddon)
      } catch {
        console.log('WebGL not available, using canvas renderer')
      }
    }

    requestAnimationFrame(() => {
      if (mounted) {
        fitAddon.fit()
      }
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    // Handle copy-on-select
    if (terminalSettings.copyOnSelect) {
      terminal.onSelectionChange(() => {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection).catch((err) => {
            console.error('Failed to copy selection:', err)
          })
        }
      })
    }

    // Handle bell events
    terminal.onBell(() => {
      const currentSettings = useAppSettingsStore.getState().terminal
      if (currentSettings.bellStyle === 'none') return

      // Visual bell - flash the terminal
      if (currentSettings.bellStyle === 'visual' || currentSettings.bellStyle === 'both') {
        if (containerRef.current) {
          containerRef.current.style.backgroundColor = '#3f3f5a'
          setTimeout(() => {
            if (containerRef.current) {
              containerRef.current.style.backgroundColor = ''
            }
          }, 100)
        }
      }

      // Sound bell - play a system beep
      if (currentSettings.bellStyle === 'sound' || currentSettings.bellStyle === 'both') {
        const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
        const oscillator = audioContext.createOscillator()
        const gainNode = audioContext.createGain()
        oscillator.connect(gainNode)
        gainNode.connect(audioContext.destination)
        oscillator.frequency.value = 800
        gainNode.gain.value = 0.1
        oscillator.start()
        setTimeout(() => {
          oscillator.stop()
          audioContext.close()
        }, 100)
      }
    })

    // Register terminal for buffer access
    registerTerminal(terminalId, terminal)

    // Restore pending buffer content if available
    const terminalState = useTerminalStore.getState().terminals.get(terminalId)
    if (terminalState?.pendingBufferContent) {
      const bufferContent = useAppSettingsStore.getState().terminal.streamerMode
        ? redactSecrets(terminalState.pendingBufferContent)
        : terminalState.pendingBufferContent
      terminal.write(bufferContent)
      // Clear the pending buffer content
      useTerminalStore.getState().updateTerminal(terminalId, { pendingBufferContent: undefined })
    }

    // Handle user input -> send to Tauri backend
    terminal.onData((data) => {
      // If we just handled Shift+Enter, skip the carriage return that follows
      if (skipNextEnterRef.current && (data === '\r' || data === '\n' || data === '\r\n')) {
        skipNextEnterRef.current = false
        return
      }
      terminalApi.write(terminalId, data)
    })

    // Subscribe to data from Tauri backend
    terminalApi.onData(terminalId, (data) => {
      if (mounted && terminalRef.current) {
        const displayData = useAppSettingsStore.getState().terminal.streamerMode
          ? redactSecrets(data)
          : data
        terminalRef.current.write(displayData)

        // Track activity for idle detection (write to module-level map, no Zustand re-render)
        terminalActivityMap.set(terminalId, Date.now())
        // If terminal was idle, clear it immediately via store
        const idleTerminal = useTerminalStore.getState().terminals.get(terminalId)
        if (idleTerminal?.isIdle) {
          useTerminalStore.getState().setTerminalIdle(terminalId, false)
        }

        // Attention detection for agent terminals (generic + provider patterns)
        const currentTerminal = useTerminalStore.getState().terminals.get(terminalId)
        if (currentTerminal?.agent) {
          // Accumulate recent output (keep last 2000 chars for pattern matching)
          // Need enough to capture full selection menus
          recentOutputRef.current = (recentOutputRef.current + data).slice(-2000)

          // Clear any existing attention check timeout
          if (attentionTimeoutRef.current) {
            clearTimeout(attentionTimeoutRef.current)
          }

          // Set a debounced timeout to check for attention patterns
          // Wait 800ms after the last output for the agent's TUI to finish rendering
          attentionTimeoutRef.current = window.setTimeout(() => {
            const store = useTerminalStore.getState()
            const terminal = store.terminals.get(terminalId)
            const isActive = store.activeTerminalId === terminalId
            const isMinimized = store.minimizedTerminals.includes(terminalId)

            // Check if output matches attention patterns
            const patterns = getProviderInfo(terminal?.agent?.providerId)?.attentionPatterns ?? []
            const needsAttention = shouldTriggerAttention(recentOutputRef.current, patterns)
            const windowHasFocus = document.hasFocus()

            // Trigger attention if:
            // 1. Output matches attention patterns (asking question/waiting for input)
            // AND either:
            //   a. Terminal is not currently active/focused, OR
            //   b. Window doesn't have focus (user tabbed away)
            if (terminal && needsAttention && (!isActive || !windowHasFocus)) {
              // Set attention flag on the terminal
              store.setTerminalAttention(terminalId, true)

              // Flash taskbar if minimized or window not focused (and setting is enabled)
              const appSettings = useAppSettingsStore.getState()
              if ((isMinimized || !windowHasFocus) && appSettings.terminal.flashTaskbarOnAttention) {
                requestWindowAttention().catch(console.error)
              }
            }

            // Clear recent output after checking
            recentOutputRef.current = ''
          }, 800)
        }
      }
    }).then((unlisten) => {
      if (mounted) {
        unsubscribeData = unlisten
      } else {
        // Already unmounted, clean up immediately
        unlisten()
      }
    })

    // Subscribe to exit events. Stale exits from a previous spawn that shared
    // this id (workspace switching) are filtered by generation in terminalApi.
    terminalApi.onExit(terminalId, () => {
      if (mounted && terminalRef.current) {
        terminalRef.current.write('\r\n\x1b[31m[Terminal closed]\x1b[0m\r\n')
      }

      // Mark PTY as exited for auto-close tracking
      useTerminalStore.getState().updateTerminal(terminalId, { hasExited: true })

      // Reverse case: PTY exits after the linked issue already moved to qa/done
      void closeIfLinkedIssueFinished(terminalId)
    }).then((unlisten) => {
      if (mounted) {
        unsubscribeExit = unlisten
      } else {
        unlisten()
      }
    })

    // Initial resize
    requestAnimationFrame(() => {
      if (mounted) {
        const dims = fitAddon.proposeDimensions()
        if (dims) {
          terminalApi.resize(terminalId, dims.cols, dims.rows)
        }
      }
    })

    // Set up resize observer
    const resizeObserver = new ResizeObserver(() => {
      handleResize()
    })
    resizeObserver.observe(containerRef.current)

    terminal.focus()

    // Follow light/dark theme changes (terminal palette comes from --qf-term-* tokens)
    unsubscribeTheme = onTerminalThemeChange((theme) => {
      if (terminalRef.current) terminalRef.current.options.theme = theme
    })

    // Subscribe to settings changes to update terminal dynamically
    unsubscribeSettings = useAppSettingsStore.subscribe((state) => {
      if (terminalRef.current) {
        const newSettings = state.terminal
        terminalRef.current.options.fontSize = newSettings.fontSize
        terminalRef.current.options.fontFamily = newSettings.fontFamily
        terminalRef.current.options.lineHeight = newSettings.lineHeight
        terminalRef.current.options.cursorStyle = newSettings.cursorStyle
        terminalRef.current.options.cursorBlink = newSettings.cursorBlink
        // Note: scrollback can't be changed after terminal creation
        // Refit after font change
        if (fitAddonRef.current) {
          requestAnimationFrame(() => {
            fitAddonRef.current?.fit()
          })
        }
      }
    })

    // Handle special key combinations
    terminal.attachCustomKeyEventHandler((event) => {
      // Handle Shift+Enter for newline (instead of submitting)
      if (event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'keydown') {
          // Set flag to skip the carriage return that xterm will still send
          skipNextEnterRef.current = true
          // Send just a newline character
          terminalApi.write(terminalId, '\n')
        }
        return false // Prevent xterm from handling
      }

      // Handle Ctrl+V for paste
      if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
        event.preventDefault() // Prevent browser paste event (which would cause double paste)
        navigator.clipboard.readText().then((text) => {
          if (text && terminalRef.current) {
            terminalApi.write(terminalId, text)
          }
        }).catch((err) => {
          console.error('Failed to read clipboard:', err)
        })
        return false // Prevent xterm from handling
      }

      // Handle Ctrl+C for copy (only when there's a selection)
      if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection).catch((err) => {
            console.error('Failed to write to clipboard:', err)
          })
          return false // Prevent default handling (don't send SIGINT)
        }
        // If no selection, let Ctrl+C pass through as SIGINT
      }

      // Handle Ctrl+Shift+C for copy (alternative)
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection).catch((err) => {
            console.error('Failed to write to clipboard:', err)
          })
          return false
        }
      }

      // Handle Ctrl+Shift+V for paste (alternative)
      if (event.ctrlKey && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        event.preventDefault() // Prevent browser paste event (which would cause double paste)
        navigator.clipboard.readText().then((text) => {
          if (text && terminalRef.current) {
            terminalApi.write(terminalId, text)
          }
        }).catch((err) => {
          console.error('Failed to read clipboard:', err)
        })
        return false
      }

      // Let global app shortcuts pass through (don't let xterm consume them)
      if (isModKey(event) && (event.key === 'w' || event.key === 'k' || event.key === 'b' || (event.shiftKey && (event.key === 'P' || event.key === 'B')))) {
        return false
      }

      return true // Allow other keys
    })

    return () => {
      mounted = false
      initializedRef.current = false
      resizeObserver.disconnect()

      if (resizeTimeoutRef.current) {
        cancelAnimationFrame(resizeTimeoutRef.current)
      }
      if (attentionTimeoutRef.current) {
        clearTimeout(attentionTimeoutRef.current)
      }
      if (unsubscribeData) {
        unsubscribeData()
      }
      if (unsubscribeExit) {
        unsubscribeExit()
      }
      if (unsubscribeSettings) {
        unsubscribeSettings()
      }
      if (unsubscribeTheme) {
        unsubscribeTheme()
      }

      unregisterTerminal(terminalId)
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId, handleResize])

  const handleClick = () => {
    terminalRef.current?.focus()
    // Clear attention flag when terminal is clicked/focused
    const terminal = useTerminalStore.getState().terminals.get(terminalId)
    if (terminal?.needsAttention) {
      useTerminalStore.getState().setTerminalAttention(terminalId, false)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    const settings = useAppSettingsStore.getState().terminal
    if (settings.rightClickPaste) {
      e.preventDefault()
      navigator.clipboard.readText().then((text) => {
        if (text && terminalRef.current) {
          terminalApi.write(terminalId, text)
        }
      }).catch((err) => {
        console.error('Failed to read clipboard:', err)
      })
    }
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
