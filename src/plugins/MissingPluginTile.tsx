/**
 * Shown instead of a tile whose plugin is not installed, disabled, failed or
 * incompatible (plugin-system.md §5.2) — never a crash or a vanished pane.
 */
import { useState } from 'react'
import { Button } from '@quadflow/ui'
import { usePluginRegistry, type PluginInfo } from './registry'
import PluginIcon from './PluginIcon'

export default function MissingPluginTile({
  pluginId,
  contributionId,
  plugin,
}: {
  pluginId: string
  contributionId: string
  plugin: PluginInfo | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = plugin?.status.kind

  let message: string
  if (!plugin) message = 'This plugin is not installed.'
  else if (kind === 'disabled') message = 'This plugin is disabled.'
  else if (kind === 'needsConsent') message = 'This plugin is waiting for permission approval in Settings → Plugins.'
  else if (kind === 'incompatible' || kind === 'failed') {
    message = `This plugin cannot run: ${'reason' in plugin.status ? plugin.status.reason : kind}`
  } else message = `This plugin is unavailable (${kind}).`

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      await usePluginRegistry.getState().enable(pluginId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted"
      data-missing-plugin={pluginId}
    >
      <div className="max-w-sm text-center px-4">
        <PluginIcon pluginId={pluginId} contributionId={contributionId} size={32} className="mx-auto mb-2 opacity-60" />
        <p className="text-sm font-medium text-vibe-text">{plugin?.name ?? pluginId}</p>
        <p className="mt-1 text-xs">{message}</p>
        {kind === 'disabled' && (
          <Button className="mt-3" size="sm" loading={busy} onClick={enable}>
            Enable
          </Button>
        )}
        {!plugin && (
          <Button className="mt-3" size="sm" disabled title="Installing plugins arrives with Settings → Plugins">
            Install
          </Button>
        )}
        {error && <p className="mt-2 text-xs text-vibe-error">{error}</p>}
      </div>
    </div>
  )
}
