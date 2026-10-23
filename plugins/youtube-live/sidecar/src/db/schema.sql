-- YouTube Live sidecar database (plugin data dir / youtube_live.db).
-- One consolidated schema: the plugin starts from scratch (no migrations from
-- the pre-plugin app DB).

-- Non-secret settings as one JSON document (`YouTubeSettings` with serde
-- defaults). API key, OAuth client id/secret and tokens live in the OS
-- keystore through the host's `secrets.*` API, never here.
CREATE TABLE IF NOT EXISTS youtube_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    json TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO youtube_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS youtube_streams (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    channel_title TEXT NOT NULL DEFAULT '',
    live_chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    started_tracking_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_poll_at INTEGER,
    next_page_token TEXT,
    messages_captured INTEGER NOT NULL DEFAULT 0,
    ideas_captured INTEGER NOT NULL DEFAULT 0,
    -- Highest number of distinct chatters active within a rolling 5-minute window.
    peak_concurrent_chatters INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS youtube_chat_ideas (
    id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    message_id TEXT UNIQUE NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_channel_id TEXT NOT NULL DEFAULT '',
    author_profile_image TEXT NOT NULL DEFAULT '',
    raw_message TEXT NOT NULL,
    idea_content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    promoted_to_id TEXT,
    published_at INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    project_id TEXT,
    project_name TEXT,
    FOREIGN KEY (stream_id) REFERENCES youtube_streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_ideas_stream ON youtube_chat_ideas(stream_id);
CREATE INDEX IF NOT EXISTS idx_chat_ideas_status ON youtube_chat_ideas(status);
CREATE INDEX IF NOT EXISTS idx_chat_ideas_message ON youtube_chat_ideas(message_id);

CREATE TABLE IF NOT EXISTS youtube_quota_log (
    date TEXT PRIMARY KEY,
    units_used INTEGER NOT NULL DEFAULT 0,
    requests_made INTEGER NOT NULL DEFAULT 0,
    daily_limit INTEGER NOT NULL DEFAULT 10000,
    chat_units INTEGER NOT NULL DEFAULT 0,
    video_stats_units INTEGER NOT NULL DEFAULT 0,
    channel_stats_units INTEGER NOT NULL DEFAULT 0,
    search_units INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS youtube_slot_pulls (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_channel_id TEXT NOT NULL,
    symbols TEXT NOT NULL,
    is_jackpot INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    prize_log_id TEXT,
    match_type TEXT,
    is_free_spin INTEGER NOT NULL DEFAULT 0,
    free_spins_remaining INTEGER NOT NULL DEFAULT 0,
    free_spins_won INTEGER NOT NULL DEFAULT 0,
    progressive_pool INTEGER
);
CREATE INDEX IF NOT EXISTS idx_slot_pulls_video ON youtube_slot_pulls(video_id);

CREATE TABLE IF NOT EXISTS youtube_user_stats (
    author_channel_id TEXT PRIMARY KEY,
    author_name TEXT NOT NULL DEFAULT '',
    points INTEGER NOT NULL DEFAULT 100,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent INTEGER NOT NULL DEFAULT 0,
    total_pulls INTEGER NOT NULL DEFAULT 0,
    total_jackpots INTEGER NOT NULL DEFAULT 0,
    total_ideas_submitted INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
    total_messages INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_member INTEGER NOT NULL DEFAULT 0,
    is_owner INTEGER NOT NULL DEFAULT 0,
    profile_image_url TEXT NOT NULL DEFAULT '',
    free_spins_remaining INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_stats_points ON youtube_user_stats(points DESC);

CREATE TABLE IF NOT EXISTS youtube_points_history (
    id TEXT PRIMARY KEY,
    author_channel_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_points_history_user ON youtube_points_history(author_channel_id);
CREATE INDEX IF NOT EXISTS idx_points_history_created ON youtube_points_history(created_at DESC);

CREATE TABLE IF NOT EXISTS youtube_stream_user_stats (
    stream_id TEXT NOT NULL,
    author_channel_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    profile_image_url TEXT NOT NULL DEFAULT '',
    messages INTEGER NOT NULL DEFAULT 0,
    ideas_submitted INTEGER NOT NULL DEFAULT 0,
    slot_pulls INTEGER NOT NULL DEFAULT 0,
    jackpots INTEGER NOT NULL DEFAULT 0,
    points_earned INTEGER NOT NULL DEFAULT 0,
    points_spent INTEGER NOT NULL DEFAULT 0,
    is_moderator INTEGER NOT NULL DEFAULT 0,
    is_member INTEGER NOT NULL DEFAULT 0,
    is_owner INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (stream_id, author_channel_id),
    FOREIGN KEY (stream_id) REFERENCES youtube_streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stream_user_stats_messages ON youtube_stream_user_stats(stream_id, messages DESC);
CREATE INDEX IF NOT EXISTS idx_stream_user_stats_ideas ON youtube_stream_user_stats(stream_id, ideas_submitted DESC);

CREATE TABLE IF NOT EXISTS youtube_slot_paytable (
    id TEXT PRIMARY KEY,
    priority INTEGER NOT NULL DEFAULT 100,
    match_type TEXT NOT NULL DEFAULT 'triple_any',
    symbol TEXT,
    prize_type TEXT NOT NULL DEFAULT 'points',
    points_amount INTEGER NOT NULL DEFAULT 0,
    prize_name TEXT,
    prize_description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    free_spins_awarded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS youtube_slot_symbols (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    emoji TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_wild INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS youtube_prize_log (
    id TEXT PRIMARY KEY,
    pull_id TEXT,
    paytable_entry_id TEXT,
    author_channel_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    prize_type TEXT NOT NULL DEFAULT 'points',
    points_awarded INTEGER NOT NULL DEFAULT 0,
    prize_name TEXT,
    prize_description TEXT,
    redeemed INTEGER NOT NULL DEFAULT 0,
    redeemed_at TEXT,
    redeemed_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prize_log_redeemed ON youtube_prize_log(redeemed);
CREATE INDEX IF NOT EXISTS idx_prize_log_author ON youtube_prize_log(author_channel_id);

CREATE TABLE IF NOT EXISTS youtube_slot_progressive (
    id INTEGER PRIMARY KEY DEFAULT 1,
    current_pool INTEGER NOT NULL DEFAULT 100,
    total_contributed INTEGER NOT NULL DEFAULT 0,
    total_paid_out INTEGER NOT NULL DEFAULT 0,
    last_winner_name TEXT,
    last_winner_at TEXT,
    times_won INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO youtube_slot_progressive (id) VALUES (1);

CREATE TABLE IF NOT EXISTS youtube_slot_daily (
    date TEXT PRIMARY KEY,
    symbol_name TEXT NOT NULL,
    multiplier INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS youtube_subscribers (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL UNIQUE,
    channel_title TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    subscribed_at TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscribers_detected ON youtube_subscribers(detected_at DESC);

CREATE TABLE IF NOT EXISTS youtube_stream_goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    stream_id TEXT
);

CREATE TABLE IF NOT EXISTS youtube_polls (
    id TEXT PRIMARY KEY,
    youtube_poll_id TEXT,
    stream_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    poll_type TEXT NOT NULL DEFAULT 'custom',
    source_context TEXT,
    duration_secs INTEGER NOT NULL DEFAULT 60,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    FOREIGN KEY (stream_id) REFERENCES youtube_streams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_youtube_polls_stream ON youtube_polls(stream_id);
CREATE INDEX IF NOT EXISTS idx_youtube_polls_status ON youtube_polls(status);

CREATE TABLE IF NOT EXISTS youtube_poll_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'custom',
    is_builtin INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_poll_templates_category ON youtube_poll_templates(category);
