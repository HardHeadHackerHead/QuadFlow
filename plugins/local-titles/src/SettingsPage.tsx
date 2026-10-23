// Settings → Local Titles: model download / delete and inference options. Ported from the
// "Local" half of the shell's Auto Titles section (src/components/settings/AppSettingsModal.tsx).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PluginContext, SettingsPageProps } from '@quadflow/plugin-api'
import { formatBytes, localTitlesModel, readSettings } from './model'

const inputCls = 'px-2 py-1 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text'

function useSettings(ctx: PluginContext) {
  const [, force] = useState(0)
  useEffect(() => ctx.settings.onDidChange(() => force((n) => n + 1)), [ctx])
  return readSettings(ctx)
}

export function SettingsPage({ ctx }: SettingsPageProps) {
  const model = localTitlesModel(ctx)
  useEffect(() => model.retain(), [model])
  const state = useSyncExternalStore(model.store.subscribe, model.store.getState)
  const settings = useSettings(ctx)
  const { info, models, progress, loading, error, sidecarState } = state

  const selected = models.find((m) => m.id === settings.modelId)
  const selectedProgress = progress[settings.modelId]
  const percent =
    selectedProgress && selectedProgress.totalBytes > 0
      ? Math.min(100, Math.round((selectedProgress.downloadedBytes / selectedProgress.totalBytes) * 100))
      : 0
  const downloading = !!selectedProgress || !!selected?.downloading
  // Stub sidecar (`--no-default-features`): it lists models but cannot run them.
  const noEngine = info?.backend === 'none'

  return (
    <div className="qf-local-titles space-y-4" data-testid="local-titles-settings">
      <div>
        <h3 className="text-sm font-medium text-vibe-text">Local Titles</h3>
        <p className="text-xs text-vibe-muted">
          Short terminal titles from a local model (llama.cpp). Used first when &quot;Auto-title terminals&quot; is on
          (Settings → Integrations → Auto Titles); without a downloaded model the agent&apos;s session title or the
          API model is used instead.
        </p>
      </div>

      <div className="bg-vibe-bg rounded-lg p-4 space-y-4 border border-vibe-border">
        <div className="flex items-center justify-between gap-3 text-xs text-vibe-muted">
          <span data-testid="local-titles-backend">
            Backend:{' '}
            {info
              ? noEngine
                ? 'none (this sidecar build has no inference engine; build it with llama.cpp to generate titles)'
                : `${info.backend}${info.gpu ? ` + ${info.gpu.toUpperCase()}` : ' (CPU)'}`
              : sidecarState === 'failed'
                ? 'sidecar not available'
                : '…'}
          </span>
          <button
            onClick={() => void model.refresh()}
            disabled={loading}
            className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label className="text-sm text-vibe-text">Model</label>
            <p className="text-xs text-vibe-muted">Pick a model tier based on speed vs quality</p>
          </div>
          <select
            value={settings.modelId}
            onChange={(e) => void model.setSetting('modelId', e.target.value)}
            className="px-3 py-1.5 bg-vibe-surface border border-vibe-border rounded text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
            data-testid="local-titles-model"
          >
            {(models.length ? models : [{ id: settings.modelId, name: settings.modelId, tier: '' }]).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.tier ? ` (${m.tier})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label className="text-sm text-vibe-text">Model status</label>
            <p className="text-xs text-vibe-muted" data-testid="local-titles-status">
              {selected?.downloaded ? 'Ready to use' : downloading ? 'Downloading…' : 'Download required'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selected?.downloaded ? (
              <button
                onClick={() => void model.remove(settings.modelId)}
                disabled={loading}
                className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 rounded text-sm hover:bg-red-500/20 disabled:opacity-50"
              >
                Delete
              </button>
            ) : downloading ? (
              <button
                onClick={() => void model.cancelDownload()}
                className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => void model.download(settings.modelId)}
                disabled={loading || !info || noEngine}
                title={noEngine ? 'This sidecar build cannot run models' : undefined}
                data-testid="local-titles-download"
                className="px-3 py-1.5 bg-vibe-bg border border-vibe-border text-vibe-text rounded text-sm hover:bg-vibe-border/50 disabled:opacity-50"
              >
                Download
              </button>
            )}
          </div>
        </div>

        {downloading && !selected?.downloaded && (
          <div className="text-xs text-vibe-muted">
            <div className="flex items-center justify-between mb-1">
              <span>Downloading... {percent}%</span>
              {selectedProgress && (
                <span>
                  {formatBytes(selectedProgress.downloadedBytes)} / {formatBytes(selectedProgress.totalBytes)}
                </span>
              )}
            </div>
            <div className="h-1 bg-vibe-border rounded">
              <div className="h-1 rounded bg-vibe-primary" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}

        {selected && (
          <div className="text-xs text-vibe-muted">
            Size: {formatBytes(selected.sizeBytes)} - Quality: {selected.qualityRating}/5
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 pt-2 border-t border-vibe-border">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-vibe-muted">Device</label>
            <select value={settings.deviceMode} onChange={(e) => void model.setSetting('deviceMode', e.target.value)} className={inputCls}>
              <option value="auto">Auto</option>
              <option value="gpu" disabled={!info?.gpu}>
                GPU{info && !info.gpu ? ' (not in this build)' : ''}
              </option>
              <option value="cpu">CPU</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-vibe-muted">GPU layers</label>
            <input
              type="number"
              min={0}
              value={settings.gpuLayers}
              onChange={(e) => void model.setSetting('gpuLayers', Math.max(0, Number(e.target.value) || 0))}
              className={`w-20 ${inputCls}`}
              title="0 = offload every layer that fits"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-vibe-muted">Max tokens</label>
            <input
              type="number"
              min={6}
              max={32}
              value={settings.maxTokens}
              onChange={(e) => void model.setSetting('maxTokens', Math.min(32, Math.max(6, Number(e.target.value) || 12)))}
              className={`w-20 ${inputCls}`}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs text-vibe-muted">Temperature</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={settings.temperature}
              onChange={(e) => void model.setSetting('temperature', Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
              className={`w-20 ${inputCls}`}
            />
          </div>
        </div>

        {error && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 flex justify-between gap-2">
            <span>{error}</span>
            <button onClick={model.clearError} className="text-red-400 hover:text-red-300">
              Dismiss
            </button>
          </div>
        )}

        {info && <div className="text-[11px] text-vibe-muted/70 break-all">Models folder: {info.modelsDir}</div>}
      </div>
    </div>
  )
}
