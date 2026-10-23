use super::YouTubeLiveDatabase;
use crate::error::Result;
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- Stream Goals ----

    pub fn list_goals(&self) -> Result<Vec<StreamGoal>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, completed, created_at, completed_at, stream_id
             FROM youtube_stream_goals
             ORDER BY completed ASC, created_at DESC"
        )?;

        let goals = stmt.query_map([], |row| {
            Ok(StreamGoal {
                id: row.get(0)?,
                title: row.get(1)?,
                completed: row.get::<_, i32>(2)? != 0,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                stream_id: row.get(5)?,
            })
        })?.filter_map(|r| r.ok()).collect();

        Ok(goals)
    }

    pub fn create_goal(&self, title: &str, stream_id: Option<&str>) -> Result<StreamGoal> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO youtube_stream_goals (id, title, stream_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, title, stream_id],
        )?;

        let goal = self.conn.query_row(
            "SELECT id, title, completed, created_at, completed_at, stream_id FROM youtube_stream_goals WHERE id = ?1",
            [&id],
            |row| Ok(StreamGoal {
                id: row.get(0)?,
                title: row.get(1)?,
                completed: row.get::<_, i32>(2)? != 0,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                stream_id: row.get(5)?,
            }),
        )?;

        Ok(goal)
    }

    pub fn toggle_goal(&self, id: &str, completed: bool) -> Result<StreamGoal> {
        let completed_at = if completed {
            Some(chrono_now())
        } else {
            None
        };

        self.conn.execute(
            "UPDATE youtube_stream_goals SET completed = ?1, completed_at = ?2 WHERE id = ?3",
            rusqlite::params![completed as i32, completed_at, id],
        )?;

        let goal = self.conn.query_row(
            "SELECT id, title, completed, created_at, completed_at, stream_id FROM youtube_stream_goals WHERE id = ?1",
            [id],
            |row| Ok(StreamGoal {
                id: row.get(0)?,
                title: row.get(1)?,
                completed: row.get::<_, i32>(2)? != 0,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                stream_id: row.get(5)?,
            }),
        )?;

        Ok(goal)
    }

    pub fn update_goal_stream(&self, id: &str, stream_id: Option<&str>) -> Result<StreamGoal> {
        self.conn.execute(
            "UPDATE youtube_stream_goals SET stream_id = ?1 WHERE id = ?2",
            rusqlite::params![stream_id, id],
        )?;

        let goal = self.conn.query_row(
            "SELECT id, title, completed, created_at, completed_at, stream_id FROM youtube_stream_goals WHERE id = ?1",
            [id],
            |row| Ok(StreamGoal {
                id: row.get(0)?,
                title: row.get(1)?,
                completed: row.get::<_, i32>(2)? != 0,
                created_at: row.get(3)?,
                completed_at: row.get(4)?,
                stream_id: row.get(5)?,
            }),
        )?;

        Ok(goal)
    }

    pub fn delete_goal(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM youtube_stream_goals WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

}
