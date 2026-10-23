// Agent session glue for the shell (agent-providers.md §8.3, §8.5).
//
// The core owns discovery: `agents_launch` registers a pending launch for
// `discover` providers and emits `agent-session-linked` once its session file
// appears (FIFO, never claimed twice). This module applies those events to the
// terminal's `AgentBinding`, and on restore seeds the core's claims with every
// persisted binding (resuming discovery for bindings still `pending`).
// Killing a terminal (`kill_terminal`) releases its claim in the core.

import { events, type AgentRestoreEntry } from '../generated/bindings'
import { restoreAgentSessions } from './core/agents'
import { useTerminalStore } from '../stores/terminalStore'

let listening = false

/** Apply `agent-session-linked` / `-unlinked` to terminal bindings (once per app). */
export function initAgentSessionListener(): void {
  if (listening) return
  listening = true
  void events.agentSessionLinked.listen(({ payload }) => {
    const store = useTerminalStore.getState()
    const b = store.terminals.get(payload.terminalId)?.agent
    if (!b || b.providerId !== payload.providerId || b.syncEnabled === false) return
    store.updateTerminal(payload.terminalId, { agent: { ...b, sessionId: payload.sessionId, sessionState: 'linked' } })
  })
  void events.agentSessionUnlinked.listen(({ payload }) => {
    const store = useTerminalStore.getState()
    const b = store.terminals.get(payload.terminalId)?.agent
    if (!b || b.sessionId) return
    store.updateTerminal(payload.terminalId, { agent: { ...b, sessionState: 'unlinked' } })
  })
}

/** Restore (§8.5): seed claims; resume discovery of bindings that were still pending. */
export function reconcileAgentSessionsOnRestore(workingDirectory: string): void {
  const entries: AgentRestoreEntry[] = []
  for (const t of useTerminalStore.getState().terminals.values()) {
    if (!t.agent) continue
    entries.push({ terminalId: t.id, cwd: t.workingDirectory || workingDirectory, binding: t.agent })
  }
  restoreAgentSessions(entries).catch((err) => console.error('[agents] restore reconciliation failed:', err))
}
