//! `quadflow ideas …` (data-layer.md §6.2, §11). Thin wrapper over
//! `domains::ideas`; every subcommand honours `--json`.

use super::output::Out;
use super::Ctx;
use crate::domains::ideas::{self, ExportFormat, Idea, IdeaPatch, IdeaQuery, NewIdea, SuggestionKind};
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::io::Write;

#[derive(Subcommand, Debug)]
pub enum IdeasAction {
    /// List ideas, newest first (archived hidden unless --include-archived).
    #[command(visible_alias = "search")]
    List(ListArgs),
    /// Show one idea.
    Get(IdArg),
    /// Create an idea.
    Create(CreateArgs),
    /// Change content, tags, archived flag or discovery link.
    Update(UpdateArgs),
    /// Delete an idea.
    Delete(IdArg),
    /// Add a tag (lowercased).
    #[command(visible_alias = "tag")]
    AddTag(TagArgs),
    /// Remove a tag.
    #[command(visible_alias = "untag")]
    RemoveTag(TagArgs),
    /// Add one tag to several ideas: `bulk-tag <id,id,…> <tag>`.
    BulkTag(BulkTagArgs),
    /// Hide an idea from default listings.
    Archive(IdArg),
    /// Show a previously archived idea again.
    Unarchive(IdArg),
    /// Merge ideas into one: `merge <id,id,…> <keep-id>`. Content is concatenated,
    /// tags and notes are unioned, the others are deleted.
    Merge(MergeArgs),
    /// Add a note to an idea.
    AddNote(NoteArgs),
    /// Delete a note from an idea.
    DeleteNote(SubIdArgs),
    /// Propose new text for an idea.
    AddSuggestion(SuggestionArgs),
    /// Accept (content = suggestion) or reject a pending suggestion.
    ResolveSuggestion(ResolveArgs),
    /// Delete a suggestion.
    DeleteSuggestion(SubIdArgs),
    /// Restore an idea's original content.
    Revert(IdArg),
    /// Counts: total, active, archived, per tag.
    Stats,
    /// Export every idea as json, markdown or csv.
    Export(ExportArgs),
}

#[derive(Args, Debug)]
pub struct IdArg {
    /// Idea id.
    id: String,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Case-insensitive text to find in content or tags.
    #[arg(long, visible_alias = "query")]
    text: Option<String>,
    /// Only ideas with all of these tags (repeatable or comma-separated).
    #[arg(long = "tag", visible_alias = "tags", value_delimiter = ',')]
    tags: Vec<String>,
    /// Include archived ideas.
    #[arg(long)]
    include_archived: bool,
    /// Created at or after this epoch-ms timestamp.
    #[arg(long, visible_alias = "from-date")]
    from: Option<i64>,
    /// Created at or before this epoch-ms timestamp.
    #[arg(long, visible_alias = "to-date")]
    to: Option<i64>,
    /// Only ideas linked to this discovery project.
    #[arg(long)]
    discovery: Option<String>,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    /// Idea text.
    content: String,
    /// Tags (repeatable or comma-separated).
    #[arg(long = "tag", visible_alias = "tags", value_delimiter = ',')]
    tags: Vec<String>,
    /// Link to a discovery project.
    #[arg(long)]
    discovery: Option<String>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Idea id.
    id: String,
    /// New content (positional form kept for older scripts).
    #[arg(conflicts_with = "content_flag")]
    content: Option<String>,
    /// New content.
    #[arg(long = "content")]
    content_flag: Option<String>,
    /// Replace all tags (comma-separated; empty string clears).
    #[arg(long)]
    tags: Option<String>,
    /// Set the archived flag.
    #[arg(long)]
    archived: Option<bool>,
    /// Link to a discovery project.
    #[arg(long, conflicts_with = "no_discovery")]
    discovery: Option<String>,
    /// Remove the discovery link.
    #[arg(long)]
    no_discovery: bool,
}

#[derive(Args, Debug)]
pub struct TagArgs {
    /// Idea id.
    id: String,
    /// Tag.
    tag: String,
}

#[derive(Args, Debug)]
pub struct BulkTagArgs {
    /// Comma-separated idea ids.
    ids: String,
    /// Tag to add.
    tag: String,
}

#[derive(Args, Debug)]
pub struct MergeArgs {
    /// Comma-separated ids of the ideas to merge (including the one to keep).
    ids: String,
    /// The id that survives.
    keep: String,
}

#[derive(Args, Debug)]
pub struct NoteArgs {
    /// Idea id.
    id: String,
    /// Note text.
    body: String,
}

