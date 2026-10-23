import type { ReactNode } from 'react'
import { Modal } from '@quadflow/ui'

/**
 * A dialog of the Issues tool: `@quadflow/ui` `Modal` (portals to `body`,
 * registers with the overlay system so native embeds hide under it) with the
 * plugin's style scope around the portal content.
 */
export function Overlay({ open, onClose, id, size = 'sm', children }: { open: boolean; onClose: () => void; id: string; size?: 'sm' | 'md'; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} overlayId={`issues-${id}`} size={size} hideClose>
      <div className="qf-issues">{children}</div>
    </Modal>
  )
}
