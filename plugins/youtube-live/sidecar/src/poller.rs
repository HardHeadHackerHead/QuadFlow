//! The live chat poller: one background thread per connected stream. Each tick
//! reads new chat messages, runs `!idea` / `!pull` commands, awards chat XP,
//! raises alerts, and (on their own timers) polls video/channel stats, OAuth
//! subscribers and auto-generated polls. Adaptive intervals save API quota.

use crate::models::*;
use crate::settings::YouTubeSettings;
use crate::slots::{self, OnBroke};
use crate::state::{App, PollerCommand};
use crate::util::*;
use crate::{commands, error::YouTubeLiveError, oauth, youtube_api};
use quadflow_sidecar::json;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Window for "concurrent chatters": distinct authors seen in the last 5 minutes.
const CONCURRENT_WINDOW: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
enum CommandType {
    Idea,
    SlotPull,
    ChatXP,
}

type Cooldowns = HashMap<(String, CommandType), Instant>;

fn is_on_cooldown(cooldowns: &Cooldowns, channel_id: &str, cmd_type: CommandType, cooldown_secs: i64) -> bool {
    if cooldown_secs <= 0 {
        return false;
    }
    cooldowns
        .get(&(channel_id.to_string(), cmd_type))
        .is_some_and(|last| last.elapsed().as_secs() < cooldown_secs as u64)
}

/// Everything the poller needs that is fixed for the connection.
pub struct PollerTarget {
    pub stream_id: String,
    pub video_id: String,
    pub live_chat_id: String,
    pub api_key: String,
    pub channel_id: String,
}

fn alert(kind: &str, name: String, channel: String, image: String, message: Option<String>) -> YouTubeAlertEvent {
    YouTubeAlertEvent {
        id: gen_id(),
        alert_type: kind.to_string(),
        author_name: name,
        author_channel_id: channel,
        author_profile_image: image,
        message,
        amount: None,
        currency: None,
        tier: None,
        milestone_months: None,
        gift_count: None,
        created_at: chrono_now_iso(),
    }
}

/// Mutable per-connection poller state.
struct Run {
    interval_ms: u64,
    page_token: Option<String>,
    retry_count: u32,
    cooldowns: Cooldowns,
    video_stats_last_poll: Option<Instant>,
    channel_stats_last_poll: Option<Instant>,
    last_known_sub_count: Option<i64>,
    subscriber_last_poll: Option<Instant>,
    auto_poll_last_check: Option<Instant>,
    consecutive_empty_polls: u32,
    last_video_views: Option<i64>,
    last_channel_subs: Option<i64>,
    channel_stats_skip_count: u32,
    recent_chatters: HashMap<String, Instant>,
}

pub fn run_poller(app: App, t: PollerTarget, cfg: YouTubeSettings, control_rx: Receiver<PollerCommand>) {
    let initial_interval_ms = cfg.poll_interval_ms.max(2000) as u64;
    let mut r = Run {
        interval_ms: initial_interval_ms,
        page_token: app.state().get_db().get_stream(&t.stream_id).ok().and_then(|s| s.next_page_token),
        retry_count: 0,
        cooldowns: HashMap::new(),
        video_stats_last_poll: None,
        channel_stats_last_poll: None,
        last_known_sub_count: None,
        subscriber_last_poll: None,
        auto_poll_last_check: None,
        consecutive_empty_polls: 0,
        last_video_views: None,
        last_channel_subs: None,
        channel_stats_skip_count: 0,
        recent_chatters: HashMap::new(),
    };

    loop {
        match control_rx.recv_timeout(Duration::from_millis(r.interval_ms)) {
            Ok(PollerCommand::Stop) | Err(RecvTimeoutError::Disconnected) => {
                app.log("info", format!("YouTube poller stopping for stream: {}", t.stream_id));
                break;
            }
            Ok(PollerCommand::UpdateInterval(new_interval)) => {
                app.log("info", format!("YouTube poller interval updated to {new_interval}ms"));
                r.interval_ms = new_interval;
                let status = {
                    let mut s = app.state().status_mut();
                    s.poll_interval_ms = new_interval;
                    s.clone()
                };
                app.emit("youtube:poll-status", &status);
            }
            Err(RecvTimeoutError::Timeout) => {
                if !tick(&app, &t, &cfg, initial_interval_ms, &mut r) {
                    break;
                }
            }
        }
    }

    app.state().status_mut().is_polling = false;
}

