import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '../utils'
import { Icon } from '../icons/Icon'
import { FloatingLayer } from './Floating'
import { FIELD_BASE } from './Inputs'

export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  /** Text used for type-ahead / filtering when `label` is not a string. */
  text?: string
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

function optionText(o: SelectOption<string>) {
  return o.text ?? (typeof o.label === 'string' ? o.label : o.value)
}

function useListNav(count: number, isDisabled: (i: number) => boolean, initial: number) {
  const [active, setActive] = useState(initial)
  const move = (delta: number) => {
    if (!count) return
    let i = active
    for (let n = 0; n < count; n++) {
      i = (i + delta + count) % count
      if (!isDisabled(i)) break
    }
    setActive(i)
  }
  return { active, setActive, move }
}

function OptionRow({ o, selected, active, onPick, onHover }: { o: SelectOption<string>; selected: boolean; active: boolean; onPick: () => void; onHover: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={o.disabled}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cx(
        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-qf-text disabled:opacity-40',
        active && 'bg-qf-primary/15',
      )}
    >
      {o.icon && <span className="shrink-0 text-qf-text-muted">{o.icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{o.label}</span>
        {o.description && <span className="truncate text-xs text-qf-text-muted">{o.description}</span>}
      </span>
      {selected && <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-qf-primary" />}
    </button>
  )
}

export interface SelectProps<V extends string = string> {
  value: V | null
  onChange: (value: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  overlayId?: string
  'aria-label'?: string
}

/** Custom select (floating list registers with the overlay system). */
export function Select<V extends string = string>({ value, onChange, options, placeholder = 'Select…', disabled, size = 'md', className, overlayId, ...aria }: SelectProps<V>) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const selectedIdx = options.findIndex((o) => o.value === value)
  const nav = useListNav(options.length, (i) => !!options[i].disabled, Math.max(0, selectedIdx))
  const current = selectedIdx >= 0 ? options[selectedIdx] : null

  useEffect(() => {
    if (open) nav.setActive(Math.max(0, selectedIdx))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = (o: SelectOption<V>) => {
    if (o.disabled) return
    onChange(o.value)
    setOpen(false)
    anchor.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      nav.move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nav.move(-1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const o = options[nav.active]
      if (o) pick(o)
    } else if (e.key === 'Tab') {
      setOpen(false)
    } else if (e.key.length === 1) {
      const i = options.findIndex((o) => !o.disabled && optionText(o).toLowerCase().startsWith(e.key.toLowerCase()))
      if (i >= 0) nav.setActive(i)
    }
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={aria['aria-label']}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cx(
          FIELD_BASE,
          'flex items-center gap-2 border-qf-border text-left',
          size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-sm',
          className,
        )}
      >
        {current?.icon && <span className="shrink-0 text-qf-text-muted">{current.icon}</span>}
        <span className={cx('min-w-0 flex-1 truncate', !current && 'text-qf-text-muted/60')}>{current ? current.label : placeholder}</span>
        <Icon name="chevron-down" className={cx('h-3.5 w-3.5 shrink-0 text-qf-text-muted transition-transform', open && 'rotate-180')} />
      </button>
      <FloatingLayer open={open} onClose={() => setOpen(false)} anchor={anchor} matchAnchorWidth overlayId={overlayId} className="max-h-64 overflow-y-auto py-1">
        <div role="listbox" onKeyDown={onKeyDown}>
          {options.map((o, i) => (
            <OptionRow key={o.value} o={o} selected={o.value === value} active={i === nav.active} onPick={() => pick(o)} onHover={() => nav.setActive(i)} />
          ))}
        </div>
      </FloatingLayer>
    </>
  )
}

export interface ComboboxProps<V extends string = string> {
  value: V | null
  onChange: (value: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  disabled?: boolean
  className?: string
  overlayId?: string
  /** Allow committing free text not in the options (calls onCreate). */
  onCreate?: (text: string) => void
  emptyText?: ReactNode
}

/** Searchable select with type-to-filter. */
export function Combobox<V extends string = string>({ value, onChange, options, placeholder = 'Search…', disabled, className, overlayId, onCreate, emptyText = 'No matches' }: ComboboxProps<V>) {
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = options.find((o) => o.value === value) ?? null
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => optionText(o).toLowerCase().includes(q)) : options
  }, [options, query])
  const nav = useListNav(filtered.length, (i) => !!filtered[i]?.disabled, 0)

  useEffect(() => {
    nav.setActive(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  const pick = (o: SelectOption<V>) => {
    if (o.disabled) return
    onChange(o.value)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      else nav.move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      nav.move(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = filtered[nav.active]
      if (o) pick(o)
      else if (onCreate && query.trim()) {
        onCreate(query.trim())
        setQuery('')
        setOpen(false)
      }
    }
  }

  return (
    <>
      <div ref={anchor} className={cx('relative', className)}>
        <input
          ref={input}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          value={open ? query : current ? optionText(current) : ''}
          placeholder={current && !open ? optionText(current) : placeholder}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className={cx(FIELD_BASE, 'h-8 border-qf-border pl-2.5 pr-7 text-sm')}
        />
        <Icon name="chevron-down" className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-qf-text-muted" />
      </div>
      <FloatingLayer
        open={open}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        anchor={anchor}
        matchAnchorWidth
        overlayId={overlayId}
        className="max-h-64 overflow-y-auto py-1"
      >
        <div role="listbox">
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-qf-text-muted">
              {onCreate && query.trim() ? `Press Enter to add “${query.trim()}”` : emptyText}
            </div>
          ) : (
            filtered.map((o, i) => (
              <OptionRow key={o.value} o={o} selected={o.value === value} active={i === nav.active} onPick={() => pick(o)} onHover={() => nav.setActive(i)} />
            ))
          )}
        </div>
      </FloatingLayer>
    </>
  )
}
