import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '../utils'
import { Spinner } from './Feedback'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-qf-primary text-qf-on-primary hover:bg-qf-primary-hover border border-transparent',
  secondary: 'bg-qf-bg-elevated text-qf-text border border-qf-border hover:border-qf-border-strong hover:bg-qf-surface',
  outline: 'bg-transparent text-qf-text border border-qf-border hover:border-qf-border-strong hover:bg-qf-surface',
  ghost: 'bg-transparent text-qf-text-muted border border-transparent hover:text-qf-text hover:bg-qf-surface',
  danger: 'bg-qf-error text-white border border-transparent hover:bg-qf-error/90',
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1',
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
}

const ICON_SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 w-6',
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
}

const BASE =
  'inline-flex items-center justify-center rounded-md font-medium transition-colors select-none ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-qf-primary/60 ' +
  'disabled:opacity-50 disabled:pointer-events-none'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  fullWidth?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, leftIcon, rightIcon, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {loading ? <Spinner size="xs" /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible label (also used as the native tooltip). */
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'sm', active, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(BASE, VARIANTS[variant], ICON_SIZES[size], active && 'bg-qf-primary/20 text-qf-primary', className)}
      {...rest}
    >
      {children}
    </button>
  )
})

export interface ButtonGroupProps {
  children: ReactNode
  className?: string
  /** Visually attach buttons (shared borders). */
  attached?: boolean
}

export function ButtonGroup({ children, className, attached }: ButtonGroupProps) {
  return (
    <div
      role="group"
      className={cx(
        'inline-flex',
        attached
          ? '[&>*]:rounded-none [&>*:first-child]:rounded-l-md [&>*:last-child]:rounded-r-md [&>*+*]:-ml-px'
          : 'gap-1.5',
        className,
      )}
    >
      {children}
    </div>
  )
}
