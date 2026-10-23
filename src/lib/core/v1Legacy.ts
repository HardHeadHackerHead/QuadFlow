/**
 * QuadFlow 1.x project folders (core `import_v1::legacy`): before a project is
 * opened, a 1.x `.quadflow/` is moved aside to `.quadflow-v1-backup/` and a
 * fresh one is created (release builds; dev builds only report it). The user
 * gets a toast with the backup path. Checked once per folder per session.
 */
import { toast } from '@quadflow/ui'
import { commands, type ImportV1LegacyNotice } from '../../generated/bindings'
import { call } from './index'

const checked = new Map<string, Promise<ImportV1LegacyNotice | null>>()

/** Notices shown this session (e2e tests read them). */
export const shownV1Notices: ImportV1LegacyNotice[] = []

export function checkV1Project(root: string): Promise<ImportV1LegacyNotice | null> {
  const key = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  let p = checked.get(key)
  if (!p) {
    p = call(commands.importV1CheckProject(root))
      .then((n) => {
        if (n) {
          shownV1Notices.push(n)
          ;(window as unknown as { __qfV1Notices?: ImportV1LegacyNotice[] }).__qfV1Notices = shownV1Notices
          toast({
            kind: n.moved ? 'warning' : 'info',
            title: 'Data from QuadFlow 1.x',
            message: n.backupDir ? `${n.message}\nBackup: ${n.backupDir}` : n.message,
            duration: 0,
          })
        }
        return n
      })
      .catch((e) => {
        checked.delete(key)
        console.error('[import-v1] could not check the project folder:', e)
        return null
      })
    checked.set(key, p)
  }
  return p
}
