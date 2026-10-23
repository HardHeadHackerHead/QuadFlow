use super::YouTubeLiveDatabase;
use crate::error::Result;
use crate::models::*;

impl YouTubeLiveDatabase {
    // ---- Subscribers ----

    /// Insert a subscriber if their channel_id doesn't already exist. Returns true if actually inserted.
    pub fn insert_subscriber_if_new(
        &self,
        id: &str,
        channel_id: &str,
        channel_title: &str,
        thumbnail_url: &str,
        subscribed_at: &str,
    ) -> Result<bool> {
        let rows = self.conn.execute(
            "INSERT OR IGNORE INTO youtube_subscribers (id, channel_id, channel_title, thumbnail_url, subscribed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, channel_id, channel_title, thumbnail_url, subscribed_at],
        )?;
        Ok(rows > 0)
    }

    pub fn delete_subscriber_by_channel(&self, channel_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM youtube_subscribers WHERE channel_id = ?1",
            [channel_id],
        )?;
        Ok(())
    }

    pub fn list_subscribers(&self, limit: i64) -> Result<Vec<Subscriber>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, channel_id, channel_title, thumbnail_url, subscribed_at, detected_at
             FROM youtube_subscribers ORDER BY detected_at DESC LIMIT ?1"
        )?;
        let subs = stmt.query_map([limit], |row| {
            Ok(Subscriber {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                channel_title: row.get(2)?,
                thumbnail_url: row.get(3)?,
                subscribed_at: row.get(4)?,
                detected_at: row.get(5)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
        Ok(subs)
    }

}
