use super::YouTubeLiveDatabase;
use crate::error::{Result, YouTubeLiveError};
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- Chat Ideas ----

    /// Returns Ok(Some(idea)) if newly inserted, Ok(None) if duplicate message_id.
    pub fn create_chat_idea(
        &self,
        id: &str,
        stream_id: &str,
        message_id: &str,
        author_name: &str,
        author_channel_id: &str,
        author_profile_image: &str,
        raw_message: &str,
        idea_content: &str,
        published_at: i64,
        project_id: Option<&str>,
        project_name: Option<&str>,
    ) -> Result<Option<ChatIdea>> {
        let now = now_millis();
        self.conn.execute(
            "INSERT OR IGNORE INTO youtube_chat_ideas
             (id, stream_id, message_id, author_name, author_channel_id, author_profile_image,
              raw_message, idea_content, status, published_at, captured_at, project_id, project_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?12)",
            rusqlite::params![
                id, stream_id, message_id, author_name, author_channel_id,
                author_profile_image, raw_message, idea_content, published_at, now,
                project_id, project_name
            ],
        )?;

        // INSERT OR IGNORE silently skips duplicates - check if row was actually inserted
        if self.conn.changes() == 0 {
            return Ok(None);
        }

        Ok(Some(ChatIdea {
            id: id.to_string(),
            stream_id: stream_id.to_string(),
            message_id: message_id.to_string(),
            author_name: author_name.to_string(),
            author_channel_id: author_channel_id.to_string(),
            author_profile_image: author_profile_image.to_string(),
            raw_message: raw_message.to_string(),
            idea_content: idea_content.to_string(),
            status: "pending".to_string(),
            promoted_to_id: None,
            project_id: project_id.map(|s| s.to_string()),
            project_name: project_name.map(|s| s.to_string()),
            published_at,
            captured_at: now,
            reviewed_at: None,
        }))
    }

    pub fn get_chat_idea(&self, id: &str) -> Result<ChatIdea> {
        let mut stmt = self.conn.prepare(
            "SELECT id, stream_id, message_id, author_name, author_channel_id,
                    author_profile_image, raw_message, idea_content, status,
                    promoted_to_id, project_id, project_name, published_at, captured_at, reviewed_at
             FROM youtube_chat_ideas WHERE id = ?1"
        )?;

        stmt.query_row([id], |row| {
            Ok(ChatIdea {
                id: row.get(0)?,
                stream_id: row.get(1)?,
                message_id: row.get(2)?,
                author_name: row.get(3)?,
                author_channel_id: row.get(4)?,
                author_profile_image: row.get(5)?,
                raw_message: row.get(6)?,
                idea_content: row.get(7)?,
                status: row.get(8)?,
                promoted_to_id: row.get(9)?,
                project_id: row.get(10)?,
                project_name: row.get(11)?,
                published_at: row.get(12)?,
                captured_at: row.get(13)?,
                reviewed_at: row.get(14)?,
            })
        }).map_err(|e| YouTubeLiveError::NotFound(format!("Chat idea not found: {}", e)))
    }

    pub fn list_chat_ideas(
        &self,
        stream_id: Option<&str>,
        status_filter: Option<&str>,
    ) -> Result<Vec<ChatIdea>> {
        let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match (stream_id, status_filter) {
            (Some(sid), Some(st)) => (
                "SELECT id, stream_id, message_id, author_name, author_channel_id,
                        author_profile_image, raw_message, idea_content, status,
                        promoted_to_id, project_id, project_name, published_at, captured_at, reviewed_at
                 FROM youtube_chat_ideas WHERE stream_id = ?1 AND status = ?2
                 ORDER BY captured_at DESC".to_string(),
                vec![Box::new(sid.to_string()) as Box<dyn rusqlite::types::ToSql>,
                     Box::new(st.to_string())],
            ),
            (Some(sid), None) => (
                "SELECT id, stream_id, message_id, author_name, author_channel_id,
                        author_profile_image, raw_message, idea_content, status,
                        promoted_to_id, project_id, project_name, published_at, captured_at, reviewed_at
                 FROM youtube_chat_ideas WHERE stream_id = ?1
                 ORDER BY captured_at DESC".to_string(),
                vec![Box::new(sid.to_string()) as Box<dyn rusqlite::types::ToSql>],
            ),
            (None, Some(st)) => (
                "SELECT id, stream_id, message_id, author_name, author_channel_id,
                        author_profile_image, raw_message, idea_content, status,
                        promoted_to_id, project_id, project_name, published_at, captured_at, reviewed_at
                 FROM youtube_chat_ideas WHERE status = ?1
                 ORDER BY captured_at DESC".to_string(),
                vec![Box::new(st.to_string()) as Box<dyn rusqlite::types::ToSql>],
            ),
            (None, None) => (
                "SELECT id, stream_id, message_id, author_name, author_channel_id,
                        author_profile_image, raw_message, idea_content, status,
                        promoted_to_id, project_id, project_name, published_at, captured_at, reviewed_at
                 FROM youtube_chat_ideas
                 ORDER BY captured_at DESC".to_string(),
                vec![],
            ),
        };

        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let ideas = stmt.query_map(param_refs.as_slice(), |row| {
            Ok(ChatIdea {
                id: row.get(0)?,
                stream_id: row.get(1)?,
                message_id: row.get(2)?,
                author_name: row.get(3)?,
                author_channel_id: row.get(4)?,
                author_profile_image: row.get(5)?,
                raw_message: row.get(6)?,
                idea_content: row.get(7)?,
                status: row.get(8)?,
                promoted_to_id: row.get(9)?,
                project_id: row.get(10)?,
                project_name: row.get(11)?,
                published_at: row.get(12)?,
                captured_at: row.get(13)?,
                reviewed_at: row.get(14)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(ideas)
    }

    pub fn update_idea_status(
        &self,
        id: &str,
        status: &str,
        promoted_to_id: Option<&str>,
    ) -> Result<()> {
        let now = now_millis();
        self.conn.execute(
            "UPDATE youtube_chat_ideas SET status = ?1, promoted_to_id = ?2, reviewed_at = ?3 WHERE id = ?4",
            rusqlite::params![status, promoted_to_id, now, id],
        )?;
        Ok(())
    }

}
