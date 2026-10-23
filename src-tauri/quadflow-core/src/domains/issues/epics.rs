//! Epics — `epics/<id>.json` (data-layer.md §6.3).

use super::labels::ensure_labels_in_tx;
use super::model::{Epic, EpicPatch, EpicStatus, Issue, NewEpic};
use super::service::clean_labels;
use crate::error::{CoreError, Result};
use crate::ids::{new_id, Id};
use crate::model::{Actor, ListResult};
use crate::store::ProjectStore;
use crate::time::now_ms;

/// Sorted by creation (id order).
pub fn epics_list(s: &ProjectStore) -> Result<ListResult<Epic>> {
    s.list::<Epic>()
}

pub fn epic_get(s: &ProjectStore, id: &Id) -> Result<Epic> {
    s.get(id)
}

fn clean_title(t: &str) -> Result<String> {
    let t = t.trim();
    if t.is_empty() {
        return Err(CoreError::invalid_input("title must not be empty"));
    }
    Ok(t.to_string())
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn epic_create(s: &ProjectStore, actor: &Actor, new: NewEpic) -> Result<Epic> {
    let title = clean_title(&new.title)?;
    let labels = clean_labels(&new.labels)?;
    s.write(actor, |tx| {
        let now = now_ms();
        ensure_labels_in_tx(tx, &labels)?;
        let epic = Epic {
            id: new_id(),
            title,
            description: clean_opt(new.description),
            status: new.status.unwrap_or(EpicStatus::Open),
            priority: new.priority.unwrap_or_default(),
            labels,
            created_at: now,
            created_by: tx.actor().clone(),
            updated_at: now,
            ext: Default::default(),
        };
        tx.put(&epic)?;
        Ok(epic)
    })
}

pub fn epic_update(s: &ProjectStore, actor: &Actor, id: &Id, patch: EpicPatch) -> Result<Epic> {
    let title = patch.title.as_deref().map(clean_title).transpose()?;
    let labels = patch.labels.as_deref().map(clean_labels).transpose()?;
    s.write(actor, |tx| {
        let mut epic: Epic = tx.get(id)?;
        if let Some(t) = title {
            epic.title = t;
        }
        if let Some(d) = patch.description {
            epic.description = clean_opt(d);
        }
        if let Some(st) = patch.status {
            epic.status = st;
        }
        if let Some(p) = patch.priority {
            epic.priority = p;
        }
        if let Some(l) = labels {
            ensure_labels_in_tx(tx, &l)?;
            epic.labels = l;
        }
        epic.updated_at = now_ms();
        tx.put(&epic)?;
        Ok(epic)
    })
}

/// Delete an epic and unlink its issues (`epicId` cleared).
pub fn epic_delete(s: &ProjectStore, actor: &Actor, id: &Id) -> Result<()> {
    s.write(actor, |tx| {
        tx.delete::<Epic>(id)?;
        let now = now_ms();
        for mut i in tx.list::<Issue>()?.items {
            if i.epic_id.as_ref() == Some(id) {
                i.epic_id = None;
                i.updated_at = now;
                tx.put(&i)?;
            }
        }
        Ok(())
    })
}
