/**
 * The `file` tile: one file in CodeMirror, read-only until "Edit", Ctrl+S saves.
 * File IO goes through `ctx.fs` (scope `project`, or `absolute` for a file the
 * user picked with `ui.pickFile`). `.env` files open behind a warning gate.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { HostError, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { Button, Input } from '@quadflow/ui'
import CodeMirrorEditor from './CodeMirrorEditor'
import { getLanguageName } from './languages'
import { claimTarget, openFile, trackTile } from './model'
import { extensionOf, fileNameOf, isEnvFileName, resolveTarget, type EditorTarget } from './paths'

function errorText(e: unknown): string {
  if (e instanceof HostError && e.code === 'permission_denied') {
    return e.permission ? `Not allowed (${e.permission}). Files outside the project can only be opened with Browse….` : e.message
  }
  return e instanceof Error ? e.message : String(e)
}

function useDarkTheme(ctx: PluginContext): boolean {
  const [dark, setDark] = useState(() => ctx.ui.theme().mode === 'dark')
  useEffect(() => ctx.ui.onThemeChange((t) => setDark(t.mode === 'dark')), [ctx])
  return dark
}

export function EditorTile(props: TileProps) {
  const { ctx, instance, setState, setTitle } = props
  // From the persisted state, else the oldest pending `editor/open` (hosts that drop `openTile` state).
  const [target, setTarget] = useState<EditorTarget | null>(() => claimTarget(ctx, instance.state))

  // setState/setTitle change identity whenever the instance metadata changes: keep them in a ref
  // so persisting the file does not re-trigger this effect.
  const persist = useRef({ setState, setTitle })
  persist.current = { setState, setTitle }
  useEffect(() => {
    if (!target) return
    const saved = instance.state as { path?: unknown; scope?: unknown } | null
    if (saved?.path !== target.path || saved?.scope !== target.scope) {
      persist.current.setState({ path: target.path, scope: target.scope })
    }
    persist.current.setTitle(fileNameOf(target.path))
    return trackTile(instance.id, target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, instance.id])

  if (!target) return <PickFile ctx={ctx} onPick={setTarget} />
  return <FileEditor key={`${target.scope}:${target.path}`} ctx={ctx} target={target} />
}

/** Empty tile ("Open Editor" from the palette): type a project path or browse. */
function PickFile({ ctx, onPick }: { ctx: PluginContext; onPick(t: EditorTarget): void }) {
  const [value, setValue] = useState('')
  const pick = (path: string) => {
    const t = resolveTarget(path, ctx.project.current()?.root)
    onPick(t)
  }
  const browse = async () => {
    const picked = await ctx.ui.pickFile({ multiple: false })
    if (picked?.[0]) pick(picked[0])
  }
  return (
    <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
      <form
        className="w-full max-w-md px-6 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) pick(value.trim())
        }}
      >
        <p className="text-sm text-vibe-text font-medium">Open a file</p>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="src/main.ts"
          aria-label="File path"
          data-testid="editor-path-input"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={!value.trim()}>
            Open
          </Button>
          {ctx.api.has('ui.pickFile') && (
            <Button type="button" size="sm" onClick={() => void browse()}>
              Browse…
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function FileEditor({ ctx, target }: { ctx: PluginContext; target: EditorTarget }) {
  const fileName = fileNameOf(target.path)
  const extension = extensionOf(target.path)
  const isEnv = isEnvFileName(fileName)
  const dark = useDarkTheme(ctx)

  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!isEnv) // env files load on reveal
  const [saving, setSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const isDirty = content !== null && content !== originalContent

  const loadFile = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const text = await ctx.fs.readText(target.path, target.scope)
      setContent(text)
      setOriginalContent(text)
    } catch (e) {
      setError(`Failed to read file: ${errorText(e)}`)
    } finally {
      setLoading(false)
    }
  }, [ctx, target])

  useEffect(() => {
    if (!isEnv) void loadFile()
  }, [isEnv, loadFile])

  const handleSave = useCallback(async () => {
    if (content === null || content === originalContent) return
    setSaving(true)
    setError(null)
    try {
      await ctx.fs.writeText(target.path, content, target.scope)
      setOriginalContent(content)
    } catch (e) {
      setError(`Failed to save: ${errorText(e)}`)
    } finally {
      setSaving(false)
    }
  }, [ctx, target, content, originalContent])

  if (isEnv && !revealed) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-vibe-bg select-none">
        <div className="text-center space-y-5 px-8">
          <div className="mx-auto w-14 h-14 rounded-full bg-yellow-500/15 border-2 border-yellow-500/40 flex items-center justify-center">
            <svg className="w-7 h-7 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold text-yellow-400 mb-1.5">Sensitive Content</h1>
            <p className="text-xs text-vibe-muted leading-relaxed max-w-[300px] mx-auto">
              This file may contain API keys, passwords, and other secrets. If you are streaming, move this pane to a
              private monitor before continuing.
            </p>
          </div>
          <p className="text-[10px] text-vibe-muted/60 font-mono">{fileName}</p>
          <Button
            variant="primary"
            onClick={() => {
              setRevealed(true)
              void loadFile()
            }}
          >
            View Contents
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg" data-testid="editor-tile" data-file={target.path}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-vibe-bg-lighter/50 border-b border-vibe-border">
        <div className="flex items-center gap-2 min-w-0">
          {isEnv ? (
            <svg className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
          )}
          <span className="text-xs font-medium text-vibe-text truncate" title={fileName}>
            {fileName}
          </span>
          {isDirty && (
            <span className="text-[10px] text-amber-400 flex-shrink-0" data-testid="editor-dirty">
              (unsaved)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isEnv && (
            <button
              onClick={() => {
                setRevealed(false)
                setContent(null)
                setOriginalContent('')
                setError(null)
              }}
              className="px-2 py-0.5 text-[10px] text-yellow-400 hover:bg-yellow-500/10 rounded transition-colors"
              title="Hide contents"
            >
              Hide
            </button>
          )}
          <button
            onClick={() => setIsEditing(!isEditing)}
            data-testid="editor-toggle-edit"
            className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
              isEditing ? 'bg-vibe-primary text-qf-on-primary' : 'hover:bg-vibe-bg text-vibe-muted'
            }`}
          >
            {isEditing ? 'Editing' : 'Read Only'}
          </button>
          {isEditing && isDirty && (
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              data-testid="editor-save"
              className="px-2 py-0.5 text-[10px] bg-vibe-primary text-qf-on-primary rounded hover:bg-vibe-primary-hover disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="mx-2 mt-1 p-1.5 bg-red-500/10 border border-red-500/30 rounded text-[10px] text-red-400 flex justify-between items-start"
          data-testid="editor-error"
        >
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:text-red-300">
            x
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin w-6 h-6 border-2 border-vibe-primary border-t-transparent rounded-full" />
          </div>
        ) : content !== null ? (
          <CodeMirrorEditor
            content={content}
            extension={extension}
            readOnly={!isEditing}
            dark={dark}
            onChange={setContent}
            onSave={() => void handleSave()}
          />
        ) : null}
      </div>

      <div className="flex items-center justify-between px-3 py-1 bg-vibe-bg-lighter/50 border-t border-vibe-border text-[10px] text-vibe-muted">
        <span className="truncate" title={target.path}>
          {target.path}
        </span>
        <span>{getLanguageName(extension)}</span>
      </div>
    </div>
  )
}

/** `editor/open` with no path: ask for one (project-relative or absolute). */
export async function promptAndOpen(ctx: PluginContext): Promise<void> {
  const path = await ctx.ui.prompt({ title: 'Open file in editor', label: 'Path (relative to the project, or absolute)' })
  if (path?.trim()) await openFile(ctx, path.trim())
}
