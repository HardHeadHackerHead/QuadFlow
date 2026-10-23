import { useState, type ReactNode } from 'react'
import { cx } from '../utils'
import { Field, Input, Checkbox, Radio, Slider, Switch, Textarea } from './Inputs'
import { Select } from './Select'
import { Tag } from './Display'

/**
 * The JSON Schema subset understood by FormFromSchema (plugin settings pages,
 * tool config forms). Unknown keywords are ignored.
 *
 * UI hints (non-standard, `x-` prefixed):
 *   x-widget: 'textarea' | 'password' | 'color' | 'slider' | 'radio' | 'tags'
 *   x-placeholder: string
 *   x-hidden: boolean
 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: unknown
  enum?: (string | number)[]
  /** Labeled enum: `oneOf: [{ const: 'a', title: 'Option A' }]`. */
  oneOf?: { const: string | number; title?: string; description?: string }[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  minItems?: number
  maxItems?: number
  'x-widget'?: 'textarea' | 'password' | 'color' | 'slider' | 'radio' | 'tags'
  'x-placeholder'?: string
  'x-hidden'?: boolean
}

export type FormValue = Record<string, unknown>
export type FormErrors = Record<string, string>

/** Fill missing values with schema defaults (recursively for objects). */
export function schemaDefaults(schema: JsonSchema, value: FormValue = {}): FormValue {
  const out: FormValue = { ...value }
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (out[k] === undefined) {
      if (s.type === 'object') out[k] = schemaDefaults(s, {})
      else if (s.default !== undefined) out[k] = s.default
    } else if (s.type === 'object' && typeof out[k] === 'object' && out[k] !== null) {
      out[k] = schemaDefaults(s, out[k] as FormValue)
    }
  }
  return out
}

function enumOptions(s: JsonSchema): { value: string; label: string; description?: string }[] | null {
  if (s.oneOf?.length) return s.oneOf.map((o) => ({ value: String(o.const), label: o.title ?? String(o.const), description: o.description }))
  if (s.enum?.length) return s.enum.map((v) => ({ value: String(v), label: String(v) }))
  return null
}

/** Validate `value` against `schema`. Keys are dotted paths (`a.b`). */
export function validateSchema(schema: JsonSchema, value: FormValue, prefix = ''): FormErrors {
  const errors: FormErrors = {}
  const required = new Set(schema.required ?? [])
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const path = prefix + k
    const v = value?.[k]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) {
      if (required.has(k)) errors[path] = 'Required'
      continue
    }
    switch (s.type) {
      case 'object':
        Object.assign(errors, validateSchema(s, v as FormValue, path + '.'))
        break
      case 'string': {
        const str = String(v)
        if (s.minLength !== undefined && str.length < s.minLength) errors[path] = `At least ${s.minLength} characters`
        else if (s.maxLength !== undefined && str.length > s.maxLength) errors[path] = `At most ${s.maxLength} characters`
        else if (s.pattern && !new RegExp(s.pattern).test(str)) errors[path] = 'Invalid format'
        else if (s.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(str)) errors[path] = 'Must be a URL'
        break
      }
      case 'number':
      case 'integer': {
        const n = Number(v)
        if (!Number.isFinite(n)) errors[path] = 'Must be a number'
        else if (s.type === 'integer' && !Number.isInteger(n)) errors[path] = 'Must be a whole number'
        else if (s.minimum !== undefined && n < s.minimum) errors[path] = `Minimum ${s.minimum}`
        else if (s.maximum !== undefined && n > s.maximum) errors[path] = `Maximum ${s.maximum}`
        break
      }
      case 'array': {
        const a = v as unknown[]
        if (s.minItems !== undefined && a.length < s.minItems) errors[path] = `At least ${s.minItems} items`
        else if (s.maxItems !== undefined && a.length > s.maxItems) errors[path] = `At most ${s.maxItems} items`
        break
      }
    }
  }
  return errors
}

function humanize(key: string) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

function TagsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const commit = () => {
    const t = draft.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-qf-border bg-qf-bg-elevated p-1">
      {value.map((t) => (
        <Tag key={t} onRemove={() => onChange(value.filter((x) => x !== t))}>
          {t}
        </Tag>
      ))}
      <input
        value={draft}
        placeholder={placeholder ?? 'Add…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={commit}
        className="min-w-[6rem] flex-1 bg-transparent px-1 text-sm text-qf-text outline-none placeholder:text-qf-text-muted/60"
      />
    </div>
  )
}

interface FieldRendererProps {
  name: string
  path: string
  schema: JsonSchema
  value: unknown
  required: boolean
  error?: string
  errors: FormErrors
  disabled?: boolean
  onChange: (v: unknown) => void
}

