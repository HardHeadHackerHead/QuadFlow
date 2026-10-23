//! Request handlers: one per former `youtube_*` Tauri command (method name =
//! command name without the prefix, params = the old `invoke` args). Errors
//! are the old `String` messages.

use crate::ai;
use crate::creds::get_effective_api_key;
use crate::models::*;
use crate::oauth;
use crate::poller::{self, PollerTarget};
use crate::slots::{self, OnBroke};
use crate::state::{App, PollerCommand};
use crate::util::*;
use crate::youtube_api;
use quadflow_sidecar::{json, Value};
use rand::Rng;
use serde::de::DeserializeOwned;
use serde::Serialize;

type R = std::result::Result<Value, String>;

fn ok<T: Serialize>(v: T) -> R {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The first present, non-null key among `keys` (camelCase as `invoke` sent
/// it, plus the snake_case spelling some old callers used).
fn raw<'a>(p: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| p.get(*k).filter(|v| !v.is_null()))
}

fn opt<T: DeserializeOwned>(p: &Value, keys: &[&str]) -> std::result::Result<Option<T>, String> {
    match raw(p, keys) {
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| format!("invalid `{}`: {e}", keys[0])),
        None => Ok(None),
    }
}

fn req<T: DeserializeOwned>(p: &Value, keys: &[&str]) -> std::result::Result<T, String> {
    opt(p, keys)?.ok_or_else(|| format!("missing parameter `{}`", keys[0]))
}

/// `Some(None)` when the key is present and null (clear), `None` when absent.
fn nullable(p: &Value, keys: &[&str]) -> std::result::Result<Option<Option<String>>, String> {
    for k in keys {
        if let Some(v) = p.get(*k) {
            return match v {
                Value::Null => Ok(Some(None)),
                Value::String(s) => Ok(Some(Some(s.clone()))),
                _ => Err(format!("invalid `{}`: expected a string or null", keys[0])),
            };
        }
    }
    Ok(None)
}

/// The `request` object of commands that took one (empty object when absent).
fn request<T: DeserializeOwned>(p: &Value) -> std::result::Result<T, String> {
    let r = p.get("request").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!({}));
    serde_json::from_value(r).map_err(|e| format!("invalid `request`: {e}"))
}

/// Every method the sidecar serves.
pub const METHODS: &[&str] = &[
    "set_active_project",
    "get_settings",
    "update_settings",
    "search_streams",
    "connect_stream",
    "disconnect_stream",
    "list_streams",
    "list_chat_ideas",
    "get_chat_idea",
    "promote_to_issue",
    "dismiss_idea",
    "hide_idea",
    "get_quota",
    "get_poll_status",
    "list_slot_pulls",
    "list_slot_symbols",
    "list_all_slot_symbols",
    "create_slot_symbol",
    "update_slot_symbol",
    "delete_slot_symbol",
    "get_progressive_pool",
    "get_symbol_of_day",
    "get_slot_stats",
    "list_paytable",
    "create_paytable_entry",
    "update_paytable_entry",
    "delete_paytable_entry",
    "list_prize_log",
    "mark_prize_redeemed",
    "count_unredeemed_prizes",
    "get_leaderboard",
    "get_user_stats",
    "get_stream_leaderboard",
    "get_stream_stats",
    "get_all_stream_stats",
    "test_idea",
    "test_slot_pull",
    "test_alert",
    "test_video_stats",
    "test_channel_stats",
    "list_subscribers",
    "test_subscriber",
    "get_quota_breakdown",
    "set_quota_usage",
    "reset_quota_usage",
    "get_points_history",
    "list_goals",
    "create_goal",
    "toggle_goal",
    "update_goal_stream",
    "delete_goal",
    "start_oauth_flow",
    "disconnect_oauth",
    "get_oauth_status",
    "refresh_oauth_token",
    "create_poll",
    "get_active_poll",
    "get_poll_results",
    "close_poll",
    "list_stream_polls",
    "list_all_polls",
    "list_poll_templates",
    "create_poll_from_template",
    "generate_ai_poll",
    "tts_speak",
];

