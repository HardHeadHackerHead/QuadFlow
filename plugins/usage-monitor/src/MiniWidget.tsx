import { useEffect } from 'react'
import type { MiniWidgetProps } from '@quadflow/plugin-api'
import { levelOf, maxPercent, providerRows } from './model'
import { bind, useUsageStore } from './store'

/**
 * Toolbar badge: the highest usage window over all providers ("--" without
 * data). The tooltip lists every provider's windows. Never runs a hook itself —
 * it shows what the tile or the background refresh fetched.
 */
export default function UsageMiniWidget({ ctx }: MiniWidgetProps) {
  const providers = useUsageStore((s) => s.providers)
  const usage = useUsageStore((s) => s.usage)
  const settings = useUsageStore((s) => s.settings)
  useEffect(() => bind(ctx), [ctx])

  const rows = providerRows(providers ?? [], usage)
  const max = maxPercent(rows.map((r) => r.snapshot))
  const title =
    rows
      .map((r) => {
        const ws = r.snapshot?.windows ?? []
        return ws.length === 0
          ? `${r.provider.name}: no data`
          : `${r.provider.name}: ${ws.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(', ')}`
      })
      .join('\n') || 'Usage Monitor: no data'

  return (
    <span
      className={`qf-um-mini${max === null ? '' : ` qf-um-mini--${levelOf(max, settings)}`}`}
      title={title}
      data-testid="usage-mini-widget"
    >
      {max === null ? '--' : `${Math.round(max)}%`}
    </span>
  )
}
