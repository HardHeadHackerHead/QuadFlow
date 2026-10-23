/**
 * Settings → Plugins (plugin-system.md §11.2, §12): installed / bundled / dev
 * plugins with status, enable/disable, update (with permission-diff consent),
 * rollback, uninstall; browse sources; add/remove/refresh sources.
 *
 * Everything shown on open comes from the DB + cached source indexes — no
 * network. "Check for updates" and "Refresh" fetch on demand.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Input,
  SearchInput,
  Spinner,
  Switch,
  Tabs,
  toast,
  type Tone,
} from '@quadflow/ui'
import { onDataChanged } from '../../../lib/core'
import type { PluginStatus } from '../../../generated/bindings'
import { PluginConsentDialog, type ConsentRequest } from './PluginConsentDialog'
import { usePluginRegistry } from '../../../plugins/registry'
import { reloadDevPlugin } from '../../../plugins/devReload'
import { suggestPluginContextDocs } from '../../../plugins/contextDocs'
import {
  errorMessage,
  pickPluginFolder,
  pluginsApi,
  type PluginAvailableData,
  type PluginInfoData,
  type PluginInstallPlan,
  type PluginSourceInfo,
  type PluginUpdateInfo,
} from './api'

type PluginsTab = 'installed' | 'browse' | 'sources'

type Pending =
  | { kind: 'plan'; plan: PluginInstallPlan; request: ConsentRequest }
  | { kind: 'grant'; plugin: PluginInfoData; request: ConsentRequest }

function statusBadge(s: PluginStatus): { tone: Tone; label: string; detail?: string } {
  switch (s.kind) {
    case 'active':
      return { tone: 'success', label: 'Active' }
    case 'disabled':
      return { tone: 'neutral', label: 'Disabled' }
    case 'needsConsent':
      return { tone: 'warning', label: 'Needs approval' }
    case 'incompatible':
      return { tone: 'warning', label: 'Incompatible', detail: s.reason }
    case 'failed':
      return { tone: 'error', label: 'Failed', detail: s.reason }
    case 'unsupportedPlatform':
      return { tone: 'neutral', label: 'Unsupported platform' }
  }
}

function planRequest(plan: PluginInstallPlan): ConsentRequest {
  const update = plan.kind === 'update'
  return {
    title: update ? 'Approve plugin update' : 'Install plugin',
    pluginName: plan.name,
    pluginId: plan.pluginId,
    version: plan.version,
    fromVersion: plan.fromVersion,
    sourceName: plan.sourceName,
    isolation: plan.isolation,
    permissions: plan.permissions,
    added: update ? plan.addedPermissions : undefined,
    removed: plan.removedPermissions,
    notes: plan.notes,
    confirmLabel: update ? 'Approve and update' : 'Install',
  }
}

function timeAgo(ms: number | null): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString()
}

export default function PluginsSettingsPage() {
  const [tab, setTab] = useState<PluginsTab>('installed')
  const [plugins, setPlugins] = useState<PluginInfoData[]>([])
  const [updates, setUpdates] = useState<PluginUpdateInfo[]>([])
  const [sources, setSources] = useState<PluginSourceInfo[]>([])
  const [available, setAvailable] = useState<PluginAvailableData[]>([])
  const [showIncompatible, setShowIncompatible] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [uninstall, setUninstall] = useState<PluginInfoData | null>(null)
  const [deleteData, setDeleteData] = useState(false)
  const [newSource, setNewSource] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [p, u, s, a] = await Promise.all([
        pluginsApi.list(showIncompatible),
        pluginsApi.availableUpdates(),
        pluginsApi.sources(),
        pluginsApi.browse(null),
      ])
      setPlugins(p)
      setUpdates(u)
      setSources(s)
      setAvailable(a)
    } catch (e) {
      toast({ kind: 'error', message: `Could not load plugins: ${errorMessage(e)}` })
    } finally {
      setLoading(false)
    }
  }, [showIncompatible])

  useEffect(() => {
    void reload()
    return onDataChanged({ domain: 'plugins' }, () => void reload())
  }, [reload])

  const run = useCallback(
    async (key: string, f: () => Promise<unknown>, ok?: string) => {
      setBusy(key)
      try {
        await f()
        if (ok) toast({ kind: 'success', message: ok })
        // Keep the shell's registry (tools, tiles, loaded modules) in step with what changed:
        // re-import the plugin whose state changed, else just refresh the contributions.
        const changed = /^(toggle|confirm|rollback|uninstall):(.+)$/.exec(key)?.[2]
        const shell = usePluginRegistry.getState()
        await (changed ? shell.reload(changed) : shell.load())
        await reload()
      } catch (e) {
        toast({ kind: 'error', message: errorMessage(e) })
      } finally {
        setBusy(null)
      }
    },
    [reload],
  )

  const updateById = useMemo(() => new Map(updates.map((u) => [u.pluginId, u])), [updates])

  const startInstall = (a: PluginAvailableData) =>
    run(`install:${a.entry.id}`, async () => {
      const plan = await pluginsApi.planInstall(a.sourceId, a.entry.id)
      setPending({ kind: 'plan', plan, request: planRequest(plan) })
    })

  const startUpdate = (id: string) =>
    run(`update:${id}`, async () => {
      const plan = await pluginsApi.planUpdate(id)
      if (plan.needsConsent) {
        setPending({ kind: 'plan', plan, request: planRequest(plan) })
      } else {
        const info = await pluginsApi.confirm(plan.planId, [])
        toast({ kind: 'success', message: `Updated ${info.name} to ${info.version}` })
      }
    })

  const startGrant = (p: PluginInfoData) =>
    setPending({
      kind: 'grant',
      plugin: p,
      request: {
        title: 'Approve permissions',
        pluginName: p.name,
        pluginId: p.id,
        version: p.version,
        isolation: p.isolation,
        permissions: p.permissions,
        added: p.missingPermissions,
        confirmLabel: 'Approve',
      },
    })

  const confirmPending = async () => {
    if (!pending) return
    const p = pending
    await run(
      `confirm:${p.request.pluginId}`,
      async () => {
        if (p.kind === 'plan') {
          await pluginsApi.confirm(
            p.plan.planId,
            p.plan.permissions.map((x) => x.permission),
          )
        } else {
          await pluginsApi.grant(
            p.plugin.id,
            p.plugin.permissions.map((x) => x.permission),
          )
        }
        setPending(null)
      },
      p.kind === 'plan' ? `${p.plan.kind === 'update' ? 'Updated' : 'Installed'} ${p.plan.name} ${p.plan.version}` : undefined,
    )
  }

  // Dev mode (§15.3): load an unpacked plugin folder; the dev watcher hot-reloads it on rebuilds.
  const loadUnpacked = () =>
    run('load-unpacked', async () => {
      const dir = await pickPluginFolder()
      if (!dir) return
      const info = await pluginsApi.devAdd(dir)
      await usePluginRegistry.getState().reload(info.id)
      const st = statusBadge(info.status)
      toast({
        kind: info.status.kind === 'active' ? 'success' : 'warning',
        message: `Loaded ${info.name} (${info.id}) from ${dir}: ${st.label}${st.detail ? ` — ${st.detail}` : ''}`,
      })
      setTab('installed')
      setExpanded(info.id)
      // The new row is usually below the fold: bring it (and its Approve button) into view.
      setTimeout(() => {
        document.querySelector(`[data-testid="plugin-row-${CSS.escape(info.id)}"]`)?.scrollIntoView({ block: 'center' })
      }, 50)
    })

  const removeUnpacked = (p: PluginInfoData) =>
    run(
      `dev-remove:${p.id}`,
      async () => {
        await pluginsApi.devRemove(p.root)
        await usePluginRegistry.getState().reload(p.id)
      },
      `Stopped loading ${p.name} from ${p.root}`,
    )

  const cancelPending = () => {
    if (pending?.kind === 'plan') void pluginsApi.cancel(pending.plan.planId).catch(() => {})
    setPending(null)
  }

  const counts = { installed: plugins.length, browse: available.length, sources: sources.length }

  return (
    <div className="space-y-4" data-testid="plugins-settings">
      <div className="flex items-center justify-between gap-2">
        <Tabs<PluginsTab>
          value={tab}
          onChange={setTab}
          variant="pills"
          size="sm"
          items={[
            {
              value: 'installed',
              label: 'Installed',
              badge: <Badge tone={updates.length ? 'primary' : 'neutral'}>{updates.length ? `${updates.length} update${updates.length > 1 ? 's' : ''}` : counts.installed}</Badge>,
            },
            { value: 'browse', label: 'Browse', badge: <Badge>{counts.browse}</Badge> },
            { value: 'sources', label: 'Sources', badge: <Badge>{counts.sources}</Badge> },
          ]}
        />
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'load-unpacked'}
            onClick={loadUnpacked}
            title="Load a plugin from a folder you are developing (hot-reloads on rebuild)"
            data-testid="plugins-load-unpacked"
          >
            Load unpacked…
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'check'}
            onClick={() =>
              run('check', async () => {
                const u = await pluginsApi.checkUpdates()
                toast({ message: u.length ? `${u.length} update${u.length > 1 ? 's' : ''} available` : 'All plugins are up to date' })
              })
            }
          >
            Check for updates
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center p-8">
          <Spinner size="md" />
        </div>
      ) : tab === 'installed' ? (
        <div className="space-y-2">
          <Checkbox checked={showIncompatible} onChange={setShowIncompatible} label="Show plugins for other platforms" />
          {plugins.length === 0 && (
            <EmptyState title="No plugins" description="Browse a source to install plugins." />
          )}
          {plugins.map((p) => {
            const st = statusBadge(p.status)
            const up = updateById.get(p.id)
            const open = expanded === p.id
            return (
              <Card key={p.id} padding="sm" data-testid={`plugin-row-${p.id}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button className="font-medium text-qf-text hover:underline" onClick={() => setExpanded(open ? null : p.id)}>
                        {p.name}
                      </button>
                      <span className="font-mono text-xs text-qf-text-muted">{p.id}</span>
                      <span className="text-xs text-qf-text-muted">{p.version ?? '-'}</span>
                      <Badge>{p.origin}</Badge>
                      {p.isolation === 'sandboxed' && <Badge tone="secondary">sandboxed</Badge>}
                      <Badge tone={st.tone} data-testid={`plugin-status-${p.id}`}>
                        {st.label}
                      </Badge>
                    </div>
                    {p.description && <div className="mt-0.5 text-xs text-qf-text-muted">{p.description}</div>}
                    {p.origin === 'dev' && !open && (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-qf-text-muted" title={p.root}>
                        {p.root}
                      </div>
                    )}
                    {st.detail && <div className="mt-0.5 text-xs text-qf-error">{st.detail}</div>}
                    {up && (
                      <div className="mt-1 text-xs text-qf-primary" data-testid={`plugin-update-${p.id}`}>
                        {up.needsConsent
                          ? `Update needs approval: ${up.version} (+ ${up.addedPermissions.join(', ')})`
                          : `Update available: ${up.version}`}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {p.status.kind === 'needsConsent' && (
                      <Button size="xs" variant="primary" onClick={() => startGrant(p)}>
                        Approve
                      </Button>
                    )}
                    {up && (
                      <Button size="xs" variant="primary" loading={busy === `update:${p.id}`} onClick={() => startUpdate(p.id)}>
                        {up.needsConsent ? 'Review update' : 'Update'}
                      </Button>
                    )}
                    {p.origin === 'dev' && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={busy === `dev-reload:${p.id}`}
                          onClick={() => run(`dev-reload:${p.id}`, () => reloadDevPlugin(p.id))}
                          data-testid={`plugin-dev-reload-${p.id}`}
                        >
                          Reload
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => removeUnpacked(p)} data-testid={`plugin-dev-remove-${p.id}`}>
                          Remove
                        </Button>
                      </>
                    )}
                    {p.origin === 'installed' && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={busy === `rollback:${p.id}`}
                          onClick={() => run(`rollback:${p.id}`, () => pluginsApi.rollback(p.id), `Rolled back ${p.name}`)}
                        >
                          Rollback
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setUninstall(p)}>
                          Uninstall
                        </Button>
                      </>
                    )}
                    <Switch
                      checked={p.enabled}
                      disabled={busy === `toggle:${p.id}`}
                      onChange={(on) =>
                        run(`toggle:${p.id}`, async () => {
                          if (!on) return pluginsApi.disable(p.id)
                          await pluginsApi.enable(p.id)
                          void suggestPluginContextDocs(p.id, p.manifest)
                        })
                      }
                      label={<span className="sr-only">Enabled</span>}
                    />
                  </div>
                </div>
                {open && (
                  <div className="mt-2 space-y-1 border-t border-qf-border pt-2 text-xs">
                    {p.permissions.length === 0 ? (
                      <div className="text-qf-text-muted">No permissions requested.</div>
                    ) : (
                      p.permissions.map((perm) => (
                        <div key={perm.permission} className="flex items-center gap-2">
                          <Badge className="shrink-0 whitespace-nowrap" tone={perm.granted ? 'success' : 'warning'}>{perm.granted ? 'granted' : 'not granted'}</Badge>
                          <span className="shrink-0 font-mono">{perm.permission}</span>
                          <span className="text-qf-text-muted">{perm.description}</span>
                        </div>
                      ))
                    )}
                    <div className="break-all text-qf-text-muted">Location: {p.root}</div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      ) : tab === 'browse' ? (
        <div className="space-y-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Search plugins" />
          {available.length === 0 && (
            <EmptyState
              title="Nothing to browse yet"
              description="Sources are fetched on demand. Refresh them on the Sources tab."
              action={
                <Button size="sm" onClick={() => run('refresh-all', () => pluginsApi.refreshSources(null))}>
                  Refresh sources
                </Button>
              }
            />
          )}
          {available
            .filter((a) => {
              const q = query.trim().toLowerCase()
              return !q || `${a.entry.id} ${a.entry.name} ${a.entry.description}`.toLowerCase().includes(q)
            })
            .map((a) => (
              <Card key={`${a.sourceId}:${a.entry.id}`} padding="sm" data-testid={`plugin-available-${a.entry.id}`}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-qf-text">{a.entry.name}</span>
                      <span className="font-mono text-xs text-qf-text-muted">{a.entry.id}</span>
                      {a.latestCompatible && <span className="text-xs text-qf-text-muted">{a.latestCompatible}</span>}
                      <Badge>{a.sourceName}</Badge>
                      {a.entry.bundled && <Badge tone="secondary">bundled</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-qf-text-muted">{a.entry.description}</div>
                    {a.incompatibleReason && <div className="mt-0.5 text-xs text-qf-warning">{a.incompatibleReason}</div>}
                    {a.permissions.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {a.permissions.map((p) => (
                          <span key={p} className="rounded bg-qf-surface px-1.5 py-0.5 font-mono text-[10px] text-qf-text-muted">
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {a.installedOrigin === 'installed' || a.installedOrigin === 'dev' ? (
                    <Badge tone="success">Installed {a.installedVersion}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!a.latestCompatible}
                      loading={busy === `install:${a.entry.id}`}
                      onClick={() => startInstall(a)}
                    >
                      Install
                    </Button>
                  )}
                </div>
              </Card>
            ))}
        </div>
      ) : (
        <div className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const url = newSource.trim()
              if (!url) return
              void run(
                'add-source',
                async () => {
                  const s = await pluginsApi.addSource(url)
                  setNewSource('')
                  if (s.lastError) toast({ kind: 'warning', message: `Added, but fetching failed: ${s.lastError}` })
                },
                'Source added',
              )
            }}
          >
            <Input
              className="flex-1"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="github:OWNER/REPO[#REF][:PATH] or https://…/index.json"
              aria-label="Source URL"
            />
            <Button type="submit" size="md" variant="primary" loading={busy === 'add-source'}>
              Add source
            </Button>
            <Button
              type="button"
              size="md"
              variant="secondary"
              loading={busy === 'refresh-all'}
              onClick={() => run('refresh-all', () => pluginsApi.refreshSources(null))}
            >
              Refresh all
            </Button>
          </form>
          {sources.map((s) => (
            <Card key={s.id} padding="sm" data-testid={`plugin-source-${s.id}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-qf-text">{s.name}</span>
                    {s.builtin && <Badge tone="primary">built-in</Badge>}
                    {s.pluginCount !== null && <Badge>{s.pluginCount} plugins</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-qf-text-muted" title={s.resolvedUrl ?? s.url}>
                    {s.url}
                  </div>
                  <div className={`mt-0.5 text-xs ${s.lastError ? 'text-qf-error' : 'text-qf-text-muted'}`}>
                    {s.lastError ? `Error: ${s.lastError}` : `Checked ${timeAgo(s.lastCheckedAt)}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busy === `refresh:${s.id}`}
                    onClick={() => run(`refresh:${s.id}`, () => pluginsApi.refreshSources(s.id))}
                  >
                    Refresh
                  </Button>
                  {!s.builtin && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => run(`remove:${s.id}`, () => pluginsApi.removeSource(s.id), 'Source removed')}
                    >
                      Remove
                    </Button>
                  )}
                  <Switch
                    checked={s.enabled}
                    onChange={(on) => run(`src-toggle:${s.id}`, () => pluginsApi.setSourceEnabled(s.id, on))}
                    label={<span className="sr-only">Enabled</span>}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <PluginConsentDialog
        request={pending?.request ?? null}
        busy={busy?.startsWith('confirm:')}
        onConfirm={confirmPending}
        onCancel={cancelPending}
      />
      <ConfirmDialog
        open={uninstall !== null}
        title={`Uninstall ${uninstall?.name ?? ''}?`}
        message={
          <div className="space-y-3">
            <p>
              Removes the plugin, its tools, stored data, settings and saved secrets. Project files under
              <span className="font-mono"> .quadflow/plugins/</span> are kept.
            </p>
            <Checkbox checked={deleteData} onChange={setDeleteData} label="Also delete its private data folder" />
          </div>
        }
        confirmLabel="Uninstall"
        danger
        overlayId="plugin-uninstall-dialog"
        onCancel={() => {
          setUninstall(null)
          setDeleteData(false)
        }}
        onConfirm={async () => {
          const p = uninstall
          if (!p) return
          setUninstall(null)
          await run(`uninstall:${p.id}`, () => pluginsApi.uninstall(p.id, deleteData), `Uninstalled ${p.name}`)
          setDeleteData(false)
        }}
      />
    </div>
  )
}