/// One poll. `false` ends the poller (stream ended, quota exceeded, repeated errors).
fn tick(app: &App, t: &PollerTarget, cfg: &YouTubeSettings, initial_interval_ms: u64, r: &mut Run) -> bool {
    if !app.state().get_db().check_quota(5).unwrap_or(false) {
        app.emit("youtube:error", &json!({ "error": "Daily quota limit reached. Polling paused.", "type": "quota_exceeded" }));
        r.interval_ms = 60_000;
        return true;
    }

    let response = match youtube_api::poll_chat_messages(app.http(), &t.api_key, &t.live_chat_id, r.page_token.as_deref()) {
        Ok(resp) => resp,
        Err(YouTubeLiveError::NotFound(_)) => {
            app.log("info", format!("YouTube live stream ended: {}", t.stream_id));
            let _ = app.state().get_db().update_stream_status(&t.stream_id, "ended");
            app.state().status_mut().is_polling = false;
            app.emit("youtube:error", &json!({ "error": "Live stream has ended.", "type": "stream_ended" }));
            return false;
        }
        Err(YouTubeLiveError::QuotaExceeded(msg)) => {
            app.log("warn", format!("YouTube quota exceeded: {msg}"));
            app.state().status_mut().is_polling = false;
            app.emit("youtube:error", &json!({ "error": format!("Quota exceeded: {msg}"), "type": "quota_exceeded" }));
            return false;
        }
        Err(e) => {
            r.retry_count += 1;
            if r.retry_count >= 3 {
                app.log("error", format!("YouTube polling failed after 3 retries: {e}"));
                let _ = app.state().get_db().update_stream_status(&t.stream_id, "error");
                app.state().status_mut().is_polling = false;
                app.emit("youtube:error", &json!({ "error": format!("Polling failed: {e}"), "type": "poll_error" }));
                return false;
            }
            r.interval_ms = r.interval_ms.saturating_mul(2).min(300_000);
            app.log("warn", format!("YouTube poll error (retry {}): {e}", r.retry_count));
            return true;
        }
    };
    r.retry_count = 0;

    // Respect the API's pollingIntervalMillis.
    if let Some(api_interval) = response.polling_interval_millis {
        if api_interval > r.interval_ms {
            r.interval_ms = api_interval;
        }
    }
    let new_page_token = response.next_page_token.clone();

    if let Ok(quota) = app.state().get_db().add_quota_usage_typed(5, "chat") {
        app.emit("youtube:quota-update", &quota);
    }

    let items = response.items.unwrap_or_default();
    let mut new_messages = 0i64;
    let mut new_ideas = 0i64;
    for item in &items {
        new_messages += 1;
        if handle_message(app, t, cfg, r, item) {
            new_ideas += 1;
        }
    }

    // Leaderboard after each batch so every page stays in sync.
    if new_messages > 0 {
        if let Ok(leaderboard) = app.state().get_db().get_leaderboard(100) {
            app.emit("youtube:leaderboard-update", &leaderboard);
        }
    }

    // Peak concurrent chatters (rolling window).
    r.recent_chatters.retain(|_, seen| seen.elapsed() < CONCURRENT_WINDOW);
    if !r.recent_chatters.is_empty() {
        let _ = app.state().get_db().update_stream_peak(&t.stream_id, r.recent_chatters.len() as i64);
    }

    // === Adaptive polling ===
    if new_messages == 0 {
        r.consecutive_empty_polls += 1;
    } else {
        r.consecutive_empty_polls = 0;
    }
    if cfg.adaptive_polling_enabled {
        let api_min_interval = response.polling_interval_millis.unwrap_or(initial_interval_ms);
        let idle_threshold = cfg.idle_threshold_polls.max(0) as u32;
        let half_idle = (idle_threshold / 2).max(1);
        if r.consecutive_empty_polls > idle_threshold {
            r.interval_ms = (api_min_interval * 2).min(cfg.max_poll_interval_ms.max(2000) as u64);
        } else if r.consecutive_empty_polls > half_idle {
            r.interval_ms = ((api_min_interval as f64) * 1.5) as u64;
        } else if new_messages > 50 {
            r.interval_ms = api_min_interval;
        }
    }

    poll_video_stats(app, t, cfg, r);
    poll_channel_stats(app, t, cfg, r);
    poll_subscribers(app, r);
    auto_poll(app, t, r);

    // Stream row + live status.
    let status = {
        let db = app.state().get_db();
        let _ = db.update_stream_poll(&t.stream_id, new_page_token.as_deref(), new_messages, new_ideas);
        let mut s = app.state().status_mut();
        s.messages_scanned += new_messages;
        s.ideas_captured += new_ideas;
        s.poll_interval_ms = r.interval_ms;
        s.last_poll_at = Some(now_millis());
        s.clone()
    };
    app.emit("youtube:poll-status", &status);
    r.page_token = new_page_token;
    true
}

