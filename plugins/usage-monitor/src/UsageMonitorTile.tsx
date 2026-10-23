import { useEffect, useState } from 'react'
import type { AgentUsageWindow, TileProps } from '@quadflow/plugin-api'
import { Badge, Button, EmptyState, Icon, IconButton, ProgressBar, Select, Spinner } from '@quadflow/ui'
import { levelOf, providerRows, resetLabel, timeAgo, type ProviderUsage, type UsageLevel, type UsageMonitorSettings } from './model'
import { bind, refresh, registerTile, useUsageStore } from './store'

const TONE: Record<UsageLevel, 'success' | 'primary' | 'warning' | 'error'> = {
  ok: 'success',
  elevated: 'primary',
  warning: 'warning',
  critical: 'error',
}

const COOLDOWNS = [60, 120, 300, 600, 900, 1800]
const POLLS = [0, 300, 600, 900, 1800, 3600]
const mins = (s: number) => (s === 0 ? 'Off' : s < 60 ? `${s} s` : `${s / 60} min`)

function WindowRow({ w, settings }: { w: AgentUsageWindow; settings: UsageMonitorSettings }) {
  const level = levelOf(w.usedPercent, settings)
  const reset = resetLabel(w)
  return (
    <div className="qf-um__window" data-testid="usage-window" data-window={w.id}>
      <div className="qf-um__window-head">
        <span className="qf-um__window-label">{w.label}</span>
        <span className={`qf-um__pct qf-um__pct--${level}`}>{Math.round(w.usedPercent)}% used</span>
      </div>
      <ProgressBar value={w.usedPercent} tone={TONE[level]} label={`${w.label}: ${Math.round(w.usedPercent)}% used`} />
      {reset && <div className="qf-um__reset">{reset}</div>}
    </div>
  )
}

function ProviderCard({ row, settings }: { row: ProviderUsage; settings: UsageMonitorSettings }) {
  const { provider, status, snapshot, error, checkedAt } = row
  const windows = snapshot?.windows ?? []
  return (
    <section className="qf-um__provider" data-testid="usage-provider" data-provider={provider.id} data-status={status}>
      <header className="qf-um__provider-head">
        <span className="qf-um__dot" style={provider.color ? { background: provider.color } : undefined} />
        <span className="qf-um__provider-name">{provider.name}</span>
        {snapshot?.plan && <Badge tone="secondary">{snapshot.plan}</Badge>}
        <span className="qf-um__spacer" />
        {status === 'loading' ? (
          <Spinner size="xs" label={`Checking ${provider.name}`} />
        ) : (
          <span className="qf-um__muted">{checkedAt ? timeAgo(snapshot?.fetchedAt ?? checkedAt) : ''}</span>
        )}
      </header>
      {windows.map((w) => (
        <WindowRow key={w.id} w={w} settings={settings} />
      ))}
      {windows.length === 0 && (
        <p className="qf-um__muted" data-testid="usage-provider-empty">
          {status === 'loading' || status === 'idle'
            ? 'Checking…'
            : status === 'error'
              ? `Could not read usage: ${error}`
              : 'No usage reported. Is the CLI installed, signed in, and trusted in this folder?'}
        </p>
      )}
    </section>
  )
}

function QuickSettings({ settings, onSet }: { settings: UsageMonitorSettings; onSet: (key: string, v: number) => void }) {
  return (
    <section className="qf-um__settings" data-testid="usage-settings">
      <label className="qf-um__field">
        <span>Refresh cooldown</span>
        <Select
          size="sm"
          aria-label="Refresh cooldown"
          value={String(settings.cooldownSeconds)}
          options={[...new Set([...COOLDOWNS, settings.cooldownSeconds])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: mins(v) }))}
          onChange={(v) => onSet('cooldownSeconds', Number(v))}
        />
      </label>
      <label className="qf-um__field">
        <span>Background refresh</span>
        <Select
          size="sm"
          aria-label="Background refresh"
          value={String(settings.backgroundPollSeconds)}
          options={[...new Set([...POLLS, settings.backgroundPollSeconds])].sort((a, b) => a - b).map((v) => ({ value: String(v), label: mins(v) }))}
          onChange={(v) => onSet('backgroundPollSeconds', Number(v))}
        />
      </label>
      <p className="qf-um__muted">
        Warning at {settings.warningThreshold}%, toast at {settings.criticalThreshold}% — change them in Settings → Usage Monitor.
      </p>
    </section>
  )
}

export default function UsageMonitorTile(props: TileProps) {
  const { ctx, instance } = props
  const providers = useUsageStore((s) => s.providers)
  const providersError = useUsageStore((s) => s.providersError)
  const usage = useUsageStore((s) => s.usage)
  const refreshing = useUsageStore((s) => s.refreshing)
  const settings = useUsageStore((s) => s.settings)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    bind(ctx)
    const off = registerTile(instance.id)
    void refresh()
    return off
  }, [ctx, instance.id])

  const rows = providerRows(providers ?? [], usage)
  const last = rows.reduce<number | null>((m, r) => (r.checkedAt && (!m || r.checkedAt > m) ? r.checkedAt : m), null)

  return (
    <div className="qf-um" data-testid="usage-monitor">
      <header className="qf-um__header">
        <Icon name="usageMonitor" className="qf-um__icon" />
        <h2 className="qf-um__title">Usage Monitor</h2>
        <span className="qf-um__spacer" />
        <IconButton label="Settings" active={showSettings} onClick={() => setShowSettings((v) => !v)} data-testid="usage-settings-toggle">
          <Icon name="settings" />
        </IconButton>
        <IconButton label="Refresh now" disabled={refreshing} onClick={() => void refresh({ force: true })} data-testid="usage-refresh">
          <Icon name="refresh" className={refreshing ? 'qf-um__spin' : undefined} />
        </IconButton>
      </header>
      <div className="qf-um__body">
        {showSettings && (
          <QuickSettings settings={settings} onSet={(k, v) => void ctx.settings.set(k, v).catch((e) => ctx.log.error(`settings.set ${k}:`, e))} />
        )}
        {providers === null ? (
          <div className="qf-um__center">
            <Spinner size="md" label="Loading providers" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No usage data"
            description={
              providersError
                ? `Agent providers are unavailable: ${providersError}`
                : 'No installed agent provider reports account usage. Enable a provider plugin with a usage hook (Claude Code, Codex).'
            }
            action={
              <Button size="sm" onClick={() => void refresh({ force: true })}>
                Check again
              </Button>
            }
          />
        ) : (
          rows.map((r) => <ProviderCard key={r.provider.id} row={r} settings={settings} />)
        )}
      </div>
      <footer className="qf-um__footer">
        <span data-testid="usage-last-checked">{last ? `Last checked ${timeAgo(last)}` : 'Not checked yet'}</span>
        <span>
          {refreshing
            ? 'Checking…'
            : settings.backgroundPollSeconds > 0
              ? `Auto-refresh every ${mins(settings.backgroundPollSeconds)}`
              : 'Auto-refresh off'}
        </span>
      </footer>
    </div>
  )
}
