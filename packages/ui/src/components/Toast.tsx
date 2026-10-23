import { useSyncExternalStore } from 'react'
import { getUiBridge, type ToastKind, type ToastOptions } from '../host'
import { cx } from '../utils'
import { Icon } from '../icons/Icon'
import { Portal } from './Floating'

interface ToastEntry extends ToastOptions {
  id: number
}

let toasts: ToastEntry[] = []
let nextId = 1
const subs = new Set<() => void>()
const notify = () => subs.forEach((s) => s())

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  notify()
}

/**
 * Show a toast. Routed to the host's toast renderer when one was configured
 * via `configureUi({ toast })` (the shell / sandbox RPC), otherwise rendered
 * by the kit's own `<Toaster />`.
 */
export function toast(t: ToastOptions | string): void {
  const opts = typeof t === 'string' ? { message: t } : t
  const host = getUiBridge().toast
  if (host) {
    host(opts)
    return
  }
  const id = nextId++
  toasts = [...toasts, { ...opts, id }]
  notify()
  const duration = opts.duration ?? 4000
  if (duration > 0) setTimeout(() => dismiss(id), duration)
}

const ICON: Record<ToastKind, string> = { info: 'info', success: 'success', warning: 'warning', error: 'error' }
const TONE: Record<ToastKind, string> = {
  info: 'text-qf-secondary',
  success: 'text-qf-success',
  warning: 'text-qf-warning',
  error: 'text-qf-error',
}

export interface ToastViewProps extends ToastOptions {
  onDismiss?: () => void
  className?: string
}

/** A single toast card (also usable by a host renderer). */
export function ToastView({ title, message, kind = 'info', action, onDismiss, className }: ToastViewProps) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cx('pointer-events-auto flex w-80 items-start gap-2.5 rounded-lg border border-qf-border bg-qf-bg-elevated p-3 text-qf-text shadow-xl shadow-black/30', className)}
      style={{ animation: 'qf-fade-in 140ms ease-out' }}
    >
      <Icon name={ICON[kind]} className={cx('mt-0.5 h-4 w-4 shrink-0', TONE[kind])} />
      <div className="min-w-0 flex-1">
        {title && <div className="text-sm font-medium">{title}</div>}
        <div className="text-xs text-qf-text-muted">{message}</div>
        {action && (
          <button
            type="button"
            className="mt-1.5 text-xs font-medium text-qf-primary hover:underline"
            onClick={() => {
              action.onClick()
              onDismiss?.()
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="text-qf-text-muted hover:text-qf-text">
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

const subscribe = (cb: () => void) => {
  subs.add(cb)
  return () => {
    subs.delete(cb)
  }
}

/** Renders kit toasts (bottom-right). Mount once if no host toast renderer is configured. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts)
  if (!list.length) return null
  return (
    <Portal>
      <div className="pointer-events-none fixed bottom-4 right-4 z-[1100] flex flex-col gap-2">
        {list.map((t) => (
          <ToastView key={t.id} {...t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Portal>
  )
}
