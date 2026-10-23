import { TerminalState } from '../types'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useConfirmModalStore } from '../stores/confirmModalStore'

/**
 * Check confirmClose setting and prompt user if needed.
 * Returns true if the close should proceed, false if cancelled.
 */
export async function confirmTerminalClose(terminal: TerminalState): Promise<boolean> {
  const { confirmClose } = useAppSettingsStore.getState().terminal
  if (confirmClose && terminal.status === 'active') {
    return await useConfirmModalStore.getState().ask({
      title: 'Close terminal',
      message: `Close this terminal${terminal.title ? ` (${terminal.title})` : ''}?\nThe running process will be terminated.`,
      confirmLabel: 'Close terminal',
      cancelLabel: 'Cancel',
      kind: 'warning',
    })
  }
  return true
}