/// One chat message. Returns true when it created a new idea.
fn handle_message(app: &App, t: &PollerTarget, cfg: &YouTubeSettings, r: &mut Run, item: &YouTubeChatItem) -> bool {
    let message_type = item.snippet.as_ref().and_then(|s| s.message_type.as_deref()).unwrap_or("");
    let author = item.author_details.as_ref();
    let author_name = author.and_then(|a| a.display_name.as_deref()).unwrap_or("Unknown").to_string();
    let author_channel = author.and_then(|a| a.channel_id.as_deref()).unwrap_or("").to_string();
    let author_image = author.and_then(|a| a.profile_image_url.as_deref()).unwrap_or("").to_string();
    let is_mod = author.and_then(|a| a.is_chat_moderator).unwrap_or(false);
    let is_sponsor = author.and_then(|a| a.is_chat_sponsor).unwrap_or(false);
    let is_chat_owner = author.and_then(|a| a.is_chat_owner).unwrap_or(false);

    // Track every chatter (global + per-stream stats and badges).
    if !author_channel.is_empty() {
        r.recent_chatters.insert(author_channel.clone(), Instant::now());
        let db = app.state().get_db();
        let _ = db.get_or_create_user_stats(&author_channel, &author_name, cfg.starting_points);
        let _ = db.update_user_badges(&author_channel, is_mod, is_sponsor, is_chat_owner, &author_image);
        let _ = db.record_message(&author_channel);
        let _ = db.ensure_stream_user_stats(&t.stream_id, &author_channel, &author_name, &author_image);
        let _ = db.update_stream_user_badges(&t.stream_id, &author_channel, is_mod, is_sponsor, is_chat_owner);
        let _ = db.record_stream_message(&t.stream_id, &author_channel);
    }

    let snippet = item.snippet.as_ref();
    match message_type {
        "textMessageEvent" => {
            let display_message = snippet.and_then(|s| s.display_message.as_deref()).unwrap_or("");

            if cfg.chat_xp_enabled && cfg.chat_xp_amount > 0 && !author_channel.is_empty()
                && !is_on_cooldown(&r.cooldowns, &author_channel, CommandType::ChatXP, cfg.chat_xp_cooldown_secs)
            {
                let _ = app.state().get_db().award_points(&author_channel, cfg.chat_xp_amount, "chat_xp", None);
                r.cooldowns.insert((author_channel.clone(), CommandType::ChatXP), Instant::now());
            }

            if cfg.slot_enabled && is_command(display_message, &cfg.slot_command_prefix) {
                if is_on_cooldown(&r.cooldowns, &author_channel, CommandType::SlotPull, cfg.slot_cooldown_secs) {
                    return false;
                }
                let pull = {
                    let db = app.state().get_db();
                    // Live settings: pay table / jackpot options may change mid-stream.
                    let live = db.get_settings().unwrap_or_else(|_| cfg.clone());
                    match slots::run_pull(&db, &live, &author_name, &author_channel, &t.video_id, OnBroke::Skip) {
                        Ok(Some(pull)) => {
                            let _ = db.record_stream_slot_pull(&t.stream_id, &pull.author_channel_id, pull.is_jackpot);
                            if let Some(change) = pull.points_change.filter(|c| *c < 0) {
                                let _ = db.record_stream_points_spent(&t.stream_id, &pull.author_channel_id, change.abs());
                            }
                            Some(pull)
                        }
                        Ok(None) => None, // not enough points: skipped silently
                        Err(e) => {
                            app.log("debug", e);
                            None
                        }
                    }
                };
                if let Some(pull) = pull {
                    r.cooldowns.insert((author_channel.clone(), CommandType::SlotPull), Instant::now());
                    app.emit("youtube:slot-pull", &pull);
                }
                return false;
            }

            if !cfg.ideas_enabled {
                return false;
            }
            let Some(parsed) = parse_chat_command(display_message, &cfg.command_prefix) else {
                return false;
            };
            if is_on_cooldown(&r.cooldowns, &author_channel, CommandType::Idea, cfg.idea_cooldown_secs) {
                return false;
            }
            let published_at = snippet
                .and_then(|s| s.published_at.as_deref())
                .and_then(parse_iso_timestamp)
                .unwrap_or_else(now_millis);
            let (proj_id, proj_name) = app.state().get_active_project();
            let created = app.state().get_db().create_chat_idea(
                &gen_id(),
                &t.stream_id,
                &item.id,
                &author_name,
                &author_channel,
                &author_image,
                display_message,
                &parsed.content,
                published_at,
                proj_id.as_deref(),
                proj_name.as_deref(),
            );
            match created {
                Ok(Some(idea)) => {
                    r.cooldowns.insert((author_channel.clone(), CommandType::Idea), Instant::now());
                    {
                        let db = app.state().get_db();
                        if cfg.idea_points_reward > 0 {
                            let _ = db.award_points(&author_channel, cfg.idea_points_reward, "idea_submitted", Some(&idea.id));
                            let _ = db.record_stream_points_earned(&t.stream_id, &author_channel, cfg.idea_points_reward);
                        }
                        let _ = db.record_idea_submitted(&author_channel);
                        let _ = db.record_stream_idea(&t.stream_id, &author_channel);
                    }
                    app.emit("youtube:chat-idea", &idea);
                    true
                }
                Ok(None) => false, // duplicate message id
                Err(e) => {
                    app.log("debug", format!("Failed to create chat idea: {e}"));
                    false
                }
            }
        }
        "superChatEvent" if cfg.alerts_enabled => {
            let d = snippet.and_then(|s| s.super_chat_details.as_ref());
            let mut a = alert("super_chat", author_name, author_channel, author_image, d.and_then(|d| d.user_comment.clone()));
            a.amount = d.and_then(|d| d.amount_display_string.clone());
            a.currency = d.and_then(|d| d.currency.clone());
            a.tier = d.and_then(|d| d.tier);
            app.emit("youtube:alert", &a);
            false
        }
        "superStickerEvent" if cfg.alerts_enabled => {
            let d = snippet.and_then(|s| s.super_sticker_details.as_ref());
            let alt = d.and_then(|d| d.super_sticker_metadata.as_ref()).and_then(|m| m.alt_text.clone());
            let mut a = alert("super_sticker", author_name, author_channel, author_image, alt);
            a.amount = d.and_then(|d| d.amount_display_string.clone());
            a.currency = d.and_then(|d| d.currency.clone());
            a.tier = d.and_then(|d| d.tier);
            app.emit("youtube:alert", &a);
            false
        }
        "newSponsorEvent" if cfg.alerts_enabled => {
            let a = alert("new_member", author_name, author_channel, author_image, Some("Welcome new member!".to_string()));
            app.emit("youtube:alert", &a);
            false
        }
        "memberMilestoneChatEvent" if cfg.alerts_enabled => {
            let msg = snippet.and_then(|s| s.display_message.clone());
            let mut a = alert("milestone", author_name, author_channel, author_image, msg.clone());
            a.milestone_months = msg;
            app.emit("youtube:alert", &a);
            false
        }
        "giftMembershipReceivedEvent" | "membershipGiftingEvent" if cfg.alerts_enabled => {
            let msg = snippet.and_then(|s| s.display_message.clone());
            let mut a = alert("gift_membership", author_name, author_channel, author_image, msg.clone());
            a.gift_count = msg;
            app.emit("youtube:alert", &a);
            false
        }
        _ => false,
    }
}

