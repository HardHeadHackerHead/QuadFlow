//! `quadflow discovery …` (data-layer.md §6.5, §11). Thin wrapper over
//! `domains::discovery`; every subcommand honours `--json`.

use super::output::Out;
use super::Ctx;
use crate::domains::discovery::{
    self, DiscoveryItemKind, DiscoveryItemPatch, DiscoveryPatch, DiscoveryProject, DiscoveryQuery, DiscoveryStatus,
    NewDiscoveryItem, NewDiscoveryProject,
};
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::io::Write;

#[derive(Subcommand, Debug)]
pub enum DiscoveryAction {
    /// List discovery projects, newest first.
    List(ListArgs),
    /// Show one discovery project with its items.
    Get(IdArg),
    /// Create a discovery project.
    Create(CreateArgs),
    /// Change title, overview, goals, success criteria or status.
    Update(UpdateArgs),
    /// Delete a discovery project (clears the link on its ideas and plans).
    Delete(IdArg),
    /// Add a research / requirement / question / reference / decision / note item.
    ItemAdd(ItemAddArgs),
    /// Change an item.
    ItemUpdate(ItemUpdateArgs),
    /// Delete an item.
    ItemDelete(ItemIdArgs),
    /// Reorder items: `items-reorder <id> <item-id,item-id,…>` (unlisted items follow).
    ItemsReorder(ReorderArgs),
    /// Ideas and plans linked to a discovery project (link with `ideas update --discovery`).
    Linked(IdArg),
}

#[derive(Args, Debug)]
pub struct IdArg {
    /// Discovery project id.
    id: String,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Only this status.
    #[arg(long, value_enum)]
    status: Option<DiscoveryStatus>,
    /// Case-insensitive text to find in title or overview.
    #[arg(long, visible_alias = "query")]
    text: Option<String>,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Title.
    title: String,
    /// Short overview / elevator pitch.
    #[arg(long)]
    overview: Option<String>,
    /// A goal (repeatable).
    #[arg(long = "goal")]
    goals: Vec<String>,
    /// A success criterion (repeatable).
    #[arg(long = "criterion", visible_alias = "success-criterion")]
    success_criteria: Vec<String>,
    /// Initial status (default: discovery).
    #[arg(long, value_enum)]
    status: Option<DiscoveryStatus>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Discovery project id.
    id: String,
    #[arg(long)]
    title: Option<String>,
    /// New overview ("" clears).
    #[arg(long)]
    overview: Option<String>,
    /// Replace the goals (repeatable).
    #[arg(long = "goal", conflicts_with = "no_goals")]
    goals: Vec<String>,
    /// Remove all goals.
    #[arg(long)]
    no_goals: bool,
    /// Replace the success criteria (repeatable).
    #[arg(long = "criterion", visible_alias = "success-criterion", conflicts_with = "no_criteria")]
    success_criteria: Vec<String>,
    /// Remove all success criteria.
    #[arg(long)]
    no_criteria: bool,
    #[arg(long, value_enum)]
    status: Option<DiscoveryStatus>,
}

#[derive(Args, Debug)]
pub struct ItemAddArgs {
    /// Discovery project id.
    id: String,
    /// Item kind.
    #[arg(long, value_enum, visible_alias = "item-type")]
    kind: DiscoveryItemKind,
    #[arg(long)]
    title: String,
    #[arg(long)]
    content: Option<String>,
    /// Free-form status, e.g. pending, answered, must_have, nice_to_have.
    #[arg(long)]
    status: Option<String>,
    /// JSON value, e.g. '{"url":"https://…"}'.
    #[arg(long)]
    metadata: Option<String>,
}

