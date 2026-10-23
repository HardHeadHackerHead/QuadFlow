/**
 * Typed client of the youtube-live sidecar (one method per former `youtube_*`
 * command; events are the sidecar's `ui/*` notifications). See ./bridge.ts.
 */
import { invoke, listen, getCtx, type UnlistenFn } from './bridge'
import type {
  YouTubeSettings,
  TrackedStream,
  ChatIdea,
  YouTubeQuotaUsage,
  YouTubePollStatus,
  YouTubeErrorEvent,
  SlotPull,
  SlotSymbol,
  PayTableEntry,
  PrizeLogEntry,
  YouTubeUserStats,
  StreamUserStats,
  StreamStats,
  PointsHistoryEntry,
  YouTubeAlertEvent,
  VideoStats,
  ChannelStats,
  QuotaBreakdown,
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


export interface UpdateYouTubeSettingsRequest {
  api_key?: string
  clear_api_key?: boolean
  credentials_file?: string
  clear_credentials_file?: boolean
  channel_id?: string
  clear_channel_id?: boolean
  poll_interval_ms?: number
  auto_connect?: boolean
  command_prefix?: string
  max_daily_quota?: number
  quota_warning_pct?: number
  tts_enabled?: boolean
  tts_mode?: string
  slot_enabled?: boolean
  slot_command_prefix?: string
  tab_auto_cycle?: boolean
  tab_cycle_interval_secs?: number
  cycle_auto_resume_secs?: number
  idea_cooldown_secs?: number
  slot_cooldown_secs?: number
  slot_pull_cost?: number
  slot_jackpot_bonus?: number
  idea_points_reward?: number
  starting_points?: number
  chat_xp_enabled?: boolean
  chat_xp_amount?: number
  chat_xp_cooldown_secs?: number
  alerts_enabled?: boolean
  alert_duration_secs?: number
  video_stats_enabled?: boolean
  video_stats_interval_secs?: number
  channel_stats_enabled?: boolean
  channel_stats_interval_secs?: number
  idea_approve_bonus?: number
  subscribers_enabled?: boolean
  subscribers_poll_interval_secs?: number
  oauth_access_token?: string
  clear_oauth_access_token?: boolean
  oauth_refresh_token?: string
  clear_oauth_refresh_token?: boolean
  oauth_client_id?: string
  clear_oauth_client_id?: boolean
  oauth_client_secret?: string
  clear_oauth_client_secret?: boolean
  oauth_token_expiry?: number
  // Adaptive polling settings
  adaptive_polling_enabled?: boolean
  idle_threshold_polls?: number
  very_idle_threshold_polls?: number
  channel_skip_threshold?: number
  max_poll_interval_ms?: number
  /** Any other `YouTubeSettings` field (the sidecar applies every known key). */
  [field: string]: unknown
}

export interface GetPointsHistoryRequest {
  author_channel_id: string
  limit?: number
  offset?: number
}

export interface ConnectStreamRequest {
  video_input: string
}

export interface SearchStreamsRequest {
  channel_id?: string
}

export interface ListChatIdeasRequest {
  stream_id?: string
  status?: string
}

export interface PromoteToIssueRequest {
  idea_id: string
  priority?: string
  /** Project root to create the issue in (default: the active project). */
  project_root?: string
}

export const youtubeLiveApi = {
  // Active project tracking
  setActiveProject: async (projectId: string | null, projectName: string | null): Promise<void> => {
    await invoke('youtube_set_active_project', { projectId, projectName })
  },

  // Settings
  getSettings: async (): Promise<YouTubeSettings> => {
    return await invoke<YouTubeSettings>('youtube_get_settings')
  },

  updateSettings: async (request: UpdateYouTubeSettingsRequest): Promise<YouTubeSettings> => {
    return await invoke<YouTubeSettings>('youtube_update_settings', { request })
  },

  // Streams
  searchStreams: async (request?: SearchStreamsRequest): Promise<TrackedStream[]> => {
    return await invoke<TrackedStream[]>('youtube_search_streams', { request: request ?? {} })
  },

  connectStream: async (request: ConnectStreamRequest): Promise<TrackedStream> => {
    return await invoke<TrackedStream>('youtube_connect_stream', { request })
  },

  disconnectStream: async (): Promise<void> => {
    await invoke('youtube_disconnect_stream')
  },

  listStreams: async (): Promise<TrackedStream[]> => {
    return await invoke<TrackedStream[]>('youtube_list_streams')
  },

  // Chat Ideas
  listChatIdeas: async (request?: ListChatIdeasRequest): Promise<ChatIdea[]> => {
    return await invoke<ChatIdea[]>('youtube_list_chat_ideas', { request: request ?? {} })
  },

  getChatIdea: async (ideaId: string): Promise<ChatIdea> => {
    return await invoke<ChatIdea>('youtube_get_chat_idea', { ideaId })
  },

  promoteToIssue: async (request: PromoteToIssueRequest): Promise<ChatIdea> => {
    return await invoke<ChatIdea>('youtube_promote_to_issue', { request })
  },

  dismissIdea: async (ideaId: string): Promise<ChatIdea> => {
    return await invoke<ChatIdea>('youtube_dismiss_idea', { ideaId })
  },

  hideIdea: async (ideaId: string): Promise<ChatIdea> => {
    return await invoke<ChatIdea>('youtube_hide_idea', { ideaId })
  },

  // Quota & Status
  getQuota: async (): Promise<YouTubeQuotaUsage> => {
    return await invoke<YouTubeQuotaUsage>('youtube_get_quota')
  },

  getPollStatus: async (): Promise<YouTubePollStatus> => {
    return await invoke<YouTubePollStatus>('youtube_get_poll_status')
  },

  // Event listeners
  onChatIdea: (callback: (idea: ChatIdea) => void): Promise<UnlistenFn> => {
    return listen<ChatIdea>('youtube:chat-idea', (event) => {
      callback(event.payload)
    })
  },

  onPollStatus: (callback: (status: YouTubePollStatus) => void): Promise<UnlistenFn> => {
    return listen<YouTubePollStatus>('youtube:poll-status', (event) => {
      callback(event.payload)
    })
  },

  onError: (callback: (error: YouTubeErrorEvent) => void): Promise<UnlistenFn> => {
    return listen<YouTubeErrorEvent>('youtube:error', (event) => {
      callback(event.payload)
    })
  },

  onQuotaUpdate: (callback: (quota: YouTubeQuotaUsage) => void): Promise<UnlistenFn> => {
    return listen<YouTubeQuotaUsage>('youtube:quota-update', (event) => {
      callback(event.payload)
    })
  },

  onSettingsChanged: (callback: (settings: YouTubeSettings) => void): Promise<UnlistenFn> => {
    return listen<YouTubeSettings>('youtube:settings-changed', (event) => {
      callback(event.payload)
    })
  },

  // Slot Machine
  listSlotPulls: async (videoId?: string, limit?: number): Promise<SlotPull[]> => {
    return await invoke<SlotPull[]>('youtube_list_slot_pulls', { videoId, limit })
  },

  listSlotSymbols: async (): Promise<SlotSymbol[]> => {
    return await invoke<SlotSymbol[]>('youtube_list_slot_symbols')
  },

  listAllSlotSymbols: async (): Promise<SlotSymbol[]> => {
    return await invoke<SlotSymbol[]>('youtube_list_all_slot_symbols')
  },

  onSlotPull: (callback: (pull: SlotPull) => void): Promise<UnlistenFn> => {
    return listen<SlotPull>('youtube:slot-pull', (event) => {
      callback(event.payload)
    })
  },

  // Pay Table
  listPayTable: async (): Promise<PayTableEntry[]> => {
    return await invoke<PayTableEntry[]>('youtube_list_paytable')
  },

  createPayTableEntry: async (
    priority: number,
    matchType: string,
    symbol: string | null,
    prizeType: string,
    pointsAmount: number,
    prizeName: string | null,
    prizeDescription: string | null,
    freeSpinsAwarded?: number,
  ): Promise<PayTableEntry> => {
    return await invoke<PayTableEntry>('youtube_create_paytable_entry', {
      priority, matchType, symbol, prizeType, pointsAmount, prizeName, prizeDescription, freeSpinsAwarded: freeSpinsAwarded ?? 0,
    })
  },

  updatePayTableEntry: async (
    id: string,
    updates: {
      priority?: number
      match_type?: string
      symbol?: string | null
      prize_type?: string
      points_amount?: number
      prize_name?: string | null
      prize_description?: string | null
      enabled?: boolean
      free_spins_awarded?: number
    },
  ): Promise<PayTableEntry> => {
    return await invoke<PayTableEntry>('youtube_update_paytable_entry', {
      id,
      ...updates,
    })
  },

  deletePayTableEntry: async (id: string): Promise<void> => {
    await invoke('youtube_delete_paytable_entry', { id })
  },

  // Progressive Jackpot
  getProgressivePool: async (): Promise<{ current_pool: number; total_contributed: number; total_paid_out: number; last_winner_name: string | null; last_winner_at: string | null; times_won: number }> => {
    return await invoke('youtube_get_progressive_pool')
  },

  // Symbol of the Day
  getSymbolOfDay: async (): Promise<{ symbol_name: string; emoji: string; multiplier: number } | null> => {
    return await invoke('youtube_get_symbol_of_day')
  },

  // Slot Stats
  getSlotStats: async (): Promise<{ total_pulls: number; total_jackpots: number; jackpot_rate: string; biggest_win: number; biggest_winner: string | null; luckiest_user: string | null; luckiest_user_wins: number }> => {
    return await invoke('youtube_get_slot_stats')
  },

  // Prize Log
  listPrizeLog: async (limit?: number, offset?: number, unredeemedOnly?: boolean): Promise<PrizeLogEntry[]> => {
    return await invoke<PrizeLogEntry[]>('youtube_list_prize_log', { limit, offset, unredeemedOnly })
  },

  markPrizeRedeemed: async (id: string, note?: string): Promise<PrizeLogEntry> => {
    return await invoke<PrizeLogEntry>('youtube_mark_prize_redeemed', { id, note })
  },

  countUnredeemedPrizes: async (): Promise<number> => {
    return await invoke<number>('youtube_count_unredeemed_prizes')
  },

  // Settings (a tile of this plugin: the old standalone window)
  openSettingsWindow: async (): Promise<string> => {
    return await getCtx().ui.openTile('settings', { placement: 'flyout' })
  },

  // Text to speech (OpenAI, key in the plugin's secrets) → base64 MP3
  ttsSpeak: async (text: string): Promise<string> => {
    return await invoke<string>('youtube_tts_speak', { text })
  },

  onOpenUrl: (callback: (e: { url: string }) => void): Promise<UnlistenFn> => {
    return listen<{ url: string }>('youtube:open-url', (event) => {
      callback(event.payload)
    })
  },

  // Leaderboard & User Stats
  getLeaderboard: async (limit?: number): Promise<YouTubeUserStats[]> => {
    return await invoke<YouTubeUserStats[]>('youtube_get_leaderboard', { limit })
  },

  getUserStats: async (authorChannelId: string): Promise<YouTubeUserStats> => {
    return await invoke<YouTubeUserStats>('youtube_get_user_stats', { authorChannelId })
  },

  // Per-stream stats & leaderboard
  getStreamLeaderboard: async (streamId: string, sortBy?: string, limit?: number): Promise<StreamUserStats[]> => {
    return await invoke<StreamUserStats[]>('youtube_get_stream_leaderboard', { streamId, sortBy, limit })
  },

  getStreamStats: async (streamId: string): Promise<StreamStats> => {
    return await invoke<StreamStats>('youtube_get_stream_stats', { streamId })
  },

  getAllStreamStats: async (limit?: number): Promise<StreamStats[]> => {
    return await invoke<StreamStats[]>('youtube_get_all_stream_stats', { limit })
  },

  getPointsHistory: async (request: GetPointsHistoryRequest): Promise<PointsHistoryEntry[]> => {
    return await invoke<PointsHistoryEntry[]>('youtube_get_points_history', { request })
  },

  // Test / Demo
  testIdea: async (): Promise<ChatIdea> => {
    return await invoke<ChatIdea>('youtube_test_idea')
  },

  testSlotPull: async (): Promise<SlotPull> => {
    return await invoke<SlotPull>('youtube_test_slot_pull')
  },

  testAlert: async (): Promise<void> => {
    await invoke('youtube_test_alert')
  },

  testVideoStats: async (): Promise<void> => {
    await invoke('youtube_test_video_stats')
  },

  testChannelStats: async (): Promise<void> => {
    await invoke('youtube_test_channel_stats')
  },

  // Quota breakdown
  getQuotaBreakdown: async (): Promise<QuotaBreakdown> => {
    return await invoke<QuotaBreakdown>('youtube_get_quota_breakdown')
  },

  // Manual quota management (for resyncing with Google Console)
  setQuotaUsage: async (unitsUsed: number): Promise<YouTubeQuotaUsage> => {
    return await invoke<YouTubeQuotaUsage>('youtube_set_quota_usage', { unitsUsed })
  },

  resetQuotaUsage: async (): Promise<YouTubeQuotaUsage> => {
    return await invoke<YouTubeQuotaUsage>('youtube_reset_quota_usage')
  },

  // Alert event listener
  onAlert: (callback: (alert: YouTubeAlertEvent) => void): Promise<UnlistenFn> => {
    return listen<YouTubeAlertEvent>('youtube:alert', (event) => {
      callback(event.payload)
    })
  },

  // Video stats event listener
  onVideoStats: (callback: (stats: VideoStats) => void): Promise<UnlistenFn> => {
    return listen<VideoStats>('youtube:video-stats', (event) => {
      callback(event.payload)
    })
  },

  // Channel stats event listener
  onChannelStats: (callback: (stats: ChannelStats) => void): Promise<UnlistenFn> => {
    return listen<ChannelStats>('youtube:channel-stats', (event) => {
      callback(event.payload)
    })
  },

  // Leaderboard update event listener (emitted after each chat poll batch)
  onLeaderboardUpdate: (callback: (leaderboard: YouTubeUserStats[]) => void): Promise<UnlistenFn> => {
    return listen<YouTubeUserStats[]>('youtube:leaderboard-update', (event) => {
      callback(event.payload)
    })
  },

  // Stream Goals
  listGoals: async (): Promise<StreamGoal[]> => {
    return await invoke<StreamGoal[]>('youtube_list_goals')
  },

  createGoal: async (title: string, streamId?: string | null): Promise<StreamGoal> => {
    return await invoke<StreamGoal>('youtube_create_goal', { title, streamId })
  },

  toggleGoal: async (id: string, completed: boolean): Promise<StreamGoal> => {
    return await invoke<StreamGoal>('youtube_toggle_goal', { id, completed })
  },

  updateGoalStream: async (id: string, streamId: string | null): Promise<StreamGoal> => {
    return await invoke<StreamGoal>('youtube_update_goal_stream', { id, streamId })
  },

  deleteGoal: async (id: string): Promise<void> => {
    await invoke('youtube_delete_goal', { id })
  },

  // Subscribers
  listSubscribers: async (limit?: number): Promise<YouTubeSubscriber[]> => {
    return await invoke<YouTubeSubscriber[]>('youtube_list_subscribers', { limit })
  },

  testSubscriber: async (): Promise<YouTubeSubscriber> => {
    return await invoke<YouTubeSubscriber>('youtube_test_subscriber')
  },

  onNewSubscriber: (callback: (subscriber: YouTubeSubscriber) => void): Promise<UnlistenFn> => {
    return listen<YouTubeSubscriber>('youtube:new-subscriber', (event) => {
      callback(event.payload)
    })
  },

  // OAuth
  startOAuthFlow: async (): Promise<void> => {
    await invoke('youtube_start_oauth_flow')
  },

  disconnectOAuth: async (): Promise<void> => {
    await invoke('youtube_disconnect_oauth')
  },

  getOAuthStatus: async (): Promise<OAuthStatus> => {
    return await invoke<OAuthStatus>('youtube_get_oauth_status')
  },

  refreshOAuthToken: async (): Promise<OAuthStatus> => {
    return await invoke<OAuthStatus>('youtube_refresh_oauth_token')
  },

  onOAuthStatus: (callback: (status: { status: string; message: string }) => void): Promise<UnlistenFn> => {
    return listen<{ status: string; message: string }>('youtube:oauth-status', (event) => {
      callback(event.payload)
    })
  },

  // YouTube Polls
  createPoll: async (request: CreateYTPollRequest): Promise<YTPoll> => {
    return await invoke<YTPoll>('youtube_create_poll', { request })
  },

  getActivePoll: async (): Promise<YTPollResults | null> => {
    return await invoke<YTPollResults | null>('youtube_get_active_poll')
  },

  getPollResults: async (pollId: string): Promise<YTPollResults> => {
    return await invoke<YTPollResults>('youtube_get_poll_results', { pollId })
  },

  closePoll: async (pollId: string): Promise<YTPollResults> => {
    return await invoke<YTPollResults>('youtube_close_poll', { pollId })
  },

  listStreamPolls: async (limit?: number): Promise<YTPoll[]> => {
    return await invoke<YTPoll[]>('youtube_list_stream_polls', { limit })
  },

  listAllPolls: async (limit?: number): Promise<YTPoll[]> => {
    return await invoke<YTPoll[]>('youtube_list_all_polls', { limit })
  },

  listPollTemplates: async (category?: string): Promise<YTPollTemplate[]> => {
    return await invoke<YTPollTemplate[]>('youtube_list_poll_templates', { category })
  },

  createPollFromTemplate: async (templateId: string, durationSecs?: number): Promise<YTPoll> => {
    return await invoke<YTPoll>('youtube_create_poll_from_template', { templateId, durationSecs })
  },

  generateAiPoll: async (request: GenerateAIPollRequest): Promise<GeneratedPoll> => {
    return await invoke<GeneratedPoll>('youtube_generate_ai_poll', { request })
  },

  // Poll event listeners
  onPollCreated: (callback: (poll: YTPoll) => void): Promise<UnlistenFn> => {
    return listen<YTPoll>('youtube:poll-created', (event) => {
      callback(event.payload)
    })
  },

  onPollClosed: (callback: (results: YTPollResults) => void): Promise<UnlistenFn> => {
    return listen<YTPollResults>('youtube:poll-closed', (event) => {
      callback(event.payload)
    })
  },
}