#[derive(Args, Debug)]
pub struct SubIdArgs {
    /// Idea id.
    id: String,
    /// Note or suggestion id.
    sub_id: String,
}

#[derive(Args, Debug)]
pub struct SuggestionArgs {
    /// Idea id.
    id: String,
    /// Kind of suggestion.
    #[arg(long, value_enum, default_value = "reword")]
    kind: SuggestionKind,
    /// Proposed text.
    text: String,
}

#[derive(Args, Debug)]
pub struct ResolveArgs {
    /// Idea id.
    id: String,
    /// Suggestion id.
    suggestion_id: String,
    /// Accept: the idea's content becomes the suggestion text.
    #[arg(long, conflicts_with = "reject", required_unless_present = "reject")]
    accept: bool,
    /// Reject: content unchanged.
    #[arg(long)]
    reject: bool,
}

#[derive(Args, Debug)]
pub struct ExportArgs {
    /// Output format.
    #[arg(long, value_enum, default_value = "markdown")]
    format: ExportFormat,
}

fn parse_ids(csv: &str) -> Result<Vec<Id>> {
    let ids: Vec<Id> = csv.split(',').map(str::trim).filter(|s| !s.is_empty()).map(Id::parse).collect::<Result<_>>()?;
    if ids.is_empty() {
        return Err(CoreError::invalid_input("no idea ids given"));
    }
    Ok(ids)
}

fn opt_id(s: Option<String>) -> Result<Option<Id>> {
    s.as_deref().map(Id::parse).transpose()
}

fn line(w: &mut dyn Write, i: &Idea) -> std::io::Result<()> {
    let tags = if i.tags.is_empty() { String::new() } else { format!(" [{}]", i.tags.join(", ")) };
    let arch = if i.archived { " (archived)" } else { "" };
    let first = i.content.lines().next().unwrap_or("");
    let preview: String = first.chars().take(80).collect();
    let more = if first.chars().count() > 80 || i.content.lines().nth(1).is_some() { "…" } else { "" };
    writeln!(w, "{}{tags}{arch}  {preview}{more}", i.id)
}

fn detail(w: &mut dyn Write, i: &Idea) -> std::io::Result<()> {
    writeln!(w, "{}", i.id)?;
    if !i.tags.is_empty() {
        writeln!(w, "tags: {}", i.tags.join(", "))?;
    }
    if i.archived {
        writeln!(w, "(archived)")?;
    }
    if let Some(d) = &i.discovery_id {
        writeln!(w, "discovery: {d}")?;
    }
    writeln!(w, "\n{}", i.content)?;
    if i.content != i.original_content {
        writeln!(w, "\noriginal:\n{}", i.original_content)?;
    }
    if !i.suggestions.is_empty() {
        writeln!(w, "\nsuggestions:")?;
        for s in &i.suggestions {
            let state = match s.accepted {
                None => "pending",
                Some(true) => "accepted",
                Some(false) => "rejected",
            };
            writeln!(w, "  {} [{:?}, {state}] {}", s.id, s.kind, s.text)?;
        }
    }
    if !i.notes.is_empty() {
        writeln!(w, "\nnotes:")?;
        for n in &i.notes {
            writeln!(w, "  {} ({}): {}", n.id, n.created_by.name, n.body)?;
        }
    }
    Ok(())
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: IdeasAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    match run(ctx, out, &store, action) {
        Ok(code) => code,
        Err(e) => out.err(&e),
    }
}

