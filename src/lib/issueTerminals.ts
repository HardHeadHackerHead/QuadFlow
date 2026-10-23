/**
 * Auto-close of agent terminals that were launched to work on an issue
 * (`TerminalState.linkedIssueId` + `autoCloseOnComplete`, set by the shell
 * when a plugin launches an agent with `issueRef`, see `hostApi` `agents.launch`).
 *
 * A linked terminal is closed once its issue is in `qa` / `done` **and** its
 * PTY has exited — whichever happens last. Shell-side because it manages the
 * terminal layout; the Issues tool itself lives in `plugins/issues` (MIG-issues)
 * and does not know about terminals.
 */
import { commands } from '../generated/bindings'
import { call, onDataChanged } from './core'
import { ensureProject } from './core/project'
import { terminalApi } from './tauri-api'
import { useTerminalStore } from '../stores/terminalStore'
import { useProjectStore } from '../stores/projectStore'

const finished = (status: string) => status === 'qa' || status === 'done'

function activeRoot(): string | undefined {
  return useProjectStore.getState().activeProject?.workingDirectory
}

function close(terminalId: string) {
  terminalApi.kill(terminalId).catch(() => {})
  useTerminalStore.getState().removeTerminal(terminalId)
}

async function issueFinished(issueId: string): Promise<boolean> {
  const root = activeRoot()
  if (!root) return false
  try {
    return finished((await call(commands.issuesGet(root, issueId))).status)
  } catch {
    return false // deleted, other project, …
  }
}

/** The PTY of `terminalId` exited: close it if its linked issue is already finished. */
export async function closeIfLinkedIssueFinished(terminalId: string): Promise<void> {
  const t = useTerminalStore.getState().terminals.get(terminalId)
  if (!t?.autoCloseOnComplete || !t.linkedIssueId) return
  if (await issueFinished(t.linkedIssueId)) close(terminalId)
}

/** Watch issue changes (UI, CLI, agents) and close exited linked terminals. Returns the unsubscribe. */
export function initIssueTerminalAutoClose(): () => void {
  return onDataChanged({ domain: 'issues' }, (e) => {
    if (e.kind === 'deleted' || e.scope.type !== 'project') return
    const linked = [...useTerminalStore.getState().terminals.values()].filter(
      (t) => t.autoCloseOnComplete && t.linkedIssueId && t.hasExited && (e.ids.length === 0 || e.ids.includes(t.linkedIssueId)),
    )
    if (linked.length === 0) return
    const root = activeRoot()
    if (!root) return
    const rootKey = e.scope.rootKey
    void ensureProject(root).then(async (p) => {
      if (p.rootKey !== rootKey) return
      for (const t of linked) if (await issueFinished(t.linkedIssueId!)) close(t.id)
    })
  })
}
