//! Data models (wire shapes shared with the UI) and YouTube Data API v3 response types.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedStream {
    pub id: String,
    pub video_id: String,
    pub title: String,
    pub channel_title: String,
    pub live_chat_id: String,
    pub status: String,
    pub started_tracking_at: i64,
    pub ended_at: Option<i64>,
    pub last_poll_at: Option<i64>,
    pub next_page_token: Option<String>,
    pub messages_captured: i64,
    pub ideas_captured: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChatIdeaStatus {
    Pending,
    #[serde(rename = "promoted_issue")]
    PromotedIssue,
    Dismissed,
    Hidden,
}

impl ChatIdeaStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatIdeaStatus::Pending => "pending",
            ChatIdeaStatus::PromotedIssue => "promoted_issue",
            ChatIdeaStatus::Dismissed => "dismissed",
            ChatIdeaStatus::Hidden => "hidden",
        }
    }

}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatIdea {
    pub id: String,
    pub stream_id: String,
    pub message_id: String,
    pub author_name: String,
    pub author_channel_id: String,
    pub author_profile_image: String,
    pub raw_message: String,
    pub idea_content: String,
    pub status: String,
    pub promoted_to_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub published_at: i64,
    pub captured_at: i64,
    pub reviewed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaUsage {
    pub date: String,
    pub units_used: i64,
    pub requests_made: i64,
    pub daily_limit: i64,
    pub remaining: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotPull {
    pub id: String,
    pub video_id: String,
    pub author_name: String,
    pub author_channel_id: String,
    pub symbols: Vec<String>,
    pub is_jackpot: bool,
    pub created_at: String,
    pub points_change: Option<i64>,
    pub new_balance: Option<i64>,
    pub match_type: Option<String>,
    pub prize_log_id: Option<String>,
    pub prize_name: Option<String>,
    pub is_free_spin: Option<bool>,
    pub free_spins_remaining: Option<i64>,
    pub free_spins_won: Option<i64>,
    pub progressive_pool: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotSymbol {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub weight: i64,
    pub enabled: bool,
    pub is_wild: bool,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayTableEntry {
    pub id: String,
    pub priority: i64,
    pub match_type: String,
    pub symbol: Option<String>,
    pub prize_type: String,
    pub points_amount: i64,
    pub prize_name: Option<String>,
    pub prize_description: Option<String>,
    pub enabled: bool,
    pub free_spins_awarded: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrizeLogEntry {
    pub id: String,
    pub pull_id: Option<String>,
    pub paytable_entry_id: Option<String>,
    pub author_channel_id: String,
    pub author_name: String,
    pub prize_type: String,
    pub points_awarded: i64,
    pub prize_name: Option<String>,
    pub prize_description: Option<String>,
    pub redeemed: bool,
    pub redeemed_at: Option<String>,
    pub redeemed_note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeUserStats {
    pub author_channel_id: String,
    pub author_name: String,
    pub points: i64,
    pub total_earned: i64,
    pub total_spent: i64,
    pub total_pulls: i64,
    pub total_jackpots: i64,
    pub total_ideas_submitted: i64,
    pub total_messages: i64,
    pub is_moderator: bool,
    pub is_member: bool,
    pub is_owner: bool,
    pub profile_image_url: String,
    pub first_seen_at: String,
    pub last_active_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PointsHistoryEntry {
    pub id: String,
    pub author_channel_id: String,
    pub amount: i64,
    pub balance_after: i64,
    pub reason: String,
    pub reference_id: Option<String>,
    pub created_at: String,
}

/// Per-stream user statistics for stream-specific leaderboards
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamUserStats {
    pub stream_id: String,
    pub author_channel_id: String,
    pub author_name: String,
    pub profile_image_url: String,
    pub messages: i64,
    pub ideas_submitted: i64,
    pub slot_pulls: i64,
    pub jackpots: i64,
    pub points_earned: i64,
    pub points_spent: i64,
    pub is_moderator: bool,
    pub is_member: bool,
    pub is_owner: bool,
    pub first_seen_at: String,
    pub last_active_at: String,
}

/// Aggregate stats for a single stream
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamStats {
    pub stream_id: String,
    pub video_id: String,
    pub title: String,
    pub total_messages: i64,
    pub total_ideas: i64,
    pub total_slot_pulls: i64,
    pub total_jackpots: i64,
    pub unique_chatters: i64,
    pub peak_concurrent_chatters: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

// ============ YouTube Live Polls ============

/// A poll option with text and tally count
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YTPollOption {
    pub text: String,
    pub tally: i64,
}

/// A YouTube Live poll (native API poll)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YTPoll {
    pub id: String,
    pub youtube_poll_id: Option<String>,
    pub stream_id: String,
    pub question: String,
    pub options: Vec<YTPollOption>,
    pub status: String,  // "active" or "closed"
    pub poll_type: String,  // "custom", "ai_generated", "template"
    pub source_context: Option<String>,
    pub duration_secs: i64,
    pub created_at: i64,
    pub closed_at: Option<i64>,
}

/// Poll results with computed percentages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YTPollResults {
    pub poll_id: String,
    pub question: String,
    pub options: Vec<YTPollOption>,
    pub total_votes: i64,
    pub percentages: Vec<f64>,
    pub winner_index: Option<usize>,
    pub status: String,
    pub time_remaining_secs: Option<i64>,
}

/// A reusable poll template
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YTPollTemplate {
    pub id: String,
    pub name: String,
    pub question: String,
    pub options: Vec<String>,
    pub category: String,  // "engagement", "feedback", "fun", "custom"
    pub is_builtin: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollStatus {
    pub is_polling: bool,
    pub stream_id: Option<String>,
    pub video_id: Option<String>,
    pub stream_title: Option<String>,
    pub messages_scanned: i64,
    pub ideas_captured: i64,
    pub poll_interval_ms: u64,
    pub last_poll_at: Option<i64>,
}

// ============ YouTube API Response Types ============

#[derive(Debug, Deserialize)]
pub struct YouTubeSearchResponse {
    pub items: Option<Vec<YouTubeSearchItem>>,
}

#[derive(Debug, Deserialize)]
pub struct YouTubeSearchItem {
    pub id: YouTubeSearchItemId,
    pub snippet: Option<YouTubeSnippet>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeSearchItemId {
    pub video_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeSnippet {
    pub title: Option<String>,
    pub channel_title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct YouTubeVideoResponse {
    pub items: Option<Vec<YouTubeVideoItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoItem {
    pub snippet: Option<YouTubeSnippet>,
    pub live_streaming_details: Option<YouTubeLiveStreamingDetails>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeLiveStreamingDetails {
    pub active_live_chat_id: Option<String>,
    pub concurrent_viewers: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChatResponse {
    pub next_page_token: Option<String>,
    pub polling_interval_millis: Option<u64>,
    pub items: Option<Vec<YouTubeChatItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChatItem {
    pub id: String,
    pub snippet: Option<YouTubeChatSnippet>,
    pub author_details: Option<YouTubeChatAuthor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChatSnippet {
    #[serde(rename = "type")]
    pub message_type: Option<String>,
    pub published_at: Option<String>,
    pub display_message: Option<String>,
    pub super_chat_details: Option<SuperChatDetails>,
    pub super_sticker_details: Option<SuperStickerDetails>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperChatDetails {
    pub amount_display_string: Option<String>,
    pub currency: Option<String>,
    pub tier: Option<u32>,
    pub user_comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperStickerDetails {
    pub amount_display_string: Option<String>,
    pub currency: Option<String>,
    pub tier: Option<u32>,
    pub super_sticker_metadata: Option<SuperStickerMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperStickerMetadata {
    pub alt_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChatAuthor {
    pub channel_id: Option<String>,
    pub display_name: Option<String>,
    pub profile_image_url: Option<String>,
    pub is_chat_moderator: Option<bool>,
    pub is_chat_sponsor: Option<bool>,
    pub is_chat_owner: Option<bool>,
}

// Video/Channel stats API response types
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoStatsResponse {
    pub items: Option<Vec<YouTubeVideoStatsItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoStatsItem {
    pub statistics: Option<YouTubeVideoStatistics>,
    pub live_streaming_details: Option<YouTubeLiveStreamingDetails>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeVideoStatistics {
    pub view_count: Option<String>,
    pub like_count: Option<String>,
    pub comment_count: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannelStatsResponse {
    pub items: Option<Vec<YouTubeChannelStatsItem>>,
}

#[derive(Debug, Deserialize)]
pub struct YouTubeChannelStatsItem {
    pub statistics: Option<YouTubeChannelStatistics>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeChannelStatistics {
    pub subscriber_count: Option<String>,
    pub hidden_subscriber_count: Option<bool>,
    pub view_count: Option<String>,
    pub video_count: Option<String>,
}

// Event payload structs
#[derive(Debug, Clone, Serialize)]
pub struct YouTubeAlertEvent {
    pub id: String,
    pub alert_type: String,
    pub author_name: String,
    pub author_channel_id: String,
    pub author_profile_image: String,
    pub message: Option<String>,
    pub amount: Option<String>,
    pub currency: Option<String>,
    pub tier: Option<u32>,
    pub milestone_months: Option<String>,
    pub gift_count: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoStats {
    pub view_count: i64,
    pub like_count: i64,
    pub comment_count: i64,
    pub concurrent_viewers: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelStats {
    pub subscriber_count: i64,
    pub hidden_subscriber_count: bool,
    pub total_view_count: i64,
    pub video_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscriber {
    pub id: String,
    pub channel_id: String,
    pub channel_title: String,
    pub thumbnail_url: String,
    pub subscribed_at: String,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuotaBreakdown {
    pub chat_polls: i64,
    pub video_stats_polls: i64,
    pub channel_stats_polls: i64,
    pub search_calls: i64,
    pub other: i64,
    pub total: i64,
    pub daily_limit: i64,
    pub remaining: i64,
    pub projected_daily_chat: i64,
    pub projected_daily_video: i64,
    pub projected_daily_channel: i64,
    pub projected_daily_total: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeErrorResponse {
    pub error: Option<YouTubeApiError>,
}

#[derive(Debug, Deserialize)]
pub struct YouTubeApiError {
    pub message: Option<String>,
}

// ============ Stream Goals ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamGoal {
    pub id: String,
    pub title: String,
    pub completed: bool,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub stream_id: Option<String>,
}


// ============ Command request types ============

/// Request to create a new YouTube poll
#[derive(Debug, Deserialize)]
pub struct CreateYTPollRequest {
    pub question: String,
    pub options: Vec<String>,
    pub duration_secs: Option<i64>,
}

/// Request to generate an AI-powered poll
#[derive(Debug, Deserialize)]
pub struct GenerateAIPollRequest {
    /// Optional IDE context (open file names, project info)
    pub ide_context: Option<String>,
    /// Whether to use recent chat messages as context
    pub use_chat_context: Option<bool>,
    /// Optional custom topic/theme for the poll
    pub topic: Option<String>,
}

/// AI-generated poll result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedPoll {
    pub question: String,
    pub options: Vec<String>,
    pub source_context: String,
}

#[derive(Debug, Deserialize)]
pub struct ConnectStreamRequest {
    pub video_input: String, // video ID or URL
}

#[derive(Debug, Deserialize)]
pub struct SearchStreamsRequest {
    pub channel_id: Option<String>, // override settings channel_id
}

#[derive(Debug, Deserialize)]
pub struct ListChatIdeasRequest {
    pub stream_id: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PromoteToIssueRequest {
    pub idea_id: String,
    pub priority: Option<String>,
    /// Project to create the issue in (the UI passes the active project's root;
    /// default: the host's active project).
    #[serde(default)]
    pub project_root: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetPointsHistoryRequest {
    pub author_channel_id: String,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}