fn run(ctx: &Ctx, out: &mut Out, s: &ProjectStore, action: IdeasAction) -> Result<i32> {
    let a = &ctx.actor;
    let one = |out: &mut Out, verb: &'static str, r: Result<Idea>| {
        out.result(r, |w, i| writeln!(w, "{verb} idea {}", i.id))
    };
    Ok(match action {
        IdeasAction::List(l) => {
            let q = IdeaQuery {
                text: l.text,
                tags: l.tags,
                include_archived: l.include_archived,
                from: l.from,
                to: l.to,
                discovery_id: opt_id(l.discovery)?,
            };
            let r = ideas::list(s, &q)?;
            out.ok(&r.items, &r.errors, |w| {
                if r.items.is_empty() {
                    writeln!(w, "(no ideas)")?;
                }
                for i in &r.items {
                    line(w, i)?;
                }
                Ok(())
            })
        }
        IdeasAction::Get(x) => out.result(ideas::get(s, &Id::parse(&x.id)?), detail),
        IdeasAction::Create(c) => {
            let new = NewIdea { content: c.content, tags: c.tags, discovery_id: opt_id(c.discovery)? };
            one(out, "Created", ideas::create(s, a, new))
        }
        IdeasAction::Update(u) => {
            let tags = u.tags.map(|t| t.split(',').map(str::trim).filter(|x| !x.is_empty()).map(String::from).collect());
            let discovery_id = if u.no_discovery { Some(None) } else { opt_id(u.discovery)?.map(Some) };
            let patch = IdeaPatch { content: u.content.or(u.content_flag), tags, archived: u.archived, discovery_id };
            if patch.content.is_none() && patch.tags.is_none() && patch.archived.is_none() && patch.discovery_id.is_none() {
                return Err(CoreError::invalid_input(
                    "nothing to update: pass content, --tags, --archived, --discovery or --no-discovery",
                ));
            }
            one(out, "Updated", ideas::update(s, a, &Id::parse(&u.id)?, patch))
        }
        IdeasAction::Delete(x) => {
            let id = Id::parse(&x.id)?;
            ideas::delete(s, a, &id)?;
            out.ok(&serde_json::json!({ "id": id, "deleted": true }), &[], |w| writeln!(w, "Deleted idea {id}"))
        }
        IdeasAction::AddTag(t) => {
            out.result(ideas::add_tag(s, a, &Id::parse(&t.id)?, &t.tag), |w, i| writeln!(w, "Tags: {}", i.tags.join(", ")))
        }
        IdeasAction::RemoveTag(t) => {
            out.result(ideas::remove_tag(s, a, &Id::parse(&t.id)?, &t.tag), |w, i| writeln!(w, "Tags: {}", i.tags.join(", ")))
        }
        IdeasAction::BulkTag(b) => {
            out.result(ideas::bulk_tag(s, a, &parse_ids(&b.ids)?, &b.tag), |w, v| writeln!(w, "Tagged {} idea(s).", v.len()))
        }
        IdeasAction::Archive(x) => one(
            out,
            "Archived",
            ideas::update(s, a, &Id::parse(&x.id)?, IdeaPatch { archived: Some(true), ..Default::default() }),
        ),
        IdeasAction::Unarchive(x) => one(
            out,
            "Unarchived",
            ideas::update(s, a, &Id::parse(&x.id)?, IdeaPatch { archived: Some(false), ..Default::default() }),
        ),
        IdeasAction::Merge(m) => {
            let r = ideas::merge(s, a, &parse_ids(&m.ids)?, &Id::parse(&m.keep)?);
            one(out, "Merged into", r)
        }
        IdeasAction::AddNote(n) => {
            out.result(ideas::add_note(s, a, &Id::parse(&n.id)?, &n.body), |w, i| {
                writeln!(w, "Added note {} to idea {}", i.notes.last().map(|n| n.id.as_str()).unwrap_or(""), i.id)
            })
        }
        IdeasAction::DeleteNote(x) => {
            one(out, "Updated", ideas::delete_note(s, a, &Id::parse(&x.id)?, &Id::parse(&x.sub_id)?))
        }
        IdeasAction::AddSuggestion(x) => {
            out.result(ideas::add_suggestion(s, a, &Id::parse(&x.id)?, x.kind, &x.text), |w, i| {
                writeln!(w, "Added suggestion {} to idea {}", i.suggestions.last().map(|s| s.id.as_str()).unwrap_or(""), i.id)
            })
        }
        IdeasAction::ResolveSuggestion(x) => {
            let verb = if x.accept { "Accepted suggestion on" } else { "Rejected suggestion on" };
            one(out, verb, ideas::resolve_suggestion(s, a, &Id::parse(&x.id)?, &Id::parse(&x.suggestion_id)?, x.accept))
        }
        IdeasAction::DeleteSuggestion(x) => {
            one(out, "Updated", ideas::delete_suggestion(s, a, &Id::parse(&x.id)?, &Id::parse(&x.sub_id)?))
        }
        IdeasAction::Revert(x) => one(out, "Reverted", ideas::revert(s, a, &Id::parse(&x.id)?)),
        IdeasAction::Stats => {
            let (st, errors) = ideas::stats_report(s)?;
            out.ok(&st, &errors, |w| {
                writeln!(w, "{} idea(s): {} active, {} archived", st.total, st.active, st.archived)?;
                for (t, n) in &st.by_tag {
                    writeln!(w, "  {t}: {n}")?;
                }
                Ok(())
            })
        }
        IdeasAction::Export(x) => {
            let (text, errors) = ideas::export_report(s, x.format)?;
            out.ok(&text, &errors, |w| write!(w, "{text}"))
        }
    })
}