fn poll_video_stats(app: &App, t: &PollerTarget, cfg: &YouTubeSettings, r: &mut Run) {
    if !cfg.video_stats_enabled {
        return;
    }
    // Viewer counts are stable while chat is idle for long: skip then.
    let idle = cfg.adaptive_polling_enabled && r.consecutive_empty_polls > cfg.very_idle_threshold_polls.max(0) as u32;
    let due = r.video_stats_last_poll.map_or(true, |t0| t0.elapsed().as_secs() >= cfg.video_stats_interval_secs.max(0) as u64);
    if idle || !due {
        return;
    }
    match youtube_api::poll_video_stats(app.http(), &t.api_key, &t.video_id) {
        Ok(stats) => {
            let views_changed = r.last_video_views.map_or(true, |v| v != stats.view_count);
            r.last_video_views = Some(stats.view_count);
            if views_changed || stats.concurrent_viewers.is_some() {
                app.emit("youtube:video-stats", &stats);
            }
        }
        Err(e) => app.log("debug", format!("Failed to poll video stats: {e}")),
    }
    let _ = app.state().get_db().add_quota_usage_typed(1, "video_stats");
    r.video_stats_last_poll = Some(Instant::now());
}

fn poll_channel_stats(app: &App, t: &PollerTarget, cfg: &YouTubeSettings, r: &mut Run) {
    if !cfg.channel_stats_enabled || t.channel_id.is_empty() {
        return;
    }
    let skip = cfg.adaptive_polling_enabled && r.channel_stats_skip_count >= cfg.channel_skip_threshold.max(0) as u32;
    let interval = cfg.channel_stats_interval_secs.max(0) as u64;
    let due = r.channel_stats_last_poll.map_or(true, |t0| t0.elapsed().as_secs() >= interval);
    if skip {
        // Check again at least every 5 normal intervals.
        if r.channel_stats_last_poll.map_or(true, |t0| t0.elapsed().as_secs() >= interval * 5) {
            r.channel_stats_skip_count = 0;
        }
        return;
    }
    if !due {
        return;
    }
    match youtube_api::poll_channel_stats(app.http(), &t.api_key, &t.channel_id) {
        Ok(stats) => {
            if r.last_channel_subs.map_or(true, |s| s != stats.subscriber_count) {
                r.channel_stats_skip_count = 0;
            } else {
                r.channel_stats_skip_count += 1;
            }
            r.last_channel_subs = Some(stats.subscriber_count);
            // Subscriber-count fallback detection (no OAuth needed).
            if let Some(prev) = r.last_known_sub_count {
                for _ in 0..(stats.subscriber_count - prev).clamp(0, 5) {
                    let a = alert("new_subscriber", "Someone".into(), String::new(), String::new(), Some("New subscriber!".into()));
                    app.emit("youtube:alert", &a);
                }
            }
            r.last_known_sub_count = Some(stats.subscriber_count);
            app.emit("youtube:channel-stats", &stats);
        }
        Err(e) => app.log("debug", format!("Failed to poll channel stats: {e}")),
    }
    let _ = app.state().get_db().add_quota_usage_typed(1, "channel_stats");
    r.channel_stats_last_poll = Some(Instant::now());
}