function SchemaField({ name, path, schema: s, value, required, error, errors, disabled, onChange }: FieldRendererProps) {
  if (s['x-hidden']) return null
  const label = s.title ?? humanize(name)
  const id = `qf-form-${path}`
  const opts = enumOptions(s)
  const placeholder = s['x-placeholder']

  if (s.type === 'object') {
    return (
      <fieldset className="flex flex-col gap-3 rounded-lg border border-qf-border p-3">
        <legend className="px-1 text-xs font-semibold text-qf-text">{label}</legend>
        {s.description && <div className="-mt-1 text-xs text-qf-text-muted">{s.description}</div>}
        <SchemaFields schema={s} value={(value as FormValue) ?? {}} onChange={onChange as (v: FormValue) => void} errors={errors} prefix={path + '.'} disabled={disabled} />
      </fieldset>
    )
  }

  if (s.type === 'boolean') {
    return (
      <div className="flex flex-col gap-1">
        <Switch id={id} checked={!!value} onChange={onChange} label={label} description={s.description} disabled={disabled} />
        {error && <div className="text-xs text-qf-error">{error}</div>}
      </div>
    )
  }

  let control: ReactNode
  if (s.type === 'array') {
    const arr = Array.isArray(value) ? (value as string[]) : []
    const itemOpts = s.items ? enumOptions(s.items) : null
    control = itemOpts ? (
      <div className="flex flex-col gap-1.5">
        {itemOpts.map((o) => (
          <Checkbox
            key={o.value}
            checked={arr.includes(o.value)}
            disabled={disabled}
            label={o.label}
            description={o.description}
            onChange={(c) => onChange(c ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
          />
        ))}
      </div>
    ) : (
      <TagsInput value={arr.map(String)} onChange={onChange} placeholder={placeholder} />
    )
  } else if (opts) {
    const str = value === undefined || value === null ? null : String(value)
    const toTyped = (v: string) => (s.type === 'number' || s.type === 'integer' ? Number(v) : v)
    control =
      s['x-widget'] === 'radio' ? (
        <Radio value={str ?? ''} options={opts.map((o) => ({ ...o, disabled }))} onChange={(v) => onChange(toTyped(v))} name={id} />
      ) : (
        <Select value={str} options={opts} onChange={(v) => onChange(toTyped(v))} disabled={disabled} placeholder={placeholder} aria-label={label} />
      )
  } else if (s.type === 'number' || s.type === 'integer') {
    const n = typeof value === 'number' ? value : value === undefined || value === '' ? undefined : Number(value)
    control =
      s['x-widget'] === 'slider' && s.minimum !== undefined && s.maximum !== undefined ? (
        <Slider value={n ?? s.minimum} min={s.minimum} max={s.maximum} step={s.multipleOf ?? (s.type === 'integer' ? 1 : 0.1)} onChange={onChange} disabled={disabled} showValue aria-label={label} />
      ) : (
        <Input
          id={id}
          type="number"
          value={n ?? ''}
          min={s.minimum}
          max={s.maximum}
          step={s.multipleOf ?? (s.type === 'integer' ? 1 : 'any')}
          placeholder={placeholder}
          disabled={disabled}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      )
  } else {
    const str = value === undefined || value === null ? '' : String(value)
    const widget = s['x-widget'] ?? (s.format === 'password' ? 'password' : s.format === 'color' ? 'color' : undefined)
    control =
      widget === 'textarea' ? (
        <Textarea id={id} value={str} placeholder={placeholder} disabled={disabled} invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      ) : widget === 'color' ? (
        <div className="flex items-center gap-2">
          <input type="color" value={str || '#000000'} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-qf-border bg-transparent" />
          <Input id={id} value={str} disabled={disabled} invalid={!!error} onChange={(e) => onChange(e.target.value)} className="font-mono" />
        </div>
      ) : (
        <Input
          id={id}
          type={widget === 'password' ? 'password' : s.format === 'uri' ? 'url' : s.format === 'email' ? 'email' : 'text'}
          value={str}
          placeholder={placeholder}
          disabled={disabled}
          invalid={!!error}
          maxLength={s.maxLength}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }

  return (
    <Field label={label} description={s.description} error={error} required={required} htmlFor={id}>
      {control}
    </Field>
  )
}

function SchemaFields({ schema, value, onChange, errors, prefix, disabled }: { schema: JsonSchema; value: FormValue; onChange: (v: FormValue) => void; errors: FormErrors; prefix: string; disabled?: boolean }) {
  const required = new Set(schema.required ?? [])
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([k, s]) => (
        <SchemaField
          key={k}
          name={k}
          path={prefix + k}
          schema={s}
          value={value[k]}
          required={required.has(k)}
          error={errors[prefix + k]}
          errors={errors}
          disabled={disabled}
          onChange={(v) => onChange({ ...value, [k]: v })}
        />
      ))}
    </>
  )
}

export interface FormFromSchemaProps {
  schema: JsonSchema
  value: FormValue
  onChange: (value: FormValue) => void
  /** Errors to display (e.g. from `validateSchema`). When omitted, errors are computed live after the first change. */
  errors?: FormErrors
  disabled?: boolean
  className?: string
}

/** Render a form for a JSON Schema object (plugin settings, tool config). */
export function FormFromSchema({ schema, value, onChange, errors, disabled, className }: FormFromSchemaProps) {
  const [touched, setTouched] = useState(false)
  const live = errors ?? (touched ? validateSchema(schema, value) : {})
  const v = schemaDefaults(schema, value)
  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <SchemaFields
        schema={schema}
        value={v}
        errors={live}
        disabled={disabled}
        prefix=""
        onChange={(next) => {
          setTouched(true)
          onChange(next)
        }}
      />
    </div>
  )
}
