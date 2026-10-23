//! Custom agent definitions (data-layer.md §7 `agent_definitions`).
//!
//! Only user-created definitions are stored; built-in definitions are Rust
//! consts owned by the missions domain (DL-9) and passed to [`list`] to merge.
//! The Tauri commands for this table live with missions (§10.2, DL-9).

use crate::error::{CoreError, Result};
use crate::events::{ChangeKind, Domain};
use crate::ids::{new_id, Id};
use crate::model::Timestamp;
use crate::store::{AppChange, AppDb};
use crate::time::now_ms;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: Id,
    pub name: String,
    pub description: Option<String>,
    pub role: String,
    pub provider_id: String,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    /// `true` for definitions shipped as consts (never stored).
    pub builtin: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// Create (no `id`) or replace (existing custom `id`).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinitionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Id>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub role: String,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

const COLS: &str = "id, name, description, role, provider_id, model, system_prompt, created_at, updated_at";

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<AgentDefinition> {
    let id: String = r.get(0)?;
    Ok(AgentDefinition {
        id: Id::parse(&id).map_err(|e| rusqlite::Error::InvalidColumnType(0, e.message, rusqlite::types::Type::Text))?,
        name: r.get(1)?,
        description: r.get(2)?,
        role: r.get(3)?,
        provider_id: r.get(4)?,
        model: r.get(5)?,
        system_prompt: r.get(6)?,
        builtin: false,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

pub fn list_custom(db: &AppDb) -> Result<Vec<AgentDefinition>> {
    db.read(|c| {
        let mut stmt = c.prepare(&format!("SELECT {COLS} FROM agent_definitions ORDER BY name"))?;
        let rows = stmt.query_map([], from_row)?;
        rows.collect()
    })
}

/// Built-ins first (as given), then custom definitions.
pub fn list(db: &AppDb, builtins: &[AgentDefinition]) -> Result<Vec<AgentDefinition>> {
    let mut out: Vec<AgentDefinition> = builtins.iter().cloned().map(|mut d| { d.builtin = true; d }).collect();
    out.extend(list_custom(db)?);
    Ok(out)
}

pub fn get(db: &AppDb, id: &Id) -> Result<AgentDefinition> {
    db.read(|c| c.query_row(&format!("SELECT {COLS} FROM agent_definitions WHERE id = ?1"), [id.as_str()], from_row))
        .map_err(|e| if e.code == crate::error::ErrorCode::NotFound { CoreError::not_found(format!("agent definition {id}")) } else { e })
}

fn opt(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn upsert(db: &AppDb, input: AgentDefinitionInput) -> Result<AgentDefinition> {
    if input.id.as_ref().is_some_and(Id::is_builtin) {
        return Err(CoreError::conflict("built-in agent definitions cannot be modified"));
    }
    let name = super::non_empty("agent name", &input.name)?;
    let role = super::non_empty("agent role", &input.role)?;
    let provider = super::non_empty("agent provider", &input.provider_id)?;
    crate::agents::spec::validate_provider_id(&provider)?;
    let (description, model, system_prompt) = (opt(input.description), opt(input.model), opt(input.system_prompt));
    if let Some(m) = &model {
        crate::agents::validate_model_id(m)?;
    }
    let id = db.transact(|tx, ch| {
        let now = now_ms();
        match &input.id {
            Some(id) => {
                let n = tx.execute(
                    "UPDATE agent_definitions SET name = ?1, description = ?2, role = ?3, provider_id = ?4, model = ?5,
                       system_prompt = ?6, updated_at = ?7 WHERE id = ?8",
                    rusqlite::params![name, description, role, provider, model, system_prompt, now, id.as_str()],
                )?;
                if n == 0 {
                    return Err(CoreError::not_found(format!("agent definition {id}")));
                }
                ch.push(AppChange::new(Domain::AgentDefinitions, ChangeKind::Updated, Some(id.as_str())));
                Ok(id.clone())
            }
            None => {
                let id = new_id();
                tx.execute(
                    &format!("INSERT INTO agent_definitions ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)"),
                    rusqlite::params![id.as_str(), name, description, role, provider, model, system_prompt, now],
                )?;
                ch.push(AppChange::new(Domain::AgentDefinitions, ChangeKind::Created, Some(id.as_str())));
                Ok(id)
            }
        }
    })?;
    get(db, &id)
}

pub fn delete(db: &AppDb, id: &Id) -> Result<()> {
    if id.is_builtin() {
        return Err(CoreError::conflict("built-in agent definitions cannot be deleted"));
    }
    db.transact(|tx, ch| {
        if tx.execute("DELETE FROM agent_definitions WHERE id = ?1", [id.as_str()])? == 0 {
            return Err(CoreError::not_found(format!("agent definition {id}")));
        }
        ch.push(AppChange::new(Domain::AgentDefinitions, ChangeKind::Deleted, Some(id.as_str())));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::app::test_util::app;
    use crate::error::ErrorCode;

    #[test]
    fn custom_crud_merges_builtins() {
        let a = app();
        let d = upsert(&a.db, AgentDefinitionInput { id: None, name: "Reviewer".into(), description: Some(" ".into()), role: "reviewer".into(), provider_id: "provider-a".into(), model: Some("opus".into()), system_prompt: None }).unwrap();
        assert_eq!(d.description, None);
        assert!(!d.builtin);
        let builtin = AgentDefinition { id: Id::builtin("fullstack"), builtin: false, ..d.clone() };
        let all = list(&a.db, &[builtin]).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all[0].builtin && !all[1].builtin);
        assert_eq!(delete(&a.db, &Id::builtin("fullstack")).unwrap_err().code, ErrorCode::Conflict);
        let u = upsert(&a.db, AgentDefinitionInput { id: Some(d.id.clone()), name: "R2".into(), description: None, role: "reviewer".into(), provider_id: "provider-b".into(), model: None, system_prompt: Some("be terse".into()) }).unwrap();
        assert_eq!((u.provider_id.as_str(), u.system_prompt.as_deref()), ("provider-b", Some("be terse")));
        delete(&a.db, &d.id).unwrap();
        assert!(list_custom(&a.db).unwrap().is_empty());
    }
}
