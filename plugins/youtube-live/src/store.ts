import { create } from 'zustand'
import { getCtx, listen, type UnlistenFn } from './bridge'
import type {
  YouTubeSettings,
  TrackedStream,
  ChatIdea,
  YouTubeQuotaUsage,
  YouTubePollStatus,
  SlotPull,
  SlotSymbol,
  PayTableEntry,
  PrizeLogEntry,
  YouTubeUserStats,
  StreamUserStats,
  StreamStats,
  YouTubeAlertEvent,
  VideoStats,
  ChannelStats,
  StreamGoal,
  YouTubeSubscriber,
  OAuthStatus,
  YTPoll,
  YTPollResults,
  YTPollTemplate,
  CreateYTPollRequest,
  GenerateAIPollRequest,
  GeneratedPoll,
} from './types'
import {
  youtubeLiveApi,
  type UpdateYouTubeSettingsRequest,
  type ListChatIdeasRequest,
  type PromoteToIssueRequest,
} from './api'

type PageTab = 'goals' | 'ideas' | 'slots' | 'leaderboard' | 'messages' | 'subscribers' | 'polls' | 'points'

const ALL_PAGES: PageTab[] = ['goals', 'ideas', 'slots', 'leaderboard', 'messages', 'subscribers', 'polls', 'points']

/** Returns only the pages whose features are enabled in settings */
export function getEnabledPages(settings: YouTubeSettings | null): PageTab[] {
  if (!settings) return ALL_PAGES
  return ALL_PAGES.filter((page) => {
    if (page === 'goals' && !settings.goals_enabled) return false
    if (page === 'ideas' && !settings.ideas_enabled) return false
    if (page === 'slots' && !settings.slot_enabled) return false
    if (page === 'polls' && !settings.yt_poll_enabled) return false
    return true
  })
}

interface YouTubeLiveStore {
  // State
  settings: YouTubeSettings | null
  trackedStreams: TrackedStream[]
  chatIdeas: ChatIdea[]
  activeStream: TrackedStream | null
  quotaUsage: YouTubeQuotaUsage | null
  pollStatus: YouTubePollStatus | null

  // Slot machine state
  slotSymbols: SlotSymbol[]
  slotPulls: SlotPull[]
  slotSpinReady: boolean
  payTable: PayTableEntry[]
  prizeLog: PrizeLogEntry[]
  unredeemedPrizeCount: number
  activeTab: PageTab
  _cycleTimer: ReturnType<typeof setInterval> | null

  // Subscribers
  subscribers: YouTubeSubscriber[]

  // OAuth
  oauthStatus: OAuthStatus | null

  // YouTube Polls
  activePoll: YTPollResults | null
  streamPolls: YTPoll[]
  allPolls: YTPoll[]  // All polls across all streams for history
  pollTemplates: YTPollTemplate[]
  isLoadingPolls: boolean
  _pollResultsTimer: ReturnType<typeof setInterval> | null

  // Stream goals
  goals: StreamGoal[]

  // Cycle progress bar
  cycleProgress: number
  cyclePaused: boolean
  _cycleProgressTimer: ReturnType<typeof setInterval> | null
  _cycleStartTime: number
  _cyclePauseTimer: ReturnType<typeof setTimeout> | null

  // Leaderboard
  leaderboard: YouTubeUserStats[]

  // Per-stream stats
  streamLeaderboard: StreamUserStats[]
  streamStats: StreamStats | null
  allStreamStats: StreamStats[]
  streamLeaderboardSortBy: 'messages' | 'ideas' | 'slot_pulls' | 'points_earned'

  // Alert queue
  alertQueue: YouTubeAlertEvent[]
  currentAlert: YouTubeAlertEvent | null
  _alertTimer: ReturnType<typeof setTimeout> | null

  // Slot pull queue (sequential display)
  slotPullQueue: SlotPull[]
  currentSlotPull: SlotPull | null

  // Idea queue (sequential display)
  ideaQueue: ChatIdea[]
  currentHeroIdea: ChatIdea | null
  _ideaDisplayTimer: ReturnType<typeof setTimeout> | null

  // Live stats
  videoStats: VideoStats | null
  channelStats: ChannelStats | null
  _videoStatsExpireTimer: ReturnType<typeof setTimeout> | null
  _channelStatsExpireTimer: ReturnType<typeof setTimeout> | null

  // Loading states
  isLoadingSettings: boolean
  isConnecting: boolean
  isLoading: boolean
  isSearching: boolean

  // Error state
  error: string | null

  // Event listener cleanup
  _unlistenFns: UnlistenFn[]
  _initialized: boolean
  _initGeneration: number
  _isInitializing: boolean

  // Actions
  init: () => Promise<void>
  cleanup: () => void
  loadSettings: () => Promise<void>
  updateSettings: (request: UpdateYouTubeSettingsRequest) => Promise<void>
  searchStreams: (channelId?: string) => Promise<TrackedStream[]>
  connectStream: (videoInput: string) => Promise<void>
  quickConnect: () => Promise<void>
  disconnectStream: () => Promise<void>
  loadStreams: () => Promise<void>
  loadChatIdeas: (request?: ListChatIdeasRequest) => Promise<void>
  promoteToIssue: (request: PromoteToIssueRequest) => Promise<void>
  dismissIdea: (ideaId: string) => Promise<void>
  hideIdea: (ideaId: string) => Promise<void>
  loadQuota: () => Promise<void>
  setQuotaUsage: (unitsUsed: number) => Promise<void>
  resetQuotaUsage: () => Promise<void>
  loadPollStatus: () => Promise<void>
  clearError: () => void

  // Slot machine actions
  loadSlotSymbols: () => Promise<void>
  loadSlotPulls: () => Promise<void>
  loadPayTable: () => Promise<void>
  loadPrizeLog: (unredeemedOnly?: boolean) => Promise<void>
  loadUnredeemedCount: () => Promise<void>
  markPrizeRedeemed: (id: string, note?: string) => Promise<void>
  setActiveTab: (tab: PageTab) => void
  startCycleTimer: () => void
  stopCycleTimer: () => void
  toggleCyclePause: () => void

  // Leaderboard actions
  loadLeaderboard: () => Promise<void>

