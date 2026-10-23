import { useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cx } from '../utils'
import { Icon } from '../icons/Icon'
import { Tabs } from './Layout'
import { Textarea } from './Inputs'

export interface CodeBlockProps {
  code: string
  language?: string
  /** Show the copy button. Default true. */
  copyable?: boolean
  className?: string
  maxHeight?: string
}

export function CodeBlock({ code, language, copyable = true, className, maxHeight }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={cx('group relative rounded-md border border-qf-border bg-qf-surface', className)}>
      {(language || copyable) && (
        <div className="flex items-center justify-between border-b border-qf-border/70 px-2.5 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-qf-text-muted">{language}</span>
          {copyable && (
            <button
              type="button"
              aria-label="Copy code"
              className="flex items-center gap-1 text-[10px] text-qf-text-muted hover:text-qf-text"
              onClick={() => {
                navigator.clipboard?.writeText(code).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                })
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} className="h-3 w-3" />
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
      <pre className="overflow-auto p-2.5 font-mono text-xs leading-relaxed text-qf-text" style={{ maxHeight }}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

const components: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-semibold text-qf-text first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold text-qf-text first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold text-qf-text first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-medium text-qf-text first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-qf-secondary underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-qf-border-strong pl-3 text-qf-text-muted">{children}</blockquote>,
  hr: () => <hr className="my-3 border-qf-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-qf-border bg-qf-surface px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-qf-border px-2 py-1">{children}</td>,
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1]
    const text = String(children ?? '')
    if (lang || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/, '')} language={lang} className="my-2" />
    return <code className="rounded bg-qf-surface px-1 py-0.5 font-mono text-[0.85em] text-qf-text">{children}</code>
  },
  pre: ({ children }) => <>{children}</>,
  input: ({ checked, type }) => (type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly className="mr-1.5 align-middle accent-[rgb(var(--qf-primary))]" /> : null),
}

export interface MarkdownProps {
  children: string
  className?: string
}

/**
 * Render Markdown (GFM). Raw HTML in the source is NOT rendered (react-markdown
 * escapes it by default), links open externally, `javascript:` URLs are dropped
 * by react-markdown's default URL transform.
 */
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cx('text-sm text-qf-text [overflow-wrap:anywhere]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  className?: string
  /** Initial mode. */
  defaultMode?: 'write' | 'preview'
  toolbar?: ReactNode
}

/** Write/preview Markdown editor (textarea based; no CodeMirror dependency). */
export function MarkdownEditor({ value, onChange, placeholder = 'Write Markdown…', rows = 8, className, defaultMode = 'write', toolbar }: MarkdownEditorProps) {
  const [mode, setMode] = useState<'write' | 'preview'>(defaultMode)
  return (
    <div className={cx('flex flex-col rounded-md border border-qf-border bg-qf-bg-elevated', className)}>
      <div className="flex items-center justify-between px-2 pt-1">
        <Tabs
          size="sm"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
          className="border-b-0"
        />
        {toolbar}
      </div>
      <div className="border-t border-qf-border">
        {mode === 'write' ? (
          <Textarea
            value={value}
            rows={rows}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-none border-0 font-mono text-xs focus:ring-0"
          />
        ) : (
          <div className="min-h-[6rem] px-3 py-2">
            {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-xs text-qf-text-muted">Nothing to preview</span>}
          </div>
        )}
      </div>
    </div>
  )
}
