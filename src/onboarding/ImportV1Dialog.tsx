/**
 * "Bring over your projects from QuadFlow 1.x" — the 1.x project list with a
 * dry-run preview, then the import and its result. State: `importV1Store`.
 */
import { Badge, Button, Checkbox, Modal, Spinner, cx } from '@quadflow/ui'
import type { ImportV1Outcome, ImportV1ProjectReport } from '../generated/bindings'
import { isSelectable, useImportV1Store } from './importV1Store'

const OUTCOME_LABEL: Record<ImportV1Outcome, string> = {
  registered: 'Added',
  already_registered: 'Already in your projects',
  moved_aside: 'Added · 1.x data moved aside',
  would_register: 'Will be added',
  would_move_aside: 'Has 1.x data: it will be moved to .quadflow-v1-backup/',
  v1_data_kept: 'Has 1.x data (dev build: left as is)',
  missing_dir: 'Folder not found',
  failed: 'Failed',
}

function tone(o: ImportV1Outcome): 'success' | 'warning' | 'error' | 'neutral' {
  if (o === 'registered' || o === 'moved_aside') return 'success'
  if (o === 'failed') return 'error'
  if (o === 'missing_dir') return 'warning'
  return 'neutral'
}

function ProjectRow({ p, checked, onToggle }: { p: ImportV1ProjectReport; checked: boolean; onToggle: (on: boolean) => void }) {
  const selectable = isSelectable(p)
  return (
    <li
      data-import-v1-project={p.root}
      data-import-v1-outcome={p.outcome}
      className={cx('flex items-start gap-3 rounded border border-qf-border px-3 py-2', !selectable && 'opacity-60')}
    >
      <Checkbox checked={checked && selectable} disabled={!selectable} onChange={onToggle} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-qf-text">{p.name}</div>
        <div className="truncate text-xs text-qf-text-muted" title={p.root}>{p.root}</div>
        <div className="text-xs text-qf-text-muted">{OUTCOME_LABEL[p.outcome]}</div>
      </div>
    </li>
  )
}

function ResultRow({ p }: { p: ImportV1ProjectReport }) {
  return (
    <li data-import-v1-result-project={p.root} data-import-v1-outcome={p.outcome} className="rounded border border-qf-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-qf-text">{p.name}</span>
        <Badge tone={tone(p.outcome)}>{OUTCOME_LABEL[p.outcome]}</Badge>
      </div>
      {p.backupDir && <div className="truncate text-xs text-qf-text-muted" title={p.backupDir}>1.x data moved to {p.backupDir}</div>}
      {p.error && <div className="text-xs text-qf-error">{p.error}</div>}
    </li>
  )
}

export default function ImportV1Dialog() {
  const s = useImportV1Store()
  if (!s.isOpen) return null
  const preview = s.detection?.preview
  const projects = preview?.projects ?? []
  const selectable = projects.filter(isSelectable)
  const dev = preview?.profile === 'dev'
  const report = s.report
  const closeOrDismiss = () => (s.mode === 'first-run' && !report ? void s.dismiss() : s.close())

  const footer = report ? (
    <div className="flex w-full justify-end">
      <Button variant="primary" onClick={s.close} data-import-v1-done data-autofocus>Done</Button>
    </div>
  ) : (
    <div className="flex w-full items-center gap-2">
      <Button variant="ghost" onClick={closeOrDismiss} data-import-v1-dismiss>
        {s.mode === 'first-run' ? 'Not now' : 'Cancel'}
      </Button>
      <div className="flex-1" />
      <Button
        variant="primary"
        onClick={() => void s.run()}
        disabled={s.loading || s.running || !s.detection?.found || s.selected.length === 0}
        data-import-v1-run
        data-autofocus
      >
        {s.running ? 'Importing…' : `Add ${s.selected.length} project${s.selected.length === 1 ? '' : 's'}`}
      </Button>
    </div>
  )

  return (
    <Modal
      open
      size="lg"
      overlayId="import-v1"
      closeOnBackdrop={false}
      onClose={closeOrDismiss}
      title="Bring over your projects from QuadFlow 1.x"
      description={s.detection?.dataDir ? `Found QuadFlow 1.x data in ${s.detection.dataDir}` : undefined}
      footer={footer}
    >
      <div data-import-v1 data-import-v1-stage={report ? 'result' : 'select'} className="flex flex-col gap-3">
        {s.loading && (
          <div className="flex items-center gap-2 text-sm text-qf-text-muted"><Spinner /> Reading your 1.x projects…</div>
        )}
        {s.error && <div className="rounded border border-qf-error/40 px-3 py-2 text-sm text-qf-error">{s.error}</div>}
        {!s.loading && s.detection && !s.detection.found && (
          <p className="text-sm text-qf-text-muted">No QuadFlow 1.x installation was found on this computer.</p>
        )}
        {!s.loading && s.detection?.found && !report && (
          <>
            <p className="text-sm text-qf-text">
              The selected projects are added to your projects list. Settings and layouts start at the defaults.
            </p>
            <div className="rounded border border-qf-warning/40 bg-qf-warning/10 px-3 py-2 text-xs text-qf-text" data-import-v1-notice>
              {dev ? (
                <>Dev build: a project's 1.x <code>.quadflow/</code> folder is left as is (dev data goes to <code>.quadflow-dev/</code>).</>
              ) : (
                <>
                  This version can't read the issues, plans and ideas a project kept in QuadFlow 1.x. Where a project has
                  such data, its <code>.quadflow/</code> folder is moved to <code>.quadflow-v1-backup/</code> (nothing is
                  deleted) and a fresh one is created. QuadFlow 1.x can't use those projects' data afterwards.
                </>
              )}
            </div>
            <div className="flex items-center justify-between text-xs text-qf-text-muted">
              <span>{selectable.length} of {projects.length} projects can be added</span>
              <span className="flex gap-2">
                <button type="button" className="hover:text-qf-text" onClick={() => s.setAll(true)}>Select all</button>
                <button type="button" className="hover:text-qf-text" onClick={() => s.setAll(false)}>Select none</button>
              </span>
            </div>
            <ul className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto pr-1" data-import-v1-list>
              {projects.map((p) => (
                <ProjectRow key={p.root} p={p} checked={s.selected.includes(p.root)} onToggle={(on) => s.toggle(p.root, on)} />
              ))}
            </ul>
          </>
        )}
        {report && (
          <div className="flex flex-col gap-2" data-import-v1-result>
            <p className="text-sm text-qf-text">
              {report.projects.filter((p) => p.outcome === 'registered' || p.outcome === 'moved_aside' || p.outcome === 'v1_data_kept').length}{' '}
              project(s) are in your projects list now.
            </p>
            <ul className="flex max-h-[24rem] flex-col gap-2 overflow-y-auto pr-1">
              {report.projects.map((p) => <ResultRow key={p.root} p={p} />)}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
