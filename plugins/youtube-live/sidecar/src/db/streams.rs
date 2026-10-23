use super::YouTubeLiveDatabase;
use crate::error::{Result, YouTubeLiveError};
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- Streams ----

    pub fn create_stream(
        &self,
        id: &str,
        video_id: &str,
        title: &str,
        channel_title: &str,
        live_chat_id: &str,
    ) -> Result<TrackedStream> {
        let now = now_millis();
        self.conn.execute(
            "INSERT INTO youtube_streams (id, video_id, title, channel_title, live_chat_id, status, started_tracking_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)",
            rusqlite::params![id, video_id, title, channel_title, live_chat_id, now],
        )?;

        Ok(TrackedStream {
            id: id.to_string(),
            video_id: video_id.to_string(),
            title: title.to_string(),
            channel_title: channel_title.to_string(),
            live_chat_id: live_chat_id.to_string(),
            status: "active".to_string(),
            started_tracking_at: now,
            ended_at: None,
            last_poll_at: None,
            next_page_token: None,
            messages_captured: 0,
            ideas_captured: 0,
        })
    }

    /// Find the most recent stream record for a video_id (to reuse page_token on reconnect)
    pub fn find_stream_by_video_id(&self, video_id: &str) -> Option<TrackedStream> {
        let mut stmt = self.conn.prepare(
            "SELECT id, video_id, title, channel_title, live_chat_id, status,
                    started_tracking_at, ended_at, last_poll_at, next_page_token,
                    messages_captured, ideas_captured
             FROM youtube_streams WHERE video_id = ?1
             ORDER BY started_tracking_at DESC LIMIT 1"
        ).ok()?;

        stmt.query_row([video_id], |row| {
            Ok(TrackedStream {
                id: row.get(0)?,
                video_id: row.get(1)?,
                title: row.get(2)?,
                channel_title: row.get(3)?,
                live_chat_id: row.get(4)?,
                status: row.get(5)?,
                started_tracking_at: row.get(6)?,
                ended_at: row.get(7)?,
                last_poll_at: row.get(8)?,
                next_page_token: row.get(9)?,
                messages_captured: row.get(10)?,
                ideas_captured: row.get(11)?,
            })
        }).ok()
    }

    pub fn get_stream(&self, id: &str) -> Result<TrackedStream> {
        let mut stmt = self.conn.prepare(
            "SELECT id, video_id, title, channel_title, live_chat_id, status,
                    started_tracking_at, ended_at, last_poll_at, next_page_token,
                    messages_captured, ideas_captured
             FROM youtube_streams WHERE id = ?1"
        )?;

        stmt.query_row([id], |row| {
            Ok(TrackedStream {
                id: row.get(0)?,
                video_id: row.get(1)?,
                title: row.get(2)?,
                channel_title: row.get(3)?,
                live_chat_id: row.get(4)?,
                status: row.get(5)?,
                started_tracking_at: row.get(6)?,
                ended_at: row.get(7)?,
                last_poll_at: row.get(8)?,
                next_page_token: row.get(9)?,
                messages_captured: row.get(10)?,
                ideas_captured: row.get(11)?,
            })
        }).map_err(|e| YouTubeLiveError::NotFound(format!("Stream not found: {}", e)))
    }

    pub fn list_streams(&self) -> Result<Vec<TrackedStream>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, video_id, title, channel_title, live_chat_id, status,
                    started_tracking_at, ended_at, last_poll_at, next_page_token,
                    messages_captured, ideas_captured
             FROM youtube_streams ORDER BY started_tracking_at DESC"
        )?;

        let streams = stmt.query_map([], |row| {
            Ok(TrackedStream {
                id: row.get(0)?,
                video_id: row.get(1)?,
                title: row.get(2)?,
                channel_title: row.get(3)?,
                live_chat_id: row.get(4)?,
                status: row.get(5)?,
                started_tracking_at: row.get(6)?,
                ended_at: row.get(7)?,
                last_poll_at: row.get(8)?,
                next_page_token: row.get(9)?,
                messages_captured: row.get(10)?,
                ideas_captured: row.get(11)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(streams)
    }

    pub fn update_stream_status(&self, id: &str, status: &str) -> Result<()> {
        let ended_at = if status == "ended" || status == "error" {
            Some(now_millis())
        } else {
            None
        };

        self.conn.execute(
            "UPDATE youtube_streams SET status = ?1, ended_at = COALESCE(?2, ended_at) WHERE id = ?3",
            rusqlite::params![status, ended_at, id],
        )?;
        Ok(())
    }

    pub fn update_stream_poll(
        &self,
        id: &str,
        next_page_token: Option<&str>,
        new_messages: i64,
        new_ideas: i64,
    ) -> Result<()> {
        let now = now_millis();
        self.conn.execute(
            "UPDATE youtube_streams
             SET last_poll_at = ?1, next_page_token = ?2,
                 messages_captured = messages_captured + ?3,
                 ideas_captured = ideas_captured + ?4
             WHERE id = ?5",
            rusqlite::params![now, next_page_token, new_messages, new_ideas, id],
        )?;
        Ok(())
    }


    /// The stream row demo/test events attach to (foreign keys).
    pub fn ensure_test_stream(&self) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO youtube_streams (id, video_id, title, channel_title, live_chat_id, status, started_tracking_at)
             VALUES ('test-stream', 'test-video', 'Test Stream', 'Test Channel', 'test-chat', 'active', ?1)",
            rusqlite::params![now_millis()],
        )?;
        Ok(())
    }

    /// Raise the stream's peak concurrent chatter count to `count` if higher.
    pub fn update_stream_peak(&self, id: &str, count: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_streams SET peak_concurrent_chatters = MAX(peak_concurrent_chatters, ?2) WHERE id = ?1",
            rusqlite::params![id, count],
        )?;
        Ok(())
    }
}
