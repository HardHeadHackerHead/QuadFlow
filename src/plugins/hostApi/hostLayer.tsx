/**
 * Host-rendered UI for plugins: `ui.confirm` / `ui.prompt` dialogs and the
 * toast stack for `notifications.toast` (plugin-system.md §6.6, §6.7). Mounted
 * lazily into its own root on first use; built from `@quadflow/ui`, so the
 * overlays register with the shell overlay store (native views hide).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, ConfirmDialog, Field, Input, Modal, Toaster } from '@quadflow/ui'

type Dialog =
  | { id: number; kind: 'confirm'; title: string; message: string; confirmLabel?: string; danger?: boolean; resolve(v: boolean): void }
  | { id: number; kind: 'prompt'; title: string; label?: string; initial?: string; resolve(v: string | null): void }

let dialogs: Dialog[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const store = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  get: () => dialogs,
}

let mounted = false
function ensureMounted() {
  if (mounted || typeof document === 'undefined') return
  mounted = true
  const el = document.createElement('div')
  el.id = 'qf-plugin-host-layer'
  document.body.appendChild(el)
  createRoot(el).render(<HostLayer />)
}

function remove(id: number) {
  dialogs = dialogs.filter((d) => d.id !== id)
  emit()
}

export function hostConfirm(o: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  ensureMounted()
  return new Promise((resolve) => {
    dialogs = [...dialogs, { id: nextId++, kind: 'confirm', ...o, resolve }]
    emit()
  })
}

export function hostPrompt(o: { title: string; label?: string; initial?: string }): Promise<string | null> {
  ensureMounted()
  return new Promise((resolve) => {
    dialogs = [...dialogs, { id: nextId++, kind: 'prompt', ...o, resolve }]
    emit()
  })
}

/** Make sure the toast stack is mounted (toasts render through `@quadflow/ui`'s Toaster). */
export function ensureToaster() {
  ensureMounted()
}

function PromptDialog({ d }: { d: Extract<Dialog, { kind: 'prompt' }> }) {
  const [value, setValue] = useState(d.initial ?? '')
  useEffect(() => setValue(d.initial ?? ''), [d.initial])
  const done = (v: string | null) => {
    remove(d.id)
    d.resolve(v)
  }
  return (
    <Modal
      open
      title={d.title}
      onClose={() => done(null)}
      size="sm"
      overlayId={`plugin-prompt-${d.id}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => done(value)} data-testid="plugin-prompt-ok">
            OK
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          done(value)
        }}
      >
        <Field label={d.label ?? ''}>
          <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} data-testid="plugin-prompt-input" />
        </Field>
      </form>
    </Modal>
  )
}

function HostLayer() {
  const list = useSyncExternalStore(store.subscribe, store.get)
  return (
    <>
      {list.map((d) =>
        d.kind === 'confirm' ? (
          <ConfirmDialog
            key={d.id}
            open
            title={d.title}
            message={d.message}
            confirmLabel={d.confirmLabel}
            danger={d.danger}
            overlayId={`plugin-confirm-${d.id}`}
            onConfirm={() => {
              remove(d.id)
              d.resolve(true)
            }}
            onCancel={() => {
              remove(d.id)
              d.resolve(false)
            }}
          />
        ) : (
          <PromptDialog key={d.id} d={d} />
        ),
      )}
      <Toaster />
    </>
  )
}
