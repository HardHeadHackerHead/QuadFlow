import { useEffect, useRef, useState } from 'react'
import { invoke, listen, open } from './bridge'
import type { YouTubeSettings, YouTubeQuotaUsage, YouTubePollStatus, TrackedStream, PayTableEntry, PrizeLogEntry, OAuthStatus, QuotaBreakdown, SlotSymbol } from './types'

type UpdateReq = Record<string, unknown>

function fileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

// ============ Reusable Components ============

function Toggle({ checked, onChange, label, description }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div className="relative">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only peer"
        />
        <div className="w-9 h-5 bg-vibe-border rounded-full peer-checked:bg-vibe-primary transition-colors" />
        <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
      </div>
      <div>
        <span className="text-sm text-vibe-text">{label}</span>
        {description && <p className="text-xs text-vibe-muted">{description}</p>}
      </div>
    </label>
  )
}

function NumberInput({ value, onChange, onBlur, label, description, min = 0, max = 10000 }: {
  value: number
  onChange: (value: number) => void
  onBlur?: () => void
  label: string
  description?: string
  min?: number
  max?: number
}) {
  return (
    <div>
      <label className="text-xs text-vibe-muted block mb-1">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, parseInt(e.target.value) || 0))}
        onBlur={onBlur}
        className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text focus:outline-none focus:border-vibe-primary"
      />
      {description && <p className="text-xs text-vibe-muted mt-1">{description}</p>}
    </div>
  )
}

function TextInput({ value, onChange, onBlur, label, description, placeholder }: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  label: string
  description?: string
  placeholder?: string
}) {
  return (
    <div>
      <label className="text-xs text-vibe-muted block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary"
      />
      {description && <p className="text-xs text-vibe-muted mt-1">{description}</p>}
    </div>
  )
}

