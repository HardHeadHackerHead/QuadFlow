import type { ReactNode } from 'react'
import { cx } from '../utils'

const SPINNER_SIZES = { xs: 'w-3 h-3 border', sm: 'w-4 h-4 border-2', md: 'w-6 h-6 border-2', lg: 'w-8 h-8 border-[3px]' }

export interface SpinnerProps {
  size?: keyof typeof SPINNER_SIZES
  className?: string
  label?: string
}

export function Spinner({ size = 'sm', className, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx('inline-block rounded-full border-current border-r-transparent text-qf-primary', SPINNER_SIZES[size], className)}
      style={{ animation: 'qf-spin 0.7s linear infinite' }}
    />
  )
}

export interface SkeletonProps {
  className?: string
  /** Render as a circle. */
  circle?: boolean
}

export function Skeleton({ className, circle }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cx('bg-qf-border/60', circle ? 'rounded-full' : 'rounded', className ?? 'h-4 w-full')}
      style={{ animation: 'qf-pulse 1.6s ease-in-out infinite' }}
    />
  )
}

export interface ProgressBarProps {
  /** 0–100; omit for indeterminate. */
  value?: number
  tone?: 'primary' | 'success' | 'warning' | 'error'
  className?: string
  label?: string
}

const TONES = { primary: 'bg-qf-primary', success: 'bg-qf-success', warning: 'bg-qf-warning', error: 'bg-qf-error' }

export function ProgressBar({ value, tone = 'primary', className, label }: ProgressBarProps) {
  const indeterminate = value === undefined
  const v = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : v}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-qf-border', className)}
    >
      <div
        className={cx('h-full rounded-full transition-[width] duration-300', TONES[tone])}
        style={indeterminate ? { width: '33%', animation: 'qf-progress-indeterminate 1.2s ease-in-out infinite' } : { width: `${v}%` }}
      />
    </div>
  )
}

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      {icon && <div className="text-qf-text-muted/60 [&>svg]:w-10 [&>svg]:h-10">{icon}</div>}
      <div className="text-sm font-medium text-qf-text">{title}</div>
      {description && <div className="max-w-sm text-xs text-qf-text-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
