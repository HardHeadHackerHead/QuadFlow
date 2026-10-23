use super::YouTubeLiveDatabase;
use crate::error::Result;
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- Quota ----

    pub fn get_quota_usage(&self) -> Result<QuotaUsage> {
        let today = today_pst();
        let settings = self.get_settings()?;

        let mut stmt = self.conn.prepare(
            "SELECT date, units_used, requests_made, daily_limit
             FROM youtube_quota_log WHERE date = ?1"
        )?;

        match stmt.query_row([&today], |row| {
            let units_used: i64 = row.get(1)?;
            let daily_limit: i64 = row.get(3)?;
            Ok(QuotaUsage {
                date: row.get(0)?,
                units_used,
                requests_made: row.get(2)?,
                daily_limit,
                remaining: daily_limit - units_used,
            })
        }) {
            Ok(usage) => Ok(usage),
            Err(_) => Ok(QuotaUsage {
                date: today,
                units_used: 0,
                requests_made: 0,
                daily_limit: settings.max_daily_quota,
                remaining: settings.max_daily_quota,
            }),
        }
    }

    pub fn check_quota(&self, units_needed: i64) -> Result<bool> {
        let usage = self.get_quota_usage()?;
        Ok(usage.remaining >= units_needed)
    }

    pub fn add_quota_usage_typed(&self, units: i64, quota_type: &str) -> Result<QuotaUsage> {
        let today = today_pst();
        let settings = self.get_settings()?;

        // Build the type-specific column update
        let type_col = match quota_type {
            "chat" => "chat_units",
            "video_stats" => "video_stats_units",
            "channel_stats" => "channel_stats_units",
            "search" => "search_units",
            _ => "chat_units",
        };

        self.conn.execute(
            "INSERT INTO youtube_quota_log (date, units_used, requests_made, daily_limit)
             VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(date) DO UPDATE SET
                units_used = units_used + ?2,
                requests_made = requests_made + 1",
            rusqlite::params![today, units, settings.max_daily_quota],
        )?;

        // Update the typed column
        let sql = format!(
            "UPDATE youtube_quota_log SET {} = {} + ?1 WHERE date = ?2",
            type_col, type_col
        );
        self.conn.execute(&sql, rusqlite::params![units, today])?;

        self.get_quota_usage()
    }

    /// Manually set quota usage (for resyncing with Google Console)
    pub fn set_quota_usage(&self, units_used: i64) -> Result<QuotaUsage> {
        let today = today_pst();
        let settings = self.get_settings()?;

        // Upsert the quota log for today with the manual value
        self.conn.execute(
            "INSERT INTO youtube_quota_log (date, units_used, requests_made, daily_limit, chat_units, video_stats_units, channel_stats_units, search_units)
             VALUES (?1, ?2, 0, ?3, 0, 0, 0, 0)
             ON CONFLICT(date) DO UPDATE SET
                units_used = ?2,
                chat_units = 0,
                video_stats_units = 0,
                channel_stats_units = 0,
                search_units = 0",
            rusqlite::params![today, units_used, settings.max_daily_quota],
        )?;

        self.get_quota_usage()
    }

    /// Reset quota usage for today (sets to 0)
    pub fn reset_quota_usage(&self) -> Result<QuotaUsage> {
        self.set_quota_usage(0)
    }

    pub fn get_quota_breakdown(&self) -> Result<QuotaBreakdown> {
        let today = today_pst();
        let settings = self.get_settings()?;

        let mut stmt = self.conn.prepare(
            "SELECT units_used, chat_units, video_stats_units, channel_stats_units, search_units, daily_limit
             FROM youtube_quota_log WHERE date = ?1"
        )?;

        let result = stmt.query_row([&today], |row| {
            let total: i64 = row.get(0)?;
            let chat: i64 = row.get(1)?;
            let video: i64 = row.get(2)?;
            let channel: i64 = row.get(3)?;
            let search: i64 = row.get(4)?;
            let daily_limit: i64 = row.get(5)?;
            let other = total - chat - video - channel - search;

            // Calculate projections: units per hour * 24
            let chat_interval_ms = settings.poll_interval_ms.max(5000);
            let projected_chat = if settings.poll_interval_ms > 0 {
                (3600_000 / chat_interval_ms) * 5 * 24
            } else { 0 };

            let projected_video = if settings.video_stats_enabled && settings.video_stats_interval_secs > 0 {
                (3600 / settings.video_stats_interval_secs) * 24
            } else { 0 };

            let projected_channel = if settings.channel_stats_enabled && settings.channel_stats_interval_secs > 0 {
                (3600 / settings.channel_stats_interval_secs) * 24
            } else { 0 };

            Ok(QuotaBreakdown {
                chat_polls: chat,
                video_stats_polls: video,
                channel_stats_polls: channel,
                search_calls: search,
                other: other.max(0),
                total,
                daily_limit,
                remaining: (daily_limit - total).max(0),
                projected_daily_chat: projected_chat,
                projected_daily_video: projected_video,
                projected_daily_channel: projected_channel,
                projected_daily_total: projected_chat + projected_video + projected_channel,
            })
        });

        match result {
            Ok(breakdown) => Ok(breakdown),
            Err(_) => Ok(QuotaBreakdown {
                chat_polls: 0,
                video_stats_polls: 0,
                channel_stats_polls: 0,
                search_calls: 0,
                other: 0,
                total: 0,
                daily_limit: settings.max_daily_quota,
                remaining: settings.max_daily_quota,
                projected_daily_chat: 0,
                projected_daily_video: 0,
                projected_daily_channel: 0,
                projected_daily_total: 0,
            }),
        }
    }

}