#[derive(Args, Debug)]
pub struct ItemUpdateArgs {
    /// Discovery project id.
    id: String,
    /// Item id.
    item_id: String,
    #[arg(long, value_enum, visible_alias = "item-type")]
    kind: Option<DiscoveryItemKind>,
    #[arg(long)]
    title: Option<String>,
    /// New content ("" clears).
    #[arg(long)]
    content: Option<String>,
    /// New status ("" clears).
    #[arg(long)]
    status: Option<String>,
    /// New metadata JSON ("" clears).
    #[arg(long)]
    metadata: Option<String>,
}

#[derive(Args, Debug)]
pub struct ItemIdArgs {
    /// Discovery project id.
    id: String,
    /// Item id.
    item_id: String,
}

#[derive(Args, Debug)]
pub struct ReorderArgs {
    /// Discovery project id.
    id: String,
    /// Comma-separated item ids in the new order.
    item_ids: String,
}

fn parse_metadata(s: &str) -> Result<serde_json::Value> {
    serde_json::from_str(s).map_err(|e| CoreError::invalid_input(format!("--metadata is not valid JSON: {e}")))
}

/// `""` → clear (`Some(None)`), else set.
fn clearable(s: Option<String>) -> Option<Option<String>> {
    s.map(|v| if v.trim().is_empty() { None } else { Some(v) })
}

fn line(w: &mut dyn Write, p: &DiscoveryProject) -> std::io::Result<()> {
    writeln!(w, "{} [{}] {}  ({} item(s))", p.id, p.status.as_str(), p.title, p.items.len())
}

fn detail(w: &mut dyn Write, p: &DiscoveryProject) -> std::io::Result<()> {
    writeln!(w, "{} [{}] {}", p.id, p.status.as_str(), p.title)?;
    if let Some(o) = &p.overview {
        writeln!(w, "\n{o}")?;
    }
    if !p.goals.is_empty() {
        writeln!(w, "\ngoals:")?;
        for g in &p.goals {
            writeln!(w, "  - {g}")?;
        }
    }
    if !p.success_criteria.is_empty() {
        writeln!(w, "\nsuccess criteria:")?;
        for c in &p.success_criteria {
            writeln!(w, "  - {c}")?;
        }
    }
    if !p.items.is_empty() {
        writeln!(w, "\nitems:")?;
        for i in &p.items {
            let st = i.status.as_deref().map(|s| format!(" ({s})")).unwrap_or_default();
            writeln!(w, "  {} [{}] {}{st}", i.id, i.kind.as_str(), i.title)?;
        }
    }
    Ok(())
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: DiscoveryAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    match run(ctx, out, &store, action) {
        Ok(code) => code,
        Err(e) => out.err(&e),
    }
}

