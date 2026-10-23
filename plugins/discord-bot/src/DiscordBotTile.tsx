// Ported from src/components/tools/DiscordBotPanel.tsx (shell) to the plugin API.
import { useEffect, useState } from 'react'
import type { TileProps } from '@quadflow/plugin-api'
import { discordModel, type DiscordModel, type MirroredTerminal } from './model'

export function DiscordBotTile({ ctx }: TileProps) {
  const model = discordModel(ctx)
  const { settings, hasToken, status, mirrored, error, isSaving, isStarting, sidecarState } = model.store()

  // Local form state. The token is write-only: the field stays empty unless the user types a new one.
  const [botToken, setBotToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [guildId, setGuildId] = useState(settings.guildId)
  const [channelId, setChannelId] = useState(settings.channelId)
  const [qualifiedRoleId, setQualifiedRoleId] = useState(settings.qualifiedRoleId)
  const [autoMirror, setAutoMirror] = useState(settings.autoMirror)
  const [showToken, setShowToken] = useState(false)
  const [settingsChanged, setSettingsChanged] = useState(false)

  // Sync form state when settings load / change elsewhere
  useEffect(() => {
    setGuildId(settings.guildId)
    setChannelId(settings.channelId)
    setQualifiedRoleId(settings.qualifiedRoleId)
    setAutoMirror(settings.autoMirror)
    setSettingsChanged(false)
  }, [settings])

  const handleSaveSettings = async () => {
    const token = clearToken ? '' : botToken.trim() ? botToken.trim() : undefined
    await model.saveSettings({ guildId: guildId.trim(), channelId: channelId.trim(), qualifiedRoleId: qualifiedRoleId.trim(), autoMirror }, token)
    setBotToken('')
    setClearToken(false)
    setSettingsChanged(false)
  }

  const markChanged = () => setSettingsChanged(true)

  return (
    <div className="h-full w-full overflow-y-auto bg-vibe-bg p-4 space-y-4" data-testid="discord-bot">
      {/* On-hold notice */}
      <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2">
        Experimental — the Discord bridge is on hold and may not work in this release.
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-red-400">{error}</span>
          <button onClick={model.clearError} className="text-red-400 hover:text-red-300 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Status Bar */}
      <div className="bg-vibe-surface border border-vibe-border rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Connection indicator */}
            <div
              className={`w-2.5 h-2.5 rounded-full ${
                status.connected
                  ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]'
                  : status.running
                    ? 'bg-yellow-400 animate-pulse'
                    : 'bg-zinc-500'
              }`}
            />
            <div>
              <div className="text-sm font-medium text-vibe-text" data-testid="discord-status">
                {status.connected ? 'Connected' : status.running ? 'Connecting...' : 'Disconnected'}
              </div>
              {status.botUsername && <div className="text-xs text-vibe-muted">{status.botUsername}</div>}
              {status.guildName && <div className="text-xs text-vibe-muted">Server: {status.guildName}</div>}
              {sidecarState === 'failed' && <div className="text-xs text-red-400">Sidecar failed (is Node.js on PATH?)</div>}
            </div>
          </div>
          <button
            onClick={() => void (status.running ? model.stop() : model.start())}
            disabled={isStarting || isSaving}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              status.running
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                : 'bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30'
            } disabled:opacity-50`}
          >
            {isStarting ? 'Starting...' : status.running ? 'Stop Bot' : 'Start Bot'}
          </button>
        </div>
      </div>

      {/* Settings */}
      <div className="bg-vibe-surface border border-vibe-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-vibe-text">Bot Settings</h3>
          {settingsChanged && (
            <button
              onClick={() => void handleSaveSettings()}
              disabled={isSaving}
              className="px-3 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>

        {/* Bot Token (OS keychain) */}
        <div>
          <label className="block text-xs text-vibe-muted mb-1">Bot Token</label>
          <div className="flex gap-2">
            <input
              type={showToken ? 'text' : 'password'}
              value={botToken}
              onChange={(e) => {
                setBotToken(e.target.value)
                setClearToken(false)
                markChanged()
              }}
              placeholder={hasToken && !clearToken ? 'Saved in the OS keychain — type to replace' : 'Discord bot token'}
              className="flex-1 px-2 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-blue-500/50"
            />
            <button
              onClick={() => setShowToken(!showToken)}
              className="px-2 py-1 text-xs text-vibe-muted hover:text-vibe-text border border-vibe-border rounded"
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
            {hasToken && !clearToken && (
              <button
                onClick={() => {
                  setBotToken('')
                  setClearToken(true)
                  markChanged()
                }}
                className="px-2 py-1 text-xs text-vibe-muted hover:text-red-400 border border-vibe-border rounded"
                title="Remove the saved token"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <TextField label="Server (Guild) ID" value={guildId} placeholder="Discord server ID" onChange={(v) => { setGuildId(v); markChanged() }} />
        <TextField label="Channel ID" value={channelId} placeholder="Text channel for threads" onChange={(v) => { setChannelId(v); markChanged() }} />
        <div>
          <TextField
            label="Qualified Role ID"
            value={qualifiedRoleId}
            placeholder="Role ID for terminal input access"
            onChange={(v) => { setQualifiedRoleId(v); markChanged() }}
          />
          <p className="text-xs text-vibe-muted/60 mt-1">Only users with this role can send commands to terminals</p>
        </div>

        {/* Auto-mirror toggle */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-vibe-text">Auto-mirror new terminals</span>
            <p className="text-xs text-vibe-muted/60">Automatically share new terminal sessions to Discord</p>
          </div>
          <button
            onClick={() => { setAutoMirror(!autoMirror); markChanged() }}
            className={`w-10 h-5 rounded-full transition-colors relative ${autoMirror ? 'bg-blue-500' : 'bg-zinc-600'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autoMirror ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Mirrored Terminals */}
      <div className="bg-vibe-surface border border-vibe-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-vibe-text mb-3">Mirrored Terminals ({mirrored.length})</h3>
        {mirrored.length === 0 ? (
          <p className="text-xs text-vibe-muted text-center py-4">
            {status.running
              ? 'No terminals are being mirrored. Use "Share to Discord" in a terminal\'s ⋯ menu to start.'
              : 'Start the bot to begin mirroring terminals to Discord.'}
          </p>
        ) : (
          <div className="space-y-2">
            {mirrored.map((t) => (
              <MirroredTerminalRow key={t.terminalId} model={model} terminal={t} />
            ))}
          </div>
        )}
      </div>

      {/* Help */}
      <div className="text-xs text-vibe-muted/60 space-y-1">
        <p>Terminal output is streamed to Discord threads. Qualified role users can reply to inject commands.</p>
        <p>Enable Developer Mode in Discord (Settings &gt; Advanced) to copy IDs by right-clicking.</p>
      </div>
    </div>
  )
}

function TextField(props: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-vibe-muted mb-1">{props.label}</label>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="w-full px-2 py-1.5 bg-vibe-bg border border-vibe-border rounded text-sm text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-blue-500/50"
      />
    </div>
  )
}

function MirroredTerminalRow({ model, terminal }: { model: DiscordModel; terminal: MirroredTerminal }) {
  return (
    <div className="flex items-center justify-between p-2 bg-vibe-bg rounded border border-vibe-border/50">
      <div className="flex items-center gap-2 min-w-0">
        <svg className="w-4 h-4 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <div className="min-w-0">
          <div className="text-sm text-vibe-text truncate">{terminal.sessionLabel}</div>
          {terminal.threadUrl && (
            <button onClick={() => model.openThread(terminal.threadUrl!)} className="text-xs text-blue-400 hover:underline">
              Open thread
            </button>
          )}
        </div>
      </div>
      <button
        onClick={() => void model.unmirror(terminal.terminalId)}
        className="p-1 text-vibe-muted hover:text-red-400 rounded transition-colors flex-shrink-0"
        title="Stop mirroring"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
