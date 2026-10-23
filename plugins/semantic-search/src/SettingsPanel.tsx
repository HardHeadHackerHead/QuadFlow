/**
 * Settings + index management (the plugin's settings page; also shown inside the tile).
 * Settings are the plugin's own (`ctx.settings`, validated by the host against the
 * manifest schema); model files, the index and the jobs belong to the sidecar.
 */
import type { PluginContext, ProviderInfo } from '@quadflow/plugin-api'
import { Badge, Button, Field, IconButton, Icon, Input, ProgressBar, Select, Switch } from '@quadflow/ui'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { formatAge, formatBytes, progressPercent, progressText } from './format'
import { errorText, semanticModel, type SemanticModelInfo, type SemanticRoot } from './model'
import { setSetting, useSettings, type SemanticSettings, type SessionDirSetting } from './settings'

const MODES: { value: SemanticSettings['indexMode']; label: string }[] = [
  { value: 'manual', label: 'Manual (Index button only)' },
  { value: 'periodic', label: 'Periodic' },
  { value: 'realtime', label: 'Realtime (when session files change)' },
]

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-vibe-border p-3" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-vibe-muted">{title}</h3>
      {children}
    </section>
  )
}

export function SettingsPanel({ ctx }: { ctx: PluginContext }) {
  const model = semanticModel(ctx)
  useEffect(() => model.retain(), [model])
  const status = model.store((s) => s.status)
  const download = model.store((s) => s.download)
  const error = model.store((s) => s.error)
  const settings = useSettings(ctx)
  const [models, setModels] = useState<SemanticModelInfo[]>([])
  const [roots, setRoots] = useState<SemanticRoot[]>([])
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [debug, setDebug] = useState<string | null>(null)
  const [newDir, setNewDir] = useState('')

  const toastError = useCallback(
    (title: string, e: unknown) => ctx.notifications.toast({ kind: 'error', title, body: errorText(e) }),
    [ctx],
  )

  const reload = useCallback(async () => {
    try {
      const [m, r] = await Promise.all([model.request<SemanticModelInfo[]>('models'), model.request<SemanticRoot[]>('roots')])
      setModels(m)
      setRoots(r)
    } catch {
      /* the error banner shows the sidecar problem */
    }
  }, [model])

  useEffect(() => {
    void reload()
  }, [reload, status?.model.downloaded, status?.model.id, settings.sessionDirs, settings.useProviderSessions])

  useEffect(() => {
    if (!ctx.api.has('agents.providers')) return
    ctx.agents.providers().then(setProviders, () => setProviders([]))
  }, [ctx])

  const update = async <K extends keyof SemanticSettings>(key: K, value: SemanticSettings[K]) => {
    try {
      await setSetting(ctx, key, value)
      await model.settingsChanged()
    } catch (e) {
      toastError('Could not save the setting', e)
    }
  }

  const current = models.find((m) => m.id === settings.model)
  const dirs = settings.sessionDirs
  const setDirs = (next: SessionDirSetting[]) => update('sessionDirs', next)
  const providerOptions = [{ value: '', label: 'Unknown agent' }, ...providers.map((p) => ({ value: p.id, label: p.displayName }))]

  const addDir = async (path: string) => {
    const p = path.trim()
    if (!p || dirs.some((d) => d.path === p)) return
    await setDirs([...dirs, { path: p, glob: '**/*.jsonl', providerId: '' }])
    setNewDir('')
  }

  const pickDir = async () => {
    try {
      const picked = await ctx.ui.pickFile({ directory: true })
      if (picked?.[0]) await addDir(picked[0])
    } catch (e) {
      toastError('Could not pick a folder', e)
    }
  }

  const run = async (label: string, f: () => Promise<unknown>) => {
    try {
      await f()
    } catch (e) {
      toastError(label, e)
    }
  }

  const stats = status?.stats
  const progress = status?.state === 'running' ? status.progress : null

  return (
    <div className="flex flex-col gap-4 p-4 text-sm text-vibe-text" data-testid="semantic-settings">
      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300" data-testid="semantic-error">
          {error}
        </div>
      )}

      <Section title="Index" testId="semantic-settings-index">
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Stat label="Sessions" value={stats?.sessions ?? '—'} />
          <Stat label="Indexed" value={stats?.indexed ?? '—'} />
          <Stat label="Pending" value={stats?.pending ?? '—'} />
          <Stat label="Chunks" value={stats?.chunks ?? '—'} />
        </div>
        <div className="text-xs text-vibe-muted">
          Last indexed {formatAge(stats?.lastIndexedAt)} · index size {formatBytes(stats?.dbBytes)}
          {stats?.errors ? ` · ${stats.errors} failed` : ''}
          {stats?.otherModelChunks ? ` · ${stats.otherModelChunks} chunks of another model (Clean up removes them)` : ''}
        </div>
        {progress && (
          <div className="flex flex-col gap-1">
            <ProgressBar value={progressPercent(progress)} />
            <span className="text-xs text-vibe-muted">{progressText(progress)}</span>
          </div>
        )}
        {status?.lastError && <div className="text-xs text-red-400">Last run failed: {status.lastError}</div>}
        <div className="flex flex-wrap gap-2">
          {status?.state === 'running' ? (
            <Button size="sm" variant="danger" onClick={() => run('Could not stop', () => model.stop())}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => run('Could not start indexing', () => model.index(false))}>
              Index now
            </Button>
          )}
          <Button
            size="sm"
            disabled={status?.state === 'running'}
            onClick={() =>
              run('Could not rebuild the index', async () => {
                if (await ctx.ui.confirm({ title: 'Rebuild index', message: 'Re-embed every session with the current model?', confirmLabel: 'Rebuild' })) {
                  await model.index(true)
                }
              })
            }
          >
            Rebuild
          </Button>
          <Button size="sm" onClick={() => run('Cleanup failed', async () => { await model.request('cleanup'); await model.refresh() })}>
            Clean up
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              run('Could not clear the index', async () => {
                if (await ctx.ui.confirm({ title: 'Clear index', message: 'Delete every indexed session? Session files are not touched.', danger: true, confirmLabel: 'Clear' })) {
                  await model.request('clear')
                  await model.refresh()
                }
              })
            }
          >
            Clear
          </Button>
        </div>
      </Section>

      <Section title="Model" testId="semantic-settings-model">
        <Field label="Embedding model" description={current?.description}>
          <Select
            aria-label="Embedding model"
            value={settings.model}
            onChange={(v) => void update('model', v)}
            options={(models.length ? models : [{ id: settings.model, name: settings.model } as SemanticModelInfo]).map((m) => ({
              value: m.id,
              label: m.name,
              description: m.repo ? `${formatBytes(m.sizeBytes)} download${m.downloaded ? ' · downloaded' : ''}` : 'Built in',
            }))}
          />
        </Field>
        {current?.repo && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {current.downloaded ? (
              <>
                <Badge tone="success">Downloaded · {formatBytes(current.diskBytes)}</Badge>
                <Button size="xs" variant="ghost" onClick={() => run('Could not delete the model', async () => { await model.request('deleteModel', { id: current.id }); await reload() })}>
                  Delete files
                </Button>
              </>
            ) : download?.modelId === current.id && !download.done ? (
              <div className="flex w-full flex-col gap-1">
                <ProgressBar value={download.totalBytes ? (100 * (download.downloadedBytes ?? 0)) / download.totalBytes : undefined} />
                <span className="text-vibe-muted">
                  {download.file} · {formatBytes(download.downloadedBytes ?? 0)}
                  {download.totalBytes ? ` of ${formatBytes(download.totalBytes)}` : ''}
                </span>
              </div>
            ) : (
              <>
                <Badge tone="warning">Not downloaded</Badge>
                <Button size="xs" onClick={() => run('Download failed', () => model.request('downloadModel', { id: current.id }))}>
                  Download ({formatBytes(current.sizeBytes)})
                </Button>
                <span className="text-vibe-muted">Indexing downloads it automatically.</span>
              </>
            )}
          </div>
        )}
        <Switch
          checked={settings.useGpu}
          onChange={(v) => void update('useGpu', v)}
          disabled={!status?.gpu.cudaCompiled && !status?.gpu.metalCompiled}
          label="Use the GPU"
          description={
            status?.gpu.cudaCompiled || status?.gpu.metalCompiled
              ? `Device in use: ${status?.model.device ?? 'not loaded'}`
              : 'This sidecar was built for the CPU only (build it with --features cuda / metal for GPU support).'
          }
        />
      </Section>

      <Section title="Indexing" testId="semantic-settings-indexing">
        <Field label="When to index">
          <Select aria-label="When to index" value={settings.indexMode} onChange={(v) => void update('indexMode', v)} options={MODES} />
        </Field>
        {settings.indexMode === 'periodic' && (
          <Field label="Every (minutes)">
            <NumberInput value={settings.intervalMinutes} min={1} max={1440} onCommit={(v) => void update('intervalMinutes', v)} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Chunk size (tokens)">
            <NumberInput value={settings.maxChunkTokens} min={64} max={2048} onCommit={(v) => void update('maxChunkTokens', v)} />
          </Field>
          <Field label="Chunk overlap (tokens)">
            <NumberInput value={settings.overlapTokens} min={0} max={512} onCommit={(v) => void update('overlapTokens', v)} />
          </Field>
        </div>
        <Field label="Clean up sessions older than (days, 0 = keep all)">
          <NumberInput value={settings.maxSessionAgeDays} min={0} max={3650} onCommit={(v) => void update('maxSessionAgeDays', v)} />
        </Field>
      </Section>

      <Section title="Session folders" testId="semantic-settings-folders">
        <Switch
          checked={settings.useProviderSessions}
          onChange={(v) => void update('useProviderSessions', v)}
          label="Index agent provider sessions"
          description={
            status?.providerSessionRoots === false
              ? 'This QuadFlow version does not tell plugins where agent providers keep their sessions yet — add the folders below.'
              : 'The session folders every active agent provider declares.'
          }
        />
        <div className="flex flex-col gap-2">
          {dirs.map((d, i) => (
            <div key={d.path} className="flex flex-wrap items-center gap-2 rounded border border-vibe-border p-2" data-testid="semantic-dir">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={d.path}>
                {d.path}
              </span>
              <Input
                size="sm"
                className="w-32"
                aria-label="Files (glob)"
                defaultValue={d.glob ?? '**/*.jsonl'}
                onBlur={(e) => {
                  const glob = e.currentTarget.value.trim() || '**/*.jsonl'
                  if (glob !== (d.glob ?? '**/*.jsonl')) void setDirs(dirs.map((x, j) => (j === i ? { ...x, glob } : x)))
                }}
              />
              <Select
                size="sm"
                aria-label="Agent"
                className="w-36"
                value={d.providerId ?? ''}
                onChange={(providerId) => void setDirs(dirs.map((x, j) => (j === i ? { ...x, providerId } : x)))}
                options={providerOptions}
              />
              <IconButton label="Remove folder" onClick={() => void setDirs(dirs.filter((_, j) => j !== i))}>
                <Icon name="trash" />
              </IconButton>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              size="sm"
              className="flex-1"
              placeholder="Folder with session transcripts (*.jsonl)"
              value={newDir}
              onChange={(e) => setNewDir(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addDir(newDir)
              }}
              data-testid="semantic-dir-input"
            />
            <Button size="sm" onClick={() => void addDir(newDir)} disabled={!newDir.trim()}>
              Add
            </Button>
            <Button size="sm" variant="ghost" leftIcon={<Icon name="folder" />} onClick={() => void pickDir()}>
              Browse…
            </Button>
          </div>
        </div>
        {roots.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-vibe-muted">Scanned:</span>
            {roots.map((r) => (
              <div key={`${r.origin}:${r.root}`} className="flex items-center gap-2">
                <Badge tone={r.exists ? 'neutral' : 'warning'}>{r.providerId || 'unknown'}</Badge>
                <span className="truncate font-mono" title={r.root}>
                  {r.root}
                </span>
                {!r.exists && <span className="text-amber-400">missing</span>}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Diagnostics">
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => run('Could not read the debug info', async () => setDebug(await model.request<string>('debugInfo')))}>
            Show debug info
          </Button>
          {debug && (
            <Button size="sm" variant="ghost" onClick={() => void ctx.clipboard.writeText(debug)}>
              Copy
            </Button>
          )}
        </div>
        {debug && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-vibe-bg p-2 font-mono text-[11px]">{debug}</pre>}
        {status && <div className="text-xs text-vibe-muted">Data folder: {status.dataDir}</div>}
      </Section>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded border border-vibe-border px-2 py-1">
      <div className="text-[10px] uppercase text-vibe-muted">{label}</div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  )
}

function NumberInput({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n)) return setText(String(value))
    const v = Math.max(min, Math.min(max, n))
    setText(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <Input
      size="sm"
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}