  // Per-stream stats actions
  loadStreamLeaderboard: (streamId: string, sortBy?: string) => Promise<void>
  loadStreamStats: (streamId: string) => Promise<void>
  loadAllStreamStats: () => Promise<void>
  setStreamLeaderboardSortBy: (sortBy: 'messages' | 'ideas' | 'slot_pulls' | 'points_earned') => void

  // Stats actions
  clearStats: () => void

  // Queue actions
  advanceSlotQueue: () => void
  advanceIdeaQueue: () => void
  _activateSlotPull: (pull: SlotPull) => void
  _activateHeroIdea: (idea: ChatIdea) => Promise<void>

  // Alert actions
  showNextAlert: () => void
  dismissAlert: () => void
  testAlert: () => Promise<void>

  // Test actions
  testIdea: () => Promise<void>
  testSlotPull: () => Promise<void>

  // Goal actions
  loadGoals: () => Promise<void>
  createGoal: (title: string) => Promise<void>
  toggleGoal: (id: string, completed: boolean) => Promise<void>
  moveGoalToStream: (goalId: string, streamId: string | null) => Promise<void>
  deleteGoal: (id: string) => Promise<void>

  // Subscriber actions
  loadSubscribers: () => Promise<void>
  testSubscriber: () => Promise<void>

  // OAuth actions
  loadOAuthStatus: () => Promise<void>

  // Poll actions
  loadActivePoll: () => Promise<void>
  loadStreamPolls: (limit?: number) => Promise<void>
  loadAllPolls: (limit?: number) => Promise<void>
  loadPollTemplates: (category?: string) => Promise<void>
  createPoll: (request: CreateYTPollRequest) => Promise<YTPoll | null>
  createPollFromTemplate: (templateId: string, durationSecs?: number) => Promise<YTPoll | null>
  generateAiPoll: (request: GenerateAIPollRequest) => Promise<GeneratedPoll | null>
  closePoll: (pollId: string) => Promise<void>
  startPollResultsPolling: (pollId: string) => void
  stopPollResultsPolling: () => void
}

