//! Stored prompts (data-layer.md §7 `stored_prompts`).

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::Timestamp;
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredPrompt {
    pub id: Id,
    pub name: String,
    pub content: String,
    pub category: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Create (no `id`) or replace (existing `id`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoredPromptInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<StoredPrompt> {
    let id: String = r.get(0)?;
    Ok(StoredPrompt {
        id: Id::parse(&id).map_err(|e| rusqlite::Error::InvalidColumnType(0, e.message, rusqlite::types::Type::Text))?,
        name: r.get(1)?,
        content: r.get(2)?,
        category: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

/// Most recently updated first.
pub fn list(db: &AppDb) -> Result<Vec<StoredPrompt>> {
    db.read(|c| {
        let mut stmt = c.prepare(
            "SELECT id, name, content, category, created_at, updated_at FROM stored_prompts ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect()
    })
}

pub fn get(db: &AppDb, id: &Id) -> Result<StoredPrompt> {
    db.read(|c| {
        c.query_row(
            "SELECT id, name, content, category, created_at, updated_at FROM stored_prompts WHERE id = ?1",
            [id.as_str()],
            from_row,
        )
    })
    .map_err(|e| if e.code == crate::error::ErrorCode::NotFound { CoreError::not_found(format!("stored prompt {id}")) } else { e })
}

pub fn upsert(db: &AppDb, input: StoredPromptInput) -> Result<StoredPrompt> {
    let name = super::non_empty("prompt name", &input.name)?;
    let category = input.category.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let id = db.transact(|tx, ch| {
        let now = now_ms();
        match &input.id {
            Some(id) => {
                let n = tx.execute(
                    "UPDATE stored_prompts SET name = ?1, content = ?2, category = ?3, updated_at = ?4 WHERE id = ?5",
                    rusqlite::params![name, input.content, category, now, id.as_str()],
                )?;
                if n == 0 {
                    return Err(CoreError::not_found(format!("stored prompt {id}")));
                }
                ch.push(AppChange::new(Domain::StoredPrompts, ChangeKind::Updated, Some(id.as_str())));
                Ok(id.clone())
            }
            None => {
                let id = new_id();
                tx.execute(
                    "INSERT INTO stored_prompts (id, name, content, category, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    rusqlite::params![id.as_str(), name, input.content, category, now],
                )?;
                ch.push(AppChange::new(Domain::StoredPrompts, ChangeKind::Created, Some(id.as_str())));
                Ok(id)
            }
        }
    })?;
    get(db, &id)
}

pub fn delete(db: &AppDb, id: &Id) -> Result<()> {
    db.transact(|tx, ch| {
        if tx.execute("DELETE FROM stored_prompts WHERE id = ?1", [id.as_str()])? == 0 {
            return Err(CoreError::not_found(format!("stored prompt {id}")));
        }
        ch.push(AppChange::new(Domain::StoredPrompts, ChangeKind::Deleted, Some(id.as_str())));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use crate::error::ErrorCode;

    #[test]
    fn round_trip() {
        let a = app();
        let p = upsert(&a.db, StoredPromptInput { id: None, name: "Review".into(), content: "Review this".into(), category: Some(" qa ".into()) }).unwrap();
        assert_eq!(p.category.as_deref(), Some("qa"));
        let u = upsert(&a.db, StoredPromptInput { id: Some(p.id.clone()), name: "Review 2".into(), content: "x".into(), category: None }).unwrap();
        assert_eq!((u.name.as_str(), u.category.clone()), ("Review 2", None));
        assert_eq!(list(&a.db).unwrap().len(), 1);
        let ev = a.take_events();
        assert_eq!(ev.iter().filter(|e| e.domain == Domain::StoredPrompts).count(), 2);
        delete(&a.db, &p.id).unwrap();
        assert_eq!(get(&a.db, &p.id).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(upsert(&a.db, StoredPromptInput { id: Some(p.id.clone()), name: "x".into(), content: "".into(), category: None }).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(upsert(&a.db, StoredPromptInput { id: None, name: "".into(), content: "".into(), category: None }).unwrap_err().code, ErrorCode::InvalidInput);
    }
}
