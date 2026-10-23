// Wire types of the youtube-live sidecar (snake_case, as the Rust structs serialize).

// ==================== YouTube Live Chat Types ====================

export interface YouTubeSettings {
  /** Masked (`AIza...WXYZ`); secrets never reach the UI in clear text. */
  api_key: string | null
  /** Masked OpenAI key (TTS + AI polls). */
  openai_api_key: string | null
  tts_voice: string
  tts_model: string
  ai_model: string
  credentials_file: string | null
  channel_id: string | null
  poll_interval_ms: number
  command_prefix: string
  max_daily_quota: number
  quota_warning_pct: number
  auto_connect: boolean
  tts_enabled: boolean
  tts_mode: string
  slot_enabled: boolean
  slot_command_prefix: string
  ideas_enabled: boolean
  goals_enabled: boolean
  tab_auto_cycle: boolean
  tab_cycle_interval_secs: number
  cycle_auto_resume_secs: number
  idea_cooldown_secs: number
  slot_cooldown_secs: number
  slot_pull_cost: number
  slot_jackpot_bonus: number
  idea_points_reward: number
  starting_points: number
  chat_xp_enabled: boolean
  chat_xp_amount: number
  chat_xp_cooldown_secs: number
  alerts_enabled: boolean
  alert_duration_secs: number
  video_stats_enabled: boolean
  video_stats_interval_secs: number
  channel_stats_enabled: boolean
  channel_stats_interval_secs: number
  idea_approve_bonus: number
  subscribers_enabled: boolean
  subscribers_poll_interval_secs: number
  oauth_access_token: string | null
  oauth_refresh_token: string | null
  oauth_client_id: string | null
  oauth_client_secret: string | null
  oauth_token_expiry: number | null
  // Adaptive polling settings
  adaptive_polling_enabled: boolean
  idle_threshold_polls: number
  very_idle_threshold_polls: number
  channel_skip_threshold: number
  max_poll_interval_ms: number
  // YouTube Live Polls settings
  yt_poll_enabled: boolean
  yt_poll_default_duration_secs: number
  yt_poll_results_interval_secs: number
  yt_poll_auto_enabled: boolean
  yt_poll_auto_interval_secs: number
  yt_poll_auto_use_chat_context: boolean
  yt_poll_auto_use_ide_context: boolean
  yt_poll_tts_announce: boolean
  // Progressive jackpot settings
  progressive_jackpot_enabled: boolean
  progressive_contribution_pct: number
  progressive_seed_amount: number
  // Stats panel
  slot_stats_enabled: boolean
  // Symbol of the day
  slot_symbol_of_day_enabled: boolean
  slot_symbol_of_day_multiplier: number
  // Lucky hour
  slot_lucky_hour_enabled: boolean
  slot_lucky_hour_start: string
  slot_lucky_hour_end: string
  slot_lucky_hour_boost: number
}

export interface OAuthStatus {
  is_connected: boolean
  has_refresh_token: boolean
  token_expires_at: number | null
  is_token_expired: boolean
}

// ==================== YouTube Live Polls ====================

export interface YTPollOption {
  text: string
  tally: number
}

export interface YTPoll {
  id: string
  youtube_poll_id: string | null
  stream_id: string
  question: string
  options: YTPollOption[]
  status: 'active' | 'closed'
  poll_type: 'custom' | 'ai_generated' | 'template'
  source_context: string | null
  duration_secs: number
  created_at: number
  closed_at: number | null
}

export interface YTPollResults {
  poll_id: string
  question: string
  options: YTPollOption[]
  total_votes: number
  percentages: number[]
  winner_index: number | null
  status: string
  time_remaining_secs: number | null
}

