import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cx } from '../utils'

export interface TabItem<V extends string = string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  badge?: ReactNode
  disabled?: boolean
}

export interface TabsProps<V extends string = string> {
  value: V
  onChange: (value: V) => void
  items: TabItem<V>[]
  variant?: 'underline' | 'pills'
  size?: 'sm' | 'md'
  className?: string
}

export function Tabs<V extends string = string>({ value, onChange, items, variant = 'underline', size = 'md', className }: TabsProps<V>) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const enabled = items.filter((i) => !i.disabled)
    const idx = enabled.findIndex((i) => i.value === value)
    const next = enabled[(idx + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length]
    if (next) onChange(next.value)
  }
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cx('flex items-center', variant === 'underline' ? 'gap-1 border-b border-qf-border' : 'gap-1 rounded-lg bg-qf-surface p-0.5', className)}
    >
      {items.map((t) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.value)}
            className={cx(
              'inline-flex items-center gap-1.5 font-medium transition-colors disabled:opacity-40',
              size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              variant === 'underline'
                ? cx('-mb-px border-b-2', active ? 'border-qf-primary text-qf-text' : 'border-transparent text-qf-text-muted hover:text-qf-text')
                : cx('rounded-md', active ? 'bg-qf-bg-elevated text-qf-text shadow-sm' : 'text-qf-text-muted hover:text-qf-text'),
            )}
          >
            {t.icon}
            {t.label}
            {t.badge}
          </button>
        )
      })}
    </div>
  )
}

export interface SplitPaneProps {
  /** First pane (left/top). */
  first: ReactNode
  /** Second pane (right/bottom). */
  second: ReactNode
  direction?: 'horizontal' | 'vertical'
  /** Initial size of the first pane in percent. Default 35. */
  defaultSize?: number
  size?: number
  onSizeChange?: (percent: number) => void
  minSize?: number
  maxSize?: number
  className?: string
}

/** Two resizable panes (e.g. list/detail). */
export function SplitPane({ first, second, direction = 'horizontal', defaultSize = 35, size, onSizeChange, minSize = 15, maxSize = 85, className }: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const [inner, setInner] = useState(defaultSize)
  const pct = size ?? inner
  const horizontal = direction === 'horizontal'

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault()
      const el = container.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const move = (ev: PointerEvent) => {
        const raw = horizontal ? ((ev.clientX - rect.left) / rect.width) * 100 : ((ev.clientY - rect.top) / rect.height) * 100
        const next = Math.max(minSize, Math.min(maxSize, raw))
        if (size === undefined) setInner(next)
        onSizeChange?.(next)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
      }
      document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [horizontal, minSize, maxSize, size, onSizeChange],
  )

  return (
    <div ref={container} className={cx('flex h-full min-h-0 w-full min-w-0', horizontal ? 'flex-row' : 'flex-col', className)}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={{ flexBasis: `${pct}%`, flexShrink: 0 }}>
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(pct)}
        onPointerDown={onPointerDown}
        className={cx(
          'shrink-0 bg-qf-border transition-colors hover:bg-qf-primary/60',
          horizontal ? 'w-px cursor-col-resize hover:w-1' : 'h-px cursor-row-resize hover:h-1',
        )}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  )
}