fn poll_subscribers(app: &App, r: &mut Run) {
    let Ok(s) = app.state().get_db().get_settings() else { return };
    if !s.subscribers_enabled {
        return;
    }
    let interval = s.subscribers_poll_interval_secs.max(30) as u64;
    if !r.subscriber_last_poll.map_or(true, |t0| t0.elapsed().as_secs() >= interval) {
        return;
    }
    let first_poll = r.subscriber_last_poll.is_none();
    if let Ok(token) = oauth::ensure_valid_token(app) {
        match youtube_api::poll_subscribers(app.http(), &token) {
            Ok(subs) => {
                for sub in &subs {
                    let inserted = app.state().get_db().insert_subscriber_if_new(
                        &sub.id,
                        &sub.channel_id,
                        &sub.channel_title,
                        &sub.thumbnail_url,
                        &sub.subscribed_at,
                    );
                    // The first poll only records existing subscribers (no alert spam).
                    if matches!(inserted, Ok(true)) && !first_poll {
                        let a = alert(
                            "new_subscriber",
                            sub.channel_title.clone(),
                            sub.channel_id.clone(),
                            sub.thumbnail_url.clone(),
                            Some(format!("{} just subscribed!", sub.channel_title)),
                        );
                        app.emit("youtube:alert", &a);
                        app.emit("youtube:new-subscriber", sub);
                    }
                }
            }
            Err(e) => {
                app.log("debug", format!("Failed to poll subscribers: {e}"));
                let msg = e.to_string();
                if msg.contains("401") || msg.contains("Unauthorized") {
                    let _ = app.state().get_db().clear_oauth_tokens();
                    app.emit(
                        "youtube:oauth-status",
                        &json!({ "status": "disconnected", "message": "Token expired and refresh failed. Please re-authorize." }),
                    );
                }
            }
        }
    }
    r.subscriber_last_poll = Some(Instant::now());
}

