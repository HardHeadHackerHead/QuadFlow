import { Terminal } from '@xterm/xterm'

// Registry to store terminal instances for buffer access
const terminalInstances = new Map<string, Terminal>()

export function registerTerminal(id: string, terminal: Terminal): void {
  terminalInstances.set(id, terminal)
}

export function unregisterTerminal(id: string): void {
  terminalInstances.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return terminalInstances.get(id)
}

// Get the buffer content (scrollback + visible) from a terminal
export function getTerminalBuffer(id: string): string | undefined {
  const terminal = terminalInstances.get(id)
  if (!terminal) return undefined

  const buffer = terminal.buffer.active
  const lines: string[] = []

  // Get all lines from the buffer (scrollback + viewport)
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (line) {
      lines.push(line.translateToString(true))
    }
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }

  return lines.join('\n')
}

// Get all terminal buffers
export function getAllTerminalBuffers(): Map<string, string> {
  const buffers = new Map<string, string>()
  for (const [id] of terminalInstances) {
    const buffer = getTerminalBuffer(id)
    if (buffer) {
      buffers.set(id, buffer)
    }
  }
  return buffers
}
