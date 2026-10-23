import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useOverlay } from '../host'
import { cx, useClickOutside, useEscape, useFloatingPosition, useIsoLayoutEffect, type Placement, type Point } from '../utils'

/**
 * Portal into document.body that keeps the theme of the element it was opened
 * from (so a `data-theme="light"` subtree's popovers are light too).
 */
export function Portal({ children, themeFrom }: { children: ReactNode; themeFrom?: Element | null }) {
  const [theme, setTheme] = useState<string | undefined>()
  useIsoLayoutEffect(() => {
    const scoped = themeFrom?.closest<HTMLElement>('[data-theme]')
    setTheme(scoped && scoped !== document.documentElement ? scoped.dataset.theme : undefined)
  }, [themeFrom])
  if (typeof document === 'undefined') return null
  return createPortal(
    theme ? (
      <div data-theme={theme} style={{ display: 'contents' }}>
        {children}
      </div>
    ) : (
      children
    ),
    document.body,
  )
}

export interface FloatingLayerProps {
  open: boolean
  onClose: () => void
  /** Anchor element ref or a viewport point (context menus). */
  anchor: RefObject<HTMLElement | null> | Point | null
  placement?: Placement
  offset?: number
  /** Overlay id for the host overlay registry; auto-generated if omitted. */
  overlayId?: string
  /** Register with the overlay system (hides native views). Default true. */
  registerOverlay?: boolean
  closeOnOutsideClick?: boolean
  /** Match the anchor's width (selects). */
  matchAnchorWidth?: boolean
  className?: string
  style?: CSSProperties
  role?: string
  children: ReactNode
  /** Extra elements that count as "inside" for outside-click detection. */
  insideRefs?: RefObject<HTMLElement | null>[]
}

export const FLOATING_SURFACE =
  'rounded-lg border border-qf-border bg-qf-bg-elevated text-qf-text shadow-xl shadow-black/30'

/** Positioned, portaled floating surface used by Popover, Menu, Select, Combobox, ContextMenu. */
export function FloatingLayer({
  open,
  onClose,
  anchor,
  placement = 'bottom-start',
  offset,
  overlayId,
  registerOverlay = true,
  closeOnOutsideClick = true,
  matchAnchorWidth,
  className,
  style,
  role,
  children,
  insideRefs = [],
}: FloatingLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const anchorRef = anchor && 'current' in anchor ? anchor : null
  useOverlay(overlayId, open && registerOverlay)
  useEscape(onClose, open)
  useClickOutside([ref, ...(anchorRef ? [anchorRef] : []), ...insideRefs], onClose, open && closeOnOutsideClick)
  const pos = useFloatingPosition(open, anchor, ref, placement, offset)
  if (!open) return null
  const width = matchAnchorWidth && anchorRef?.current ? anchorRef.current.offsetWidth : undefined
  return (
    <Portal themeFrom={anchorRef?.current ?? null}>
      <div
        ref={ref}
        role={role}
        className={cx('fixed z-[1000]', FLOATING_SURFACE, className)}
        style={{
          left: pos?.x ?? -9999,
          top: pos?.y ?? -9999,
          minWidth: width,
          visibility: pos ? 'visible' : 'hidden',
          animation: 'qf-fade-in 90ms ease-out',
          ...style,
        }}
      >
        {children}
      </div>
    </Portal>
  )
}

export interface PopoverProps {
  /** Trigger content; wrapped in an inline element that toggles the popover. */
  trigger: ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  open?: boolean
  onOpenChange?: (open: boolean) => void
  placement?: Placement
  className?: string
  overlayId?: string
  disabled?: boolean
}

export function Popover({ trigger, children, open: openProp, onOpenChange, placement = 'bottom-start', className, overlayId, disabled }: PopoverProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [inner, setInner] = useState(false)
  const open = openProp ?? inner
  const setOpen = (v: boolean) => {
    if (openProp === undefined) setInner(v)
    onOpenChange?.(v)
  }
  const close = () => setOpen(false)
  return (
    <>
      <span
        ref={anchor}
        className="inline-flex"
        onClick={() => !disabled && setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {trigger}
      </span>
      <FloatingLayer open={open} onClose={close} anchor={anchor} placement={placement} overlayId={overlayId} role="dialog" className={cx('p-3', className)}>
        {typeof children === 'function' ? children(close) : children}
      </FloatingLayer>
    </>
  )
}

export interface TooltipProps {
  content: ReactNode
  children: ReactNode
  placement?: Placement
  /** ms before showing. Default 400. */
  delay?: number
  className?: string
}

/** Hover/focus tooltip. Deliberately does NOT register as an overlay (§14.2). */
export function Tooltip({ content, children, placement = 'top', delay = 400, className }: TooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const [open, setOpen] = useState(false)
  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    <>
      <span ref={anchor} className="inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
        {children}
      </span>
      <FloatingLayer
        open={open && !!content}
        onClose={hide}
        anchor={anchor}
        placement={placement}
        registerOverlay={false}
        closeOnOutsideClick={false}
        role="tooltip"
        className={cx('pointer-events-none max-w-xs px-2 py-1 text-xs shadow-md', className)}
      >
        {content}
      </FloatingLayer>
    </>
  )
}