fn auto_poll(app: &App, t: &PollerTarget, r: &mut Run) {
    let Ok(s) = app.state().get_db().get_settings() else { return };
    if !(s.yt_poll_enabled && s.yt_poll_auto_enabled) {
        return;
    }
    let interval = s.yt_poll_auto_interval_secs.max(60) as u64;
    if !r.auto_poll_last_check.map_or(true, |t0| t0.elapsed().as_secs() >= interval) {
        return;
    }
    r.auto_poll_last_check = Some(Instant::now());
    let has_active = app.state().get_db().get_active_poll(&t.stream_id).ok().flatten().is_some();
    if has_active || oauth::ensure_valid_token(app).is_err() {
        return;
    }
    app.log("info", format!("Auto-poll: generating AI poll for stream {}", t.stream_id));
    let context = commands::poll_context(app, Some(&t.stream_id), s.yt_poll_auto_use_chat_context, s.yt_poll_auto_use_ide_context.then_some("Context: User is coding in a programming IDE during a live stream."), None);
    match commands::generate_poll(app, &context) {
        Ok(generated) => match commands::create_poll_internal(
            app,
            &t.stream_id,
            &t.live_chat_id,
            &generated.question,
            &generated.options,
            "ai_generated",
            Some(&generated.source_context),
            s.yt_poll_default_duration_secs,
        ) {
            Ok(poll) => {
                app.log("info", format!("Auto-poll created: {}", poll.question));
                app.emit("youtube:poll-created", &poll);
            }
            Err(e) => app.log("warn", format!("Failed to create auto-poll: {e}")),
        },
        Err(e) => app.log("warn", format!("Failed to generate AI poll: {e}")),
    }
}
