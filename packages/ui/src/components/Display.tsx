import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from '../utils'

export type Tone = 'neutral' | 'primary' | 'secondary' | 'success' | 'warning' | 'error'

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-qf-surface text-qf-text-muted border-qf-border',
  primary: 'bg-qf-primary/15 text-qf-primary border-qf-primary/30',
  secondary: 'bg-qf-secondary/15 text-qf-secondary border-qf-secondary/30',
  success: 'bg-qf-success/15 text-qf-success border-qf-success/30',
  warning: 'bg-qf-warning/15 text-qf-warning border-qf-warning/30',
  error: 'bg-qf-error/15 text-qf-error border-qf-error/30',
}

const DOT_CLASSES: Record<Tone, string> = {
  neutral: 'bg-qf-text-muted',
  primary: 'bg-qf-primary',
  secondary: 'bg-qf-secondary',
  success: 'bg-qf-success',
  warning: 'bg-qf-warning',
  error: 'bg-qf-error',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  /** Small dot instead of a pill. */
  dot?: boolean
}

export function Badge({ tone = 'neutral', dot, className, children, ...rest }: BadgeProps) {
  if (dot) {
    return <span className={cx('inline-block h-2 w-2 rounded-full', DOT_CLASSES[tone], className)} {...rest} />
  }
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none', TONE_CLASSES[tone], className)}
      {...rest}
    >
      {children}
    </span>
  )
}

export interface LabelBadgeProps {
  /** Label name. */
  name: string
  /** Arbitrary label color (hex). */
  color?: string
  className?: string
  onRemove?: () => void
}

/** Colored label chip (issue labels, idea tags with user-chosen colors). */
export function LabelBadge({ name, color = '#94a3b8', className, onRemove }: LabelBadgeProps) {
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none border', className)}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`, borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}
    >
      {name}
      {onRemove && (
        <button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="opacity-70 hover:opacity-100">
          ×
        </button>
      )}
    </span>
  )
}

export interface TagProps {
  children: ReactNode
  selected?: boolean
  onClick?: () => void
  onRemove?: () => void
  className?: string
}

export function Tag({ children, selected, onClick, onRemove, className }: TagProps) {
  const Comp = onClick ? 'button' : 'span'
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors',
        selected
          ? 'border-qf-primary/50 bg-qf-primary/15 text-qf-text'
          : 'border-qf-border bg-qf-surface text-qf-text-muted',
        onClick && 'hover:border-qf-border-strong hover:text-qf-text',
        className,
      )}
    >
      {children}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="cursor-pointer opacity-60 hover:opacity-100"
        >
          ×
        </span>
      )}
    </Comp>
  )
}

const AVATAR_SIZES = { xs: 'h-5 w-5 text-[9px]', sm: 'h-6 w-6 text-[10px]', md: 'h-8 w-8 text-xs', lg: 'h-10 w-10 text-sm' }

export interface AvatarProps {
  name: string
  src?: string
  size?: keyof typeof AVATAR_SIZES
  className?: string
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

function hue(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

export function Avatar({ name, src, size = 'sm', className }: AvatarProps) {
  return src ? (
    <img src={src} alt={name} title={name} className={cx('rounded-full object-cover', AVATAR_SIZES[size], className)} />
  ) : (
    <span
      title={name}
      className={cx('inline-flex items-center justify-center rounded-full font-semibold text-white', AVATAR_SIZES[size], className)}
      style={{ backgroundColor: `hsl(${hue(name)} 55% 45%)` }}
    >
      {initials(name)}
    </span>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex min-w-[1.25rem] items-center justify-center rounded border border-qf-border border-b-2 bg-qf-surface px-1 font-mono text-[10px] text-qf-text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  selected?: boolean
  padding?: 'none' | 'sm' | 'md'
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, selected, padding = 'md', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        'rounded-lg border bg-qf-bg-elevated',
        selected ? 'border-qf-primary/60' : 'border-qf-border',
        interactive && 'cursor-pointer transition-colors hover:border-qf-border-strong',
        padding === 'sm' ? 'p-2' : padding === 'md' ? 'p-3' : '',
        className,
      )}
      {...rest}
    />
  )
})

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('flex h-full min-h-0 flex-col bg-qf-bg text-qf-text', className)} {...rest} />
}

export interface PanelHeaderProps {
  title: ReactNode
  icon?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PanelHeader({ title, icon, subtitle, actions, className }: PanelHeaderProps) {
  return (
    <div className={cx('flex shrink-0 items-center gap-2 border-b border-qf-border bg-qf-surface px-3 py-2', className)}>
      {icon && <span className="text-qf-primary">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-qf-text">{title}</div>
        {subtitle && <div className="truncate text-xs text-qf-text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  )
}

export function Toolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="toolbar"
      className={cx('flex shrink-0 items-center gap-1 border-b border-qf-border bg-qf-surface px-2 py-1', className)}
      {...rest}
    />
  )
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  /** Thin scrollbars. Default true. */
  thin?: boolean
  axis?: 'y' | 'x' | 'both'
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { thin = true, axis = 'y', className, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        'min-h-0 min-w-0',
        axis === 'y' ? 'overflow-y-auto overflow-x-hidden' : axis === 'x' ? 'overflow-x-auto overflow-y-hidden' : 'overflow-auto',
        className,
      )}
      style={thin ? { scrollbarWidth: 'thin', scrollbarColor: 'rgb(var(--qf-scrollbar-thumb)) transparent', ...style } : style}
      {...rest}
    />
  )
})

export interface TableColumn<T> {
  key: string
  header: ReactNode
  render?: (row: T, index: number) => ReactNode
  className?: string
  width?: string
  align?: 'left' | 'right' | 'center'
}

export interface TableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  selectedKey?: string
  empty?: ReactNode
  dense?: boolean
  className?: string
}

export function Table<T>({ columns, rows, rowKey, onRowClick, selectedKey, empty, dense, className }: TableProps<T>) {
  const cell = dense ? 'px-2 py-1' : 'px-3 py-2'
  return (
    <div className={cx('overflow-auto rounded-lg border border-qf-border', className)}>
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-qf-surface">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align ?? 'left' }}
                className={cx(cell, 'border-b border-qf-border text-xs font-medium uppercase tracking-wide text-qf-text-muted')}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="p-6 text-center text-xs text-qf-text-muted">
                {empty ?? 'No data'}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const k = rowKey(row, i)
              return (
                <tr
                  key={k}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cx(
                    'border-b border-qf-border/60 last:border-b-0',
                    onRowClick && 'cursor-pointer hover:bg-qf-surface',
                    selectedKey === k && 'bg-qf-primary/10',
                  )}
                >
                  {columns.map((c) => (
                    <td key={c.key} style={{ textAlign: c.align ?? 'left' }} className={cx(cell, 'text-qf-text', c.className)}>
                      {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
