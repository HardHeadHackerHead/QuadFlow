import { useEffect, useState, type MouseEvent, type PointerEvent } from 'react'
import type { MiniWidgetProps } from '@quadflow/plugin-api'
import { Icon } from '@quadflow/ui'
import {
  countdown,
  levelOf,
  miniGroups,
  miniTooltip,
  providerRows,
  visibleMax,
  type MiniGroup,
  type UsageMonitorSettings,
} from './model'
import { bind, useUsageStore } from './store'

/** Re-render every minute so reset countdowns stay current. */
function useMinuteTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/**
 * The mini view itself (also rendered as a preview on the settings page):
 * one group per visible provider (its colour dot, then each visible window),
 * drawn in the chosen `miniStyle`.
 */
export function MiniView({ groups, settings, max, now }: { groups: MiniGroup[]; settings: UsageMonitorSettings; max: number | null; now: number }) {
  if (settings.miniStyle === 'highest' || groups.length === 0) {
    return (
      <span className={`qf-um-mini__single${max === null ? '' : ` qf-um-mini--${levelOf(max, settings)}`}`} data-testid="usage-mini-value">
        {max === null ? '--' : `${Math.round(max)}%`}
      </span>
    )
  }
  return (
    <>
      {groups.map((g) => (
        <span key={g.provider.id} className="qf-um-mini__group" data-provider={g.provider.id}>
          <span className="qf-um-mini__dot" style={g.provider.color ? { background: g.provider.color } : undefined} aria-label={g.provider.name} />
          {g.windows.map(({ key, short, window: w, level }) => {
            const pct = `${Math.round(w.usedPercent)}%`
            const cd = settings.miniStyle === 'countdown' ? countdown(w.resetsAt, now) : null
            return (
              <span key={key} className="qf-um-mini__win" data-window={w.id}>
                <span className="qf-um-mini__line">
                  <span className="qf-um-mini__label">{short}</span>
                  <span className={`qf-um-mini__pct qf-um-mini--${level}`}>{pct}</span>
                </span>
                {settings.miniStyle === 'bars' && (
                  <span className="qf-um-mini__track">
                    <span className={`qf-um-mini__fill qf-um-mini__fill--${level}`} style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
                  </span>
                )}
                {settings.miniStyle === 'countdown' && <span className="qf-um-mini__cd">{cd ?? '—'}</span>}
              </span>
            )
          })}
        </span>
      ))}
    </>
  )
}

/**
 * Toolbar widget: every visible window of every provider (setting
 * `miniStyle` / `miniHidden`), the full list in the tooltip, and a gear that
 * opens Settings → Usage Monitor. Never runs a hook itself — it shows what the
 * tile or the background refresh fetched.
 */
export default function UsageMiniWidget({ ctx }: MiniWidgetProps) {
  const providers = useUsageStore((s) => s.providers)
  const usage = useUsageStore((s) => s.usage)
  const settings = useUsageStore((s) => s.settings)
  useEffect(() => bind(ctx), [ctx])
  const now = useMinuteTick(settings.miniStyle === 'countdown')

  const rows = providerRows(providers ?? [], usage)
  const groups = miniGroups(rows, settings)
  const max = visibleMax(groups)

  // Inside the toolbar button: keep its click (open the tile) and drag handle off the gear.
  const stop = (e: MouseEvent | PointerEvent) => e.stopPropagation()
  const openSettings = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    void ctx.ui.openSettings('usage-monitor').catch((err) => ctx.log.warn('openSettings failed:', err))
  }

  return (
    <span className={`qf-um-mini qf-um-mini--style-${settings.miniStyle}`} title={miniTooltip(rows, now)} data-testid="usage-mini-widget" data-style={settings.miniStyle}>
      <MiniView groups={groups} settings={settings} max={max} now={now} />
      <span
        role="button"
        aria-label="Customize the usage widget"
        title="Customize the usage widget"
        className="qf-um-mini__gear"
        data-testid="usage-mini-settings"
        onPointerDown={stop}
        onMouseDown={stop}
        onClick={openSettings}
      >
        <Icon name="settings" />
      </span>
    </span>
  )
}