pub fn dispatch(app: &App, method: &str, p: &Value) -> R {
    let st = app.state();
    match method {
        "set_active_project" => {
            st.set_active_project(opt(p, &["projectId", "project_id"])?, opt(p, &["projectName", "project_name"])?);
            Ok(Value::Null)
        }
        "get_settings" => ok(st.get_db().get_settings().map_err(es)?.masked()),
        "update_settings" => update_settings(app, p),
        "search_streams" => search_streams(app, request(p)?),
        "connect_stream" => connect_stream(app, request(p)?),
        "disconnect_stream" => {
            disconnect_stream(app);
            Ok(Value::Null)
        }
        "list_streams" => ok(st.get_db().list_streams().map_err(es)?),
        "list_chat_ideas" => {
            let r: ListChatIdeasRequest = request(p)?;
            ok(st.get_db().list_chat_ideas(r.stream_id.as_deref(), r.status.as_deref()).map_err(es)?)
        }
        "get_chat_idea" => ok(st.get_db().get_chat_idea(&req::<String>(p, &["ideaId", "idea_id"])?).map_err(es)?),
        "promote_to_issue" => promote_to_issue(app, request(p)?),
        "dismiss_idea" | "hide_idea" => {
            let id: String = req(p, &["ideaId", "idea_id"])?;
            let status = if method == "dismiss_idea" { ChatIdeaStatus::Dismissed } else { ChatIdeaStatus::Hidden };
            let db = st.get_db();
            db.update_idea_status(&id, status.as_str(), None).map_err(es)?;
            ok(db.get_chat_idea(&id).map_err(es)?)
        }
        "get_quota" => ok(st.get_db().get_quota_usage().map_err(es)?),
        "get_poll_status" => ok(st.get_poll_status()),
        "list_slot_pulls" => ok(st
            .get_db()
            .list_slot_pulls(opt::<String>(p, &["videoId", "video_id"])?.as_deref(), opt(p, &["limit"])?.unwrap_or(50))
            .map_err(es)?),
        "list_slot_symbols" => ok(st.get_db().list_slot_symbols().map_err(es)?),
        "list_all_slot_symbols" => ok(st.get_db().list_all_slot_symbols().map_err(es)?),
        "create_slot_symbol" => ok(st
            .get_db()
            .create_slot_symbol(
                &req::<String>(p, &["name"])?,
                &req::<String>(p, &["emoji"])?,
                req(p, &["weight"])?,
                opt(p, &["isWild", "is_wild"])?.unwrap_or(false),
            )
            .map_err(es)?),
        "update_slot_symbol" => ok(st
            .get_db()
            .update_slot_symbol(
                &req::<String>(p, &["id"])?,
                opt::<String>(p, &["name"])?.as_deref(),
                opt::<String>(p, &["emoji"])?.as_deref(),
                opt(p, &["weight"])?,
                opt(p, &["enabled"])?,
                opt(p, &["isWild", "is_wild"])?,
            )
            .map_err(es)?),
        "delete_slot_symbol" => {
            st.get_db().delete_slot_symbol(&req::<String>(p, &["id"])?).map_err(es)?;
            Ok(Value::Null)
        }
        "get_progressive_pool" => st.get_db().progressive_pool_info().map_err(es),
        "get_symbol_of_day" => {
            let db = st.get_db();
            match db.get_symbol_of_day().map_err(es)? {
                Some((name, multiplier)) => {
                    let emoji = db
                        .list_slot_symbols()
                        .unwrap_or_default()
                        .into_iter()
                        .find(|s| s.name == name)
                        .map(|s| s.emoji)
                        .unwrap_or_default();
                    // `symbol_name` is what the UI reads; `name` kept for old callers.
                    Ok(json!({ "symbol_name": name, "name": name, "emoji": emoji, "multiplier": multiplier }))
                }
                None => Ok(Value::Null),
            }
        }
        "get_slot_stats" => st.get_db().slot_stats().map_err(es),
        "list_paytable" => ok(st.get_db().list_paytable_entries().map_err(es)?),
        "create_paytable_entry" => ok(st
            .get_db()
            .create_paytable_entry(
                req(p, &["priority"])?,
                &req::<String>(p, &["matchType", "match_type"])?,
                opt::<String>(p, &["symbol"])?.as_deref(),
                &req::<String>(p, &["prizeType", "prize_type"])?,
                req(p, &["pointsAmount", "points_amount"])?,
                opt::<String>(p, &["prizeName", "prize_name"])?.as_deref(),
                opt::<String>(p, &["prizeDescription", "prize_description"])?.as_deref(),
                opt(p, &["freeSpinsAwarded", "free_spins_awarded"])?,
            )
            .map_err(es)?),
        "update_paytable_entry" => {
            let symbol = nullable(p, &["symbol"])?;
            let prize_name = nullable(p, &["prizeName", "prize_name"])?;
            let prize_description = nullable(p, &["prizeDescription", "prize_description"])?;
            ok(st
                .get_db()
                .update_paytable_entry(
                    &req::<String>(p, &["id"])?,
                    opt(p, &["priority"])?,
                    opt::<String>(p, &["matchType", "match_type"])?.as_deref(),
                    symbol.as_ref().map(|s| s.as_deref()),
                    opt::<String>(p, &["prizeType", "prize_type"])?.as_deref(),
                    opt(p, &["pointsAmount", "points_amount"])?,
                    prize_name.as_ref().map(|s| s.as_deref()),
                    prize_description.as_ref().map(|s| s.as_deref()),
                    opt(p, &["enabled"])?,
                    opt(p, &["freeSpinsAwarded", "free_spins_awarded"])?,
                )
                .map_err(es)?)
        }
        "delete_paytable_entry" => {
            st.get_db().delete_paytable_entry(&req::<String>(p, &["id"])?).map_err(es)?;
            Ok(Value::Null)
        }
        "list_prize_log" => ok(st
            .get_db()
            .list_prize_log(
                opt(p, &["limit"])?.unwrap_or(50),
                opt(p, &["offset"])?.unwrap_or(0),
                opt(p, &["unredeemedOnly", "unredeemed_only"])?.unwrap_or(false),
            )
            .map_err(es)?),
        "mark_prize_redeemed" => ok(st
            .get_db()
            .mark_prize_redeemed(&req::<String>(p, &["id"])?, opt::<String>(p, &["note"])?.as_deref())
            .map_err(es)?),
        "count_unredeemed_prizes" => ok(st.get_db().count_unredeemed_prizes().map_err(es)?),
        "get_leaderboard" => ok(st.get_db().get_leaderboard(opt(p, &["limit"])?.unwrap_or(10)).map_err(es)?),
        "get_user_stats" => ok(st
            .get_db()
            .get_user_stats(&req::<String>(p, &["authorChannelId", "author_channel_id"])?)
            .map_err(es)?),
        "get_stream_leaderboard" => ok(st
            .get_db()
            .get_stream_leaderboard(
                &req::<String>(p, &["streamId", "stream_id"])?,
                opt::<String>(p, &["sortBy", "sort_by"])?.as_deref().unwrap_or("messages"),
                opt(p, &["limit"])?.unwrap_or(100),
            )
            .map_err(es)?),
        "get_stream_stats" => ok(st.get_db().get_stream_stats(&req::<String>(p, &["streamId", "stream_id"])?).map_err(es)?),
        "get_all_stream_stats" => ok(st.get_db().get_all_stream_stats(opt(p, &["limit"])?.unwrap_or(50)).map_err(es)?),
        "test_idea" => test_idea(app),
        "test_slot_pull" => test_slot_pull(app),
        "test_alert" => {
            test_alert(app);
            Ok(Value::Null)
        }
        "test_video_stats" => {
            let mut rng = rand::thread_rng();
            let stats = VideoStats {
                view_count: rng.gen_range(100..50_000),
                like_count: rng.gen_range(10..5_000),
                comment_count: rng.gen_range(5..1_000),
                concurrent_viewers: Some(rng.gen_range(5..500)),
            };
            app.emit("youtube:video-stats", &stats);
            Ok(Value::Null)
        }
        "test_channel_stats" => {
            let mut rng = rand::thread_rng();
            let stats = ChannelStats {
                subscriber_count: rng.gen_range(100..1_000_000),
                hidden_subscriber_count: false,
                total_view_count: rng.gen_range(10_000..10_000_000),
                video_count: rng.gen_range(10..500),
            };
            app.emit("youtube:channel-stats", &stats);
            Ok(Value::Null)
        }
        "list_subscribers" => ok(st.get_db().list_subscribers(opt(p, &["limit"])?.unwrap_or(50)).map_err(es)?),
        "test_subscriber" => test_subscriber(app),
        "get_quota_breakdown" => ok(st.get_db().get_quota_breakdown().map_err(es)?),
        "set_quota_usage" => ok(st.get_db().set_quota_usage(req(p, &["unitsUsed", "units_used"])?).map_err(es)?),
        "reset_quota_usage" => ok(st.get_db().reset_quota_usage().map_err(es)?),
        "get_points_history" => {
            let r: GetPointsHistoryRequest = request(p)?;
            ok(st
                .get_db()
                .get_points_history(&r.author_channel_id, r.limit.unwrap_or(50), r.offset.unwrap_or(0))
                .map_err(es)?)
        }
        "list_goals" => ok(st.get_db().list_goals().map_err(es)?),
        "create_goal" => ok(st
            .get_db()
            .create_goal(&req::<String>(p, &["title"])?, opt::<String>(p, &["streamId", "stream_id"])?.as_deref())
            .map_err(es)?),
        "toggle_goal" => ok(st.get_db().toggle_goal(&req::<String>(p, &["id"])?, req(p, &["completed"])?).map_err(es)?),
        "update_goal_stream" => ok(st
            .get_db()
            .update_goal_stream(&req::<String>(p, &["id"])?, opt::<String>(p, &["streamId", "stream_id"])?.as_deref())
            .map_err(es)?),
        "delete_goal" => {
            st.get_db().delete_goal(&req::<String>(p, &["id"])?).map_err(es)?;
            Ok(Value::Null)
        }
        "start_oauth_flow" => oauth::start_flow(app).map(|_| Value::Null),
        "disconnect_oauth" => {
            let settings = {
                let db = st.get_db();
                db.clear_oauth_tokens().map_err(es)?;
                db.get_settings().map_err(es)?
            };
            app.emit("youtube:oauth-status", &json!({ "status": "disconnected", "message": "OAuth disconnected" }));
            app.emit("youtube:settings-changed", &settings.masked());
            Ok(Value::Null)
        }
        "get_oauth_status" => ok(oauth::status(st).map_err(es)?),
        "refresh_oauth_token" => {
            oauth::ensure_valid_token(app).map_err(es)?;
            app.emit("youtube:oauth-status", &json!({ "status": "connected", "message": "Token refreshed successfully" }));
            ok(oauth::status(st).map_err(es)?)
        }
        "create_poll" => create_poll(app, request(p)?),
        "get_active_poll" => {
            let Some(stream_id) = st.get_poll_status().stream_id else { return Ok(Value::Null) };
            let db = st.get_db();
            match db.get_active_poll(&stream_id).map_err(es)? {
                Some(poll) => ok(db.get_poll_results(&poll.id).map_err(es)?),
                None => Ok(Value::Null),
            }
        }
        "get_poll_results" => ok(st.get_db().get_poll_results(&req::<String>(p, &["pollId", "poll_id"])?).map_err(es)?),
        "close_poll" => {
            let id: String = req(p, &["pollId", "poll_id"])?;
            let results = {
                let db = st.get_db();
                db.close_poll(&id).map_err(es)?;
                db.get_poll_results(&id).map_err(es)?
            };
            app.emit("youtube:poll-closed", &results);
            ok(results)
        }
        "list_stream_polls" => {
            let Some(stream_id) = st.get_poll_status().stream_id else { return Ok(json!([])) };
            ok(st.get_db().list_stream_polls(&stream_id, opt(p, &["limit"])?.unwrap_or(20)).map_err(es)?)
        }
        "list_all_polls" => ok(st.get_db().list_all_polls(opt(p, &["limit"])?.unwrap_or(100)).map_err(es)?),
        "list_poll_templates" => ok(st.get_db().list_poll_templates(opt::<String>(p, &["category"])?.as_deref()).map_err(es)?),
        "create_poll_from_template" => {
            let template = st.get_db().get_poll_template(&req::<String>(p, &["templateId", "template_id"])?).map_err(es)?;
            create_poll(
                app,
                CreateYTPollRequest {
                    question: template.question,
                    options: template.options,
                    duration_secs: opt(p, &["durationSecs", "duration_secs"])?,
                },
            )
        }
        "generate_ai_poll" => {
            let r: GenerateAIPollRequest = request(p)?;
            let stream_id = st.get_poll_status().stream_id;
            let ide = r.ide_context.filter(|c| !c.is_empty()).map(|c| format!("IDE Context:\n{c}"));
            let context = poll_context(app, stream_id.as_deref(), r.use_chat_context.unwrap_or(true), ide.as_deref(), r.topic.as_deref());
            ok(generate_poll(app, &context)?)
        }
        "tts_speak" => ok(ai::tts_speak(app, &req::<String>(p, &["text"])?).map_err(es)?),
        _ => Err(format!("unknown method {method}")),
    }
}

