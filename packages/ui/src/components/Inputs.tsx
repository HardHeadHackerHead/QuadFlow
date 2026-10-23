import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { cx } from '../utils'
import { Icon } from '../icons/Icon'

export const FIELD_BASE =
  'w-full rounded-md border bg-qf-bg-elevated text-qf-text placeholder:text-qf-text-muted/60 ' +
  'transition-colors focus:outline-none focus:border-qf-primary focus:ring-1 focus:ring-qf-primary/40 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

const FIELD_SIZES = { sm: 'h-7 px-2 text-xs', md: 'h-8 px-2.5 text-sm' }

export interface FieldProps {
  label?: ReactNode
  description?: ReactNode
  error?: ReactNode
  required?: boolean
  htmlFor?: string
  className?: string
  children: ReactNode
}

/** Label + description + error wrapper for any control. */
export function Field({ label, description, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-xs font-medium text-qf-text">
          {label}
          {required && <span className="ml-0.5 text-qf-error">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <div className="text-xs text-qf-error">{error}</div>
      ) : description ? (
        <div className="text-xs text-qf-text-muted">{description}</div>
      ) : null}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: keyof typeof FIELD_SIZES
  invalid?: boolean
  leftSlot?: ReactNode
  rightSlot?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid, leftSlot, rightSlot, className, ...rest },
  ref,
) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        FIELD_BASE,
        FIELD_SIZES[size],
        invalid ? 'border-qf-error' : 'border-qf-border',
        leftSlot && 'pl-7',
        rightSlot && 'pr-7',
        !leftSlot && !rightSlot && className,
      )}
      {...rest}
    />
  )
  if (!leftSlot && !rightSlot) return input
  return (
    <div className={cx('relative', className)}>
      {leftSlot && <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-qf-text-muted">{leftSlot}</span>}
      {input}
      {rightSlot && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-qf-text-muted">{rightSlot}</span>}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cx(FIELD_BASE, 'px-2.5 py-1.5 text-sm resize-y', invalid ? 'border-qf-error' : 'border-qf-border', className)}
      {...rest}
    />
  )
})

export interface SearchInputProps extends Omit<InputProps, 'onChange' | 'value' | 'leftSlot' | 'rightSlot'> {
  value: string
  onChange: (value: string) => void
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, placeholder = 'Search…', ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && value) {
          e.stopPropagation()
          onChange('')
        }
      }}
      leftSlot={<Icon name="search" className="h-3.5 w-3.5" />}
      rightSlot={
        value ? (
          <button type="button" aria-label="Clear search" onClick={() => onChange('')} className="hover:text-qf-text">
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        ) : undefined
      }
      {...rest}
    />
  )
})

interface ToggleBaseProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
  id?: string
}

export interface CheckboxProps extends ToggleBaseProps {
  indeterminate?: boolean
}

export function Checkbox({ checked, onChange, label, description, disabled, indeterminate, className, id }: CheckboxProps) {
  const auto = useId()
  const cid = id ?? auto
  return (
    <label htmlFor={cid} className={cx('inline-flex items-start gap-2 select-none', disabled ? 'opacity-50' : 'cursor-pointer', className)}>
      <span className="relative mt-0.5 inline-flex">
        <input
          id={cid}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          ref={(el) => {
            if (el) el.indeterminate = !!indeterminate
          }}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={cx(
            'flex h-4 w-4 items-center justify-center rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-qf-primary/50',
            checked || indeterminate ? 'border-qf-primary bg-qf-primary text-qf-on-primary' : 'border-qf-border-strong bg-qf-bg-elevated',
          )}
        >
          {indeterminate ? <Icon name="minus" className="h-3 w-3" /> : checked ? <Icon name="check" className="h-3 w-3" /> : null}
        </span>
      </span>
      {(label || description) && (
        <span className="flex flex-col">
          {label && <span className="text-sm text-qf-text">{label}</span>}
          {description && <span className="text-xs text-qf-text-muted">{description}</span>}
        </span>
      )}
    </label>
  )
}

export function Switch({ checked, onChange, label, description, disabled, className, id }: ToggleBaseProps) {
  const auto = useId()
  const sid = id ?? auto
  return (
    <label htmlFor={sid} className={cx('inline-flex items-start gap-2 select-none', disabled ? 'opacity-50' : 'cursor-pointer', className)}>
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-4 w-7 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-qf-primary/50',
          checked ? 'bg-qf-primary' : 'bg-qf-border-strong',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </button>
      {(label || description) && (
        <span className="flex flex-col">
          {label && <span className="text-sm text-qf-text">{label}</span>}
          {description && <span className="text-xs text-qf-text-muted">{description}</span>}
        </span>
      )}
    </label>
  )
}

export interface RadioOption<V extends string = string> {
  value: V
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface RadioProps<V extends string = string> {
  value: V
  onChange: (value: V) => void
  options: RadioOption<V>[]
  name?: string
  direction?: 'row' | 'column'
  className?: string
}

/** Radio group. */
export function Radio<V extends string = string>({ value, onChange, options, name, direction = 'column', className }: RadioProps<V>) {
  const auto = useId()
  const group = name ?? auto
  return (
    <div role="radiogroup" className={cx('flex gap-2', direction === 'column' ? 'flex-col' : 'flex-row flex-wrap', className)}>
      {options.map((o) => {
        const selected = o.value === value
        return (
          <label key={o.value} className={cx('inline-flex items-start gap-2 select-none', o.disabled ? 'opacity-50' : 'cursor-pointer')}>
            <input
              type="radio"
              className="peer sr-only"
              name={group}
              value={o.value}
              checked={selected}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            <span
              className={cx(
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-qf-primary/50',
                selected ? 'border-qf-primary' : 'border-qf-border-strong bg-qf-bg-elevated',
              )}
            >
              {selected && <span className="h-2 w-2 rounded-full bg-qf-primary" />}
            </span>
            <span className="flex flex-col">
              <span className="text-sm text-qf-text">{o.label}</span>
              {o.description && <span className="text-xs text-qf-text-muted">{o.description}</span>}
            </span>
          </label>
        )
      })}
    </div>
  )
}

export interface SliderProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  showValue?: boolean
  format?: (v: number) => string
  className?: string
  'aria-label'?: string
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, disabled, showValue, format, className, ...aria }: SliderProps) {
  const pct = ((value - min) / (max - min || 1)) * 100
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-qf-primary"
        style={{ background: `linear-gradient(to right, rgb(var(--qf-primary)) ${pct}%, rgb(var(--qf-border)) ${pct}%)` }}
      />
      {showValue && <span className="w-10 shrink-0 text-right font-mono text-xs text-qf-text-muted">{format ? format(value) : value}</span>}
    </div>
  )
}