export interface YTPollTemplate {
  id: string
  name: string
  question: string
  options: string[]
  category: 'engagement' | 'feedback' | 'fun' | 'custom'
  is_builtin: boolean
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CreateYTPollRequest {
  question: string
  options: string[]
  duration_secs?: number
}

export interface GenerateAIPollRequest {
  ide_context?: string
  use_chat_context?: boolean
  topic?: string
}

export interface GeneratedPoll {
  question: string
  options: string[]
  source_context: string
}

export interface SlotPull {
  id: string
  video_id: string
  author_name: string
  author_channel_id: string
  symbols: string[]
  is_jackpot: boolean
  created_at: string
  points_change?: number | null
  new_balance?: number | null
  match_type?: string | null
  prize_log_id?: string | null
  prize_name?: string | null
  is_free_spin?: boolean | null
  free_spins_remaining?: number | null
  free_spins_won?: number | null
  progressive_pool?: number | null
}

export interface SlotSymbol {
  id: string
  name: string
  emoji: string
  weight: number
  enabled: boolean
  is_wild: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface PayTableEntry {
  id: string
  priority: number
  match_type: string
  symbol?: string | null
  prize_type: string
  points_amount: number
  prize_name?: string | null
  prize_description?: string | null
  enabled: boolean
  created_at: string
  updated_at: string
  free_spins_awarded?: number
}

export interface PrizeLogEntry {
  id: string
  pull_id?: string | null
  paytable_entry_id?: string | null
  author_channel_id: string
  author_name: string
  prize_type: string
  points_awarded: number
  prize_name?: string | null
  prize_description?: string | null
  redeemed: boolean
  redeemed_at?: string | null
  redeemed_note?: string | null
  created_at: string
}

export interface YouTubeUserStats {
  author_channel_id: string
  author_name: string
  points: number
  total_earned: number
  total_spent: number
  total_pulls: number
  total_jackpots: number
  total_ideas_submitted: number
  total_messages: number
  is_moderator: boolean
  is_member: boolean
  is_owner: boolean
  profile_image_url: string
  first_seen_at: string
  last_active_at: string
}

export interface PointsHistoryEntry {
  id: string
  author_channel_id: string
  amount: number
  balance_after: number
  reason: string
  reference_id: string | null
  created_at: string
}

/** Per-stream user statistics for stream-specific leaderboards */
export interface StreamUserStats {
  stream_id: string
  author_channel_id: string
  author_name: string
  profile_image_url: string
  messages: number
  ideas_submitted: number
  slot_pulls: number
  jackpots: number
  points_earned: number
  points_spent: number
  is_moderator: boolean
  is_member: boolean
  is_owner: boolean
  first_seen_at: string
  last_active_at: string
}

/** Aggregate stats for a single stream */
export interface StreamStats {
  stream_id: string
  video_id: string
  title: string
  total_messages: number
  total_ideas: number
  total_slot_pulls: number
  total_jackpots: number
  unique_chatters: number
  peak_concurrent_chatters: number
  started_at: number
  ended_at: number | null
}

export interface TrackedStream {
  id: string
  video_id: string
  title: string
  channel_title: string
  live_chat_id: string
  status: string
  started_tracking_at: number
  ended_at: number | null
  last_poll_at: number | null
  next_page_token: string | null
  messages_captured: number
  ideas_captured: number
}

export interface ChatIdea {
  id: string
  stream_id: string
  message_id: string
  author_name: string
  author_channel_id: string
  author_profile_image: string
  raw_message: string
  idea_content: string
  status: string
  promoted_to_id: string | null
  project_id: string | null
  project_name: string | null
  published_at: number
  captured_at: number
  reviewed_at: number | null
}

export interface YouTubeQuotaUsage {
  date: string
  units_used: number
  requests_made: number
  daily_limit: number
  remaining: number
}

export interface YouTubePollStatus {
  is_polling: boolean
  stream_id: string | null
  video_id: string | null
  stream_title: string | null
  messages_scanned: number
  ideas_captured: number
  poll_interval_ms: number
  last_poll_at: number | null
}

export interface YouTubeErrorEvent {
  error: string
  type: string
}

export interface YouTubeAlertEvent {
  id: string
  alert_type: 'super_chat' | 'new_member' | 'milestone' | 'gift_membership' | 'super_sticker' | 'new_subscriber'
  author_name: string
  author_channel_id: string
  author_profile_image: string
  message: string | null
  amount: string | null
  currency: string | null
  tier: number | null
  milestone_months: string | null
  gift_count: string | null
  created_at: string
}

export interface YouTubeSubscriber {
  id: string
  channel_id: string
  channel_title: string
  thumbnail_url: string
  subscribed_at: string
  detected_at: string
}

export interface VideoStats {
  view_count: number
  like_count: number
  comment_count: number
  concurrent_viewers: number | null
}

export interface ChannelStats {
  subscriber_count: number
  hidden_subscriber_count: boolean
  total_view_count: number
  video_count: number
}

export interface QuotaBreakdown {
  chat_polls: number
  video_stats_polls: number
  channel_stats_polls: number
  search_calls: number
  other: number
  total: number
  daily_limit: number
  remaining: number
  projected_daily_chat: number
  projected_daily_video: number
  projected_daily_channel: number
  projected_daily_total: number
}

// ==================== Stream Goals ====================

export interface StreamGoal {
  id: string
  title: string
  completed: boolean
  created_at: string
  completed_at: string | null
  stream_id: string | null
}