fn update_settings(app: &App, p: &Value) -> R {
    let patch = p.get("request").cloned().unwrap_or_else(|| json!({}));
    let settings = app.state().get_db().update_settings(&patch).map_err(es)?;
    // A running poller picks up a new interval at once.
    if let Some(interval) = patch.get("poll_interval_ms").and_then(Value::as_i64) {
        if let Some(tx) = app.state().poller_control.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(PollerCommand::UpdateInterval(interval.max(2000) as u64));
        }
    }
    let masked = settings.masked();
    app.emit("youtube:settings-changed", &masked);
    ok(masked)
}

fn search_streams(app: &App, r: SearchStreamsRequest) -> R {
    let (api_key, channel_id, quota) = {
        let db = app.state().get_db();
        let settings = db.get_settings().map_err(es)?;
        let api_key = get_effective_api_key(&settings).map_err(es)?;
        let channel_id = r
            .channel_id
            .filter(|c| !c.is_empty())
            .or(settings.channel_id)
            .ok_or_else(|| "Channel ID not provided. Please enter a channel ID.".to_string())?;
        (api_key, channel_id, db.add_quota_usage_typed(100, "search").ok())
    };
    if let Some(q) = quota {
        app.emit("youtube:quota-update", &q);
    }
    ok(youtube_api::search_live_streams(app.http(), &api_key, &channel_id).map_err(es)?)
}