fn run(ctx: &Ctx, out: &mut Out, s: &ProjectStore, action: DiscoveryAction) -> Result<i32> {
    let a = &ctx.actor;
    Ok(match action {
        DiscoveryAction::List(l) => {
            let r = discovery::list(s, &DiscoveryQuery { text: l.text, status: l.status })?;
            out.ok(&r.items, &r.errors, |w| {
                if r.items.is_empty() {
                    writeln!(w, "(no discovery projects)")?;
                }
                for p in &r.items {
                    line(w, p)?;
                }
                Ok(())
            })
        }
        DiscoveryAction::Get(x) => out.result(discovery::get(s, &Id::parse(&x.id)?), detail),
        DiscoveryAction::Create(c) => {
            let new = NewDiscoveryProject {
                title: c.title,
                overview: c.overview,
                goals: c.goals,
                success_criteria: c.success_criteria,
                status: c.status,
            };
            out.result(discovery::create(s, a, new), |w, p| writeln!(w, "Created discovery project {}: {}", p.id, p.title))
        }
        DiscoveryAction::Update(u) => {
            let goals = if u.no_goals { Some(Vec::new()) } else { Some(u.goals).filter(|g| !g.is_empty()) };
            let success_criteria =
                if u.no_criteria { Some(Vec::new()) } else { Some(u.success_criteria).filter(|c| !c.is_empty()) };
            let patch = DiscoveryPatch { title: u.title, overview: clearable(u.overview), goals, success_criteria, status: u.status };
            if patch.title.is_none()
                && patch.overview.is_none()
                && patch.goals.is_none()
                && patch.success_criteria.is_none()
                && patch.status.is_none()
            {
                return Err(CoreError::invalid_input(
                    "nothing to update: pass --title, --overview, --goal, --no-goals, --criterion, --no-criteria or --status",
                ));
            }
            out.result(discovery::update(s, a, &Id::parse(&u.id)?, patch), |w, p| writeln!(w, "Updated discovery project {}", p.id))
        }
        DiscoveryAction::Delete(x) => {
            let id = Id::parse(&x.id)?;
            discovery::delete(s, a, &id)?;
            out.ok(&serde_json::json!({ "id": id, "deleted": true }), &[], |w| writeln!(w, "Deleted discovery project {id}"))
        }
        DiscoveryAction::ItemAdd(i) => {
            let new = NewDiscoveryItem {
                kind: i.kind,
                title: i.title,
                content: i.content,
                status: i.status,
                metadata: i.metadata.as_deref().map(parse_metadata).transpose()?,
            };
            out.result(discovery::item_add(s, a, &Id::parse(&i.id)?, new), |w, p| {
                let it = p.items.last();
                writeln!(w, "Added item {} to discovery project {}", it.map(|i| i.id.as_str()).unwrap_or(""), p.id)
            })
        }
        DiscoveryAction::ItemUpdate(i) => {
            let metadata = match i.metadata {
                None => None,
                Some(m) if m.trim().is_empty() => Some(None),
                Some(m) => Some(Some(parse_metadata(&m)?)),
            };
            let patch = DiscoveryItemPatch {
                kind: i.kind,
                title: i.title,
                content: clearable(i.content),
                status: clearable(i.status),
                metadata,
            };
            if patch.kind.is_none()
                && patch.title.is_none()
                && patch.content.is_none()
                && patch.status.is_none()
                && patch.metadata.is_none()
            {
                return Err(CoreError::invalid_input(
                    "nothing to update: pass --kind, --title, --content, --status or --metadata",
                ));
            }
            let item_id = Id::parse(&i.item_id)?;
            out.result(discovery::item_update(s, a, &Id::parse(&i.id)?, &item_id, patch), |w, _| {
                writeln!(w, "Updated item {item_id}")
            })
        }
        DiscoveryAction::ItemDelete(i) => {
            let item_id = Id::parse(&i.item_id)?;
            out.result(discovery::item_delete(s, a, &Id::parse(&i.id)?, &item_id), |w, _| {
                writeln!(w, "Deleted item {item_id}")
            })
        }
        DiscoveryAction::ItemsReorder(r) => {
            let ids: Vec<Id> =
                r.item_ids.split(',').map(str::trim).filter(|x| !x.is_empty()).map(Id::parse).collect::<Result<_>>()?;
            if ids.is_empty() {
                return Err(CoreError::invalid_input("no item ids given"));
            }
            out.result(discovery::items_reorder(s, a, &Id::parse(&r.id)?, &ids), |w, p| {
                writeln!(w, "Reordered {} item(s) of discovery project {}", p.items.len(), p.id)
            })
        }
        DiscoveryAction::Linked(x) => {
            let l = discovery::linked(s, &Id::parse(&x.id)?)?;
            out.ok(&l, &l.errors, |w| {
                writeln!(w, "ideas ({}):", l.ideas.len())?;
                for i in &l.ideas {
                    let first: String = i.content.lines().next().unwrap_or("").chars().take(80).collect();
                    writeln!(w, "  {}  {first}", i.id)?;
                }
                writeln!(w, "plans ({}):", l.plans.len())?;
                for p in &l.plans {
                    writeln!(w, "  {} [{}] {}  {}/{} steps", p.id, p.status, p.title, p.steps_completed, p.steps_total)?;
                }
                Ok(())
            })
        }
    })
}