function SectionCard({ title, children, icon }: { title: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="bg-vibe-surface border border-vibe-border rounded-lg p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-medium text-vibe-text">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

// ============ Tab Components ============

// ---- Connection Tab ----
function ConnectionTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [channelId, setChannelId] = useState(settings?.channel_id || '')
  const [pollStatus, setPollStatus] = useState<YouTubePollStatus | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [trackedStreams, setTrackedStreams] = useState<TrackedStream[]>([])
  const [videoInput, setVideoInput] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setChannelId(settings?.channel_id || '')
  }, [settings?.channel_id])

  const loadStatus = async () => {
    try {
      const status = await invoke<YouTubePollStatus>('youtube_get_poll_status')
      setPollStatus(status)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadStatus()
    pollIntervalRef.current = setInterval(loadStatus, 3000)
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    }
  }, [])

  const handleConnect = async () => {
    setError(null)
    if (videoInput.trim()) {
      setIsConnecting(true)
      try {
        await invoke('youtube_connect_stream', { request: { video_input: videoInput.trim() } })
        setVideoInput('')
        setShowResults(false)
        await loadStatus()
      } catch (e) {
        setError(`Failed to connect: ${e}`)
      }
      setIsConnecting(false)
    } else {
      setIsSearching(true)
      try {
        const streams = await invoke<TrackedStream[]>('youtube_search_streams', { request: {} })
        if (streams.length === 1) {
          setIsConnecting(true)
          await invoke('youtube_connect_stream', { request: { video_input: streams[0].video_id } })
          await loadStatus()
          setIsConnecting(false)
        } else if (streams.length > 1) {
          setTrackedStreams(streams)
          setShowResults(true)
        } else {
          setError('No live streams found. Make sure your channel ID is set and you have an active live stream.')
        }
      } catch (e) {
        setError(`Failed to search: ${e}`)
      }
      setIsSearching(false)
    }
  }

  const handleSelectStream = async (videoId: string) => {
    setShowResults(false)
    setIsConnecting(true)
    setError(null)
    try {
      await invoke('youtube_connect_stream', { request: { video_input: videoId } })
      await loadStatus()
    } catch (e) {
      setError(`Failed to connect: ${e}`)
    }
    setIsConnecting(false)
  }

  const handleDisconnect = async () => {
    try {
      await invoke('youtube_disconnect_stream')
      await loadStatus()
    } catch (e) {
      setError(`Failed to disconnect: ${e}`)
    }
  }

  const handlePickFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: 'Select YouTube API Credentials File',
        filters: [
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      })
      if (selected && typeof selected === 'string') {
        await saveField({ credentials_file: selected }, 'credentials')
      }
    } catch (e) {
      console.error('File picker error:', e)
    }
  }

  const hasCredentials = !!(settings?.credentials_file)
  const isPolling = pollStatus?.is_polling

  return (
    <div className="space-y-6">
      {/* API Credentials */}
      <SectionCard title="API Credentials" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>}>
        {hasCredentials ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 p-2.5 bg-vibe-bg border border-green-500/30 rounded-lg">
              <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-vibe-text truncate">{fileName(settings!.credentials_file!)}</p>
                <p className="text-xs text-vibe-muted truncate">{settings!.credentials_file}</p>
              </div>
              <button
                onClick={() => saveField({ clear_credentials_file: true }, 'credentials')}
                className="p-1 text-vibe-muted hover:text-red-400 transition-colors flex-shrink-0"
                title="Remove credentials file"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <button onClick={handlePickFile} className="text-xs text-vibe-muted hover:text-vibe-text transition-colors">
              Choose a different file...
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={handlePickFile}
              className="w-full flex items-center justify-center gap-2 p-3 bg-vibe-bg border border-dashed border-vibe-border rounded-lg text-sm text-vibe-muted hover:text-vibe-text hover:border-vibe-primary transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Browse for credentials file...
            </button>
            <div className="text-xs text-vibe-muted space-y-1.5">
              <p>Create a JSON file with your API key:</p>
              <code className="block bg-vibe-bg px-2 py-1.5 rounded text-vibe-text font-mono">{'{ "key": "AIza..." }'}</code>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Stream Connection */}
      <SectionCard title="Stream Connection" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>}>
        {error && (
          <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400 flex justify-between items-start">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-2 hover:text-red-300">×</button>
          </div>
        )}

        {isPolling ? (
          <div className="bg-vibe-bg border border-green-500/30 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-vibe-text">Connected</span>
              </div>
              <button
                onClick={handleDisconnect}
                className="text-xs px-2 py-1 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
              >
                Disconnect
              </button>
            </div>
            {pollStatus?.stream_title && (
              <p className="text-xs text-vibe-muted mt-1 truncate">{pollStatus.stream_title}</p>
            )}
            <div className="flex gap-4 mt-2 text-xs text-vibe-muted">
              <span>{pollStatus?.messages_scanned || 0} messages</span>
              <span>{pollStatus?.ideas_captured || 0} ideas</span>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                onClick={handleConnect}
                disabled={isConnecting || isSearching}
                className="flex-1 px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {isConnecting ? 'Connecting...' : isSearching ? 'Searching...' : 'Connect to Live Stream'}
              </button>
              <button
                onClick={() => setShowManual(!showManual)}
                className="px-2 py-2 text-vibe-muted hover:text-vibe-text bg-vibe-bg border border-vibe-border rounded transition-colors"
              >
                <svg className={`w-4 h-4 transition-transform ${showManual ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>

            {showManual && (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                  placeholder="Video URL or ID"
                  className="flex-1 bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary"
                />
                <button
                  onClick={handleConnect}
                  disabled={isConnecting || !videoInput.trim()}
                  className="px-3 py-1.5 text-sm bg-vibe-primary text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  Go
                </button>
              </div>
            )}

            {showResults && trackedStreams.length > 0 && (
              <div className="space-y-1.5 pt-2">
                <p className="text-xs text-vibe-muted">Select a stream:</p>
                {trackedStreams.map((stream) => (
                  <button
                    key={stream.video_id}
                    onClick={() => handleSelectStream(stream.video_id)}
                    className="w-full text-left p-2 bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary transition-colors"
                  >
                    <p className="text-sm text-vibe-text truncate">{stream.title || stream.video_id}</p>
                    <p className="text-xs text-vibe-muted">{stream.channel_title}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* Channel Settings */}
      <SectionCard title="Channel Settings" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}>
        <TextInput
          label="Default Channel ID"
          value={channelId}
          onChange={(v) => {
            setChannelId(v)
            debouncedSave('channelId', v ? { channel_id: v } : { clear_channel_id: true }, 'channel')
          }}
          onBlur={() => flushDebounce('channelId')}
          placeholder="UCxxxxxxxxxxxxxxxxxxxxxx"
          description="Used when searching for live streams"
        />
      </SectionCard>
    </div>
  )
}

// ---- Commands Tab ----
function CommandsTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [prefix, setPrefix] = useState(settings?.command_prefix || '!idea')
  const [ideaCooldown, setIdeaCooldown] = useState(settings?.idea_cooldown_secs ?? 0)
  const [pollInterval, setPollInterval] = useState(Math.round((settings?.poll_interval_ms || 5000) / 1000))
  const [autoConnect, setAutoConnect] = useState(settings?.auto_connect ?? false)

  useEffect(() => {
    setPrefix(settings?.command_prefix || '!idea')
    setIdeaCooldown(settings?.idea_cooldown_secs ?? 0)
    setPollInterval(Math.round((settings?.poll_interval_ms || 5000) / 1000))
    setAutoConnect(settings?.auto_connect ?? false)
  }, [settings])

  return (
    <div className="space-y-6">
      {/* Idea Command */}
      <SectionCard title="Idea Command" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>}>
        <TextInput
          label="Command Prefix"
          value={prefix}
          onChange={(v) => {
            setPrefix(v)
            debouncedSave('prefix', { command_prefix: v }, 'prefix')
          }}
          onBlur={() => flushDebounce('prefix')}
          placeholder="!idea"
          description={`Viewers type "${prefix} their suggestion" in chat`}
        />
        <NumberInput
          label="Idea Cooldown (seconds)"
          value={ideaCooldown}
          onChange={(v) => {
            setIdeaCooldown(v)
            debouncedSave('ideaCooldown', { idea_cooldown_secs: Math.min(300, v) }, 'idea cooldown')
          }}
          onBlur={() => flushDebounce('ideaCooldown')}
          min={0}
          max={300}
          description="Per-user cooldown between ideas (0 = no cooldown)"
        />
      </SectionCard>

      {/* Polling Settings */}
      <SectionCard title="Polling Settings" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}>
        <NumberInput
          label="Base Poll Interval (seconds)"
          value={pollInterval}
          onChange={(v) => {
            setPollInterval(v)
            debouncedSave('pollInterval', { poll_interval_ms: Math.max(5, v) * 1000 }, 'interval')
          }}
          onBlur={() => flushDebounce('pollInterval')}
          min={5}
          max={60}
          description="How often to check for new chat messages (min 5s)"
        />
        <Toggle
          checked={autoConnect}
          onChange={(checked) => {
            setAutoConnect(checked)
            saveField({ auto_connect: checked }, 'auto-connect')
          }}
          label="Auto-Connect"
          description="Automatically connect when a live stream is detected"
        />
      </SectionCard>
    </div>
  )
}

// ---- Points Tab ----
function PointsTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [startingPoints, setStartingPoints] = useState(settings?.starting_points ?? 100)
  const [ideaReward, setIdeaReward] = useState(settings?.idea_points_reward ?? 5)
  const [ideaApproveBonus, setIdeaApproveBonus] = useState(settings?.idea_approve_bonus ?? 50)
  const [chatXpEnabled, setChatXpEnabled] = useState(settings?.chat_xp_enabled ?? true)
  const [chatXpAmount, setChatXpAmount] = useState(settings?.chat_xp_amount ?? 1)
  const [chatXpCooldown, setChatXpCooldown] = useState(settings?.chat_xp_cooldown_secs ?? 30)

  useEffect(() => {
    setStartingPoints(settings?.starting_points ?? 100)
    setIdeaReward(settings?.idea_points_reward ?? 5)
    setIdeaApproveBonus(settings?.idea_approve_bonus ?? 50)
    setChatXpEnabled(settings?.chat_xp_enabled ?? true)
    setChatXpAmount(settings?.chat_xp_amount ?? 1)
    setChatXpCooldown(settings?.chat_xp_cooldown_secs ?? 30)
  }, [settings])

  return (
    <div className="space-y-6">
      {/* Points System */}
      <SectionCard title="Points System" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}>
        <NumberInput
          label="Starting Balance"
          value={startingPoints}
          onChange={(v) => {
            setStartingPoints(v)
            debouncedSave('startingPoints', { starting_points: Math.min(10000, v) }, 'starting points')
          }}
          onBlur={() => flushDebounce('startingPoints')}
          min={0}
          max={10000}
          description="Points given to new viewers on first interaction"
        />
      </SectionCard>

      {/* Chat XP */}
      <SectionCard title="Chat XP" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}>
        <Toggle
          checked={chatXpEnabled}
          onChange={(checked) => {
            setChatXpEnabled(checked)
            saveField({ chat_xp_enabled: checked }, 'chat XP')
          }}
          label="Enable Chat XP"
          description="Award points for participating in chat"
        />

        {chatXpEnabled && (
          <div className="grid grid-cols-2 gap-3">
            <NumberInput
              label="XP per Message"
              value={chatXpAmount}
              onChange={(v) => {
                setChatXpAmount(v)
                debouncedSave('chatXpAmount', { chat_xp_amount: Math.min(100, v) }, 'chat XP amount')
              }}
              onBlur={() => flushDebounce('chatXpAmount')}
              min={0}
              max={100}
            />
            <NumberInput
              label="Cooldown (seconds)"
              value={chatXpCooldown}
              onChange={(v) => {
                setChatXpCooldown(v)
                debouncedSave('chatXpCooldown', { chat_xp_cooldown_secs: Math.min(300, v) }, 'chat XP cooldown')
              }}
              onBlur={() => flushDebounce('chatXpCooldown')}
              min={0}
              max={300}
            />
          </div>
        )}
      </SectionCard>

      {/* Idea Rewards */}
      <SectionCard title="Idea Rewards" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>}>
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Submit Reward"
            value={ideaReward}
            onChange={(v) => {
              setIdeaReward(v)
              debouncedSave('ideaReward', { idea_points_reward: Math.min(100, v) }, 'idea reward')
            }}
            onBlur={() => flushDebounce('ideaReward')}
            min={0}
            max={100}
            description="Points for submitting"
          />
          <NumberInput
            label="Approve Bonus"
            value={ideaApproveBonus}
            onChange={(v) => {
              setIdeaApproveBonus(v)
              debouncedSave('ideaApproveBonus', { idea_approve_bonus: Math.min(1000, v) }, 'approve bonus')
            }}
            onBlur={() => flushDebounce('ideaApproveBonus')}
            min={0}
            max={1000}
            description="Bonus when approved"
          />
        </div>
      </SectionCard>
    </div>
  )
}

// ---- Slots Tab ----

const FALLBACK_SYMBOL_EMOJIS: Record<string, string> = {
  cherry: '\uD83C\uDF52', lemon: '\uD83C\uDF4B', orange: '\uD83C\uDF4A',
  plum: '\uD83E\uDED0', bell: '\uD83D\uDD14', bar: '\uD83C\uDF2D', seven: '7\uFE0F\u20E3',
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  triple_specific: 'Triple Specific',
  triple_any: 'Any Triple',
  partial: 'Partial Match',
}

function SlotSymbolsSection({ onSymbolsChanged }: { onSymbolsChanged: () => void }) {
  const [symbols, setSymbols] = useState<SlotSymbol[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formEmoji, setFormEmoji] = useState('')
  const [formWeight, setFormWeight] = useState(10)
  const [formIsWild, setFormIsWild] = useState(false)

  const loadSymbols = async () => {
    try {
      const data = await invoke<SlotSymbol[]>('youtube_list_all_slot_symbols')
      setSymbols(data)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadSymbols() }, [])

  const totalWeight = symbols.filter(s => s.enabled).reduce((sum, s) => sum + s.weight, 0)

  const getChanceDisplay = (weight: number) => {
    if (totalWeight <= 0) return '-'
    const oneIn = totalWeight / weight
    return `1 in ${Math.round(oneIn)}`
  }

  const resetForm = () => {
    setFormName('')
    setFormEmoji('')
    setFormWeight(10)
    setFormIsWild(false)
    setShowAdd(false)
    setEditId(null)
  }

  const handleSave = async () => {
    if (!formName.trim() || !formEmoji.trim()) return
    try {
      if (editId) {
        await invoke('youtube_update_slot_symbol', {
          id: editId,
          name: formName.trim(),
          emoji: formEmoji.trim(),
          weight: Math.max(1, formWeight),
          isWild: formIsWild,
        })
      } else {
        await invoke('youtube_create_slot_symbol', {
          name: formName.trim().toLowerCase().replace(/\s+/g, '_'),
          emoji: formEmoji.trim(),
          weight: Math.max(1, formWeight),
          isWild: formIsWild,
        })
      }
      resetForm()
      loadSymbols()
      onSymbolsChanged()
    } catch { /* ignore */ }
  }

  const handleEdit = (sym: SlotSymbol) => {
    setEditId(sym.id)
    setFormName(sym.name)
    setFormEmoji(sym.emoji)
    setFormWeight(sym.weight)
    setFormIsWild(sym.is_wild)
    setShowAdd(true)
  }

  const handleDelete = async (id: string) => {
    try {
      await invoke('youtube_delete_slot_symbol', { id })
      loadSymbols()
      onSymbolsChanged()
    } catch { /* ignore */ }
  }

  const handleToggle = async (sym: SlotSymbol) => {
    try {
      await invoke('youtube_update_slot_symbol', { id: sym.id, enabled: !sym.enabled })
      loadSymbols()
      onSymbolsChanged()
    } catch { /* ignore */ }
  }

  return (
    <SectionCard title="Slot Symbols" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-vibe-muted">Configure symbols and their probabilities. Lower weight = rarer.</p>
        <button
          onClick={() => { resetForm(); setShowAdd(true) }}
          className="text-xs px-2 py-1 bg-vibe-primary/20 text-vibe-primary rounded hover:bg-vibe-primary/30 transition-colors"
        >
          + Add Symbol
        </button>
      </div>

      {/* Header row */}
      {symbols.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-vibe-muted uppercase tracking-wider">
          <span className="w-8 text-center">Icon</span>
          <span className="flex-1">Name</span>
          <span className="w-10 text-center">Wild</span>
          <span className="w-14 text-right">Weight</span>
          <span className="w-16 text-right">Chance</span>
          <span className="w-20" />
        </div>
      )}

      {/* Symbol list — sorted by weight ascending (rarest first) */}
      <div className="space-y-1.5">
        {symbols.map((sym) => (
          <div key={sym.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${sym.enabled ? 'bg-vibe-bg border-vibe-border' : 'bg-vibe-bg/50 border-vibe-border/50 opacity-60'}`}>
            <span className="w-8 text-center text-lg">{sym.emoji}</span>
            <span className="flex-1 text-xs text-vibe-text font-medium">{sym.name}</span>
            <span className="w-10 text-center">
              {sym.is_wild && <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded-full font-bold border border-purple-500/30">W</span>}
            </span>
            <span className="w-14 text-right text-xs font-mono text-vibe-muted">{sym.weight}</span>
            <span className={`w-16 text-right text-xs font-mono ${sym.enabled ? 'text-vibe-primary' : 'text-vibe-muted'}`}>
              {sym.enabled ? getChanceDisplay(sym.weight) : 'off'}
            </span>
            <div className="w-20 flex items-center justify-end gap-1">
              <button onClick={() => handleToggle(sym)} className={`w-7 h-4 rounded-full flex-shrink-0 transition-colors relative ${sym.enabled ? 'bg-vibe-primary' : 'bg-vibe-border'}`}>
                <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform ${sym.enabled ? 'left-3.5' : 'left-0.5'}`} />
              </button>
              <button onClick={() => handleEdit(sym)} className="text-xs text-vibe-muted hover:text-vibe-text flex-shrink-0">{'\u270F\uFE0F'}</button>
              <button onClick={() => handleDelete(sym.id)} className="text-xs text-red-400 hover:text-red-300 flex-shrink-0">{'\u2715'}</button>
            </div>
          </div>
        ))}
        {symbols.length === 0 && (
          <p className="text-xs text-vibe-muted text-center py-4">No symbols configured. Click "+ Add Symbol" to create one.</p>
        )}
      </div>

      {/* Probability summary bar */}
      {symbols.filter(s => s.enabled).length > 0 && (
        <div className="space-y-1">
          <div className="flex h-3 rounded-full overflow-hidden bg-vibe-border/30">
            {symbols.filter(s => s.enabled).map((sym) => (
              <div
                key={sym.id}
                className="h-full flex items-center justify-center text-[8px] font-bold text-white overflow-hidden"
                style={{
                  width: `${(sym.weight / totalWeight) * 100}%`,
                  backgroundColor: `hsl(${(sym.sort_order * 47) % 360}, 60%, 50%)`,
                  minWidth: sym.weight / totalWeight > 0.03 ? undefined : '4px',
                }}
                title={`${sym.emoji} ${sym.name}: ${((sym.weight / totalWeight) * 100).toFixed(1)}%`}
              >
                {sym.weight / totalWeight > 0.06 ? sym.emoji : ''}
              </div>
            ))}
          </div>
          <p className="text-[10px] text-vibe-muted text-center">
            Total weight: {totalWeight} across {symbols.filter(s => s.enabled).length} symbols
          </p>
        </div>
      )}

      {/* Add/Edit form */}
      {showAdd && (
        <div className="space-y-3 p-3 rounded-lg border border-vibe-primary/30 bg-vibe-primary/5">
          <h5 className="text-xs font-semibold text-vibe-primary">{editId ? 'Edit Symbol' : 'New Symbol'}</h5>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-vibe-muted block mb-1">Name</label>
              <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="e.g. diamond" className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted" />
            </div>
            <div className="w-20">
              <label className="text-xs text-vibe-muted block mb-1">Emoji</label>
              <input type="text" value={formEmoji} onChange={(e) => setFormEmoji(e.target.value)} placeholder="💎" className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text text-center" />
            </div>
            <div className="w-24">
              <label className="text-xs text-vibe-muted block mb-1">Weight</label>
              <input type="number" min={1} max={9999} value={formWeight} onChange={(e) => setFormWeight(Math.max(1, parseInt(e.target.value) || 1))} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text" />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <div className="relative">
              <input type="checkbox" checked={formIsWild} onChange={(e) => setFormIsWild(e.target.checked)} className="sr-only peer" />
              <div className="w-8 h-4 bg-vibe-border rounded-full peer-checked:bg-purple-500 transition-colors" />
              <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4" />
            </div>
            <span className="text-xs text-vibe-text">Wild Symbol</span>
            <span className="text-[10px] text-vibe-muted">(matches any other symbol)</span>
          </label>
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-vibe-muted">
              {formWeight > 0 && totalWeight > 0 && `Estimated chance: ~${getChanceDisplay(formWeight)} (${((formWeight / (totalWeight + (editId ? 0 : formWeight))) * 100).toFixed(1)}%)`}
            </p>
            <div className="flex gap-2">
              <button onClick={resetForm} className="text-xs px-3 py-1.5 text-vibe-muted hover:text-vibe-text transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={!formName.trim() || !formEmoji.trim()} className="text-xs px-3 py-1.5 bg-vibe-primary text-white rounded hover:bg-vibe-primary/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">{editId ? 'Save' : 'Add'}</button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function PayTableSection() {
  const [entries, setEntries] = useState<PayTableEntry[]>([])
  const [dynamicSymbols, setDynamicSymbols] = useState<SlotSymbol[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formMatchType, setFormMatchType] = useState('triple_specific')
  const [formSymbol, setFormSymbol] = useState('seven')
  const [formPrizeType, setFormPrizeType] = useState('points')
  const [formPoints, setFormPoints] = useState(100)
  const [formPrizeName, setFormPrizeName] = useState('')
  const [formPrizeDesc, setFormPrizeDesc] = useState('')
  const [formPriority, setFormPriority] = useState(100)
  const [formFreeSpins, setFormFreeSpins] = useState(0)

  const loadEntries = async () => {
    try {
      const data = await invoke<PayTableEntry[]>('youtube_list_paytable')
      setEntries(data)
    } catch { /* ignore */ }
  }

  const loadDynamicSymbols = async () => {
    try {
      const data = await invoke<SlotSymbol[]>('youtube_list_all_slot_symbols')
      setDynamicSymbols(data)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadEntries(); loadDynamicSymbols() }, [])

  // Build emoji map from dynamic symbols, with fallback
  const symbolEmojiMap: Record<string, string> = { ...FALLBACK_SYMBOL_EMOJIS }
  for (const sym of dynamicSymbols) {
    symbolEmojiMap[sym.name] = sym.emoji
  }

  const resetForm = () => {
    setFormMatchType('triple_specific')
    setFormSymbol('seven')
    setFormPrizeType('points')
    setFormPoints(100)
    setFormPrizeName('')
    setFormPrizeDesc('')
    setFormPriority(100)
    setFormFreeSpins(0)
    setShowAdd(false)
    setEditId(null)
  }

  const handleSave = async () => {
    try {
      if (editId) {
        await invoke('youtube_update_paytable_entry', {
          id: editId,
          priority: formPriority,
          matchType: formMatchType,
          symbol: formMatchType === 'triple_specific' ? formSymbol : null,
          prizeType: formPrizeType,
          pointsAmount: formPoints,
          prizeName: formPrizeName || null,
          prizeDescription: formPrizeDesc || null,
          freeSpinsAwarded: formFreeSpins,
        })
      } else {
        await invoke('youtube_create_paytable_entry', {
          priority: formPriority,
          matchType: formMatchType,
          symbol: formMatchType === 'triple_specific' ? formSymbol : null,
          prizeType: formPrizeType,
          pointsAmount: formPoints,
          prizeName: formPrizeName || null,
          prizeDescription: formPrizeDesc || null,
          freeSpinsAwarded: formFreeSpins,
        })
      }
      resetForm()
      loadEntries()
    } catch { /* ignore */ }
  }

  const handleEdit = (entry: PayTableEntry) => {
    setEditId(entry.id)
    setFormMatchType(entry.match_type)
    setFormSymbol(entry.symbol || 'seven')
    setFormPrizeType(entry.prize_type)
    setFormPoints(entry.points_amount)
    setFormPrizeName(entry.prize_name || '')
    setFormPrizeDesc(entry.prize_description || '')
    setFormPriority(entry.priority)
    setFormFreeSpins(entry.free_spins_awarded || 0)
    setShowAdd(true)
  }

  const handleDelete = async (id: string) => {
    try {
      await invoke('youtube_delete_paytable_entry', { id })
      loadEntries()
    } catch { /* ignore */ }
  }

  const handleToggle = async (entry: PayTableEntry) => {
    try {
      await invoke('youtube_update_paytable_entry', { id: entry.id, enabled: !entry.enabled })
      loadEntries()
    } catch { /* ignore */ }
  }

  return (
    <SectionCard title="Pay Table" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-vibe-muted">Configure prizes for different symbol combinations</p>
        <button
          onClick={() => { resetForm(); setShowAdd(true) }}
          className="text-xs px-2 py-1 bg-vibe-primary/20 text-vibe-primary rounded hover:bg-vibe-primary/30 transition-colors"
        >
          + Add Entry
        </button>
      </div>

      {/* Entry list */}
      <div className="space-y-1.5">
        {entries.map((entry) => (
          <div key={entry.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${entry.enabled ? 'bg-vibe-bg border-vibe-border' : 'bg-vibe-bg/50 border-vibe-border/50 opacity-60'}`}>
            <span className="text-[10px] font-mono text-vibe-muted w-5 text-right">{entry.priority}</span>
            <span className="text-base flex-shrink-0">{entry.symbol ? symbolEmojiMap[entry.symbol] || entry.symbol : '\u2728'}</span>
            <div className="flex-1 min-w-0">
              <span className="text-xs text-vibe-text font-medium truncate block">{entry.prize_name || MATCH_TYPE_LABELS[entry.match_type] || entry.match_type}</span>
              <span className="text-[10px] text-vibe-muted">{MATCH_TYPE_LABELS[entry.match_type] || entry.match_type}</span>
            </div>
            <span className="text-xs font-mono text-vibe-text flex-shrink-0">
              {entry.prize_type === 'real' ? '\uD83C\uDF81 Real' : `${entry.points_amount}x`}
            </span>
            <button onClick={() => handleToggle(entry)} className={`w-7 h-4 rounded-full flex-shrink-0 transition-colors relative ${entry.enabled ? 'bg-vibe-primary' : 'bg-vibe-border'}`}>
              <div className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform ${entry.enabled ? 'left-3.5' : 'left-0.5'}`} />
            </button>
            <button onClick={() => handleEdit(entry)} className="text-xs text-vibe-muted hover:text-vibe-text flex-shrink-0">\u270F\uFE0F</button>
            <button onClick={() => handleDelete(entry.id)} className="text-xs text-red-400 hover:text-red-300 flex-shrink-0">\u2715</button>
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs text-vibe-muted text-center py-4">No pay table entries. Click "+ Add Entry" to create one.</p>
        )}
      </div>

      {/* Add/Edit form */}
      {showAdd && (
        <div className="space-y-3 p-3 rounded-lg border border-vibe-primary/30 bg-vibe-primary/5">
          <h5 className="text-xs font-semibold text-vibe-primary">{editId ? 'Edit Entry' : 'New Entry'}</h5>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-vibe-muted block mb-1">Match Type</label>
              <select value={formMatchType} onChange={(e) => setFormMatchType(e.target.value)} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text">
                <option value="triple_specific">Triple Specific</option>
                <option value="triple_any">Any Triple</option>
                <option value="partial">Partial Match</option>
              </select>
            </div>
            {formMatchType === 'triple_specific' && (
              <div className="flex-1">
                <label className="text-xs text-vibe-muted block mb-1">Symbol</label>
                <select value={formSymbol} onChange={(e) => setFormSymbol(e.target.value)} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text">
                  {dynamicSymbols.length > 0
                    ? dynamicSymbols.map((sym) => (
                        <option key={sym.name} value={sym.name}>{sym.emoji} {sym.name}</option>
                      ))
                    : Object.entries(FALLBACK_SYMBOL_EMOJIS).map(([key, emoji]) => (
                        <option key={key} value={key}>{emoji} {key}</option>
                      ))
                  }
                </select>
              </div>
            )}
            <div className="w-20">
              <label className="text-xs text-vibe-muted block mb-1">Priority</label>
              <input type="number" min={1} max={999} value={formPriority} onChange={(e) => setFormPriority(Math.max(1, parseInt(e.target.value) || 1))} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text" />
            </div>
          </div>
          <div className="flex gap-3">
            <div>
              <label className="text-xs text-vibe-muted block mb-1">Prize Type</label>
              <div className="flex gap-2">
                <label className="flex items-center gap-1.5 text-xs text-vibe-text cursor-pointer">
                  <input type="radio" name="prizeType" checked={formPrizeType === 'points'} onChange={() => setFormPrizeType('points')} className="accent-vibe-primary" /> Points
                </label>
                <label className="flex items-center gap-1.5 text-xs text-vibe-text cursor-pointer">
                  <input type="radio" name="prizeType" checked={formPrizeType === 'real'} onChange={() => setFormPrizeType('real')} className="accent-vibe-primary" /> Real Prize
                </label>
              </div>
            </div>
            <div className="flex-1">
              <label className="text-xs text-vibe-muted block mb-1">Multiplier (x pull cost)</label>
              <input type="number" min={0} max={99999} value={formPoints} onChange={(e) => setFormPoints(Math.max(0, parseInt(e.target.value) || 0))} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text" />
            </div>
            <div className="w-28">
              <label className="text-xs text-vibe-muted block mb-1">Free Spins</label>
              <input type="number" min={0} max={50} value={formFreeSpins} onChange={(e) => setFormFreeSpins(Math.max(0, parseInt(e.target.value) || 0))} className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text" />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-vibe-muted block mb-1">Prize Name</label>
              <input type="text" value={formPrizeName} onChange={(e) => setFormPrizeName(e.target.value)} placeholder="e.g. Triple Sevens" className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted" />
            </div>
            {formPrizeType === 'real' && (
              <div className="flex-1">
                <label className="text-xs text-vibe-muted block mb-1">Description</label>
                <input type="text" value={formPrizeDesc} onChange={(e) => setFormPrizeDesc(e.target.value)} placeholder="Prize description" className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted" />
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={resetForm} className="text-xs px-3 py-1.5 text-vibe-muted hover:text-vibe-text transition-colors">Cancel</button>
            <button onClick={handleSave} className="text-xs px-3 py-1.5 bg-vibe-primary text-white rounded hover:bg-vibe-primary/80 transition-colors">{editId ? 'Save' : 'Add'}</button>
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function PrizeLogSection() {
  const [entries, setEntries] = useState<PrizeLogEntry[]>([])
  const [filter, setFilter] = useState<'all' | 'unredeemed' | 'redeemed'>('all')
  const [unredeemedCount, setUnredeemedCount] = useState(0)
  const [redeemingId, setRedeemingId] = useState<string | null>(null)
  const [redeemNote, setRedeemNote] = useState('')

  const loadEntries = async () => {
    try {
      const unredeemedOnly = filter === 'unredeemed'
      const data = await invoke<PrizeLogEntry[]>('youtube_list_prize_log', {
        limit: 100, offset: 0, unredeemedOnly,
      })
      const filtered = filter === 'redeemed' ? data.filter(e => e.redeemed) : data
      setEntries(filtered)
    } catch { /* ignore */ }
  }

  const loadCount = async () => {
    try {
      const count = await invoke<number>('youtube_count_unredeemed_prizes')
      setUnredeemedCount(count)
    } catch { /* ignore */ }
  }

  useEffect(() => { loadEntries(); loadCount() }, [filter])

  const handleRedeem = async (id: string) => {
    try {
      await invoke('youtube_mark_prize_redeemed', { id, note: redeemNote || null })
      setRedeemingId(null)
      setRedeemNote('')
      loadEntries()
      loadCount()
    } catch { /* ignore */ }
  }

  return (
    <SectionCard title="Prize Log" icon={
      <div className="flex items-center gap-2">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" /></svg>
        {unredeemedCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full font-bold border border-red-500/30">
            {unredeemedCount} unredeemed
          </span>
        )}
      </div>
    }>
      <div className="flex gap-1 justify-end">
        {(['all', 'unredeemed', 'redeemed'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === f ? 'bg-vibe-primary/20 text-vibe-primary' : 'text-vibe-muted hover:text-vibe-text'}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
        {entries.map((entry) => (
          <div key={entry.id} className={`px-3 py-2 rounded-lg border ${entry.redeemed ? 'bg-green-500/5 border-green-500/20' : 'bg-vibe-bg border-vibe-border'}`}>
            <div className="flex items-center gap-2">
              <span className="text-base flex-shrink-0">{entry.prize_type === 'real' ? '\uD83C\uDF81' : '\uD83D\uDCB0'}</span>
              <div className="flex-1 min-w-0">
                <span className="text-xs text-vibe-text font-medium truncate block">{entry.author_name}</span>
                <span className="text-[10px] text-vibe-muted">{entry.prize_name || `${entry.points_awarded} pts`}</span>
              </div>
              <span className="text-[10px] text-vibe-muted flex-shrink-0">{new Date(entry.created_at).toLocaleDateString()}</span>
              {entry.redeemed ? (
                <span className="text-[10px] text-green-400 flex-shrink-0">\u2713 Redeemed</span>
              ) : entry.prize_type === 'real' && (
                redeemingId === entry.id ? (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <input
                      type="text"
                      value={redeemNote}
                      onChange={(e) => setRedeemNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-24 bg-vibe-bg border border-vibe-border rounded px-1.5 py-0.5 text-[10px] text-vibe-text"
                    />
                    <button onClick={() => handleRedeem(entry.id)} className="text-[10px] px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded hover:bg-green-500/30">\u2713</button>
                    <button onClick={() => { setRedeemingId(null); setRedeemNote('') }} className="text-[10px] px-1.5 py-0.5 text-vibe-muted hover:text-vibe-text">\u2715</button>
                  </div>
                ) : (
                  <button onClick={() => setRedeemingId(entry.id)} className="text-[10px] px-2 py-0.5 bg-vibe-primary/20 text-vibe-primary rounded hover:bg-vibe-primary/30 flex-shrink-0">
                    Mark Redeemed
                  </button>
                )
              )}
            </div>
            {entry.redeemed && entry.redeemed_note && (
              <p className="text-[10px] text-green-400/60 mt-1 ml-7">Note: {entry.redeemed_note}</p>
            )}
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs text-vibe-muted text-center py-4">No prize log entries yet.</p>
        )}
      </div>
    </SectionCard>
  )
}

function SlotsTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [slotEnabled, setSlotEnabled] = useState(settings?.slot_enabled ?? true)
  const [slotPrefix, setSlotPrefix] = useState(settings?.slot_command_prefix || '!pull')
  const [slotCooldown, setSlotCooldown] = useState(settings?.slot_cooldown_secs ?? 30)
  const [slotPullCost, setSlotPullCost] = useState(settings?.slot_pull_cost ?? 10)
  const [slotJackpotBonus, setSlotJackpotBonus] = useState(settings?.slot_jackpot_bonus ?? 50)
  const [progressiveEnabled, setProgressiveEnabled] = useState(settings?.progressive_jackpot_enabled ?? false)
  const [progressiveContribution, setProgressiveContribution] = useState(settings?.progressive_contribution_pct ?? 10)
  const [progressiveSeed, setProgressiveSeed] = useState(settings?.progressive_seed_amount ?? 100)
  const [statsEnabled, setStatsEnabled] = useState(settings?.slot_stats_enabled ?? true)
  const [symbolOfDayEnabled, setSymbolOfDayEnabled] = useState(settings?.slot_symbol_of_day_enabled ?? false)
  const [symbolOfDayMultiplier, setSymbolOfDayMultiplier] = useState(settings?.slot_symbol_of_day_multiplier ?? 2)
  const [luckyHourEnabled, setLuckyHourEnabled] = useState(settings?.slot_lucky_hour_enabled ?? false)
  const [luckyHourStart, setLuckyHourStart] = useState(settings?.slot_lucky_hour_start ?? '20:00')
  const [luckyHourEnd, setLuckyHourEnd] = useState(settings?.slot_lucky_hour_end ?? '21:00')
  const [luckyHourBoost, setLuckyHourBoost] = useState(settings?.slot_lucky_hour_boost ?? 50)

  useEffect(() => {
    setSlotEnabled(settings?.slot_enabled ?? true)
    setSlotPrefix(settings?.slot_command_prefix || '!pull')
    setSlotCooldown(settings?.slot_cooldown_secs ?? 30)
    setSlotPullCost(settings?.slot_pull_cost ?? 10)
    setSlotJackpotBonus(settings?.slot_jackpot_bonus ?? 50)
    setProgressiveEnabled(settings?.progressive_jackpot_enabled ?? false)
    setProgressiveContribution(settings?.progressive_contribution_pct ?? 10)
    setProgressiveSeed(settings?.progressive_seed_amount ?? 100)
    setStatsEnabled(settings?.slot_stats_enabled ?? true)
    setSymbolOfDayEnabled(settings?.slot_symbol_of_day_enabled ?? false)
    setSymbolOfDayMultiplier(settings?.slot_symbol_of_day_multiplier ?? 2)
    setLuckyHourEnabled(settings?.slot_lucky_hour_enabled ?? false)
    setLuckyHourStart(settings?.slot_lucky_hour_start ?? '20:00')
    setLuckyHourEnd(settings?.slot_lucky_hour_end ?? '21:00')
    setLuckyHourBoost(settings?.slot_lucky_hour_boost ?? 50)
  }, [settings])

  return (
    <div className="space-y-6">
      {/* Enable / Command */}
      <SectionCard title="Slot Machine" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 15.536c-1.171 1.952-3.07 1.952-4.242 0-1.172-1.953-1.172-5.119 0-7.072 1.171-1.952 3.07-1.952 4.242 0M8 10.5h4m-4 3h4m9-1.5a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}>
        <Toggle
          checked={slotEnabled}
          onChange={(checked) => {
            setSlotEnabled(checked)
            saveField({ slot_enabled: checked }, 'slot')
          }}
          label="Enable Slot Machine"
          description="Allow viewers to pull the slot machine"
        />

        {slotEnabled && (
          <>
            <TextInput
              label="Command Prefix"
              value={slotPrefix}
              onChange={(v) => {
                setSlotPrefix(v)
                debouncedSave('slotPrefix', { slot_command_prefix: v }, 'slot prefix')
              }}
              onBlur={() => flushDebounce('slotPrefix')}
              placeholder="!pull"
              description={`Viewers type "${slotPrefix}" in chat to pull`}
            />
            <NumberInput
              label="Cooldown (seconds)"
              value={slotCooldown}
              onChange={(v) => {
                setSlotCooldown(v)
                debouncedSave('slotCooldown', { slot_cooldown_secs: Math.min(300, v) }, 'slot cooldown')
              }}
              onBlur={() => flushDebounce('slotCooldown')}
              min={0}
              max={300}
              description="Per-user cooldown between pulls (0 = no cooldown)"
            />
          </>
        )}
      </SectionCard>

      {/* Costs */}
      {slotEnabled && (
        <>
          <SectionCard title="Costs & Rewards" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="Pull Cost"
                value={slotPullCost}
                onChange={(v) => {
                  setSlotPullCost(v)
                  debouncedSave('slotPullCost', { slot_pull_cost: Math.min(1000, v) }, 'pull cost')
                }}
                onBlur={() => flushDebounce('slotPullCost')}
                min={0}
                max={1000}
                description="Points deducted per pull (payouts are multiples of this)"
              />
              <NumberInput
                label="Jackpot Fallback (x)"
                value={slotJackpotBonus}
                onChange={(v) => {
                  setSlotJackpotBonus(v)
                  debouncedSave('slotJackpotBonus', { slot_jackpot_bonus: Math.min(10000, v) }, 'jackpot')
                }}
                onBlur={() => flushDebounce('slotJackpotBonus')}
                min={0}
                max={10000}
                description="Multiplier of pull cost if no pay table match"
              />
            </div>
          </SectionCard>

          {/* Progressive Jackpot */}
          <SectionCard title="Progressive Jackpot" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>}>
            <Toggle
              checked={progressiveEnabled}
              onChange={(checked) => {
                setProgressiveEnabled(checked)
                saveField({ progressive_jackpot_enabled: checked }, 'progressive jackpot')
              }}
              label="Enable Progressive Jackpot"
              description="A growing prize pool funded by a % of each pull cost"
            />
            {progressiveEnabled && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <NumberInput
                  label="Contribution %"
                  value={progressiveContribution}
                  onChange={(v) => {
                    setProgressiveContribution(v)
                    debouncedSave('progressiveContribution', { progressive_contribution_pct: Math.min(100, v) }, 'progressive contribution')
                  }}
                  onBlur={() => flushDebounce('progressiveContribution')}
                  min={1}
                  max={100}
                  description="% of pull cost added to jackpot pool"
                />
                <NumberInput
                  label="Seed Amount"
                  value={progressiveSeed}
                  onChange={(v) => {
                    setProgressiveSeed(v)
                    debouncedSave('progressiveSeed', { progressive_seed_amount: Math.min(10000, v) }, 'progressive seed')
                  }}
                  onBlur={() => flushDebounce('progressiveSeed')}
                  min={0}
                  max={10000}
                  description="Pool resets to this after payout"
                />
              </div>
            )}
          </SectionCard>

          {/* Symbol of the Day */}
          <SectionCard title="Symbol of the Day" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>}>
            <Toggle
              checked={symbolOfDayEnabled}
              onChange={(checked) => {
                setSymbolOfDayEnabled(checked)
                saveField({ slot_symbol_of_day_enabled: checked }, 'symbol of the day')
              }}
              label="Enable Symbol of the Day"
              description="One random symbol gets a payout multiplier each day"
            />
            {symbolOfDayEnabled && (
              <div className="mt-3">
                <NumberInput
                  label="Multiplier"
                  value={symbolOfDayMultiplier}
                  onChange={(v) => {
                    setSymbolOfDayMultiplier(v)
                    debouncedSave('symbolOfDayMultiplier', { slot_symbol_of_day_multiplier: Math.min(10, v) }, 'symbol of day multiplier')
                  }}
                  onBlur={() => flushDebounce('symbolOfDayMultiplier')}
                  min={2}
                  max={10}
                  description="Payout multiplier for the daily symbol"
                />
              </div>
            )}
          </SectionCard>

          {/* Lucky Hour */}
          <SectionCard title="Lucky Hour" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}>
            <Toggle
              checked={luckyHourEnabled}
              onChange={(checked) => {
                setLuckyHourEnabled(checked)
                saveField({ slot_lucky_hour_enabled: checked }, 'lucky hour')
              }}
              label="Enable Lucky Hour"
              description="Time windows where rare symbols get boosted weight"
            />
            {luckyHourEnabled && (
              <div className="space-y-3 mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <TextInput
                    label="Start Time"
                    value={luckyHourStart}
                    onChange={(v) => {
                      setLuckyHourStart(v)
                      debouncedSave('luckyHourStart', { slot_lucky_hour_start: v }, 'lucky hour start')
                    }}
                    onBlur={() => flushDebounce('luckyHourStart')}
                    placeholder="20:00"
                    description="24h format (HH:MM)"
                  />
                  <TextInput
                    label="End Time"
                    value={luckyHourEnd}
                    onChange={(v) => {
                      setLuckyHourEnd(v)
                      debouncedSave('luckyHourEnd', { slot_lucky_hour_end: v }, 'lucky hour end')
                    }}
                    onBlur={() => flushDebounce('luckyHourEnd')}
                    placeholder="21:00"
                    description="24h format (HH:MM)"
                  />
                </div>
                <NumberInput
                  label="Rare Symbol Boost %"
                  value={luckyHourBoost}
                  onChange={(v) => {
                    setLuckyHourBoost(v)
                    debouncedSave('luckyHourBoost', { slot_lucky_hour_boost: Math.min(200, v) }, 'lucky hour boost')
                  }}
                  onBlur={() => flushDebounce('luckyHourBoost')}
                  min={10}
                  max={200}
                  description="% weight boost for rare symbols during lucky hour"
                />
              </div>
            )}
          </SectionCard>

          {/* Stats Panel */}
          <SectionCard title="Stats Panel" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}>
            <Toggle
              checked={statsEnabled}
              onChange={(checked) => {
                setStatsEnabled(checked)
                saveField({ slot_stats_enabled: checked }, 'stats panel')
              }}
              label="Enable Stats Panel"
              description="Show slot machine statistics overlay (hit rates, odds, biggest wins)"
            />
          </SectionCard>

          {/* Slot Symbols */}
          <SlotSymbolsSection onSymbolsChanged={() => { /* PayTable will re-fetch on its own */ }} />

          {/* Pay Table */}
          <PayTableSection />

          {/* Prize Log */}
          <PrizeLogSection />
        </>
      )}
    </div>
  )
}

// ---- Display Tab ----
function DisplayTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [ttsEnabled, setTtsEnabled] = useState(settings?.tts_enabled ?? false)
  const [ttsMode, setTtsMode] = useState<'name_only' | 'full'>((settings?.tts_mode as 'name_only' | 'full') || 'name_only')
  const [alertsEnabled, setAlertsEnabled] = useState(settings?.alerts_enabled ?? true)
  const [alertDuration, setAlertDuration] = useState(settings?.alert_duration_secs ?? 5)
  const [tabAutoCycle, setTabAutoCycle] = useState(settings?.tab_auto_cycle ?? false)
  const [cycleInterval, setCycleInterval] = useState(settings?.tab_cycle_interval_secs ?? 15)
  const [cycleAutoResume, setCycleAutoResume] = useState(settings?.cycle_auto_resume_secs ?? 30)

  useEffect(() => {
    setTtsEnabled(settings?.tts_enabled ?? false)
    setTtsMode((settings?.tts_mode as 'name_only' | 'full') || 'name_only')
    setAlertsEnabled(settings?.alerts_enabled ?? true)
    setAlertDuration(settings?.alert_duration_secs ?? 5)
    setTabAutoCycle(settings?.tab_auto_cycle ?? false)
    setCycleInterval(settings?.tab_cycle_interval_secs ?? 15)
    setCycleAutoResume(settings?.cycle_auto_resume_secs ?? 30)
  }, [settings])

  return (
    <div className="space-y-6">
      {/* Text-to-Speech */}
      <SectionCard title="Text-to-Speech" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>}>
        <Toggle
          checked={ttsEnabled}
          onChange={(checked) => {
            setTtsEnabled(checked)
            saveField({ tts_enabled: checked }, 'TTS')
          }}
          label="Enable TTS"
          description="Announce new ideas with speech synthesis"
        />

        {ttsEnabled && (
          <div className="space-y-3 pl-12">
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ttsMode"
                  checked={ttsMode === 'name_only'}
                  onChange={() => {
                    setTtsMode('name_only')
                    saveField({ tts_mode: 'name_only' }, 'TTS mode')
                  }}
                  className="accent-[var(--color-accent)]"
                />
                <span className="text-sm text-vibe-text">Announce name only</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="ttsMode"
                  checked={ttsMode === 'full'}
                  onChange={() => {
                    setTtsMode('full')
                    saveField({ tts_mode: 'full' }, 'TTS mode')
                  }}
                  className="accent-[var(--color-accent)]"
                />
                <span className="text-sm text-vibe-text">Read full idea</span>
              </label>
            </div>
            <p className="text-xs text-vibe-muted italic">
              {ttsMode === 'full' ? '"Viewer123 says: Add dark mode support"' : '"Viewer123 submitted an idea"'}
            </p>
            <button
              onClick={() => {
                const text = ttsMode === 'full' ? 'Viewer123 says: Add dark mode support' : 'Viewer123 submitted an idea'
                speechSynthesis.speak(new SpeechSynthesisUtterance(text))
              }}
              className="px-3 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary text-vibe-text transition-colors"
            >
              Test TTS
            </button>
          </div>
        )}
      </SectionCard>

      {/* Alerts */}
      <SectionCard title="Stream Alerts" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>}>
        <Toggle
          checked={alertsEnabled}
          onChange={(checked) => {
            setAlertsEnabled(checked)
            saveField({ alerts_enabled: checked }, 'alerts')
          }}
          label="Enable Alerts"
          description="Show alerts for super chats, memberships, etc."
        />

        {alertsEnabled && (
          <NumberInput
            label="Alert Duration (seconds)"
            value={alertDuration}
            onChange={(v) => {
              setAlertDuration(v)
              debouncedSave('alertDuration', { alert_duration_secs: Math.min(30, v) }, 'alert duration')
            }}
            onBlur={() => flushDebounce('alertDuration')}
            min={1}
            max={30}
          />
        )}
      </SectionCard>

      {/* Tab Cycling */}
      <SectionCard title="Tab Auto-Cycle" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}>
        <Toggle
          checked={tabAutoCycle}
          onChange={(checked) => {
            setTabAutoCycle(checked)
            saveField({ tab_auto_cycle: checked }, 'auto-cycle')
          }}
          label="Enable Auto-Cycle"
          description="Automatically cycle through tabs"
        />

        {tabAutoCycle && (
          <div className="grid grid-cols-2 gap-3">
            <NumberInput
              label="Cycle Interval (seconds)"
              value={cycleInterval}
              onChange={(v) => {
                setCycleInterval(v)
                debouncedSave('cycleInterval', { tab_cycle_interval_secs: Math.max(5, v) }, 'cycle interval')
              }}
              onBlur={() => flushDebounce('cycleInterval')}
              min={5}
              max={120}
            />
            <NumberInput
              label="Auto-Resume After (seconds)"
              value={cycleAutoResume}
              onChange={(v) => {
                setCycleAutoResume(v)
                debouncedSave('cycleAutoResume', { cycle_auto_resume_secs: Math.max(10, v) }, 'auto-resume')
              }}
              onBlur={() => flushDebounce('cycleAutoResume')}
              min={10}
              max={300}
            />
          </div>
        )}
      </SectionCard>
    </div>
  )
}

function QuotaSyncInput({ onSync }: { onSync: (units: number) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [syncing, setSyncing] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary text-vibe-text transition-colors"
      >
        Sync with Console
      </button>
    )
  }

  const handleSync = async () => {
    const units = parseInt(value)
    if (isNaN(units) || units < 0) return
    setSyncing(true)
    try {
      await onSync(units)
      setOpen(false)
      setValue('')
    } catch { /* ignore */ }
    setSyncing(false)
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        max={100000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSync(); if (e.key === 'Escape') { setOpen(false); setValue('') } }}
        placeholder="Units used"
        autoFocus
        className="w-24 bg-vibe-bg border border-vibe-border rounded px-2 py-1 text-xs text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary"
      />
      <button
        onClick={handleSync}
        disabled={syncing || !value || parseInt(value) < 0}
        className="px-2 py-1 text-xs bg-vibe-primary text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {syncing ? '...' : 'Set'}
      </button>
      <button
        onClick={() => { setOpen(false); setValue('') }}
        className="px-1.5 py-1 text-xs text-vibe-muted hover:text-vibe-text transition-colors"
      >
        &times;
      </button>
    </div>
  )
}

// ---- API & Stats Tab ----
function ApiStatsTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [videoStatsEnabled, setVideoStatsEnabled] = useState(settings?.video_stats_enabled ?? true)
  const [videoStatsInterval, setVideoStatsInterval] = useState(settings?.video_stats_interval_secs ?? 60)
  const [channelStatsEnabled, setChannelStatsEnabled] = useState(settings?.channel_stats_enabled ?? true)
  const [channelStatsInterval, setChannelStatsInterval] = useState(settings?.channel_stats_interval_secs ?? 300)
  const [subscribersEnabled, setSubscribersEnabled] = useState(settings?.subscribers_enabled ?? false)
  const [subscribersPollInterval, setSubscribersPollInterval] = useState(settings?.subscribers_poll_interval_secs ?? 60)

  // Adaptive polling
  const [adaptiveEnabled, setAdaptiveEnabled] = useState(settings?.adaptive_polling_enabled ?? true)
  const [idleThreshold, setIdleThreshold] = useState(settings?.idle_threshold_polls ?? 5)
  const [veryIdleThreshold, setVeryIdleThreshold] = useState(settings?.very_idle_threshold_polls ?? 10)
  const [channelSkipThreshold, setChannelSkipThreshold] = useState(settings?.channel_skip_threshold ?? 5)
  const [maxPollInterval, setMaxPollInterval] = useState(Math.round((settings?.max_poll_interval_ms ?? 60000) / 1000))

  // Quota
  const [quota, setQuota] = useState<YouTubeQuotaUsage | null>(null)
  const [breakdown, setBreakdown] = useState<QuotaBreakdown | null>(null)

  useEffect(() => {
    setVideoStatsEnabled(settings?.video_stats_enabled ?? true)
    setVideoStatsInterval(settings?.video_stats_interval_secs ?? 60)
    setChannelStatsEnabled(settings?.channel_stats_enabled ?? true)
    setChannelStatsInterval(settings?.channel_stats_interval_secs ?? 300)
    setSubscribersEnabled(settings?.subscribers_enabled ?? false)
    setSubscribersPollInterval(settings?.subscribers_poll_interval_secs ?? 60)
    setAdaptiveEnabled(settings?.adaptive_polling_enabled ?? true)
    setIdleThreshold(settings?.idle_threshold_polls ?? 5)
    setVeryIdleThreshold(settings?.very_idle_threshold_polls ?? 10)
    setChannelSkipThreshold(settings?.channel_skip_threshold ?? 5)
    setMaxPollInterval(Math.round((settings?.max_poll_interval_ms ?? 60000) / 1000))
  }, [settings])

  useEffect(() => {
    const load = () => {
      invoke<YouTubeQuotaUsage>('youtube_get_quota').then(setQuota).catch(() => {})
      invoke<QuotaBreakdown>('youtube_get_quota_breakdown').then(setBreakdown).catch(() => {})
    }
    load()
    const interval = setInterval(load, 10000)
    return () => clearInterval(interval)
  }, [])

  const quotaPercent = quota ? Math.round((quota.units_used / quota.daily_limit) * 100) : 0

  return (
    <div className="space-y-6">
      {/* Quota Usage */}
      <SectionCard title="API Quota" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}>
        {quota && (
          <div className="space-y-3">
            {/* Total usage bar */}
            <div className="flex justify-between text-sm">
              <span className="text-vibe-muted">Daily Usage</span>
              <span className="text-vibe-text">{quota.units_used.toLocaleString()} / {quota.daily_limit.toLocaleString()} units</span>
            </div>
            <div className="h-2.5 bg-vibe-bg rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${quotaPercent > 80 ? 'bg-red-500' : quotaPercent > 50 ? 'bg-yellow-500' : 'bg-green-500'}`}
                style={{ width: `${Math.min(100, quotaPercent)}%` }}
              />
            </div>

            {/* Summary row */}
            <div className="flex items-center justify-between text-xs text-vibe-muted">
              <span>{quota.requests_made} API calls made</span>
              <span>{quota.remaining.toLocaleString()} units remaining</span>
            </div>

            {/* Per-endpoint breakdown */}
            {breakdown && (
              <div className="space-y-2 pt-1">
                <p className="text-xs font-medium text-vibe-text">Usage by Endpoint</p>
                {[
                  { label: 'Chat Polling', units: breakdown.chat_polls, projected: breakdown.projected_daily_chat, cost: '5 units/call', color: 'bg-blue-500' },
                  { label: 'Video Stats', units: breakdown.video_stats_polls, projected: breakdown.projected_daily_video, cost: '1 unit/call', color: 'bg-purple-500' },
                  { label: 'Channel Stats', units: breakdown.channel_stats_polls, projected: breakdown.projected_daily_channel, cost: '1 unit/call', color: 'bg-cyan-500' },
                  { label: 'Search', units: breakdown.search_calls, projected: 0, cost: '100 units/call', color: 'bg-orange-500' },
                  ...(breakdown.other > 0 ? [{ label: 'Other', units: breakdown.other, projected: 0, cost: '', color: 'bg-gray-500' }] : []),
                ].map(({ label, units, projected, cost, color }) => {
                  const pct = breakdown.total > 0 ? Math.round((units / breakdown.daily_limit) * 100) : 0
                  return (
                    <div key={label} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${color}`} />
                          <span className="text-vibe-text">{label}</span>
                          {cost && <span className="text-vibe-muted">({cost})</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-vibe-text font-mono">{units.toLocaleString()}</span>
                          {projected > 0 && (
                            <span className="text-vibe-muted text-[10px]">/ ~{projected.toLocaleString()} projected</span>
                          )}
                        </div>
                      </div>
                      <div className="h-1 bg-vibe-bg rounded-full overflow-hidden">
                        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </div>
                  )
                })}

                {/* Projected daily total */}
                {breakdown.projected_daily_total > 0 && (
                  <div className="pt-2 border-t border-vibe-border/50">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-vibe-muted">Projected 24h total</span>
                      <span className={`font-mono font-medium ${breakdown.projected_daily_total > breakdown.daily_limit ? 'text-red-400' : 'text-vibe-text'}`}>
                        ~{breakdown.projected_daily_total.toLocaleString()} units
                        {breakdown.projected_daily_total > breakdown.daily_limit && ' (over limit!)'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Time estimates */}
            {(() => {
              const remaining = quota.remaining
              if (remaining <= 0) return <p className="text-xs text-red-400 font-medium">Quota exhausted</p>
              // Use projected total if we have breakdown, otherwise fallback to chat-only estimate
              const projectedPerHour = breakdown && breakdown.projected_daily_total > 0
                ? Math.round(breakdown.projected_daily_total / 24)
                : (() => {
                    const intervalSec = Math.max(5, (settings?.poll_interval_ms || 5000) / 1000)
                    return Math.floor(3600 / intervalSec) * 5
                  })()
              if (projectedPerHour <= 0) return null
              const hoursLeft = remaining / projectedPerHour
              const h = Math.floor(hoursLeft)
              const m = Math.round((hoursLeft - h) * 60)
              const estimate = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : '<1m'
              const stopTime = new Date(Date.now() + hoursLeft * 3600000)
              const stopStr = stopTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
              return (
                <div className="text-xs text-vibe-muted space-y-0.5 pt-1">
                  <p>~{projectedPerHour.toLocaleString()} units/hr &middot; {estimate} of polling left</p>
                  <p>Quota runs out around <span className="text-vibe-text font-medium">{stopStr}</span></p>
                </div>
              )
            })()}

            <p className="text-xs text-vibe-muted">Resets at midnight PST</p>

            {/* Quota actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  const newQuota = await invoke<YouTubeQuotaUsage>('youtube_reset_quota_usage')
                  setQuota(newQuota)
                  invoke<QuotaBreakdown>('youtube_get_quota_breakdown').then(setBreakdown).catch(() => {})
                }}
                className="px-3 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary text-vibe-text transition-colors"
              >
                Reset to 0
              </button>
              <QuotaSyncInput onSync={async (units) => {
                const newQuota = await invoke<YouTubeQuotaUsage>('youtube_set_quota_usage', { unitsUsed: units })
                setQuota(newQuota)
                invoke<QuotaBreakdown>('youtube_get_quota_breakdown').then(setBreakdown).catch(() => {})
              }} />
            </div>
          </div>
        )}
      </SectionCard>

      {/* Video Stats */}
      <SectionCard title="Video Statistics" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>}>
        <Toggle
          checked={videoStatsEnabled}
          onChange={(checked) => {
            setVideoStatsEnabled(checked)
            saveField({ video_stats_enabled: checked }, 'video stats')
          }}
          label="Enable Video Stats"
          description="Poll view count, likes, concurrent viewers"
        />
        {videoStatsEnabled && (
          <NumberInput
            label="Poll Interval (seconds)"
            value={videoStatsInterval}
            onChange={(v) => {
              setVideoStatsInterval(v)
              debouncedSave('videoStatsInterval', { video_stats_interval_secs: Math.max(30, v) }, 'video stats interval')
            }}
            onBlur={() => flushDebounce('videoStatsInterval')}
            min={30}
            max={600}
          />
        )}
      </SectionCard>

      {/* Channel Stats */}
      <SectionCard title="Channel Statistics" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>}>
        <Toggle
          checked={channelStatsEnabled}
          onChange={(checked) => {
            setChannelStatsEnabled(checked)
            saveField({ channel_stats_enabled: checked }, 'channel stats')
          }}
          label="Enable Channel Stats"
          description="Poll subscriber count"
        />
        {channelStatsEnabled && (
          <NumberInput
            label="Poll Interval (seconds)"
            value={channelStatsInterval}
            onChange={(v) => {
              setChannelStatsInterval(v)
              debouncedSave('channelStatsInterval', { channel_stats_interval_secs: Math.max(60, v) }, 'channel stats interval')
            }}
            onBlur={() => flushDebounce('channelStatsInterval')}
            min={60}
            max={1800}
          />
        )}
      </SectionCard>

      {/* Subscribers (OAuth) */}
      <SectionCard title="Subscriber Notifications" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>}>
        <Toggle
          checked={subscribersEnabled}
          onChange={(checked) => {
            setSubscribersEnabled(checked)
            saveField({ subscribers_enabled: checked }, 'subscribers')
          }}
          label="Enable Subscriber Alerts"
          description="Requires OAuth connection"
        />
        {subscribersEnabled && (
          <NumberInput
            label="Poll Interval (seconds)"
            value={subscribersPollInterval}
            onChange={(v) => {
              setSubscribersPollInterval(v)
              debouncedSave('subscribersPollInterval', { subscribers_poll_interval_secs: Math.max(30, v) }, 'subscribers interval')
            }}
            onBlur={() => flushDebounce('subscribersPollInterval')}
            min={30}
            max={300}
          />
        )}
      </SectionCard>

      {/* Adaptive Polling */}
      <SectionCard title="Adaptive Polling" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}>
        <Toggle
          checked={adaptiveEnabled}
          onChange={(checked) => {
            setAdaptiveEnabled(checked)
            saveField({ adaptive_polling_enabled: checked }, 'adaptive polling')
          }}
          label="Enable Adaptive Polling"
          description="Automatically adjust polling based on activity to save quota"
        />

        {adaptiveEnabled && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="Idle Threshold (polls)"
                value={idleThreshold}
                onChange={(v) => {
                  setIdleThreshold(v)
                  debouncedSave('idleThreshold', { idle_threshold_polls: Math.max(1, v) }, 'idle threshold')
                }}
                onBlur={() => flushDebounce('idleThreshold')}
                min={1}
                max={50}
                description="Empty polls before slowing"
              />
              <NumberInput
                label="Very Idle Threshold"
                value={veryIdleThreshold}
                onChange={(v) => {
                  setVeryIdleThreshold(v)
                  debouncedSave('veryIdleThreshold', { very_idle_threshold_polls: Math.max(1, v) }, 'very idle threshold')
                }}
                onBlur={() => flushDebounce('veryIdleThreshold')}
                min={1}
                max={100}
                description="Skip video stats after"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="Channel Skip Threshold"
                value={channelSkipThreshold}
                onChange={(v) => {
                  setChannelSkipThreshold(v)
                  debouncedSave('channelSkipThreshold', { channel_skip_threshold: Math.max(1, v) }, 'channel skip')
                }}
                onBlur={() => flushDebounce('channelSkipThreshold')}
                min={1}
                max={50}
                description="Unchanged polls to skip"
              />
              <NumberInput
                label="Max Interval (seconds)"
                value={maxPollInterval}
                onChange={(v) => {
                  setMaxPollInterval(v)
                  debouncedSave('maxPollInterval', { max_poll_interval_ms: Math.max(10, v) * 1000 }, 'max interval')
                }}
                onBlur={() => flushDebounce('maxPollInterval')}
                min={10}
                max={120}
                description="Cap when idle"
              />
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ---- OAuth Tab ----
function OAuthTab({
  settings,
  saveField
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
}) {
  const [oauthClientId, setOauthClientId] = useState(settings?.oauth_client_id || '')
  const [oauthClientSecret, setOauthClientSecret] = useState(settings?.oauth_client_secret || '')
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null)
  const [oauthFlowStatus, setOauthFlowStatus] = useState<string | null>(null)
  const [oauthFlowMessage, setOauthFlowMessage] = useState<string | null>(null)
  const [isOauthFlowRunning, setIsOauthFlowRunning] = useState(false)

  useEffect(() => {
    setOauthClientId(settings?.oauth_client_id || '')
    setOauthClientSecret(settings?.oauth_client_secret || '')
    invoke<OAuthStatus>('youtube_get_oauth_status').then(setOauthStatus).catch(() => {})
  }, [settings])

  useEffect(() => {
    const unlisten = listen<{ status: string; message: string }>('youtube:oauth-status', (event) => {
      setOauthFlowStatus(event.payload.status)
      setOauthFlowMessage(event.payload.message)
      if (['connected', 'disconnected', 'error'].includes(event.payload.status)) {
        setIsOauthFlowRunning(false)
        invoke<OAuthStatus>('youtube_get_oauth_status').then(setOauthStatus).catch(() => {})
      }
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  const handleStartOAuth = async () => {
    setIsOauthFlowRunning(true)
    setOauthFlowStatus('starting')
    setOauthFlowMessage('Opening browser...')
    try {
      await invoke('youtube_start_oauth_flow')
    } catch (e) {
      setOauthFlowStatus('error')
      setOauthFlowMessage(`Failed to start OAuth: ${e}`)
      setIsOauthFlowRunning(false)
    }
  }

  const handleDisconnectOAuth = async () => {
    try {
      await invoke('youtube_disconnect_oauth')
      const status = await invoke<OAuthStatus>('youtube_get_oauth_status')
      setOauthStatus(status)
    } catch (e) {
      console.error('Failed to disconnect OAuth:', e)
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard title="OAuth Connection" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>}>
        <p className="text-xs text-vibe-muted mb-3">
          OAuth is required for subscriber notifications. You need to create OAuth credentials in Google Cloud Console.
        </p>

        {oauthStatus?.is_connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 bg-vibe-bg border border-green-500/30 rounded-lg">
              <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-vibe-text">Connected</p>
                {oauthStatus.token_expires_at && (
                  <p className="text-xs text-vibe-muted">
                    Token expires: {new Date(oauthStatus.token_expires_at * 1000).toLocaleString()}
                  </p>
                )}
              </div>
              <button
                onClick={handleDisconnectOAuth}
                className="px-3 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-vibe-muted block mb-1">OAuth Client ID</label>
              <input
                type="text"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                onBlur={() => {
                  if (oauthClientId && !oauthClientId.includes('...')) {
                    saveField({ oauth_client_id: oauthClientId }, 'client ID')
                  }
                }}
                placeholder="xxx.apps.googleusercontent.com"
                className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-vibe-muted block mb-1">OAuth Client Secret</label>
              <input
                type="password"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                onBlur={() => {
                  if (oauthClientSecret && !oauthClientSecret.includes('...')) {
                    saveField({ oauth_client_secret: oauthClientSecret }, 'client secret')
                  }
                }}
                placeholder="GOCSPX-xxx"
                className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary font-mono"
              />
            </div>

            {oauthFlowStatus && (
              <div className={`p-2 rounded text-xs ${
                oauthFlowStatus === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/30' :
                oauthFlowStatus === 'connected' ? 'bg-green-500/10 text-green-400 border border-green-500/30' :
                'bg-vibe-surface text-vibe-muted border border-vibe-border'
              }`}>
                {oauthFlowMessage}
              </div>
            )}

            <button
              onClick={handleStartOAuth}
              disabled={isOauthFlowRunning || !oauthClientId || !oauthClientSecret}
              className="w-full px-4 py-2 text-sm bg-vibe-primary text-white rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {isOauthFlowRunning ? 'Waiting for authorization...' : 'Connect with Google'}
            </button>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ---- Polls Tab ----
function PollsTab({
  settings,
  saveField,
  debouncedSave,
  flushDebounce
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [pollsEnabled, setPollsEnabled] = useState(settings?.yt_poll_enabled ?? false)
  const [pollDuration, setPollDuration] = useState(settings?.yt_poll_default_duration_secs ?? 60)
  const [pollResultsInterval, setPollResultsInterval] = useState(settings?.yt_poll_results_interval_secs ?? 5)
  const [autoPollEnabled, setAutoPollEnabled] = useState(settings?.yt_poll_auto_enabled ?? false)
  const [autoInterval, setAutoInterval] = useState(settings?.yt_poll_auto_interval_secs ?? 900)
  const [useChatContext, setUseChatContext] = useState(settings?.yt_poll_auto_use_chat_context ?? true)
  const [useIdeContext, setUseIdeContext] = useState(settings?.yt_poll_auto_use_ide_context ?? false)
  const [ttsAnnounce, setTtsAnnounce] = useState(settings?.yt_poll_tts_announce ?? false)

  useEffect(() => {
    setPollsEnabled(settings?.yt_poll_enabled ?? false)
    setPollDuration(settings?.yt_poll_default_duration_secs ?? 60)
    setPollResultsInterval(settings?.yt_poll_results_interval_secs ?? 5)
    setAutoPollEnabled(settings?.yt_poll_auto_enabled ?? false)
    setAutoInterval(settings?.yt_poll_auto_interval_secs ?? 900)
    setUseChatContext(settings?.yt_poll_auto_use_chat_context ?? true)
    setUseIdeContext(settings?.yt_poll_auto_use_ide_context ?? false)
    setTtsAnnounce(settings?.yt_poll_tts_announce ?? false)
  }, [settings])

  return (
    <div className="space-y-6">
      <SectionCard title="YouTube Live Polls" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}>
        <Toggle
          checked={pollsEnabled}
          onChange={(checked) => {
            setPollsEnabled(checked)
            saveField({ yt_poll_enabled: checked }, 'polls')
          }}
          label="Enable Polls"
          description="Create polls for your live stream"
        />

        {pollsEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <NumberInput
                label="Default Duration (seconds)"
                value={pollDuration}
                onChange={(v) => {
                  setPollDuration(v)
                  debouncedSave('pollDuration', { yt_poll_default_duration_secs: Math.max(15, v) }, 'poll duration')
                }}
                onBlur={() => flushDebounce('pollDuration')}
                min={15}
                max={300}
              />
              <NumberInput
                label="Results Update Interval"
                value={pollResultsInterval}
                onChange={(v) => {
                  setPollResultsInterval(v)
                  debouncedSave('pollResultsInterval', { yt_poll_results_interval_secs: Math.max(1, v) }, 'results interval')
                }}
                onBlur={() => flushDebounce('pollResultsInterval')}
                min={1}
                max={30}
              />
            </div>
            <Toggle
              checked={ttsAnnounce}
              onChange={(checked) => {
                setTtsAnnounce(checked)
                saveField({ yt_poll_tts_announce: checked }, 'poll TTS')
              }}
              label="Announce Polls with TTS"
              description="Read poll questions aloud"
            />
          </>
        )}
      </SectionCard>

      {pollsEnabled && (
        <SectionCard title="Auto-Generated Polls" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>}>
          <Toggle
            checked={autoPollEnabled}
            onChange={(checked) => {
              setAutoPollEnabled(checked)
              saveField({ yt_poll_auto_enabled: checked }, 'auto polls')
            }}
            label="Enable Auto-Polls"
            description="Automatically generate polls periodically"
          />

          {autoPollEnabled && (
            <>
              <NumberInput
                label="Auto-Poll Interval (seconds)"
                value={autoInterval}
                onChange={(v) => {
                  setAutoInterval(v)
                  debouncedSave('autoInterval', { yt_poll_auto_interval_secs: Math.max(60, v) }, 'auto interval')
                }}
                onBlur={() => flushDebounce('autoInterval')}
                min={60}
                max={3600}
                description="Time between automatic polls"
              />
              <Toggle
                checked={useChatContext}
                onChange={(checked) => {
                  setUseChatContext(checked)
                  saveField({ yt_poll_auto_use_chat_context: checked }, 'chat context')
                }}
                label="Use Chat Context"
                description="Generate polls based on recent chat messages"
              />
              <Toggle
                checked={useIdeContext}
                onChange={(checked) => {
                  setUseIdeContext(checked)
                  saveField({ yt_poll_auto_use_ide_context: checked }, 'IDE context')
                }}
                label="Use IDE Context"
                description="Generate polls based on current code"
              />
            </>
          )}
        </SectionCard>
      )}
    </div>
  )
}

// ---- Features Tab ----
function FeaturesTab({
  settings,
  saveField,
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
  debouncedSave: (field: string, req: UpdateReq, label: string) => void
  flushDebounce: (field: string) => void
}) {
  const [goalsEnabled, setGoalsEnabled] = useState(settings?.goals_enabled ?? true)
  const [ideasEnabled, setIdeasEnabled] = useState(settings?.ideas_enabled ?? true)
  const [slotsEnabled, setSlotsEnabled] = useState(settings?.slot_enabled ?? true)
  const [pollsEnabled, setPollsEnabled] = useState(settings?.yt_poll_enabled ?? true)

  useEffect(() => {
    setGoalsEnabled(settings?.goals_enabled ?? true)
    setIdeasEnabled(settings?.ideas_enabled ?? true)
    setSlotsEnabled(settings?.slot_enabled ?? true)
    setPollsEnabled(settings?.yt_poll_enabled ?? true)
  }, [settings])

  return (
    <div className="space-y-6">
      <SectionCard title="Feature Toggles" icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>}>
        <p className="text-xs text-vibe-muted mb-4">
          Disable features to remove their pages from the rotation. Disabled features will not appear in the dashboard.
        </p>

        <div className="space-y-4">
          <Toggle
            checked={goalsEnabled}
            onChange={(checked) => {
              setGoalsEnabled(checked)
              saveField({ goals_enabled: checked }, 'goals')
            }}
            label="Stream Goals"
            description="Track and display stream goals with progress"
          />

          <Toggle
            checked={ideasEnabled}
            onChange={(checked) => {
              setIdeasEnabled(checked)
              saveField({ ideas_enabled: checked }, 'ideas')
            }}
            label="Chat Ideas"
            description="Capture viewer ideas from chat commands"
          />

          <Toggle
            checked={slotsEnabled}
            onChange={(checked) => {
              setSlotsEnabled(checked)
              saveField({ slot_enabled: checked }, 'slots')
            }}
            label="Slot Machine"
            description="Allow viewers to pull the slot machine"
          />

          <Toggle
            checked={pollsEnabled}
            onChange={(checked) => {
              setPollsEnabled(checked)
              saveField({ yt_poll_enabled: checked }, 'polls')
            }}
            label="YouTube Polls"
            description="Create and track YouTube native polls"
          />
        </div>
      </SectionCard>
    </div>
  )
}

// ============ Main Component ============

// ---- AI & Voice Tab ----
// The OpenAI key (TTS announcements + AI-generated polls) is a secret of this plugin
// (OS keystore through the host); the settings only ever show it masked.
const TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']

function AiTab({
  settings,
  saveField,
}: {
  settings: YouTubeSettings | null
  saveField: (req: UpdateReq, label?: string) => Promise<void>
}) {
  const [key, setKey] = useState('')
  const [model, setModel] = useState(settings?.ai_model || 'gpt-4o-mini')
  const [testStatus, setTestStatus] = useState<string | null>(null)

  useEffect(() => {
    setModel(settings?.ai_model || 'gpt-4o-mini')
  }, [settings])

  const testVoice = async () => {
    setTestStatus('Speaking…')
    try {
      const b64 = await invoke<string>('youtube_tts_speak', { text: 'Hello, this is a test.' })
      await new Audio(`data:audio/mp3;base64,${b64}`).play()
      setTestStatus(null)
    } catch (e) {
      setTestStatus(`Failed: ${e}`)
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard title="OpenAI">
        <p className="text-xs text-vibe-muted">
          Used for spoken announcements (text to speech) and AI-generated polls. Stored in the system keystore; only a masked
          value is shown. Without a key, announcements use the system voice.
        </p>
        <div>
          <label className="text-xs text-vibe-muted block mb-1">API key {settings?.openai_api_key ? `(stored: ${settings.openai_api_key})` : ''}</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={settings?.openai_api_key ? 'Type to replace the stored key' : 'sk-...'}
              className="flex-1 bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted focus:outline-none focus:border-vibe-primary"
            />
            <button
              disabled={!key.trim()}
              onClick={async () => {
                await saveField({ openai_api_key: key.trim() }, 'OpenAI key')
                setKey('')
              }}
              className="px-3 py-1 text-xs bg-vibe-primary text-white rounded disabled:opacity-40"
            >
              Save
            </button>
            {settings?.openai_api_key && (
              <button
                onClick={() => saveField({ clear_openai_api_key: true }, 'OpenAI key')}
                className="px-3 py-1 text-xs bg-vibe-bg border border-vibe-border rounded text-red-400 hover:border-red-400"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <TextInput
          value={model}
          onChange={setModel}
          onBlur={() => model.trim() && model !== settings?.ai_model && saveField({ ai_model: model.trim() }, 'AI model')}
          label="Poll model"
          description="Chat model for AI-generated polls."
          placeholder="gpt-4o-mini"
        />
      </SectionCard>
      <SectionCard title="Voice">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-vibe-muted block mb-1">Voice</label>
            <select
              value={settings?.tts_voice || 'alloy'}
              onChange={(e) => saveField({ tts_voice: e.target.value }, 'voice')}
              className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text"
            >
              {TTS_VOICES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-vibe-muted block mb-1">Model</label>
            <select
              value={settings?.tts_model || 'tts-1'}
              onChange={(e) => saveField({ tts_model: e.target.value }, 'TTS model')}
              className="w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text"
            >
              {['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={testVoice}
            disabled={!settings?.openai_api_key}
            className="px-3 py-1 text-xs bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary text-vibe-text transition-colors disabled:opacity-40"
          >
            Test voice
          </button>
          {testStatus && <span className="text-xs text-vibe-muted">{testStatus}</span>}
        </div>
      </SectionCard>
    </div>
  )
}

const TABS = [
  { id: 'connection', label: 'Connection', icon: '🔌' },
  { id: 'features', label: 'Features', icon: '🧩' },
  { id: 'commands', label: 'Commands', icon: '⌨️' },
  { id: 'points', label: 'Points', icon: '💰' },
  { id: 'slots', label: 'Slots', icon: '🎰' },
  { id: 'display', label: 'Display', icon: '🖥️' },
  { id: 'api', label: 'API & Stats', icon: '📊' },
  { id: 'oauth', label: 'OAuth', icon: '🔐' },
  { id: 'polls', label: 'Polls', icon: '📋' },
  { id: 'ai', label: 'AI & Voice', icon: '🗣️' },
]

export default function YouTubeSettingsWindowApp() {
  const [revealed, setRevealed] = useState(false)
  const [settings, setSettings] = useState<YouTubeSettings | null>(null)
  const [activeTab, setActiveTab] = useState('connection')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savedField, setSavedField] = useState<string | null>(null)
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const pendingSaves = useRef<Record<string, () => void>>({})

  const debouncedSave = (field: string, req: UpdateReq, label: string) => {
    if (debounceTimers.current[field]) clearTimeout(debounceTimers.current[field])
    pendingSaves.current[field] = () => saveField(req, label)
    debounceTimers.current[field] = setTimeout(() => {
      delete debounceTimers.current[field]
      const run = pendingSaves.current[field]
      delete pendingSaves.current[field]
      run?.()
    }, 400)
  }

  /** Save a pending edit now (blur). (The old window dropped it instead.) */
  const flushDebounce = (field: string) => {
    if (debounceTimers.current[field]) {
      clearTimeout(debounceTimers.current[field])
      delete debounceTimers.current[field]
    }
    const run = pendingSaves.current[field]
    delete pendingSaves.current[field]
    run?.()
  }

  const loadSettings = async () => {
    try {
      const s = await invoke<YouTubeSettings>('youtube_get_settings')
      setSettings(s)
    } catch (e) {
      setError(`Failed to load settings: ${e}`)
    }
  }

  useEffect(() => {
    loadSettings()
    return () => {
      Object.values(debounceTimers.current).forEach(clearTimeout)
    }
  }, [])

  const saveField = async (req: UpdateReq, label?: string) => {
    setSaving(true)
    setError(null)
    try {
      const updated = await invoke<YouTubeSettings>('youtube_update_settings', { request: req })
      setSettings(updated)
      setSaving(false)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      setSavedField(label || 'saved')
      savedTimer.current = setTimeout(() => setSavedField(null), 1500)
    } catch (e) {
      setSaving(false)
      setError(`Failed to save: ${e}`)
    }
  }

  // Warning gate
  if (!revealed) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-vibe-bg select-none">
        <div className="text-center space-y-6 px-8">
          <div className="mx-auto w-16 h-16 rounded-full bg-yellow-500/15 border-2 border-yellow-500/40 flex items-center justify-center">
            <svg className="w-8 h-8 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-yellow-400 mb-2">Sensitive Content</h1>
            <p className="text-sm text-vibe-muted leading-relaxed max-w-[300px] mx-auto">
              This window contains your API credentials and account settings.
              If you are streaming, drag this window to a private monitor before continuing.
            </p>
          </div>
          <button
            onClick={() => setRevealed(true)}
            className="px-8 py-2.5 text-sm font-medium bg-vibe-primary text-white rounded-lg hover:opacity-90 transition-opacity"
          >
            View Settings
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-vibe-border bg-vibe-surface" data-tauri-drag-region>
        <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
        </svg>
        <span className="text-sm font-medium text-vibe-text">YouTube Live Settings</span>
        <div className="ml-auto flex items-center gap-1.5">
          {saving && <span className="text-xs text-vibe-muted animate-pulse">Saving...</span>}
          {savedField && !saving && <span className="text-xs text-green-400">✓ Saved</span>}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400 flex justify-between items-start">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:text-red-300">×</button>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex gap-1 px-4 py-2 border-b border-vibe-border bg-vibe-surface overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs rounded-lg whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? 'bg-vibe-primary text-white'
                : 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-bg'
            }`}
          >
            <span className="mr-1">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'connection' && (
          <ConnectionTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'features' && (
          <FeaturesTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'commands' && (
          <CommandsTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'points' && (
          <PointsTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'slots' && (
          <SlotsTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'display' && (
          <DisplayTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'api' && (
          <ApiStatsTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
        {activeTab === 'oauth' && (
          <OAuthTab settings={settings} saveField={saveField} />
        )}
        {activeTab === 'ai' && (
          <AiTab settings={settings} saveField={saveField} />
        )}
        {activeTab === 'polls' && (
          <PollsTab settings={settings} saveField={saveField} debouncedSave={debouncedSave} flushDebounce={flushDebounce} />
        )}
      </div>
    </div>
  )
}