fn stop_poller(app: &App) -> bool {
    match app.state().poller_control.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(tx) => {
            let _ = tx.send(PollerCommand::Stop);
            true
        }
        None => false,
    }
}

fn connect_stream(app: &App, r: ConnectStreamRequest) -> R {
    let video_id = extract_video_id(&r.video_input).ok_or_else(|| "Could not extract a valid video ID from the input.".to_string())?;
    let (api_key, settings, quota) = {
        let db = app.state().get_db();
        let settings = db.get_settings().map_err(es)?;
        let api_key = get_effective_api_key(&settings).map_err(es)?;
        (api_key, settings, db.add_quota_usage_typed(1, "chat").ok())
    };
    if let Some(q) = quota {
        app.emit("youtube:quota-update", &q);
    }
    let (live_chat_id, title, channel_title) = youtube_api::get_video_live_details(app.http(), &api_key, &video_id).map_err(es)?;

    // Reuse the stream record when reconnecting to the same video (keeps the page token).
    let stream = {
        let db = app.state().get_db();
        match db.find_stream_by_video_id(&video_id) {
            Some(existing) => {
                let _ = db.update_stream_status(&existing.id, "active");
                existing
            }
            None => db.create_stream(&gen_id(), &video_id, &title, &channel_title, &live_chat_id).map_err(es)?,
        }
    };
    {
        let status = app.state().get_poll_status();
        if status.is_polling && status.video_id.as_deref() == Some(&video_id) {
            app.log("info", format!("Already polling video {video_id}, skipping duplicate connect"));
            return ok(stream);
        }
    }
    if stop_poller(app) {
        app.log("info", "Stopping existing poller before starting new connection");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    {
        let mut s = app.state().status_mut();
        s.is_polling = true;
        s.stream_id = Some(stream.id.clone());
        s.video_id = Some(video_id.clone());
        s.stream_title = Some(title.clone());
        s.messages_scanned = 0;
        s.ideas_captured = 0;
        s.poll_interval_ms = settings.poll_interval_ms.max(5000) as u64;
        s.last_poll_at = None;
    }
    let (tx, rx) = std::sync::mpsc::channel::<PollerCommand>();
    *app.state().poller_control.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let target = PollerTarget {
        stream_id: stream.id.clone(),
        video_id,
        live_chat_id,
        api_key,
        channel_id: settings.channel_id.clone().unwrap_or_default(),
    };
    let poller_app = app.clone();
    std::thread::Builder::new()
        .name("youtube-poller".into())
        .spawn(move || poller::run_poller(poller_app, target, settings, rx))
        .map_err(es)?;
    ok(stream)
}

pub fn disconnect_stream(app: &App) {
    stop_poller(app);
    let stream_id = {
        let mut s = app.state().status_mut();
        s.is_polling = false;
        s.stream_id.clone()
    };
    if let Some(id) = stream_id {
        let _ = app.state().get_db().update_stream_status(&id, "ended");
    }
}

fn promote_to_issue(app: &App, r: PromoteToIssueRequest) -> R {
    let (idea, stream) = {
        let db = app.state().get_db();
        let idea = db.get_chat_idea(&r.idea_id).map_err(es)?;
        let stream = db.get_stream(&idea.stream_id).ok();
        (idea, stream)
    };
    let priority = match r.priority.as_deref() {
        Some(p @ ("low" | "high" | "critical")) => p,
        _ => "medium",
    };
    let body = format!(
        "From YouTube chat by **{}**\nStream: {}\nOriginal message: `{}`",
        idea.author_name,
        stream.as_ref().map(|s| s.title.as_str()).unwrap_or("Unknown"),
        idea.raw_message,
    );
    let host = app.host().ok_or_else(|| "Creating issues needs the QuadFlow host".to_string())?;
    let mut params = json!({
        "issue": {
            "title": idea.idea_content,
            "body": body,
            "status": "todo",
            "priority": priority,
            "labels": ["youtube-chat"],
        }
    });
    if let Some(root) = r.project_root.filter(|r| !r.is_empty()) {
        params["projectRoot"] = Value::String(root);
    }
    let issue = host.call("data.issues.create", params).map_err(|e| format!("Failed to create issue: {}", e.message))?;
    let issue_id = issue.get("id").and_then(Value::as_str).unwrap_or_default().to_string();

    let db = app.state().get_db();
    db.update_idea_status(&r.idea_id, ChatIdeaStatus::PromotedIssue.as_str(), Some(&issue_id)).map_err(es)?;
    let settings = db.get_settings().map_err(es)?;
    if settings.idea_approve_bonus > 0 && !idea.author_channel_id.is_empty() {
        let _ = db.get_or_create_user_stats(&idea.author_channel_id, &idea.author_name, settings.starting_points);
        let _ = db.award_points(&idea.author_channel_id, settings.idea_approve_bonus, "idea_approved", Some(&idea.id));
    }
    ok(db.get_chat_idea(&r.idea_id).map_err(es)?)
}

const TEST_NAMES: &[&str] = &[
    "StreamerFan42", "CodeMonkey99", "PixelNinja", "ByteWizard", "QuadLover", "TechSavvy", "ChatHero", "ViewerPrime",
    "NightOwlDev", "GigaCoder", "RustFanatic", "TypeScriptGuru", "AIEnthusiast", "OpenSourceFan", "DebugKing",
];

const TEST_IDEAS: &[&str] = &[
    "Add dark mode toggle to the settings panel",
    "Support for multiple monitor layouts",
    "Integrate with Discord for notifications",
    "Add a Pomodoro timer widget",
    "Custom keyboard shortcuts editor",
    "Git branch visualization tree",
    "Code snippet sharing to clipboard",
    "Auto-save session state on exit",
    "Plugin marketplace for extensions",
    "Voice command support for hands-free coding",
    "Split pane drag and drop reordering",
    "Built-in markdown preview",
    "Theme import/export functionality",
    "AI-powered code review suggestions",
    "Collaborative editing sessions",
];

fn test_name() -> String {
    TEST_NAMES[rand::thread_rng().gen_range(0..TEST_NAMES.len())].to_string()
}

/// A simulated chat idea (no live stream, no network).
fn test_idea(app: &App) -> R {
    let author_name = test_name();
    let author_channel_id = format!("test-channel-{}", author_name.to_lowercase());
    let idea_content = TEST_IDEAS[rand::thread_rng().gen_range(0..TEST_IDEAS.len())].to_string();
    let (proj_id, proj_name) = app.state().get_active_project();
    let (idea, leaderboard) = {
        let db = app.state().get_db();
        db.ensure_test_stream().map_err(es)?;
        let settings = db.get_settings().map_err(es)?;
        let idea = db
            .create_chat_idea(
                &gen_id(),
                "test-stream",
                &gen_id(),
                &author_name,
                &author_channel_id,
                "",
                &format!("!idea {idea_content}"),
                &idea_content,
                now_millis(),
                proj_id.as_deref(),
                proj_name.as_deref(),
            )
            .map_err(es)?
            .ok_or_else(|| "Duplicate test idea (try again)".to_string())?;
        let _ = db.get_or_create_user_stats(&author_channel_id, &author_name, settings.starting_points);
        if settings.idea_points_reward > 0 {
            let _ = db.award_points(&author_channel_id, settings.idea_points_reward, "idea_submitted", Some(&idea.id));
        }
        let _ = db.record_idea_submitted(&author_channel_id);
        (idea, db.get_leaderboard(100).ok())
    };
    app.emit("youtube:chat-idea", &idea);
    if let Some(l) = leaderboard {
        app.emit("youtube:leaderboard-update", &l);
    }
    ok(idea)
}

/// A simulated slot pull (no live stream, no network).
fn test_slot_pull(app: &App) -> R {
    let author_name = test_name();
    let author_channel_id = format!("test-channel-{}", author_name.to_lowercase());
    let (pull, leaderboard) = {
        let db = app.state().get_db();
        let settings = db.get_settings().map_err(es)?;
        let _ = db.get_or_create_user_stats(&author_channel_id, &author_name, settings.starting_points);
        let pull = slots::run_pull(&db, &settings, &author_name, &author_channel_id, "test-video", OnBroke::TopUp)?
            .ok_or_else(|| "Slot pull skipped".to_string())?;
        (pull, db.get_leaderboard(100).ok())
    };
    app.emit("youtube:slot-pull", &pull);
    if let Some(l) = leaderboard {
        app.emit("youtube:leaderboard-update", &l);
    }
    ok(pull)
}

fn test_alert(app: &App) {
    let mut rng = rand::thread_rng();
    let author_name = test_name();
    let kinds = ["super_chat", "new_member", "milestone", "gift_membership", "super_sticker"];
    let kind = kinds[rng.gen_range(0..kinds.len())];
    let paid = matches!(kind, "super_chat" | "super_sticker");
    let amounts = ["$2.00", "$5.00", "$10.00", "$20.00", "$50.00"];
    let alert = YouTubeAlertEvent {
        id: gen_id(),
        alert_type: kind.to_string(),
        author_name: author_name.clone(),
        author_channel_id: format!("test-channel-{}", author_name.to_lowercase()),
        author_profile_image: String::new(),
        message: Some(match kind {
            "super_chat" => "Great stream! Keep it up!".to_string(),
            "new_member" => "Welcome new member!".to_string(),
            "milestone" => format!("{author_name} has been a member for 6 months!"),
            "gift_membership" => format!("{author_name} gifted 5 memberships!"),
            _ => "Sent a super sticker!".to_string(),
        }),
        amount: paid.then(|| amounts[rng.gen_range(0..amounts.len())].to_string()),
        currency: paid.then(|| "USD".to_string()),
        tier: paid.then(|| rng.gen_range(1..=7)),
        milestone_months: (kind == "milestone").then(|| "6 months".to_string()),
        gift_count: (kind == "gift_membership").then(|| "5".to_string()),
        created_at: chrono_now_iso(),
    };
    app.emit("youtube:alert", &alert);
}

fn test_subscriber(app: &App) -> R {
    let author_name = test_name();
    let channel_id = format!("test-sub-{}", author_name.to_lowercase().replace(' ', "-"));
    let now = chrono_now_iso();
    let sub = Subscriber {
        id: gen_id(),
        channel_id: channel_id.clone(),
        channel_title: author_name.clone(),
        thumbnail_url: String::new(),
        subscribed_at: now.clone(),
        detected_at: now,
    };
    {
        let db = app.state().get_db();
        // Replace an earlier test subscriber with the same channel so the test always fires.
        let _ = db.delete_subscriber_by_channel(&channel_id);
        let _ = db.insert_subscriber_if_new(&sub.id, &sub.channel_id, &sub.channel_title, &sub.thumbnail_url, &sub.subscribed_at);
    }
    let alert = YouTubeAlertEvent {
        id: gen_id(),
        alert_type: "new_subscriber".to_string(),
        author_name: author_name.clone(),
        author_channel_id: channel_id,
        author_profile_image: String::new(),
        message: Some(format!("{author_name} just subscribed!")),
        amount: None,
        currency: None,
        tier: None,
        milestone_months: None,
        gift_count: None,
        created_at: chrono_now_iso(),
    };
    app.emit("youtube:alert", &alert);
    app.emit("youtube:new-subscriber", &sub);
    ok(sub)
}

// ---- Polls ----

/// Context for AI polls: IDE line, stream title + recent viewer ideas, topic.
pub fn poll_context(app: &App, stream_id: Option<&str>, use_chat: bool, ide: Option<&str>, topic: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(ide) = ide {
        parts.push(ide.to_string());
    }
    if use_chat {
        if let Some(title) = app.state().get_poll_status().stream_title {
            parts.push(format!("Current live stream: {title}"));
        }
        if let Some(sid) = stream_id {
            if let Ok(ideas) = app.state().get_db().list_chat_ideas(Some(sid), None) {
                let recent: Vec<String> = ideas.into_iter().take(10).map(|i| format!("{}: {}", i.author_name, i.idea_content)).collect();
                if !recent.is_empty() {
                    parts.push(format!("Recent viewer ideas from chat:\n{}", recent.join("\n")));
                }
            }
        }
    }
    if let Some(t) = topic.filter(|t| !t.is_empty()) {
        parts.push(format!("Requested topic: {t}"));
    }
    if parts.is_empty() {
        "No specific context provided. Generate a general coding/streaming engagement poll.".to_string()
    } else {
        parts.join("\n\n")
    }
}

pub fn generate_poll(app: &App, context: &str) -> std::result::Result<GeneratedPoll, String> {
    let user = format!("Generate an engaging poll based on this context:\n\n{context}");
    let content = ai::complete(app, ai::POLL_SYSTEM_PROMPT, &user).map_err(es)?;
    ai::parse_generated_poll(&content, context)
}

/// Store a poll and post it to the live chat (OAuth). A poll YouTube rejects is closed again.
#[allow(clippy::too_many_arguments)]
pub fn create_poll_internal(
    app: &App,
    stream_id: &str,
    live_chat_id: &str,
    question: &str,
    options: &[String],
    poll_type: &str,
    source_context: Option<&str>,
    duration: i64,
) -> std::result::Result<YTPoll, String> {
    if options.len() < 2 || options.len() > 4 {
        return Err("YouTube polls require 2-4 options".to_string());
    }
    let token = oauth::ensure_valid_token(app).map_err(es)?;
    let poll = app
        .state()
        .get_db()
        .create_poll(stream_id, question, options, poll_type, source_context, duration)
        .map_err(es)?;
    // The options array starts with the question text, then one entry per answer.
    let mut options_json = vec![json!({ "questionText": question })];
    options_json.extend(options.iter().map(|t| json!({ "optionText": t })));
    let body = json!({
        "snippet": {
            "liveChatId": live_chat_id,
            "type": "pollEvent",
            "pollDetails": { "metadata": { "options": options_json } }
        }
    });
    let resp = app
        .http()
        .post_json("https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet", &token, &body)
        .map_err(|e| format!("YouTube API request failed: {e}"))?;
    if !resp.is_success() {
        let _ = app.state().get_db().close_poll(&poll.id);
        return Err(format!("YouTube API error {}: {}", resp.status, resp.text()));
    }
    if let Ok(v) = resp.json::<Value>() {
        if let Some(yid) = v.get("id").and_then(Value::as_str) {
            let _ = app.state().get_db().update_poll_youtube_id(&poll.id, yid);
        }
    }
    Ok(poll)
}

fn create_poll(app: &App, r: CreateYTPollRequest) -> R {
    let stream_id = app.state().get_poll_status().stream_id.ok_or_else(|| "No active stream connected".to_string())?;
    let (live_chat_id, default_duration) = {
        let db = app.state().get_db();
        (db.get_stream(&stream_id).map_err(es)?.live_chat_id, db.get_settings().map_err(es)?.yt_poll_default_duration_secs)
    };
    let poll = create_poll_internal(
        app,
        &stream_id,
        &live_chat_id,
        &r.question,
        &r.options,
        "custom",
        None,
        r.duration_secs.unwrap_or(default_duration),
    )?;
    app.emit("youtube:poll-created", &poll);
    ok(poll)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::YouTubeLiveState;
    use std::sync::Arc;

    fn app() -> App {
        App::new(Arc::new(YouTubeLiveState::new(None, None)), None)
    }

    fn events(app: &App) -> Vec<String> {
        app.events.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
    }

    #[test]
    fn every_method_is_dispatched() {
        let a = app();
        for m in METHODS {
            // Unknown-method is the only error that means "not wired".
            if let Err(e) = dispatch(&a, m, &json!({})) {
                assert!(!e.starts_with("unknown method"), "{m}: {e}");
            }
        }
    }

    #[test]
    fn settings_update_masks_and_emits() {
        let a = app();
        let s = dispatch(&a, "update_settings", &json!({ "request": { "api_key": "AIzaSyABCDEFGHIJ", "tts_enabled": true } })).unwrap();
        assert_eq!(s["api_key"], "AIza...GHIJ");
        assert_eq!(s["tts_enabled"], true);
        assert_eq!(events(&a), vec!["settings-changed"]);
        let s = dispatch(&a, "get_settings", &json!({})).unwrap();
        assert_eq!(s["api_key"], "AIza...GHIJ");
    }

    #[test]
    fn demo_events_flow() {
        let a = app();
        dispatch(&a, "set_active_project", &json!({ "projectId": "p1", "projectName": "Demo" })).unwrap();
        let idea = dispatch(&a, "test_idea", &json!({})).unwrap();
        assert_eq!(idea["project_name"], "Demo");
        let ideas = dispatch(&a, "list_chat_ideas", &json!({ "request": { "status": "pending" } })).unwrap();
        assert_eq!(ideas.as_array().unwrap().len(), 1);
        let id = idea["id"].as_str().unwrap();
        let d = dispatch(&a, "dismiss_idea", &json!({ "ideaId": id })).unwrap();
        assert_eq!(d["status"], "dismissed");

        let pull = dispatch(&a, "test_slot_pull", &json!({})).unwrap();
        assert_eq!(pull["symbols"].as_array().unwrap().len(), 3);
        dispatch(&a, "test_alert", &json!({})).unwrap();
        dispatch(&a, "test_subscriber", &json!({})).unwrap();
        let ev = events(&a);
        for e in ["chat-idea", "leaderboard-update", "slot-pull", "alert", "new-subscriber"] {
            assert!(ev.iter().any(|x| x == e), "missing {e} in {ev:?}");
        }
        let lb = dispatch(&a, "get_leaderboard", &json!({ "limit": 10 })).unwrap();
        assert!(!lb.as_array().unwrap().is_empty());
        let stats = dispatch(&a, "get_slot_stats", &json!({})).unwrap();
        assert_eq!(stats["total_pulls"], 1);
    }

    #[test]
    fn paytable_update_accepts_snake_and_camel_case() {
        let a = app();
        let e = dispatch(
            &a,
            "create_paytable_entry",
            &json!({ "priority": 1, "matchType": "triple_any", "symbol": null, "prizeType": "points", "pointsAmount": 3, "prizeName": "x", "prizeDescription": null }),
        )
        .unwrap();
        let id = e["id"].as_str().unwrap();
        let u = dispatch(&a, "update_paytable_entry", &json!({ "id": id, "points_amount": 7, "prize_name": null })).unwrap();
        assert_eq!(u["points_amount"], 7);
        assert!(u["prize_name"].is_null());
    }

    #[test]
    fn network_commands_fail_cleanly_without_a_host() {
        let a = app();
        dispatch(&a, "update_settings", &json!({ "request": { "api_key": "AIzaSyABCDEFGHIJ" } })).unwrap();
        let e = dispatch(&a, "connect_stream", &json!({ "request": { "video_input": "dQw4w9WgXcQ" } })).unwrap_err();
        assert!(e.contains("HTTP error"), "{e}");
        let e = dispatch(&a, "promote_to_issue", &json!({ "request": { "idea_id": "nope" } })).unwrap_err();
        assert!(e.contains("Not found") || e.contains("not found") || e.contains("Query returned no rows"), "{e}");
        assert!(dispatch(&a, "tts_speak", &json!({ "text": "hi" })).unwrap_err().contains("OpenAI API key"));
    }
}
