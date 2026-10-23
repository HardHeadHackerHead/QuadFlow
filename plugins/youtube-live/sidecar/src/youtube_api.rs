//! YouTube Data API v3 client (through the host's `http.fetch`).

use crate::error::{Result, YouTubeLiveError};
use crate::http::Http;
use crate::models::*;
use crate::util::*;

const YOUTUBE_API_BASE: &str = "https://www.googleapis.com/youtube/v3";

pub fn search_live_streams(
    http: &Http,
    api_key: &str,
    channel_id: &str,
) -> Result<Vec<TrackedStream>> {
    let url = format!(
        "{}/search?part=snippet&channelId={}&type=video&eventType=live&maxResults=5&key={}",
        YOUTUBE_API_BASE, channel_id, api_key
    );

    let resp = http.get(&url)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: YouTubeSearchResponse = resp.json()?;
    let items = data.items.unwrap_or_default();

    let mut streams = Vec::new();
    for item in items {
        if let Some(video_id) = item.id.video_id {
            let snippet = item.snippet.as_ref();
            streams.push(TrackedStream {
                id: String::new(), // Not persisted yet
                video_id,
                title: snippet.and_then(|s| s.title.clone()).unwrap_or_default(),
                channel_title: snippet.and_then(|s| s.channel_title.clone()).unwrap_or_default(),
                live_chat_id: String::new(), // Need to fetch separately
                status: "active".to_string(),
                started_tracking_at: 0,
                ended_at: None,
                last_poll_at: None,
                next_page_token: None,
                messages_captured: 0,
                ideas_captured: 0,
            });
        }
    }

    Ok(streams)
}

pub fn get_video_live_details(
    http: &Http,
    api_key: &str,
    video_id: &str,
) -> Result<(String, String, String)> {
    // Returns: (live_chat_id, title, channel_title)
    let url = format!(
        "{}/videos?part=liveStreamingDetails,snippet&id={}&key={}",
        YOUTUBE_API_BASE, video_id, api_key
    );

    let resp = http.get(&url)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: YouTubeVideoResponse = resp.json()?;
    let item = data.items
        .and_then(|items| items.into_iter().next())
        .ok_or_else(|| YouTubeLiveError::NotFound("Video not found".into()))?;

    let live_chat_id = item.live_streaming_details
        .and_then(|d| d.active_live_chat_id)
        .ok_or_else(|| YouTubeLiveError::NotFound(
            "No active live chat found. The stream may have ended or not started yet.".into()
        ))?;

    let title = item.snippet.as_ref().and_then(|s| s.title.clone()).unwrap_or_default();
    let channel_title = item.snippet.as_ref().and_then(|s| s.channel_title.clone()).unwrap_or_default();

    Ok((live_chat_id, title, channel_title))
}

pub fn poll_chat_messages(
    http: &Http,
    api_key: &str,
    live_chat_id: &str,
    page_token: Option<&str>,
) -> Result<YouTubeChatResponse> {
    let mut url = format!(
        "{}/liveChat/messages?liveChatId={}&part=snippet,authorDetails&maxResults=200&key={}",
        YOUTUBE_API_BASE, live_chat_id, api_key
    );

    if let Some(token) = page_token {
        url.push_str(&format!("&pageToken={}", token));
    }

    let resp = http.get(&url)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: YouTubeChatResponse = resp.json()?;
    Ok(data)
}

pub fn poll_video_stats(http: &Http, api_key: &str, video_id: &str) -> Result<VideoStats> {
    let url = format!(
        "{}/videos?part=statistics,liveStreamingDetails&id={}&key={}",
        YOUTUBE_API_BASE, video_id, api_key
    );

    let resp = http.get(&url)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: YouTubeVideoStatsResponse = resp.json()?;
    let item = data.items
        .and_then(|items| items.into_iter().next())
        .ok_or_else(|| YouTubeLiveError::NotFound("Video stats not found".into()))?;

    let stats = item.statistics
        .ok_or_else(|| YouTubeLiveError::NotFound("Video statistics not found".into()))?;

    let concurrent_viewers = item.live_streaming_details
        .and_then(|d| d.concurrent_viewers)
        .and_then(|s| s.parse().ok());

    Ok(VideoStats {
        view_count: stats.view_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        like_count: stats.like_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        comment_count: stats.comment_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        concurrent_viewers,
    })
}

pub fn poll_channel_stats(http: &Http, api_key: &str, channel_id: &str) -> Result<ChannelStats> {
    let url = format!(
        "{}/channels?part=statistics&id={}&key={}",
        YOUTUBE_API_BASE, channel_id, api_key
    );

    let resp = http.get(&url)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: YouTubeChannelStatsResponse = resp.json()?;
    let stats = data.items
        .and_then(|items| items.into_iter().next())
        .and_then(|item| item.statistics)
        .ok_or_else(|| YouTubeLiveError::NotFound("Channel stats not found".into()))?;

    Ok(ChannelStats {
        subscriber_count: stats.subscriber_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        hidden_subscriber_count: stats.hidden_subscriber_count.unwrap_or(false),
        total_view_count: stats.view_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        video_count: stats.video_count.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
    })
}

/// Poll the YouTube Subscriptions API for recent subscribers (requires OAuth2 token)
pub fn poll_subscribers(http: &Http, oauth_token: &str) -> Result<Vec<Subscriber>> {
    let url = format!(
        "{}/subscriptions?part=snippet,subscriberSnippet&myRecentSubscribers=true&maxResults=50",
        YOUTUBE_API_BASE
    );

    let resp = http.get_bearer(&url, oauth_token)?;

    if !resp.is_success() {
        let status = resp.status;
        let body = resp.text();
        return handle_api_error(status, &body);
    }

    let data: serde_json::Value = resp.json()?;
    let items = data.get("items").and_then(|v| v.as_array());

    let mut subs = Vec::new();
    if let Some(items) = items {
        for item in items {
            let snippet = match item.get("snippet") {
                Some(s) => s,
                None => continue,
            };
            // subscriberSnippet has the actual subscriber's info (name, thumbnail)
            // snippet.title/thumbnails contain YOUR channel's info when using myRecentSubscribers
            let subscriber_snippet = item.get("subscriberSnippet");

            let channel_id = snippet.get("channelId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let channel_title = subscriber_snippet
                .and_then(|ss| ss.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let thumbnail_url = subscriber_snippet
                .and_then(|ss| ss.get("thumbnails"))
                .and_then(|t| t.get("default"))
                .and_then(|d| d.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let subscribed_at = snippet.get("publishedAt")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();

            subs.push(Subscriber {
                id: gen_id(),
                channel_id,
                channel_title,
                thumbnail_url,
                subscribed_at,
                detected_at: chrono_now_iso(),
            });
        }
    }
    Ok(subs)
}

pub fn handle_api_error<T>(status: u16, body: &str) -> Result<T> {
    // Try to parse YouTube error response
    let msg = if let Ok(err_resp) = serde_json::from_str::<YouTubeErrorResponse>(body) {
        err_resp.error
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("HTTP {}", status))
    } else {
        format!("HTTP {}: {}", status, body)
    };

    match status {
        403 => Err(YouTubeLiveError::QuotaExceeded(msg)),
        404 => Err(YouTubeLiveError::NotFound(msg)),
        429 => Err(YouTubeLiveError::QuotaExceeded(msg)),
        _ => Err(YouTubeLiveError::Api(msg)),
    }
}