export const useYouTubeLiveStore = create<YouTubeLiveStore>((set, get) => ({
  // Initial state
  settings: null,
  trackedStreams: [],
  chatIdeas: [],
  activeStream: null,
  quotaUsage: null,
  pollStatus: null,
  slotSymbols: [],
  slotPulls: [],
  slotSpinReady: true,
  payTable: [],
  prizeLog: [],
  unredeemedPrizeCount: 0,
  activeTab: 'goals',
  _cycleTimer: null,
  subscribers: [],
  oauthStatus: null,
  activePoll: null,
  streamPolls: [],
  allPolls: [],
  pollTemplates: [],
  isLoadingPolls: false,
  _pollResultsTimer: null,
  goals: [],
  cycleProgress: 0,
  cyclePaused: false,
  _cycleProgressTimer: null,
  _cycleStartTime: 0,
  _cyclePauseTimer: null,
  leaderboard: [],
  streamLeaderboard: [],
  streamStats: null,
  allStreamStats: [],
  streamLeaderboardSortBy: 'messages',
  alertQueue: [],
  currentAlert: null,
  _alertTimer: null,
  slotPullQueue: [],
  currentSlotPull: null,
  ideaQueue: [],
  currentHeroIdea: null,
  _ideaDisplayTimer: null,
  videoStats: null,
  channelStats: null,
  _videoStatsExpireTimer: null,
  _channelStatsExpireTimer: null,
  isLoadingSettings: false,
  isConnecting: false,
  isLoading: false,
  isSearching: false,
  error: null,
  _unlistenFns: [],
  _initialized: false,
  _initGeneration: 0,
  _isInitializing: false,

  init: async () => {
    // Prevent concurrent initialization
    if (get()._isInitializing) {
      console.log('YouTube Live store init already in progress, skipping')
      return
    }

    // Clean up any existing listeners to prevent duplicates (e.g. project switch)
    get().cleanup()

    // Mark as initializing
    set({ _isInitializing: true })

    // Track this init generation — if cleanup() runs during our async setup,
    // we'll detect it via isStale() and dispose of any listeners we registered.
    const generation = get()._initGeneration + 1
    set({ _initGeneration: generation })

    const isStale = () => get()._initGeneration !== generation

    // Set up event listeners
    const unlistens: UnlistenFn[] = []

    try {
      const unlistenIdea = await youtubeLiveApi.onChatIdea(async (idea) => {
        // Always add to history
        set((state) => ({
          chatIdeas: [idea, ...state.chatIdeas],
        }))

        const { currentHeroIdea } = get()
        // Activate immediately if no hero or hero has been reviewed
        if (!currentHeroIdea || currentHeroIdea.status !== 'pending') {
          get()._activateHeroIdea(idea)
        } else {
          // Queue it — TTS and display will happen when it becomes active
          set((state) => ({
            ideaQueue: [...state.ideaQueue, idea],
          }))
        }
      })
      unlistens.push(unlistenIdea)

      // Slot pull event listener
      const unlistenSlotPull = await youtubeLiveApi.onSlotPull((pull) => {
        // Always add to history
        set((state) => ({
          slotPulls: [pull, ...state.slotPulls],
        }))

        const { currentSlotPull } = get()
        if (!currentSlotPull) {
          // No active pull — activate immediately
          get()._activateSlotPull(pull)
        } else {
          // Queue it — TTS and animation will happen when it becomes active
          set((state) => ({
            slotPullQueue: [...state.slotPullQueue, pull],
          }))
        }
      })
      unlistens.push(unlistenSlotPull)

      const unlistenStatus = await youtubeLiveApi.onPollStatus((status) => {
        set({ pollStatus: status })
      })
      unlistens.push(unlistenStatus)

      const unlistenError = await youtubeLiveApi.onError((event) => {
        set({ error: event.error })
        // If stream ended, refresh status
        if (event.type === 'stream_ended' || event.type === 'quota_exceeded') {
          get().loadPollStatus()
        }
      })
      unlistens.push(unlistenError)

      const unlistenQuota = await youtubeLiveApi.onQuotaUpdate((quota) => {
        set({ quotaUsage: quota })
      })
      unlistens.push(unlistenQuota)

      // Settings changed listener (from settings window)
      const unlistenSettings = await youtubeLiveApi.onSettingsChanged((newSettings) => {
        set({ settings: newSettings })
        // Restart or stop cycle timer based on new settings
        if (newSettings.tab_auto_cycle) {
          get().startCycleTimer()
        } else {
          get().stopCycleTimer()
        }
      })
      unlistens.push(unlistenSettings)

      // Alert event listener
      const unlistenAlert = await youtubeLiveApi.onAlert((alert) => {
        const { currentAlert } = get()
        if (!currentAlert) {
          // No current alert, show immediately
          set({ currentAlert: alert })
          const { settings } = get()
          const duration = (settings?.alert_duration_secs || 5) * 1000
          const timer = setTimeout(() => get().dismissAlert(), duration)
          set({ _alertTimer: timer })
        } else {
          // Queue it
          set((state) => ({
            alertQueue: [...state.alertQueue, alert],
          }))
        }
        // TTS for alerts
        const { settings } = get()
        if (settings?.tts_enabled) {
          let text = ''
          switch (alert.alert_type) {
            case 'super_chat':
              text = `${alert.author_name} sent a Super Chat${alert.amount ? ' of ' + alert.amount : ''}!`
              break
            case 'new_member':
              text = `Welcome new member ${alert.author_name}!`
              break
            case 'milestone':
              text = `${alert.author_name} reached a membership milestone!`
              break
            case 'gift_membership':
              text = `${alert.author_name} gifted memberships!`
              break
            case 'super_sticker':
              text = `${alert.author_name} sent a Super Sticker${alert.amount ? ' of ' + alert.amount : ''}!`
              break
            case 'new_subscriber':
              text = `${alert.author_name} just subscribed!`
              break
          }
          if (text) {
            try {
              youtubeLiveApi.ttsSpeak(text).then((base64Audio) => {
                const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
                audio.play()
              }).catch(() => {
                const utterance = new SpeechSynthesisUtterance(text)
                speechSynthesis.speak(utterance)
              })
            } catch {
              const utterance = new SpeechSynthesisUtterance(text)
              speechSynthesis.speak(utterance)
            }
          }
        }
      })
      unlistens.push(unlistenAlert)

      // Video stats listener — auto-expire after 10 minutes so test data doesn't stick forever.
      // Must be longer than the longest possible polling interval to avoid flickering.
      const unlistenVideoStats = await youtubeLiveApi.onVideoStats((stats) => {
        const { _videoStatsExpireTimer } = get()
        if (_videoStatsExpireTimer) clearTimeout(_videoStatsExpireTimer)
        const timer = setTimeout(() => {
          set({ videoStats: null, _videoStatsExpireTimer: null })
        }, 600_000)
        set({ videoStats: stats, _videoStatsExpireTimer: timer })
      })
      unlistens.push(unlistenVideoStats)

      // Channel stats listener — auto-expire after 10 minutes (must exceed channel_stats_interval_secs)
      const unlistenChannelStats = await youtubeLiveApi.onChannelStats((stats) => {
        const { _channelStatsExpireTimer } = get()
        if (_channelStatsExpireTimer) clearTimeout(_channelStatsExpireTimer)
        const timer = setTimeout(() => {
          set({ channelStats: null, _channelStatsExpireTimer: null })
        }, 600_000)
        set({ channelStats: stats, _channelStatsExpireTimer: timer })
      })
      unlistens.push(unlistenChannelStats)

      // Leaderboard update listener — pushed from backend after each chat poll batch
      const unlistenLeaderboard = await youtubeLiveApi.onLeaderboardUpdate((leaderboard) => {
        set({ leaderboard })
      })
      unlistens.push(unlistenLeaderboard)

      // New subscriber event listener
      const unlistenNewSub = await youtubeLiveApi.onNewSubscriber((subscriber) => {
        set((state) => ({
          subscribers: [subscriber, ...state.subscribers],
          activeTab: 'subscribers',
        }))
        // Reset cycle timer on new subscriber
        get().startCycleTimer()
        // TTS for new subscriber
        const { settings } = get()
        if (settings?.tts_enabled) {
          const name = subscriber.channel_title || 'Someone'
          const text = `${name} just subscribed!`
          try {
            youtubeLiveApi.ttsSpeak(text).then((base64Audio) => {
              const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
              audio.play()
            }).catch(() => {
              const utterance = new SpeechSynthesisUtterance(text)
              speechSynthesis.speak(utterance)
            })
          } catch {
            const utterance = new SpeechSynthesisUtterance(text)
            speechSynthesis.speak(utterance)
          }
        }
      })
      unlistens.push(unlistenNewSub)

      // OAuth status listener — update oauthStatus when flow events fire
      const unlistenOAuthStatus = await youtubeLiveApi.onOAuthStatus((_event) => {
        // Reload the full status from backend on any change
        get().loadOAuthStatus()
      })
      unlistens.push(unlistenOAuthStatus)

      // YouTube poll created listener
      const unlistenPollCreated = await youtubeLiveApi.onPollCreated((poll) => {
        set((state) => ({
          streamPolls: [poll, ...state.streamPolls],
        }))
        // Start polling for results if this is the active poll
        if (poll.status === 'active') {
          get().loadActivePoll()
          get().startPollResultsPolling(poll.id)
          // Switch to polls tab and reset cycle timer
          set({ activeTab: 'polls' })
          get().startCycleTimer()
        }
        // TTS announcement for new poll
        const { settings } = get()
        if (settings?.yt_poll_tts_announce) {
          const text = `New poll: ${poll.question}`
          try {
            youtubeLiveApi.ttsSpeak(text).then((base64Audio) => {
              const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
              audio.play()
            }).catch(() => {
              const utterance = new SpeechSynthesisUtterance(text)
              speechSynthesis.speak(utterance)
            })
          } catch {
            const utterance = new SpeechSynthesisUtterance(text)
            speechSynthesis.speak(utterance)
          }
        }
      })
      unlistens.push(unlistenPollCreated)

      // YouTube poll closed listener
      const unlistenPollClosed = await youtubeLiveApi.onPollClosed((results) => {
        // Stop polling for results
        get().stopPollResultsPolling()
        // Update local state
        set((state) => ({
          activePoll: results.status === 'closed' ? results : state.activePoll,
          streamPolls: state.streamPolls.map((p) =>
            p.id === results.poll_id ? { ...p, status: 'closed' as const, closed_at: Date.now() } : p
          ),
        }))
        // TTS announcement for poll results
        const { settings } = get()
        if (settings?.yt_poll_tts_announce && results.winner_index !== null) {
          const winnerOption = results.options[results.winner_index]
          const text = `Poll ended! Winner: ${winnerOption.text} with ${winnerOption.tally} votes.`
          try {
            youtubeLiveApi.ttsSpeak(text).then((base64Audio) => {
              const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
              audio.play()
            }).catch(() => {
              const utterance = new SpeechSynthesisUtterance(text)
              speechSynthesis.speak(utterance)
            })
          } catch {
            const utterance = new SpeechSynthesisUtterance(text)
            speechSynthesis.speak(utterance)
          }
        }
      })
      unlistens.push(unlistenPollClosed)

      // Clear stats listener (from settings window "Clear Stats" button)
      const unlistenClearStats = await listen('youtube:clear-stats', () => {
        get().clearStats()
      })
      unlistens.push(unlistenClearStats)

      // If cleanup() ran while we were awaiting listener registrations,
      // dispose of everything we registered and abort.
      if (isStale()) {
        unlistens.forEach((fn) => fn())
        return
      }

      set({ _unlistenFns: unlistens, _initialized: true, _isInitializing: false })

      // Load initial data
      await Promise.all([
        get().loadSettings(),
        get().loadPollStatus(),
        get().loadQuota(),
        get().loadChatIdeas(),
        get().loadSlotSymbols(),
        get().loadSlotPulls(),
        get().loadLeaderboard(),
        get().loadPayTable(),
        get().loadUnredeemedCount(),
        get().loadGoals(),
        get().loadSubscribers(),
        get().loadOAuthStatus(),
        get().loadActivePoll(),
        get().loadStreamPolls(),
        get().loadPollTemplates(),
      ])

      // Start auto-cycle timer if enabled
      const { settings } = get()
      if (settings?.tab_auto_cycle) {
        get().startCycleTimer()
      }

      // Auto-connect if enabled and not already polling (with additional guard)
      const { settings: s, pollStatus: currentPollStatus, isConnecting } = get()
      if (s?.auto_connect && !currentPollStatus?.is_polling && !isConnecting) {
        get().quickConnect()
      }
    } catch (error) {
      // Clean up any listeners registered before the error
      unlistens.forEach((fn) => fn())
      set({ _isInitializing: false })
      console.error('Failed to initialize YouTube Live store:', error)
    }
  },

  cleanup: () => {
    // Bump generation to invalidate any in-flight async init()
    set((state) => ({ _initGeneration: state._initGeneration + 1, _isInitializing: false }))

    const { _unlistenFns, _cycleTimer, _cycleProgressTimer, _alertTimer, _videoStatsExpireTimer, _channelStatsExpireTimer, _ideaDisplayTimer, _pollResultsTimer } = get()
    _unlistenFns.forEach((fn) => fn())
    if (_cycleTimer) clearInterval(_cycleTimer)
    if (_cycleProgressTimer) clearInterval(_cycleProgressTimer)
    if (_alertTimer) clearTimeout(_alertTimer)
    if (_videoStatsExpireTimer) clearTimeout(_videoStatsExpireTimer)
    if (_channelStatsExpireTimer) clearTimeout(_channelStatsExpireTimer)
    if (_ideaDisplayTimer) clearTimeout(_ideaDisplayTimer)
    if (_pollResultsTimer) clearInterval(_pollResultsTimer)
    set({ _unlistenFns: [], _initialized: false, _cycleTimer: null, _cycleProgressTimer: null, cycleProgress: 0, cyclePaused: false, _alertTimer: null, currentAlert: null, alertQueue: [], videoStats: null, channelStats: null, _videoStatsExpireTimer: null, _channelStatsExpireTimer: null, slotPullQueue: [], currentSlotPull: null, ideaQueue: [], currentHeroIdea: null, _ideaDisplayTimer: null, activePoll: null, streamPolls: [], _pollResultsTimer: null })
  },

  loadSettings: async () => {
    set({ isLoadingSettings: true, error: null })
    try {
      const settings = await youtubeLiveApi.getSettings()
      set({ settings, isLoadingSettings: false })
    } catch (error) {
      set({ isLoadingSettings: false, error: `Failed to load settings: ${error}` })
    }
  },

  updateSettings: async (request) => {
    set({ isLoadingSettings: true, error: null })
    try {
      const settings = await youtubeLiveApi.updateSettings(request)
      set({ settings, isLoadingSettings: false })
      // Handle auto-cycle changes
      if (request.tab_auto_cycle !== undefined || request.tab_cycle_interval_secs !== undefined) {
        if (settings.tab_auto_cycle) {
          get().startCycleTimer()
        } else {
          get().stopCycleTimer()
        }
      }
    } catch (error) {
      set({ isLoadingSettings: false, error: `Failed to update settings: ${error}` })
    }
  },

  searchStreams: async (channelId?: string) => {
    set({ isSearching: true, error: null })
    try {
      const streams = await youtubeLiveApi.searchStreams(
        channelId ? { channel_id: channelId } : undefined
      )
      set({ trackedStreams: streams, isSearching: false })
      return streams
    } catch (error) {
      set({ isSearching: false, error: `Failed to search streams: ${error}` })
      return []
    }
  },

  connectStream: async (videoInput: string) => {
    // Prevent double-connect
    const { isConnecting, pollStatus } = get()
    if (isConnecting) {
      console.log('Connection already in progress, skipping')
      return
    }
    // Skip if already polling this exact video
    if (pollStatus?.is_polling && pollStatus.video_id === videoInput) {
      console.log('Already connected to this stream, skipping')
      return
    }

    // Clear polls from previous stream before connecting
    set({ isConnecting: true, error: null, streamPolls: [], activePoll: null })
    try {
      const stream = await youtubeLiveApi.connectStream({ video_input: videoInput })
      set({
        activeStream: stream,
        isConnecting: false,
      })
      // Refresh related data including polls for this stream
      get().loadPollStatus()
      get().loadQuota()
      get().loadActivePoll()
      get().loadStreamPolls()
    } catch (error) {
      set({ isConnecting: false, error: `Failed to connect: ${error}` })
    }
  },

  quickConnect: async () => {
    // Prevent double-connect
    const { isConnecting, pollStatus } = get()
    if (isConnecting) {
      console.log('Connection already in progress, skipping quickConnect')
      return
    }
    if (pollStatus?.is_polling) {
      console.log('Already polling, skipping quickConnect')
      return
    }

    // Clear polls from previous stream before connecting
    set({ isConnecting: true, error: null, streamPolls: [], activePoll: null })
    try {
      // Search for live streams using configured channel ID
      const streams = await youtubeLiveApi.searchStreams()
      if (streams.length === 0) {
        set({ isConnecting: false, error: 'No live streams found. Make sure your channel ID is set in settings and you have an active live stream.' })
        return
      }
      // Connect to the first live stream found
      const stream = await youtubeLiveApi.connectStream({ video_input: streams[0].video_id })
      set({
        activeStream: stream,
        trackedStreams: streams,
        isConnecting: false,
      })
      // Refresh related data including polls for this stream
      get().loadPollStatus()
      get().loadQuota()
      get().loadActivePoll()
      get().loadStreamPolls()
    } catch (error) {
      set({ isConnecting: false, error: `Failed to connect: ${error}` })
    }
  },

  disconnectStream: async () => {
    try {
      await youtubeLiveApi.disconnectStream()
      // Clear stream-specific state including polls
      set({ activeStream: null, streamPolls: [], activePoll: null })
      get().stopPollResultsPolling()
      get().clearStats()
      get().loadPollStatus()
    } catch (error) {
      set({ error: `Failed to disconnect: ${error}` })
    }
  },

  loadStreams: async () => {
    set({ isLoading: true })
    try {
      const streams = await youtubeLiveApi.listStreams()
      set({ trackedStreams: streams, isLoading: false })
    } catch (error) {
      set({ isLoading: false, error: `Failed to load streams: ${error}` })
    }
  },

  loadChatIdeas: async (request?: ListChatIdeasRequest) => {
    set({ isLoading: true })
    try {
      const ideas = await youtubeLiveApi.listChatIdeas(request)
      set({ chatIdeas: ideas, isLoading: false })
    } catch (error) {
      set({ isLoading: false, error: `Failed to load ideas: ${error}` })
    }
  },

  promoteToIssue: async (request: PromoteToIssueRequest) => {
    try {
      // The issue goes to the project that is active right now (captured before the call).
      const projectRoot = getCtx().project.current()?.root
      const updated = await youtubeLiveApi.promoteToIssue({ ...request, project_root: request.project_root ?? projectRoot })
      set((state) => ({
        chatIdeas: state.chatIdeas.map((i) =>
          i.id === updated.id ? updated : i
        ),
        currentHeroIdea: state.currentHeroIdea?.id === updated.id ? updated : state.currentHeroIdea,
      }))
      // Advance queue if the reviewed idea was the current hero
      const { currentHeroIdea } = get()
      if (currentHeroIdea?.id === request.idea_id) {
        get().advanceIdeaQueue()
      }
    } catch (error) {
      set({ error: `Failed to promote to issue: ${error}` })
    }
  },

  dismissIdea: async (ideaId: string) => {
    try {
      const updated = await youtubeLiveApi.dismissIdea(ideaId)
      set((state) => ({
        chatIdeas: state.chatIdeas.map((i) =>
          i.id === updated.id ? updated : i
        ),
        currentHeroIdea: state.currentHeroIdea?.id === updated.id ? updated : state.currentHeroIdea,
      }))
      const { currentHeroIdea } = get()
      if (currentHeroIdea?.id === ideaId) {
        get().advanceIdeaQueue()
      }
    } catch (error) {
      set({ error: `Failed to dismiss idea: ${error}` })
    }
  },

  hideIdea: async (ideaId: string) => {
    try {
      const updated = await youtubeLiveApi.hideIdea(ideaId)
      set((state) => ({
        chatIdeas: state.chatIdeas.map((i) =>
          i.id === updated.id ? updated : i
        ),
        currentHeroIdea: state.currentHeroIdea?.id === updated.id ? updated : state.currentHeroIdea,
      }))
      const { currentHeroIdea } = get()
      if (currentHeroIdea?.id === ideaId) {
        get().advanceIdeaQueue()
      }
    } catch (error) {
      set({ error: `Failed to hide idea: ${error}` })
    }
  },

  loadQuota: async () => {
    try {
      const quota = await youtubeLiveApi.getQuota()
      set({ quotaUsage: quota })
    } catch (error) {
      console.error('Failed to load quota:', error)
    }
  },

  setQuotaUsage: async (unitsUsed: number) => {
    try {
      const quota = await youtubeLiveApi.setQuotaUsage(unitsUsed)
      set({ quotaUsage: quota })
    } catch (error) {
      set({ error: `Failed to set quota: ${error}` })
    }
  },

  resetQuotaUsage: async () => {
    try {
      const quota = await youtubeLiveApi.resetQuotaUsage()
      set({ quotaUsage: quota })
    } catch (error) {
      set({ error: `Failed to reset quota: ${error}` })
    }
  },

  loadPollStatus: async () => {
    try {
      const status = await youtubeLiveApi.getPollStatus()
      set({ pollStatus: status })
    } catch (error) {
      console.error('Failed to load poll status:', error)
    }
  },

  clearError: () => set({ error: null }),

  // Stats actions
  clearStats: () => {
    const { _videoStatsExpireTimer, _channelStatsExpireTimer } = get()
    if (_videoStatsExpireTimer) clearTimeout(_videoStatsExpireTimer)
    if (_channelStatsExpireTimer) clearTimeout(_channelStatsExpireTimer)
    set({ videoStats: null, channelStats: null, _videoStatsExpireTimer: null, _channelStatsExpireTimer: null })
  },

  // Slot machine actions
  loadSlotSymbols: async () => {
    try {
      const symbols = await youtubeLiveApi.listSlotSymbols()
      set({ slotSymbols: symbols })
    } catch (error) {
      console.error('Failed to load slot symbols:', error)
    }
  },

  loadSlotPulls: async () => {
    try {
      const pulls = await youtubeLiveApi.listSlotPulls(undefined, 50)
      set({ slotPulls: pulls })
    } catch (error) {
      console.error('Failed to load slot pulls:', error)
    }
  },

  loadPayTable: async () => {
    try {
      const payTable = await youtubeLiveApi.listPayTable()
      set({ payTable })
    } catch (error) {
      console.error('Failed to load pay table:', error)
    }
  },

  loadPrizeLog: async (unredeemedOnly?: boolean) => {
    try {
      const prizeLog = await youtubeLiveApi.listPrizeLog(100, 0, unredeemedOnly)
      set({ prizeLog })
    } catch (error) {
      console.error('Failed to load prize log:', error)
    }
  },

  loadUnredeemedCount: async () => {
    try {
      const count = await youtubeLiveApi.countUnredeemedPrizes()
      set({ unredeemedPrizeCount: count })
    } catch (error) {
      console.error('Failed to load unredeemed count:', error)
    }
  },

  markPrizeRedeemed: async (id: string, note?: string) => {
    try {
      const updated = await youtubeLiveApi.markPrizeRedeemed(id, note)
      set((state) => ({
        prizeLog: state.prizeLog.map((p) => p.id === updated.id ? updated : p),
        unredeemedPrizeCount: Math.max(0, state.unredeemedPrizeCount - 1),
      }))
    } catch (error) {
      console.error('Failed to mark prize redeemed:', error)
    }
  },

  setActiveTab: (tab) => {
    set({ activeTab: tab })
    // Reset cycle timer when manually switching (only if not paused)
    const { settings, cyclePaused } = get()
    if (settings?.tab_auto_cycle && !cyclePaused) {
      get().startCycleTimer()
    }
  },

  startCycleTimer: () => {
    const { _cycleTimer, _cycleProgressTimer, settings, cyclePaused } = get()
    if (_cycleTimer) clearInterval(_cycleTimer)
    if (_cycleProgressTimer) clearInterval(_cycleProgressTimer)
    if (!settings?.tab_auto_cycle) return
    if (cyclePaused) return

    const intervalMs = (settings.tab_cycle_interval_secs || 15) * 1000
    const startTime = Date.now()
    set({ _cycleStartTime: startTime, cycleProgress: 0 })

    // Main cycle timer - rotates through enabled pages only
    const timer = setInterval(() => {
      set((state) => {
        const pageOrder = getEnabledPages(state.settings)
        if (pageOrder.length === 0) return {}
        const currentIndex = pageOrder.indexOf(state.activeTab)
        const nextIndex = (currentIndex + 1) % pageOrder.length
        return {
          activeTab: pageOrder[nextIndex],
          _cycleStartTime: Date.now(),
          cycleProgress: 0,
        }
      })
    }, intervalMs)

    // Progress timer - updates progress bar at 100ms intervals
    const progressTimer = setInterval(() => {
      const { _cycleStartTime, settings: s } = get()
      const elapsed = Date.now() - _cycleStartTime
      const total = (s?.tab_cycle_interval_secs || 15) * 1000
      const progress = Math.min(100, (elapsed / total) * 100)
      set({ cycleProgress: progress })
    }, 100)

    set({ _cycleTimer: timer, _cycleProgressTimer: progressTimer })
  },

  stopCycleTimer: () => {
    const { _cycleTimer, _cycleProgressTimer, _cyclePauseTimer } = get()
    if (_cycleTimer) clearInterval(_cycleTimer)
    if (_cycleProgressTimer) clearInterval(_cycleProgressTimer)
    if (_cyclePauseTimer) clearTimeout(_cyclePauseTimer)
    set({ _cycleTimer: null, _cycleProgressTimer: null, _cyclePauseTimer: null, cycleProgress: 0 })
  },

  toggleCyclePause: () => {
    const { cyclePaused, _cycleTimer, _cycleProgressTimer, _cyclePauseTimer, settings } = get()
    if (cyclePaused) {
      // Resume - clear auto-resume timer
      if (_cyclePauseTimer) clearTimeout(_cyclePauseTimer)
      set({ cyclePaused: false, _cyclePauseTimer: null })
      get().startCycleTimer()
    } else {
      // Pause - clear timers but keep cycleProgress frozen
      if (_cycleTimer) clearInterval(_cycleTimer)
      if (_cycleProgressTimer) clearInterval(_cycleProgressTimer)
      if (_cyclePauseTimer) clearTimeout(_cyclePauseTimer)

      // Start auto-resume timer if configured (0 = disabled)
      const autoResumeSecs = settings?.cycle_auto_resume_secs ?? 30
      let pauseTimer: ReturnType<typeof setTimeout> | null = null
      if (autoResumeSecs > 0) {
        pauseTimer = setTimeout(() => {
          set({ cyclePaused: false, _cyclePauseTimer: null })
          get().startCycleTimer()
        }, autoResumeSecs * 1000)
      }

      set({ cyclePaused: true, _cycleTimer: null, _cycleProgressTimer: null, _cyclePauseTimer: pauseTimer })
    }
  },

  // Leaderboard actions
  loadLeaderboard: async () => {
    try {
      const leaderboard = await youtubeLiveApi.getLeaderboard(100)
      set({ leaderboard })
    } catch (error) {
      console.error('Failed to load leaderboard:', error)
    }
  },

  // Per-stream stats actions
  loadStreamLeaderboard: async (streamId: string, sortBy?: string) => {
    try {
      const streamLeaderboard = await youtubeLiveApi.getStreamLeaderboard(
        streamId,
        sortBy || get().streamLeaderboardSortBy,
        100
      )
      set({ streamLeaderboard })
    } catch (error) {
      console.error('Failed to load stream leaderboard:', error)
    }
  },

  loadStreamStats: async (streamId: string) => {
    try {
      const streamStats = await youtubeLiveApi.getStreamStats(streamId)
      set({ streamStats })
    } catch (error) {
      console.error('Failed to load stream stats:', error)
    }
  },

  loadAllStreamStats: async () => {
    try {
      const allStreamStats = await youtubeLiveApi.getAllStreamStats(50)
      set({ allStreamStats })
    } catch (error) {
      console.error('Failed to load all stream stats:', error)
    }
  },

  setStreamLeaderboardSortBy: (sortBy) => {
    set({ streamLeaderboardSortBy: sortBy })
    // Reload leaderboard with new sort if we have a stream
    const { pollStatus } = get()
    if (pollStatus?.stream_id) {
      get().loadStreamLeaderboard(pollStatus.stream_id, sortBy)
    }
  },

  // Alert actions
  showNextAlert: () => {
    const { alertQueue, _alertTimer } = get()
    if (_alertTimer) clearTimeout(_alertTimer)
    if (alertQueue.length > 0) {
      const [next, ...rest] = alertQueue
      set({ currentAlert: next, alertQueue: rest })
      const { settings } = get()
      const duration = (settings?.alert_duration_secs || 5) * 1000
      const timer = setTimeout(() => get().dismissAlert(), duration)
      set({ _alertTimer: timer })
    } else {
      set({ currentAlert: null, _alertTimer: null })
    }
  },

  dismissAlert: () => {
    const { _alertTimer } = get()
    if (_alertTimer) clearTimeout(_alertTimer)
    set({ _alertTimer: null, currentAlert: null })
    // Show next in queue
    setTimeout(() => get().showNextAlert(), 300)
  },

  testAlert: async () => {
    try {
      await youtubeLiveApi.testAlert()
    } catch (error) {
      set({ error: `Test alert failed: ${error}` })
    }
  },

  // --- Internal activation helpers (not exposed in interface) ---

  _activateSlotPull: (pull: SlotPull) => {
    const { settings } = get()
    const ttsEnabled = settings?.tts_enabled

    // Stop auto-cycling while slot animation plays — the full animation
    // (spin + result display) should stay on screen without being cycled away.
    // Cycling resumes only when the entire queue is drained.
    get().stopCycleTimer()

    // Set as current pull, switch tab, hold spin for TTS
    set({
      currentSlotPull: pull,
      activeTab: 'slots',
      slotSpinReady: !ttsEnabled,
    })

    if (pull.prize_log_id) {
      get().loadUnredeemedCount()
    }

    if (ttsEnabled) {
      let text = pull.is_free_spin
        ? `Free spin for ${pull.author_name}!${pull.free_spins_remaining != null && pull.free_spins_remaining > 0 ? ` ${pull.free_spins_remaining} remaining.` : ''}`
        : `${pull.author_name} pulls the slot machine!`
      // Append free spins won info if applicable
      if (pull.free_spins_won != null && pull.free_spins_won > 0) {
        text += ` They won ${pull.free_spins_won} free spin${pull.free_spins_won > 1 ? 's' : ''}!`
      }
      const triggerSpin = () => set({ slotSpinReady: true })
      try {
        youtubeLiveApi.ttsSpeak(text).then((base64Audio) => {
          const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
          audio.play().then(triggerSpin).catch(triggerSpin)
        }).catch(() => {
          const utterance = new SpeechSynthesisUtterance(text)
          speechSynthesis.speak(utterance)
          triggerSpin()
        })
      } catch {
        const utterance = new SpeechSynthesisUtterance(text)
        speechSynthesis.speak(utterance)
        triggerSpin()
      }
    }
  },

  _activateHeroIdea: async (idea: ChatIdea) => {
    const { _ideaDisplayTimer, settings } = get()
    if (_ideaDisplayTimer) clearTimeout(_ideaDisplayTimer)

    set({
      currentHeroIdea: idea,
      activeTab: 'ideas',
    })
    get().startCycleTimer()

    // TTS announcement
    if (settings?.tts_enabled) {
      const text = settings.tts_mode === 'full'
        ? `${idea.author_name} says: ${idea.idea_content}`
        : `${idea.author_name} submitted an idea`
      try {
        const base64Audio = await youtubeLiveApi.ttsSpeak(text)
        const audio = new Audio(`data:audio/mp3;base64,${base64Audio}`)
        audio.play()
      } catch {
        const utterance = new SpeechSynthesisUtterance(text)
        speechSynthesis.speak(utterance)
      }
    }

    // Auto-advance after 15 seconds if not reviewed
    const timer = setTimeout(() => get().advanceIdeaQueue(), 15000)
    set({ _ideaDisplayTimer: timer })
  },

  // --- Queue advance actions ---

  advanceSlotQueue: () => {
    const { slotPullQueue } = get()
    if (slotPullQueue.length > 0) {
      const [next, ...rest] = slotPullQueue
      set({ slotPullQueue: rest })
      get()._activateSlotPull(next)
    } else {
      // Queue empty — clear currentSlotPull so new pulls activate immediately,
      // then resume auto-cycling now that all slot animations are done.
      set({ currentSlotPull: null })
      get().startCycleTimer()
    }
  },

  advanceIdeaQueue: () => {
    const { ideaQueue, _ideaDisplayTimer } = get()
    if (_ideaDisplayTimer) clearTimeout(_ideaDisplayTimer)

    if (ideaQueue.length > 0) {
      const [next, ...rest] = ideaQueue
      set({ ideaQueue: rest })
      get()._activateHeroIdea(next)
    } else {
      // Queue empty — clear hero so component falls back to visibleIdeas[0]
      set({ currentHeroIdea: null, _ideaDisplayTimer: null })
    }
  },

  // Test actions
  testIdea: async () => {
    try {
      await youtubeLiveApi.testIdea()
      // The event listener handles adding it to state
    } catch (error) {
      set({ error: `Test idea failed: ${error}` })
    }
  },

  testSlotPull: async () => {
    try {
      await youtubeLiveApi.testSlotPull()
      // The event listener handles adding it to state
      get().loadLeaderboard()
    } catch (error) {
      set({ error: `Test slot pull failed: ${error}` })
    }
  },

  // Goal actions
  loadGoals: async () => {
    try {
      const goals = await youtubeLiveApi.listGoals()
      set({ goals })
    } catch (error) {
      set({ error: `Failed to load goals: ${error}` })
    }
  },

  createGoal: async (title: string) => {
    try {
      const streamId = get().activeStream?.id ?? null
      const goal = await youtubeLiveApi.createGoal(title, streamId)
      set((state) => ({ goals: [goal, ...state.goals] }))
    } catch (error) {
      set({ error: `Failed to create goal: ${error}` })
    }
  },

  toggleGoal: async (id: string, completed: boolean) => {
    try {
      const updated = await youtubeLiveApi.toggleGoal(id, completed)
      set((state) => ({
        goals: state.goals.map((g) => (g.id === id ? updated : g)),
      }))
    } catch (error) {
      set({ error: `Failed to toggle goal: ${error}` })
    }
  },

  moveGoalToStream: async (goalId: string, streamId: string | null) => {
    try {
      const updated = await youtubeLiveApi.updateGoalStream(goalId, streamId)
      set((state) => ({
        goals: state.goals.map((g) => (g.id === goalId ? updated : g)),
      }))
    } catch (error) {
      set({ error: `Failed to move goal: ${error}` })
    }
  },

  deleteGoal: async (id: string) => {
    try {
      await youtubeLiveApi.deleteGoal(id)
      set((state) => ({ goals: state.goals.filter((g) => g.id !== id) }))
    } catch (error) {
      set({ error: `Failed to delete goal: ${error}` })
    }
  },

  // Subscriber actions
  loadSubscribers: async () => {
    try {
      const subscribers = await youtubeLiveApi.listSubscribers(50)
      set({ subscribers })
    } catch (error) {
      console.error('Failed to load subscribers:', error)
    }
  },

  testSubscriber: async () => {
    try {
      await youtubeLiveApi.testSubscriber()
      // The event listener handles adding it to state and auto-jumping
    } catch (error) {
      set({ error: `Test subscriber failed: ${error}` })
    }
  },

  // OAuth actions
  loadOAuthStatus: async () => {
    try {
      const oauthStatus = await youtubeLiveApi.getOAuthStatus()
      set({ oauthStatus })
    } catch (error) {
      console.error('Failed to load OAuth status:', error)
    }
  },

  // Poll actions
  loadActivePoll: async () => {
    set({ isLoadingPolls: true })
    try {
      const activePoll = await youtubeLiveApi.getActivePoll()
      set({ activePoll, isLoadingPolls: false })
      // Start polling for results if there's an active poll
      if (activePoll && activePoll.status === 'active') {
        get().startPollResultsPolling(activePoll.poll_id)
      }
    } catch (error) {
      set({ isLoadingPolls: false })
      console.error('Failed to load active poll:', error)
    }
  },

  loadStreamPolls: async (limit?: number) => {
    try {
      const streamPolls = await youtubeLiveApi.listStreamPolls(limit || 50)
      set({ streamPolls })
    } catch (error) {
      console.error('Failed to load stream polls:', error)
    }
  },

  loadAllPolls: async (limit?: number) => {
    try {
      const allPolls = await youtubeLiveApi.listAllPolls(limit || 100)
      set({ allPolls })
    } catch (error) {
      console.error('Failed to load all polls:', error)
    }
  },

  loadPollTemplates: async (category?: string) => {
    try {
      const pollTemplates = await youtubeLiveApi.listPollTemplates(category)
      set({ pollTemplates })
    } catch (error) {
      console.error('Failed to load poll templates:', error)
    }
  },

  createPoll: async (request: CreateYTPollRequest) => {
    set({ isLoadingPolls: true, error: null })
    try {
      const poll = await youtubeLiveApi.createPoll(request)
      set((state) => ({
        streamPolls: [poll, ...state.streamPolls],
        isLoadingPolls: false,
      }))
      // Load active poll to get results format
      get().loadActivePoll()
      return poll
    } catch (error) {
      set({ isLoadingPolls: false, error: `Failed to create poll: ${error}` })
      return null
    }
  },

  createPollFromTemplate: async (templateId: string, durationSecs?: number) => {
    set({ isLoadingPolls: true, error: null })
    try {
      const poll = await youtubeLiveApi.createPollFromTemplate(templateId, durationSecs)
      set((state) => ({
        streamPolls: [poll, ...state.streamPolls],
        isLoadingPolls: false,
      }))
      // Load active poll to get results format
      get().loadActivePoll()
      return poll
    } catch (error) {
      set({ isLoadingPolls: false, error: `Failed to create poll from template: ${error}` })
      return null
    }
  },

  generateAiPoll: async (request: GenerateAIPollRequest) => {
    set({ isLoadingPolls: true, error: null })
    try {
      const generated = await youtubeLiveApi.generateAiPoll(request)
      set({ isLoadingPolls: false })
      return generated
    } catch (error) {
      set({ isLoadingPolls: false, error: `Failed to generate AI poll: ${error}` })
      return null
    }
  },

  closePoll: async (pollId: string) => {
    set({ isLoadingPolls: true, error: null })
    try {
      const results = await youtubeLiveApi.closePoll(pollId)
      get().stopPollResultsPolling()
      set((state) => ({
        activePoll: results,
        streamPolls: state.streamPolls.map((p) =>
          p.id === pollId ? { ...p, status: 'closed' as const, closed_at: Date.now() } : p
        ),
        isLoadingPolls: false,
      }))
    } catch (error) {
      set({ isLoadingPolls: false, error: `Failed to close poll: ${error}` })
    }
  },

  startPollResultsPolling: (pollId: string) => {
    const { _pollResultsTimer, settings } = get()
    if (_pollResultsTimer) clearInterval(_pollResultsTimer)

    const intervalMs = (settings?.yt_poll_results_interval_secs || 5) * 1000

    // Poll for results at regular intervals
    const timer = setInterval(async () => {
      try {
        const results = await youtubeLiveApi.getPollResults(pollId)
        set({ activePoll: results })
        // Stop polling if poll is closed
        if (results.status === 'closed') {
          get().stopPollResultsPolling()
        }
      } catch (error) {
        console.error('Failed to fetch poll results:', error)
      }
    }, intervalMs)

    set({ _pollResultsTimer: timer })
  },

  stopPollResultsPolling: () => {
    const { _pollResultsTimer } = get()
    if (_pollResultsTimer) {
      clearInterval(_pollResultsTimer)
      set({ _pollResultsTimer: null })
    }
  },
}))
