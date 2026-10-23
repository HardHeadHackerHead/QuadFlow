//! Labels — `labels.json` (data-layer.md §6.3). Issues and epics reference
//! labels by name; using an unknown name adds it to the catalog.

use super::model::{Epic, Issue, Label, Labels};
use crate::error::{CoreError, Result};
use crate::model::Actor;
use crate::store::{ProjectStore, Tx};
use crate::time::now_ms;
use regex::Regex;
use std::sync::OnceLock;

/// Colors assigned to labels created implicitly (by name hash).
pub const DEFAULT_COLORS: [&str; 8] =
    ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];

const MAX_NAME: usize = 50;

pub fn validate_label_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(CoreError::invalid_input("label name must not be empty"));
    }
    if n.chars().count() > MAX_NAME {
        return Err(CoreError::invalid_input(format!("label name is longer than {MAX_NAME} characters")));
    }
    if n.contains(',') || n.chars().any(char::is_control) {
        return Err(CoreError::invalid_input(format!("invalid label name {n:?}: no commas or control characters")));
    }
    Ok(n.to_string())
}

fn color_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap())
}

pub fn validate_color(c: &str) -> Result<String> {
    let c = c.trim();
    if color_re().is_match(c) {
        Ok(c.to_ascii_lowercase())
    } else {
        Err(CoreError::invalid_input(format!("invalid color {c:?}: expected #rrggbb")))
    }
}

pub fn default_color(name: &str) -> &'static str {
    let h = name.bytes().fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
    DEFAULT_COLORS[(h as usize) % DEFAULT_COLORS.len()]
}

fn sorted(mut v: Vec<Label>) -> Vec<Label> {
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    v
}

pub fn labels_list(s: &ProjectStore) -> Result<Vec<Label>> {
    Ok(sorted(s.read_singleton::<Labels>()?.labels))
}

/// Add any of `names` missing from the catalog (default colors).
pub fn ensure_labels_in_tx(tx: &mut Tx, names: &[String]) -> Result<()> {
    if names.is_empty() {
        return Ok(());
    }
    let current: Labels = tx.read_singleton()?;
    let missing: Vec<&String> = names.iter().filter(|n| !current.labels.iter().any(|l| &l.name == *n)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    tx.update_singleton::<Labels>(|l| {
        for n in missing {
            l.labels.push(Label { name: n.clone(), color: default_color(n).to_string(), description: None });
        }
        l.labels = sorted(std::mem::take(&mut l.labels));
    })?;
    Ok(())
}

/// Create or update a label. With `rename_from`, the label of that name is
/// renamed to `label.name` everywhere (issues and epics included).
pub fn label_upsert(s: &ProjectStore, actor: &Actor, label: Label, rename_from: Option<String>) -> Result<Vec<Label>> {
    let name = validate_label_name(&label.name)?;
    let color = validate_color(&label.color)?;
    let description = label.description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    let rename_from = match rename_from {
        Some(r) => Some(validate_label_name(&r)?).filter(|r| r != &name),
        None => None,
    };
    s.write(actor, |tx| {
        let current: Labels = tx.read_singleton()?;
        if let Some(old) = &rename_from {
            if !current.labels.iter().any(|l| &l.name == old) {
                return Err(CoreError::not_found(format!("label {old:?} not found")));
            }
            if current.labels.iter().any(|l| l.name == name) {
                return Err(CoreError::conflict(format!("label {name:?} already exists")));
            }
            replace_label_everywhere(tx, old, Some(&name))?;
        }
        let new = Label { name: name.clone(), color, description };
        let out = tx.update_singleton::<Labels>(|l| {
            if let Some(old) = &rename_from {
                l.labels.retain(|x| &x.name != old);
            }
            match l.labels.iter_mut().find(|x| x.name == name) {
                Some(x) => *x = new,
                None => l.labels.push(new),
            }
            l.labels = sorted(std::mem::take(&mut l.labels));
        })?;
        Ok(out.labels)
    })
}

/// Delete a label from the catalog and strip it from every issue and epic.
pub fn label_delete(s: &ProjectStore, actor: &Actor, name: &str) -> Result<Vec<Label>> {
    let name = validate_label_name(name)?;
    s.write(actor, |tx| {
        let current: Labels = tx.read_singleton()?;
        if !current.labels.iter().any(|l| l.name == name) {
            return Err(CoreError::not_found(format!("label {name:?} not found")));
        }
        replace_label_everywhere(tx, &name, None)?;
        let out = tx.update_singleton::<Labels>(|l| l.labels.retain(|x| x.name != name))?;
        Ok(out.labels)
    })
}

/// Rename (`Some(new)`) or remove (`None`) a label name on all issues and epics.
fn replace_label_everywhere(tx: &mut Tx, old: &str, new: Option<&str>) -> Result<()> {
    let now = now_ms();
    let fix = |labels: &mut Vec<String>| -> bool {
        if !labels.iter().any(|l| l == old) {
            return false;
        }
        labels.retain(|l| l != old);
        if let Some(n) = new {
            if !labels.iter().any(|l| l == n) {
                labels.push(n.to_string());
            }
        }
        labels.sort();
        true
    };
    for mut i in tx.list::<Issue>()?.items {
        if fix(&mut i.labels) {
            i.updated_at = now;
            tx.put(&i)?;
        }
    }
    for mut e in tx.list::<Epic>()?.items {
        if fix(&mut e.labels) {
            e.updated_at = now;
            tx.put(&e)?;
        }
    }
    Ok(())
}
