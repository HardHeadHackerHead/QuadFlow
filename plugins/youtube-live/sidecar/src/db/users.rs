use super::YouTubeLiveDatabase;
use crate::error::{Result, YouTubeLiveError};
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- User Stats ----

    pub fn get_or_create_user_stats(&self, channel_id: &str, name: &str, starting_points: i64) -> Result<YouTubeUserStats> {
        self.conn.execute(
            "INSERT OR IGNORE INTO youtube_user_stats (author_channel_id, author_name, points)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![channel_id, name, starting_points],
        )?;
        // Update name in case it changed
        self.conn.execute(
            "UPDATE youtube_user_stats SET author_name = ?1, last_active_at = datetime('now') WHERE author_channel_id = ?2",
            rusqlite::params![name, channel_id],
        )?;
        self.get_user_stats(channel_id)
    }

    pub fn deduct_pull_cost(&self, channel_id: &str, cost: i64, reference_id: Option<&str>) -> Result<YouTubeUserStats> {
        let changed = self.conn.execute(
            "UPDATE youtube_user_stats SET points = points - ?1, total_spent = total_spent + ?1, last_active_at = datetime('now')
             WHERE author_channel_id = ?2 AND points >= ?1",
            rusqlite::params![cost, channel_id],
        )?;
        if changed == 0 {
            return Err(YouTubeLiveError::Api("Insufficient points".into()));
        }
        let stats = self.get_user_stats(channel_id)?;
        self.record_points_history(channel_id, -(cost as i64), stats.points, "slot_pull", reference_id)?;
        Ok(stats)
    }

    pub fn award_points(&self, channel_id: &str, amount: i64, reason: &str, reference_id: Option<&str>) -> Result<YouTubeUserStats> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET points = points + ?1, total_earned = total_earned + ?1, last_active_at = datetime('now')
             WHERE author_channel_id = ?2",
            rusqlite::params![amount, channel_id],
        )?;
        let stats = self.get_user_stats(channel_id)?;
        self.record_points_history(channel_id, amount, stats.points, reason, reference_id)?;
        Ok(stats)
    }

    pub fn record_points_history(&self, channel_id: &str, amount: i64, balance_after: i64, reason: &str, reference_id: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO youtube_points_history (id, author_channel_id, amount, balance_after, reason, reference_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![gen_id(), channel_id, amount, balance_after, reason, reference_id],
        )?;
        Ok(())
    }

    pub fn get_points_history(&self, channel_id: &str, limit: i64, offset: i64) -> Result<Vec<PointsHistoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, author_channel_id, amount, balance_after, reason, reference_id, created_at
             FROM youtube_points_history
             WHERE author_channel_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2 OFFSET ?3"
        )?;
        let entries = stmt.query_map(rusqlite::params![channel_id, limit, offset], |row| {
            Ok(PointsHistoryEntry {
                id: row.get(0)?,
                author_channel_id: row.get(1)?,
                amount: row.get(2)?,
                balance_after: row.get(3)?,
                reason: row.get(4)?,
                reference_id: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn record_pull(&self, channel_id: &str, is_jackpot: bool) -> Result<()> {
        if is_jackpot {
            self.conn.execute(
                "UPDATE youtube_user_stats SET total_pulls = total_pulls + 1, total_jackpots = total_jackpots + 1 WHERE author_channel_id = ?1",
                [channel_id],
            )?;
        } else {
            self.conn.execute(
                "UPDATE youtube_user_stats SET total_pulls = total_pulls + 1 WHERE author_channel_id = ?1",
                [channel_id],
            )?;
        }
        Ok(())
    }

    pub fn record_idea_submitted(&self, channel_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET total_ideas_submitted = total_ideas_submitted + 1 WHERE author_channel_id = ?1",
            [channel_id],
        )?;
        Ok(())
    }

    pub fn get_leaderboard(&self, limit: i64) -> Result<Vec<YouTubeUserStats>> {
        let mut stmt = self.conn.prepare(
            "SELECT author_channel_id, author_name, points, total_earned, total_spent, total_pulls, total_jackpots, total_ideas_submitted, total_messages, is_moderator, is_member, is_owner, profile_image_url, first_seen_at, last_active_at
             FROM youtube_user_stats ORDER BY points DESC LIMIT ?1"
        )?;
        let stats = stmt.query_map([limit], |row| {
            let is_mod_int: i64 = row.get(9)?;
            let is_member_int: i64 = row.get(10)?;
            let is_owner_int: i64 = row.get(11)?;
            Ok(YouTubeUserStats {
                author_channel_id: row.get(0)?,
                author_name: row.get(1)?,
                points: row.get(2)?,
                total_earned: row.get(3)?,
                total_spent: row.get(4)?,
                total_pulls: row.get(5)?,
                total_jackpots: row.get(6)?,
                total_ideas_submitted: row.get(7)?,
                total_messages: row.get(8)?,
                is_moderator: is_mod_int != 0,
                is_member: is_member_int != 0,
                is_owner: is_owner_int != 0,
                profile_image_url: row.get(12)?,
                first_seen_at: row.get(13)?,
                last_active_at: row.get(14)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(stats)
    }

    pub fn get_user_stats(&self, channel_id: &str) -> Result<YouTubeUserStats> {
        let mut stmt = self.conn.prepare(
            "SELECT author_channel_id, author_name, points, total_earned, total_spent, total_pulls, total_jackpots, total_ideas_submitted, total_messages, is_moderator, is_member, is_owner, profile_image_url, first_seen_at, last_active_at
             FROM youtube_user_stats WHERE author_channel_id = ?1"
        )?;
        stmt.query_row([channel_id], |row| {
            let is_mod_int: i64 = row.get(9)?;
            let is_member_int: i64 = row.get(10)?;
            let is_owner_int: i64 = row.get(11)?;
            Ok(YouTubeUserStats {
                author_channel_id: row.get(0)?,
                author_name: row.get(1)?,
                points: row.get(2)?,
                total_earned: row.get(3)?,
                total_spent: row.get(4)?,
                total_pulls: row.get(5)?,
                total_jackpots: row.get(6)?,
                total_ideas_submitted: row.get(7)?,
                total_messages: row.get(8)?,
                is_moderator: is_mod_int != 0,
                is_member: is_member_int != 0,
                is_owner: is_owner_int != 0,
                profile_image_url: row.get(12)?,
                first_seen_at: row.get(13)?,
                last_active_at: row.get(14)?,
            })
        }).map_err(|e| YouTubeLiveError::NotFound(format!("User stats not found: {}", e)))
    }

    pub fn record_message(&self, channel_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET total_messages = total_messages + 1, last_active_at = datetime('now') WHERE author_channel_id = ?1",
            [channel_id],
        )?;
        Ok(())
    }

    pub fn update_user_badges(&self, channel_id: &str, is_mod: bool, is_member: bool, is_owner: bool, profile_image: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET is_moderator = ?1, is_member = ?2, is_owner = ?3, profile_image_url = ?4 WHERE author_channel_id = ?5",
            rusqlite::params![is_mod as i64, is_member as i64, is_owner as i64, profile_image, channel_id],
        )?;
        Ok(())
    }

    // ---- Per-Stream Stats ----

    /// Ensure a stream user stats row exists
    pub fn ensure_stream_user_stats(&self, stream_id: &str, channel_id: &str, author_name: &str, profile_image: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO youtube_stream_user_stats (stream_id, author_channel_id, author_name, profile_image_url)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![stream_id, channel_id, author_name, profile_image],
        )?;
        // Update name/image if they've changed
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET author_name = ?3, profile_image_url = ?4 WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id, author_name, profile_image],
        )?;
        Ok(())
    }

    /// Record a message for per-stream stats
    pub fn record_stream_message(&self, stream_id: &str, channel_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET messages = messages + 1, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id],
        )?;
        Ok(())
    }

    /// Record an idea submission for per-stream stats
    pub fn record_stream_idea(&self, stream_id: &str, channel_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET ideas_submitted = ideas_submitted + 1, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id],
        )?;
        Ok(())
    }

    /// Record a slot pull for per-stream stats
    pub fn record_stream_slot_pull(&self, stream_id: &str, channel_id: &str, is_jackpot: bool) -> Result<()> {
        if is_jackpot {
            self.conn.execute(
                "UPDATE youtube_stream_user_stats SET slot_pulls = slot_pulls + 1, jackpots = jackpots + 1, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
                rusqlite::params![stream_id, channel_id],
            )?;
        } else {
            self.conn.execute(
                "UPDATE youtube_stream_user_stats SET slot_pulls = slot_pulls + 1, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
                rusqlite::params![stream_id, channel_id],
            )?;
        }
        Ok(())
    }

    /// Record points earned for per-stream stats
    pub fn record_stream_points_earned(&self, stream_id: &str, channel_id: &str, amount: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET points_earned = points_earned + ?3, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id, amount],
        )?;
        Ok(())
    }

    /// Record points spent for per-stream stats
    pub fn record_stream_points_spent(&self, stream_id: &str, channel_id: &str, amount: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET points_spent = points_spent + ?3, last_active_at = datetime('now') WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id, amount],
        )?;
        Ok(())
    }

    /// Update badges for per-stream stats
    pub fn update_stream_user_badges(&self, stream_id: &str, channel_id: &str, is_mod: bool, is_member: bool, is_owner: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_stream_user_stats SET is_moderator = ?3, is_member = ?4, is_owner = ?5 WHERE stream_id = ?1 AND author_channel_id = ?2",
            rusqlite::params![stream_id, channel_id, is_mod as i64, is_member as i64, is_owner as i64],
        )?;
        Ok(())
    }

    /// Get per-stream leaderboard (sorted by messages by default)
    pub fn get_stream_leaderboard(&self, stream_id: &str, sort_by: &str, limit: i64) -> Result<Vec<StreamUserStats>> {
        let order_col = match sort_by {
            "ideas" => "ideas_submitted",
            "slot_pulls" => "slot_pulls",
            "jackpots" => "jackpots",
            "points_earned" => "points_earned",
            _ => "messages",
        };
        let sql = format!(
            "SELECT stream_id, author_channel_id, author_name, profile_image_url, messages, ideas_submitted, slot_pulls, jackpots, points_earned, points_spent, is_moderator, is_member, is_owner, first_seen_at, last_active_at
             FROM youtube_stream_user_stats WHERE stream_id = ?1 ORDER BY {} DESC LIMIT ?2",
            order_col
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let stats = stmt.query_map(rusqlite::params![stream_id, limit], |row| {
            let is_mod_int: i64 = row.get(10)?;
            let is_member_int: i64 = row.get(11)?;
            let is_owner_int: i64 = row.get(12)?;
            Ok(StreamUserStats {
                stream_id: row.get(0)?,
                author_channel_id: row.get(1)?,
                author_name: row.get(2)?,
                profile_image_url: row.get(3)?,
                messages: row.get(4)?,
                ideas_submitted: row.get(5)?,
                slot_pulls: row.get(6)?,
                jackpots: row.get(7)?,
                points_earned: row.get(8)?,
                points_spent: row.get(9)?,
                is_moderator: is_mod_int != 0,
                is_member: is_member_int != 0,
                is_owner: is_owner_int != 0,
                first_seen_at: row.get(13)?,
                last_active_at: row.get(14)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(stats)
    }

    /// Get aggregate stats for a stream
    pub fn get_stream_stats(&self, stream_id: &str) -> Result<StreamStats> {
        let stream = self.get_stream(stream_id)?;

        // Get aggregates from stream_user_stats
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(SUM(messages), 0), COALESCE(SUM(ideas_submitted), 0), COALESCE(SUM(slot_pulls), 0), COALESCE(SUM(jackpots), 0), COUNT(DISTINCT author_channel_id)
             FROM youtube_stream_user_stats WHERE stream_id = ?1"
        )?;
        let (total_messages, total_ideas, total_slot_pulls, total_jackpots, unique_chatters): (i64, i64, i64, i64, i64) = stmt.query_row([stream_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })?;

        Ok(StreamStats {
            stream_id: stream.id,
            video_id: stream.video_id,
            title: stream.title,
            total_messages,
            total_ideas,
            total_slot_pulls,
            total_jackpots,
            unique_chatters,
            peak_concurrent_chatters: self
                .conn
                .query_row("SELECT peak_concurrent_chatters FROM youtube_streams WHERE id = ?1", [stream_id], |r| r.get(0))
                .unwrap_or(0),
            started_at: stream.started_tracking_at,
            ended_at: stream.ended_at,
        })
    }

    /// Get stats for all streams (for history view)
    pub fn get_all_stream_stats(&self, limit: i64) -> Result<Vec<StreamStats>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.video_id, s.title, s.started_tracking_at, s.ended_at,
                    COALESCE(SUM(u.messages), 0), COALESCE(SUM(u.ideas_submitted), 0),
                    COALESCE(SUM(u.slot_pulls), 0), COALESCE(SUM(u.jackpots), 0),
                    COUNT(DISTINCT u.author_channel_id), s.peak_concurrent_chatters
             FROM youtube_streams s
             LEFT JOIN youtube_stream_user_stats u ON s.id = u.stream_id
             GROUP BY s.id
             ORDER BY s.started_tracking_at DESC
             LIMIT ?1"
        )?;
        let stats = stmt.query_map([limit], |row| {
            Ok(StreamStats {
                stream_id: row.get(0)?,
                video_id: row.get(1)?,
                title: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                total_messages: row.get(5)?,
                total_ideas: row.get(6)?,
                total_slot_pulls: row.get(7)?,
                total_jackpots: row.get(8)?,
                unique_chatters: row.get(9)?,
                peak_concurrent_chatters: row.get(10)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(stats)
    }

}
