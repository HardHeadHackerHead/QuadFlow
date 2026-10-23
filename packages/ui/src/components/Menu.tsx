import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { cx, type Placement, type Point } from '../utils'
import { Icon } from '../icons/Icon'
import { Kbd } from './Display'
import { FloatingLayer } from './Floating'

export type MenuItem =
  | {
      type?: 'item'
      id: string
      label: ReactNode
      icon?: ReactNode
      shortcut?: string
      description?: ReactNode
      danger?: boolean
      disabled?: boolean
      /** Shows a check mark (toggle items). */
      checked?: boolean
      onSelect?: () => void
    }
  | { type: 'separator'; id?: string }
  | { type: 'label'; id?: string; label: ReactNode }

export interface MenuProps {
  items: MenuItem[]
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null> | Point | null
  placement?: Placement
  overlayId?: string
  className?: string
  /** Fallback for items without their own onSelect. */
  onSelect?: (id: string) => void
}

type ActionItem = Extract<MenuItem, { id: string; label: ReactNode; type?: 'item' }>

const isAction = (i: MenuItem): i is ActionItem => (i.type === undefined || i.type === 'item') && !(i as ActionItem).disabled

/** Floating menu list. Registers with the overlay system while open. */
export function Menu({ items, open, onClose, anchor, placement = 'bottom-start', overlayId, className, onSelect }: MenuProps) {
  const [active, setActive] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const actionable = items.map((i, idx) => (isAction(i) ? idx : -1)).filter((i) => i >= 0)

  useEffect(() => {
    if (open) {
      setActive(-1)
      requestAnimationFrame(() => listRef.current?.focus())
    }
  }, [open])

  const select = (item: ActionItem) => {
    onClose()
    if (item.onSelect) item.onSelect()
    else onSelect?.(item.id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!actionable.length) return
    const pos = actionable.indexOf(active)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(actionable[(pos + 1) % actionable.length])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(actionable[(pos - 1 + actionable.length) % actionable.length])
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(actionable[0])
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(actionable[actionable.length - 1])
    } else if ((e.key === 'Enter' || e.key === ' ') && active >= 0) {
      e.preventDefault()
      select(items[active] as ActionItem)
    }
  }

  return (
    <FloatingLayer open={open} onClose={onClose} anchor={anchor} placement={placement} overlayId={overlayId} className={cx('min-w-[10rem] py-1', className)}>
      <div ref={listRef} role="menu" tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
        {items.map((item, idx) => {
          if (item.type === 'separator') return <div key={item.id ?? `sep-${idx}`} role="separator" className="my-1 h-px bg-qf-border" />
          if (item.type === 'label')
            return (
              <div key={item.id ?? `label-${idx}`} className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-qf-text-muted">
                {item.label}
              </div>
            )
          const it = item as ActionItem
          return (
            <button
              key={it.id}
              type="button"
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked}
              disabled={it.disabled}
              onMouseEnter={() => setActive(idx)}
              onClick={() => select(it)}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors disabled:opacity-40',
                it.danger ? 'text-qf-error' : 'text-qf-text',
                active === idx && (it.danger ? 'bg-qf-error/10' : 'bg-qf-primary/15'),
              )}
            >
              <span className="flex w-4 shrink-0 justify-center text-qf-text-muted">
                {it.checked ? <Icon name="check" className="h-3.5 w-3.5 text-qf-primary" /> : it.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{it.label}</span>
                {it.description && <span className="truncate text-xs text-qf-text-muted">{it.description}</span>}
              </span>
              {it.shortcut && <Kbd>{it.shortcut}</Kbd>}
            </button>
          )
        })}
      </div>
    </FloatingLayer>
  )
}

export interface DropdownMenuProps {
  trigger: ReactNode
  items: MenuItem[]
  placement?: Placement
  overlayId?: string
  className?: string
  disabled?: boolean
  onSelect?: (id: string) => void
}

/** Trigger + Menu. */
export function DropdownMenu({ trigger, items, placement, overlayId, className, disabled, onSelect }: DropdownMenuProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <span ref={anchor} className="inline-flex" aria-haspopup="menu" aria-expanded={open} onClick={() => !disabled && setOpen((o) => !o)}>
        {trigger}
      </span>
      <Menu items={items} open={open} onClose={() => setOpen(false)} anchor={anchor} placement={placement} overlayId={overlayId} className={className} onSelect={onSelect} />
    </>
  )
}

export interface ContextMenuProps {
  /** Items, or a function computing them at open time. */
  items: MenuItem[] | (() => MenuItem[])
  children: ReactNode
  className?: string
  overlayId?: string
  disabled?: boolean
  onSelect?: (id: string) => void
}

/** Right-click menu around `children`. */
export function ContextMenu({ items, children, className, overlayId, disabled, onSelect }: ContextMenuProps) {
  const [point, setPoint] = useState<Point | null>(null)
  const [resolved, setResolved] = useState<MenuItem[]>([])
  return (
    <div
      className={className}
      onContextMenu={(e) => {
        if (disabled) return
        e.preventDefault()
        setResolved(typeof items === 'function' ? items() : items)
        setPoint({ x: e.clientX, y: e.clientY })
      }}
    >
      {children}
      <Menu items={resolved} open={!!point} onClose={() => setPoint(null)} anchor={point} placement="bottom-start" overlayId={overlayId} onSelect={onSelect} />
    </div>
  )
}
