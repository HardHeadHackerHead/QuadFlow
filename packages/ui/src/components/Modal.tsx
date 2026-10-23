import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useOverlay } from '../host'
import { cx, useEscape } from '../utils'
import { Icon } from '../icons/Icon'
import { Button } from './Button'
import { Portal } from './Floating'

const MODAL_SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-[calc(100vw-4rem)] h-[calc(100vh-4rem)]' }

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Footer content (usually buttons, right-aligned). */
  footer?: ReactNode
  size?: keyof typeof MODAL_SIZES
  /** Close when clicking the backdrop. Default true. */
  closeOnBackdrop?: boolean
  /** Hide the × button. */
  hideClose?: boolean
  overlayId?: string
  className?: string
  /** Element whose theme the modal should inherit (for data-theme subtrees). */
  themeFrom?: Element | null
}

function useFocusTrap(open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (n) => !n.hasAttribute('disabled'),
      )
    requestAnimationFrame(() => {
      const auto = el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? el
      auto?.focus()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return
      const f = focusables()
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el?.addEventListener('keydown', onKey)
    return () => {
      el?.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [open])
  return ref
}

/** Centered modal dialog. Registers with the overlay system while open. */
export function Modal({ open, onClose, title, description, children, footer, size = 'md', closeOnBackdrop = true, hideClose, overlayId, className, themeFrom }: ModalProps) {
  useOverlay(overlayId, open)
  useEscape(onClose, open)
  const ref = useFocusTrap(open)
  if (!open) return null
  return (
    <Portal themeFrom={themeFrom}>
      <div
        className="fixed inset-0 z-[900] flex items-center justify-center bg-qf-scrim/60 p-8 backdrop-blur-[1px]"
        onMouseDown={(e) => {
          if (closeOnBackdrop && e.target === e.currentTarget) onClose()
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className={cx(
            'flex max-h-full w-full flex-col overflow-hidden rounded-xl border border-qf-border bg-qf-bg-elevated text-qf-text shadow-2xl shadow-black/40 outline-none',
            MODAL_SIZES[size],
            className,
          )}
          style={{ animation: 'qf-fade-in 120ms ease-out' }}
        >
          {(title || !hideClose) && (
            <div className="flex shrink-0 items-start gap-3 border-b border-qf-border px-4 py-3">
              <div className="min-w-0 flex-1">
                {title && <h2 className="text-sm font-semibold text-qf-text">{title}</h2>}
                {description && <p className="mt-0.5 text-xs text-qf-text-muted">{description}</p>}
              </div>
              {!hideClose && (
                <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-qf-text-muted hover:bg-qf-surface hover:text-qf-text">
                  <Icon name="close" className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
          {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-qf-border bg-qf-surface/50 px-4 py-2.5">{footer}</div>}
        </div>
      </div>
    </Portal>
  )
}

/** Alias of Modal (spec name). */
export const Dialog = Modal

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  overlayId?: string
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel, overlayId }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      title={title}
      size="sm"
      overlayId={overlayId}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            data-autofocus
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-qf-text-muted">{message}</div>
    </Modal>
  )
}

export interface DrawerProps {
  open: boolean
  onClose: () => void
  side?: 'right' | 'left' | 'bottom'
  title?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** CSS width (left/right) or height (bottom). Default 24rem / 40vh. */
  extent?: string
  overlayId?: string
  className?: string
}

/** Edge-anchored sheet. Registers with the overlay system while open. */
export function Drawer({ open, onClose, side = 'right', title, children, footer, extent, overlayId, className }: DrawerProps) {
  useOverlay(overlayId, open)
  useEscape(onClose, open)
  const ref = useFocusTrap(open)
  if (!open) return null
  const pos =
    side === 'right' ? 'right-0 top-0 h-full border-l' : side === 'left' ? 'left-0 top-0 h-full border-r' : 'bottom-0 left-0 w-full border-t'
  const dim = side === 'bottom' ? { height: extent ?? '40vh' } : { width: extent ?? '24rem' }
  return (
    <Portal>
      <div className="fixed inset-0 z-[900] bg-qf-scrim/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          className={cx('absolute flex flex-col border-qf-border bg-qf-bg-elevated text-qf-text shadow-2xl outline-none', pos, className)}
          style={{ ...dim, animation: 'qf-fade-in 120ms ease-out' }}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-qf-border px-4 py-3">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</div>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-qf-text-muted hover:bg-qf-surface hover:text-qf-text">
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-qf-border px-4 py-2.5">{footer}</div>}
        </div>
      </div>
    </Portal>
  )
}
