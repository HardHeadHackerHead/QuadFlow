use super::YouTubeLiveDatabase;
use crate::error::{Result, YouTubeLiveError};
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- YouTube Live Polls ----

    pub fn seed_default_poll_templates(&self) {
        // Only seed if the table is empty
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM youtube_poll_templates",
            [],
            |row| row.get(0),
        ).unwrap_or(0);
        if count > 0 {
            return;
        }

        let templates = vec![
            ("engagement", "Like & Subscribe", "Have you liked and subscribed?", vec!["Yes!", "Just did!", "Already subscribed", "Not yet"]),
            ("engagement", "Notification Bell", "Did you hit the notification bell?", vec!["All notifications", "Personalized", "None", "What bell?"]),
            ("feedback", "Stream Quality", "How's the stream quality today?", vec!["Perfect!", "Good", "Okay", "Having issues"]),
            ("feedback", "Content Rating", "Are you enjoying today's content?", vec!["Love it!", "Pretty good", "It's okay", "Not my thing"]),
            ("fun", "Coding Fuel", "What's your coding fuel?", vec!["Coffee", "Tea", "Energy drinks", "Water"]),
            ("fun", "Tabs vs Spaces", "The eternal debate:", vec!["Tabs", "Spaces", "Don't care", "Mix both"]),
        ];

        for (category, name, question, options) in templates {
            let options_json = serde_json::to_string(&options).unwrap_or_else(|_| "[]".to_string());
            let id = uuid::Uuid::new_v4().to_string();
            let _ = self.conn.execute(
                "INSERT INTO youtube_poll_templates (id, name, question, options, category, is_builtin, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, 1)",
                rusqlite::params![id, name, question, options_json, category],
            );
        }
    }

    pub fn create_poll(
        &self,
        stream_id: &str,
        question: &str,
        options: &[String],
        poll_type: &str,
        source_context: Option<&str>,
        duration_secs: i64,
    ) -> Result<YTPoll> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = now_millis();
        let options_json: Vec<YTPollOption> = options.iter()
            .map(|text| YTPollOption { text: text.clone(), tally: 0 })
            .collect();
        let options_str = serde_json::to_string(&options_json)
            .map_err(|e| YouTubeLiveError::Json(e.to_string()))?;

        self.conn.execute(
            "INSERT INTO youtube_polls (id, stream_id, question, options, poll_type, source_context, duration_secs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, stream_id, question, options_str, poll_type, source_context, duration_secs, created_at],
        )?;

        Ok(YTPoll {
            id,
            youtube_poll_id: None,
            stream_id: stream_id.to_string(),
            question: question.to_string(),
            options: options_json,
            status: "active".to_string(),
            poll_type: poll_type.to_string(),
            source_context: source_context.map(String::from),
            duration_secs,
            created_at,
            closed_at: None,
        })
    }

    pub fn get_poll(&self, poll_id: &str) -> Result<YTPoll> {
        let mut stmt = self.conn.prepare(
            "SELECT id, youtube_poll_id, stream_id, question, options, status, poll_type, source_context, duration_secs, created_at, closed_at
             FROM youtube_polls WHERE id = ?1"
        )?;

        stmt.query_row([poll_id], |row| {
            let options_str: String = row.get(4)?;
            let options: Vec<YTPollOption> = serde_json::from_str(&options_str).unwrap_or_default();
            Ok(YTPoll {
                id: row.get(0)?,
                youtube_poll_id: row.get(1)?,
                stream_id: row.get(2)?,
                question: row.get(3)?,
                options,
                status: row.get(5)?,
                poll_type: row.get(6)?,
                source_context: row.get(7)?,
                duration_secs: row.get(8)?,
                created_at: row.get(9)?,
                closed_at: row.get(10)?,
            })
        }).map_err(|e| e.into())
    }

    pub fn get_active_poll(&self, stream_id: &str) -> Result<Option<YTPoll>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM youtube_polls WHERE stream_id = ?1 AND status = 'active' LIMIT 1"
        )?;

        match stmt.query_row([stream_id], |row| row.get::<_, String>(0)) {
            Ok(poll_id) => Ok(Some(self.get_poll(&poll_id)?)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn update_poll_youtube_id(&self, poll_id: &str, youtube_poll_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE youtube_polls SET youtube_poll_id = ?1 WHERE id = ?2",
            rusqlite::params![youtube_poll_id, poll_id],
        )?;
        Ok(())
    }

    pub fn close_poll(&self, poll_id: &str) -> Result<YTPoll> {
        let closed_at = now_millis();
        self.conn.execute(
            "UPDATE youtube_polls SET status = 'closed', closed_at = ?1 WHERE id = ?2",
            rusqlite::params![closed_at, poll_id],
        )?;
        self.get_poll(poll_id)
    }

    pub fn list_stream_polls(&self, stream_id: &str, limit: i64) -> Result<Vec<YTPoll>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, youtube_poll_id, stream_id, question, options, status, poll_type, source_context, duration_secs, created_at, closed_at
             FROM youtube_polls WHERE stream_id = ?1 ORDER BY created_at DESC LIMIT ?2"
        )?;

        let polls = stmt.query_map(rusqlite::params![stream_id, limit], |row| {
            let options_str: String = row.get(4)?;
            let options: Vec<YTPollOption> = serde_json::from_str(&options_str).unwrap_or_default();
            Ok(YTPoll {
                id: row.get(0)?,
                youtube_poll_id: row.get(1)?,
                stream_id: row.get(2)?,
                question: row.get(3)?,
                options,
                status: row.get(5)?,
                poll_type: row.get(6)?,
                source_context: row.get(7)?,
                duration_secs: row.get(8)?,
                created_at: row.get(9)?,
                closed_at: row.get(10)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

        Ok(polls)
    }

    /// List all polls across all streams for history purposes
    pub fn list_all_polls(&self, limit: i64) -> Result<Vec<YTPoll>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, youtube_poll_id, stream_id, question, options, status, poll_type, source_context, duration_secs, created_at, closed_at
             FROM youtube_polls ORDER BY created_at DESC LIMIT ?1"
        )?;

        let polls = stmt.query_map(rusqlite::params![limit], |row| {
            let options_str: String = row.get(4)?;
            let options: Vec<YTPollOption> = serde_json::from_str(&options_str).unwrap_or_default();
            Ok(YTPoll {
                id: row.get(0)?,
                youtube_poll_id: row.get(1)?,
                stream_id: row.get(2)?,
                question: row.get(3)?,
                options,
                status: row.get(5)?,
                poll_type: row.get(6)?,
                source_context: row.get(7)?,
                duration_secs: row.get(8)?,
                created_at: row.get(9)?,
                closed_at: row.get(10)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

        Ok(polls)
    }

    pub fn list_poll_templates(&self, category: Option<&str>) -> Result<Vec<YTPollTemplate>> {
        let query = match category {
            Some(_) => "SELECT id, name, question, options, category, is_builtin, enabled, created_at, updated_at
                        FROM youtube_poll_templates WHERE category = ?1 AND enabled = 1 ORDER BY name",
            None => "SELECT id, name, question, options, category, is_builtin, enabled, created_at, updated_at
                     FROM youtube_poll_templates WHERE enabled = 1 ORDER BY category, name",
        };

        let mut stmt = self.conn.prepare(query)?;

        let templates = if let Some(cat) = category {
            stmt.query_map([cat], |row| {
                let options_str: String = row.get(3)?;
                let options: Vec<String> = serde_json::from_str(&options_str).unwrap_or_default();
                Ok(YTPollTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    question: row.get(2)?,
                    options,
                    category: row.get(4)?,
                    is_builtin: row.get::<_, i64>(5)? != 0,
                    enabled: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect()
        } else {
            stmt.query_map([], |row| {
                let options_str: String = row.get(3)?;
                let options: Vec<String> = serde_json::from_str(&options_str).unwrap_or_default();
                Ok(YTPollTemplate {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    question: row.get(2)?,
                    options,
                    category: row.get(4)?,
                    is_builtin: row.get::<_, i64>(5)? != 0,
                    enabled: row.get::<_, i64>(6)? != 0,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect()
        };

        Ok(templates)
    }

    pub fn get_poll_template(&self, template_id: &str) -> Result<YTPollTemplate> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, question, options, category, is_builtin, enabled, created_at, updated_at
             FROM youtube_poll_templates WHERE id = ?1"
        )?;

        stmt.query_row([template_id], |row| {
            let options_str: String = row.get(3)?;
            let options: Vec<String> = serde_json::from_str(&options_str).unwrap_or_default();
            Ok(YTPollTemplate {
                id: row.get(0)?,
                name: row.get(1)?,
                question: row.get(2)?,
                options,
                category: row.get(4)?,
                is_builtin: row.get::<_, i64>(5)? != 0,
                enabled: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        }).map_err(|e| e.into())
    }

    pub fn get_poll_results(&self, poll_id: &str) -> Result<YTPollResults> {
        let poll = self.get_poll(poll_id)?;
        let total_votes: i64 = poll.options.iter().map(|o| o.tally).sum();
        let percentages: Vec<f64> = poll.options.iter()
            .map(|o| if total_votes > 0 { (o.tally as f64 / total_votes as f64) * 100.0 } else { 0.0 })
            .collect();
        let winner_index = if total_votes > 0 {
            poll.options.iter().enumerate().max_by_key(|(_, o)| o.tally).map(|(i, _)| i)
        } else {
            None
        };

        let time_remaining_secs = if poll.status == "active" {
            let now = now_millis();
            let end_time = poll.created_at + (poll.duration_secs * 1000);
            Some(((end_time - now) / 1000).max(0))
        } else {
            None
        };

        Ok(YTPollResults {
            poll_id: poll.id,
            question: poll.question,
            options: poll.options,
            total_votes,
            percentages,
            winner_index,
            status: poll.status,
            time_remaining_secs,
        })
    }
}
