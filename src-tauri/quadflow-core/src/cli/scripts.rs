//! `quadflow scripts …` (data-layer.md §6.6, §10.2, §11): scripts, groups and
//! terminal environments. Mirrors `commands/scripts.rs` one-to-one, plus a few
//! conveniences (tag / pin / archive) that map onto `update`.

use super::output::Out;
use super::Ctx;
use crate::domains::environments::{self, EnvironmentInput, TargetPlatform, ShellKind, TerminalEnvironment};
use crate::domains::scripts::{
    self, ScriptGroupMemberInput, ScriptGroupMode, ScriptResolveOptions, Script, ScriptGroup, ScriptGroupInput, ScriptGroupPatch,
    ScriptInput, ScriptKind, ScriptPatch, ScriptQuery,
};
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;
use clap::{Args, Subcommand};
use std::collections::BTreeMap;
use std::io::Write;

#[derive(Subcommand, Debug)]
pub enum ScriptsAction {
    /// List scripts (pinned first). Archived scripts are hidden unless --include-archived.
    List(ListArgs),
    /// Search scripts (same as `list --text <query>`).
    #[command(hide = true)]
    Search(SearchArgs),
    /// Show one script.
    Get(IdArg),
    /// Create a script.
    Create(CreateArgs),
    /// Update a script (only the given fields; --clear <field> unsets one).
    Update(UpdateArgs),
    /// Delete a script (also removes it from every group).
    Delete(IdArg),
    /// Resolve a script for this machine and print the full command line.
    GetCommand(GetCommandArgs),
    /// Add a tag.
    Tag(TagArgs),
    /// Remove a tag.
    Untag(TagArgs),
    /// Pin (favorite).
    Pin(IdArg),
    Unpin(IdArg),
    /// Hide from default listings.
    Archive(IdArg),
    Unarchive(IdArg),

    /// Script groups (run several scripts together).
    Groups {
        #[command(subcommand)]
        action: GroupsAction,
    },

    /// List this machine's terminal environments.
    EnvList,
    /// Show one terminal environment (id or name).
    EnvGet(KeyArg),
    /// Create or replace a custom terminal environment.
    EnvAdd(EnvAddArgs),
    /// Delete a terminal environment (id or name).
    EnvDelete(KeyArg),
    /// Detect shells / toolchains on this machine and register them.
    EnvDetect,
}

#[derive(Subcommand, Debug)]
pub enum GroupsAction {
    List,
    Get(IdArg),
    Create(GroupCreateArgs),
    Update(GroupUpdateArgs),
    Delete(IdArg),
    /// Add a script to a group.
    Add(GroupAddArgs),
    /// Remove a script from a group.
    Remove(GroupRemoveArgs),
}

#[derive(Args, Debug)]
pub struct IdArg {
    pub id: String,
}

#[derive(Args, Debug)]
pub struct KeyArg {
    /// Environment id or name.
    pub key: String,
}

#[derive(Args, Debug, Default)]
pub struct ListArgs {
    /// Case-insensitive substring of name / description / command / tags.
    #[arg(long)]
    pub text: Option<String>,
    #[arg(long)]
    pub tag: Option<String>,
    #[arg(long)]
    pub pinned: bool,
    #[arg(long)]
    pub include_archived: bool,
    /// Only scripts that run on this platform (windows | macos | linux).
    #[arg(long)]
    pub platform: Option<String>,
}

#[derive(Args, Debug)]
pub struct SearchArgs {
    pub query: Option<String>,
    #[arg(long)]
    pub tag: Option<String>,
    #[arg(long)]
    pub pinned: bool,
    #[arg(long)]
    pub include_archived: bool,
}

#[derive(Args, Debug)]
pub struct TagArgs {
    pub id: String,
    pub tag: String,
}

#[derive(Args, Debug)]
pub struct GetCommandArgs {
    pub id: String,
    /// Resolve for another platform (default: this one).
    #[arg(long)]
    pub platform: Option<String>,
    /// Environment name to use when the script names none.
    #[arg(long)]
    pub default_environment: Option<String>,
}

/// Fields shared by create and update.
#[derive(Args, Debug, Default)]
pub struct ScriptFields {
    #[arg(long)]
    pub description: Option<String>,
    /// Setup command run before the command (repeatable).
    #[arg(long = "setup", value_name = "CMD")]
    pub setup: Vec<String>,
    /// Environment variable KEY=VALUE (repeatable).
    #[arg(long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// Platform the script runs on (repeatable; default all): windows | macos | linux.
    #[arg(long = "platform", value_name = "PLATFORM")]
    pub platforms: Vec<String>,
    /// cmd | powershell | pwsh | bash | zsh | sh.
    #[arg(long)]
    pub shell: Option<String>,
    /// Relative to the project root.
    #[arg(long)]
    pub working_directory: Option<String>,
    /// Terminal environment name (resolved on each machine).
    #[arg(long)]
    pub environment: Option<String>,
    /// command | server | build.
    #[arg(long)]
    pub kind: Option<String>,
    #[arg(long)]
    pub preview_url: Option<String>,
    #[arg(long)]
    pub auto_open_preview: Option<bool>,
    /// Tag (repeatable).
    #[arg(long = "tag", value_name = "TAG")]
    pub tags: Vec<String>,
    #[arg(long)]
    pub pinned: Option<bool>,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    pub name: String,
    #[arg(long)]
    pub command: String,
    #[command(flatten)]
    pub fields: ScriptFields,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    pub id: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub command: Option<String>,
    #[command(flatten)]
    pub fields: ScriptFields,
    #[arg(long)]
    pub archived: Option<bool>,
    /// Unset a field (repeatable): description, shell, working-directory, environment,
    /// preview-url, setup, env, platform, tag.
    #[arg(long = "clear", value_name = "FIELD")]
    pub clear: Vec<String>,
}

#[derive(Args, Debug)]
pub struct GroupCreateArgs {
    pub name: String,
    #[arg(long)]
    pub description: Option<String>,
    /// parallel | sequential (default parallel).
    #[arg(long)]
    pub mode: Option<String>,
    /// Member script id, in order (repeatable).
    #[arg(long = "script", value_name = "SCRIPT_ID")]
    pub scripts: Vec<String>,
}

#[derive(Args, Debug)]
pub struct GroupUpdateArgs {
    pub id: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub description: Option<String>,
    #[arg(long)]
    pub mode: Option<String>,
    /// Unset the description.
    #[arg(long)]
    pub clear_description: bool,
}

#[derive(Args, Debug)]
pub struct GroupAddArgs {
    pub group_id: String,
    pub script_id: String,
    /// 0-based position (default: end).
    #[arg(long)]
    pub order: Option<u32>,
    /// Parallel mode: delay before this member starts.
    #[arg(long)]
    pub delay_ms: Option<u32>,
    #[arg(long)]
    pub auto_open_preview: Option<bool>,
}

#[derive(Args, Debug)]
pub struct GroupRemoveArgs {
    pub group_id: String,
    pub script_id: String,
}

#[derive(Args, Debug)]
pub struct EnvAddArgs {
    pub name: String,
    /// cmd | powershell | pwsh | bash | zsh | sh.
    #[arg(long)]
    pub shell: String,
    #[arg(long)]
    pub description: Option<String>,
    /// Absolute path of the shell executable.
    #[arg(long)]
    pub shell_path: Option<String>,
    /// Init command (repeatable).
    #[arg(long = "init", value_name = "CMD")]
    pub init: Vec<String>,
    /// KEY=VALUE (repeatable).
    #[arg(long = "env", value_name = "KEY=VALUE")]
    pub env: Vec<String>,
    /// Replace the custom environment with this id instead of creating one.
    #[arg(long)]
    pub id: Option<String>,
}

// ---------------------------------------------------------------------------

fn parse_env(pairs: &[String]) -> Result<BTreeMap<String, String>> {
    let mut m = BTreeMap::new();
    for p in pairs {
        let (k, v) = p
            .split_once('=')
            .ok_or_else(|| CoreError::invalid_input(format!("--env {p:?}: expected KEY=VALUE")))?;
        scripts::validate_env_key(k)?;
        m.insert(k.to_string(), v.to_string());
    }
    Ok(m)
}

fn parse_platforms(v: &[String]) -> Result<Vec<TargetPlatform>> {
    v.iter().flat_map(|s| s.split(',')).filter(|s| !s.trim().is_empty() && s.trim() != "all").map(TargetPlatform::parse).collect()
}

fn opt<T>(v: Option<String>, f: impl Fn(&str) -> Result<T>) -> Result<Option<T>> {
    v.as_deref().map(f).transpose()
}

fn script_input(name: String, command: String, f: ScriptFields) -> Result<ScriptInput> {
    Ok(ScriptInput {
        name,
        command,
        description: f.description,
        setup_commands: f.setup,
        env: parse_env(&f.env)?,
        platforms: parse_platforms(&f.platforms)?,
        shell: opt(f.shell, ShellKind::parse)?,
        working_directory: f.working_directory,
        environment: f.environment,
        kind: opt(f.kind, ScriptKind::parse)?,
        preview_url: f.preview_url,
        auto_open_preview: f.auto_open_preview.unwrap_or(false),
        tags: f.tags,
        pinned: f.pinned.unwrap_or(false),
    })
}

fn script_patch(a: UpdateArgs) -> Result<ScriptPatch> {
    let f = a.fields;
    let mut p = ScriptPatch {
        name: a.name,
        command: a.command,
        description: f.description.map(Some),
        setup_commands: (!f.setup.is_empty()).then_some(f.setup),
        env: if f.env.is_empty() { None } else { Some(parse_env(&f.env)?) },
        platforms: if f.platforms.is_empty() { None } else { Some(parse_platforms(&f.platforms)?) },
        shell: opt(f.shell, ShellKind::parse)?.map(Some),
        working_directory: f.working_directory.map(Some),
        environment: f.environment.map(Some),
        kind: opt(f.kind, ScriptKind::parse)?,
        preview_url: f.preview_url.map(Some),
        auto_open_preview: f.auto_open_preview,
        tags: (!f.tags.is_empty()).then_some(f.tags),
        pinned: f.pinned,
        archived: a.archived,
    };
    for c in a.clear {
        match c.as_str() {
            "description" => p.description = Some(None),
            "shell" => p.shell = Some(None),
            "working-directory" | "workingDirectory" => p.working_directory = Some(None),
            "environment" => p.environment = Some(None),
            "preview-url" | "previewUrl" => p.preview_url = Some(None),
            "setup" => p.setup_commands = Some(Vec::new()),
            "env" => p.env = Some(BTreeMap::new()),
            "platform" | "platforms" => p.platforms = Some(Vec::new()),
            "tag" | "tags" => p.tags = Some(Vec::new()),
            other => return Err(CoreError::invalid_input(format!("--clear {other:?}: unknown field"))),
        }
    }
    Ok(p)
}

fn id(s: &str) -> Result<Id> {
    Id::parse(s)
}

fn print_script(w: &mut dyn Write, s: &Script) -> std::io::Result<()> {
    writeln!(w, "{}  {}", s.id, s.name)?;
    if let Some(d) = &s.description {
        writeln!(w, "  {d}")?;
    }
    writeln!(w, "  command: {}", s.command)?;
    for c in &s.setup_commands {
        writeln!(w, "  setup:   {c}")?;
    }
    for (k, v) in &s.env {
        writeln!(w, "  env:     {k}={v}")?;
    }
    let mut meta = vec![format!("kind {:?}", s.kind).to_lowercase()];
    if let Some(sh) = s.shell {
        meta.push(format!("shell {}", sh.as_str()));
    }
    if let Some(e) = &s.environment {
        meta.push(format!("environment {e:?}"));
    }
    if let Some(wd) = &s.working_directory {
        meta.push(format!("cwd {wd}"));
    }
    if !s.platforms.is_empty() {
        meta.push(format!("platforms {}", s.platforms.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(",")));
    }
    if !s.tags.is_empty() {
        meta.push(format!("tags {}", s.tags.join(",")));
    }
    if s.pinned {
        meta.push("pinned".into());
    }
    if s.archived {
        meta.push("archived".into());
    }
    writeln!(w, "  {}", meta.join(" · "))
}

fn print_script_row(w: &mut dyn Write, s: &Script) -> std::io::Result<()> {
    let flag = if s.pinned { "*" } else if s.archived { "~" } else { " " };
    writeln!(w, "{flag} {}  {:<24} {}", s.id, s.name, s.command)
}

fn print_group(w: &mut dyn Write, g: &ScriptGroup, names: &BTreeMap<Id, String>) -> std::io::Result<()> {
    let mode = match g.mode {
        ScriptGroupMode::Parallel => "parallel",
        ScriptGroupMode::Sequential => "sequential",
    };
    writeln!(w, "{}  {} ({mode}, {} scripts)", g.id, g.name, g.members.len())?;
    if let Some(d) = &g.description {
        writeln!(w, "  {d}")?;
    }
    for m in &g.members {
        let name = names.get(&m.script_id).map(String::as_str).unwrap_or("(missing)");
        let delay = if m.delay_ms > 0 { format!("  +{}ms", m.delay_ms) } else { String::new() };
        writeln!(w, "  {}. {} {name}{delay}", m.order + 1, m.script_id)?;
    }
    Ok(())
}

fn print_env(w: &mut dyn Write, e: &TerminalEnvironment) -> std::io::Result<()> {
    let state = if !e.available {
        " (unavailable)"
    } else if e.built_in {
        ""
    } else {
        " (custom)"
    };
    writeln!(w, "{}  {:<28} {}{state}", e.id, e.name, e.shell.as_str())?;
    if let Some(p) = &e.shell_path {
        writeln!(w, "    {p}")?;
    }
    for c in &e.init_commands {
        writeln!(w, "    init: {c}")?;
    }
    Ok(())
}

fn script_names(store: &ProjectStore) -> BTreeMap<Id, String> {
    store
        .list::<Script>()
        .map(|l| l.items.into_iter().map(|s| (s.id, s.name)).collect())
        .unwrap_or_default()
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: ScriptsAction) -> i32 {
    // Environment commands need only the app DB.
    match action {
        ScriptsAction::EnvList => return env_cmd(ctx, out, |db| environments::list(db)),
        ScriptsAction::EnvGet(k) => {
            let db = match ctx.app_db() {
                Ok(d) => d,
                Err(e) => return out.err(&e),
            };
            let r = environments::get_by_id_or_name(&db, &k.key);
            return out.result(r, |w, e| print_env(w, e));
        }
        ScriptsAction::EnvAdd(a) => {
            let r = (|| {
                let input = EnvironmentInput {
                    id: a.id.as_deref().map(Id::parse).transpose()?,
                    name: a.name,
                    description: a.description,
                    shell: ShellKind::parse(&a.shell)?,
                    shell_path: a.shell_path,
                    init_commands: a.init,
                    env: parse_env(&a.env)?,
                };
                environments::upsert(&*ctx.app_db()?, input)
            })();
            return out.result(r, |w, e| print_env(w, e));
        }
        ScriptsAction::EnvDelete(k) => {
            let r = (|| {
                let db = ctx.app_db()?;
                let e = environments::get_by_id_or_name(&db, &k.key)?;
                environments::delete(&db, &e.id)?;
                Ok(serde_json::json!({ "deleted": e.id }))
            })();
            return out.result(r, |w, v| writeln!(w, "Deleted environment {}", v["deleted"].as_str().unwrap_or("")));
        }
        ScriptsAction::EnvDetect => return env_cmd(ctx, out, |db| environments::detect(db)),
        other => project_cmd(ctx, out, other),
    }
}

fn env_cmd(ctx: &Ctx, out: &mut Out, f: impl FnOnce(&crate::store::AppDb) -> Result<Vec<TerminalEnvironment>>) -> i32 {
    let r = ctx.app_db().and_then(|db| f(&db));
    out.result(r, |w, list| {
        if list.is_empty() {
            writeln!(w, "(no environments; run `quadflow scripts env-detect`)")?;
        }
        for e in list {
            print_env(w, e)?;
        }
        Ok(())
    })
}

fn project_cmd(ctx: &Ctx, out: &mut Out, action: ScriptsAction) -> i32 {
    let store = match ctx.project_store() {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    let actor = &ctx.actor;
    let store_ref = &store;
    let set = move |out: &mut Out, id_s: &str, patch: ScriptPatch| set_fields(out, store_ref, actor, id_s, patch);
    match action {
        ScriptsAction::List(a) => {
            let r = (|| {
                let q = ScriptQuery {
                    text: a.text,
                    tag: a.tag,
                    pinned: a.pinned,
                    include_archived: a.include_archived,
                    platform: opt(a.platform, TargetPlatform::parse)?,
                };
                scripts::list(&store, &q)
            })();
            list_out(out, r)
        }
        ScriptsAction::Search(a) => {
            let q = ScriptQuery { text: a.query, tag: a.tag, pinned: a.pinned, include_archived: a.include_archived, platform: None };
            list_out(out, scripts::list(&store, &q))
        }
        ScriptsAction::Get(a) => {
            let r = id(&a.id).and_then(|i| scripts::get(&store, &i));
            out.result(r, |w, s| print_script(w, s))
        }
        ScriptsAction::Create(a) => {
            let r = script_input(a.name, a.command, a.fields).and_then(|i| scripts::create(&store, actor, i));
            out.result(r, |w, s| {
                writeln!(w, "Created script {}", s.id)?;
                print_script(w, s)
            })
        }
        ScriptsAction::Update(a) => {
            let id_s = a.id.clone();
            match script_patch(a) {
                Ok(p) => set(out, &id_s, p),
                Err(e) => out.err(&e),
            }
        }
        ScriptsAction::Delete(a) => {
            let r = id(&a.id).and_then(|i| scripts::delete(&store, actor, &i).map(|()| i));
            out.result(r.map(|i| serde_json::json!({ "deleted": i })), |w, v| {
                writeln!(w, "Deleted script {}", v["deleted"].as_str().unwrap_or(""))
            })
        }
        ScriptsAction::GetCommand(a) => {
            let r = (|| {
                let i = id(&a.id)?;
                let opts = ScriptResolveOptions { platform: opt(a.platform, TargetPlatform::parse)?, default_environment: a.default_environment };
                let script = scripts::get(&store, &i)?;
                // The app DB is opened only when an environment must be resolved.
                let db = if script.environment.is_some() || opts.default_environment.is_some() {
                    Some(ctx.app_db()?)
                } else {
                    None
                };
                scripts::resolve_command(&store, db.as_deref(), &i, &opts)
            })();
            out.result(r, |w, rc| writeln!(w, "{}", rc.full_command))
        }
        ScriptsAction::Tag(a) => tag(out, &store, actor, &a.id, &a.tag, true),
        ScriptsAction::Untag(a) => tag(out, &store, actor, &a.id, &a.tag, false),
        ScriptsAction::Pin(a) => set(out, &a.id, ScriptPatch { pinned: Some(true), ..Default::default() }),
        ScriptsAction::Unpin(a) => set(out, &a.id, ScriptPatch { pinned: Some(false), ..Default::default() }),
        ScriptsAction::Archive(a) => set(out, &a.id, ScriptPatch { archived: Some(true), ..Default::default() }),
        ScriptsAction::Unarchive(a) => set(out, &a.id, ScriptPatch { archived: Some(false), ..Default::default() }),
        ScriptsAction::Groups { action } => groups(out, &store, actor, action),
        ScriptsAction::EnvList
        | ScriptsAction::EnvGet(_)
        | ScriptsAction::EnvAdd(_)
        | ScriptsAction::EnvDelete(_)
        | ScriptsAction::EnvDetect => unreachable!("handled in handle()"),
    }
}

fn set_fields(out: &mut Out, store: &ProjectStore, actor: &crate::Actor, id_s: &str, patch: ScriptPatch) -> i32 {
    let r = id(id_s).and_then(|i| scripts::update(store, actor, &i, patch));
    out.result(r, |w, s| print_script(w, s))
}

fn tag(out: &mut Out, store: &ProjectStore, actor: &crate::Actor, id_s: &str, t: &str, add: bool) -> i32 {
    let r = (|| {
        let i = id(id_s)?;
        let mut tags = scripts::get(store, &i)?.tags;
        let t = t.trim().to_lowercase();
        if add {
            tags.push(t);
        } else {
            tags.retain(|x| *x != t);
        }
        scripts::update(store, actor, &i, ScriptPatch { tags: Some(tags), ..Default::default() })
    })();
    out.result(r, |w, s| print_script(w, s))
}

fn list_out(out: &mut Out, r: Result<crate::ListResult<Script>>) -> i32 {
    match r {
        Ok(l) => out.ok(&l.items, &l.errors, |w| {
            if l.items.is_empty() {
                writeln!(w, "(no scripts)")?;
            }
            for s in &l.items {
                print_script_row(w, s)?;
            }
            Ok(())
        }),
        Err(e) => out.err(&e),
    }
}

fn show_group(out: &mut Out, store: &ProjectStore, r: Result<ScriptGroup>) -> i32 {
    let n = script_names(store);
    out.result(r, |w, g| print_group(w, g, &n))
}

fn groups(out: &mut Out, store: &ProjectStore, actor: &crate::Actor, action: GroupsAction) -> i32 {
    let names = || script_names(store);
    let show = |out: &mut Out, r: Result<ScriptGroup>| show_group(out, store, r);
    match action {
        GroupsAction::List => match scripts::groups_list(store) {
            Ok(l) => {
                let n = names();
                out.ok(&l.items, &l.errors, |w| {
                    if l.items.is_empty() {
                        writeln!(w, "(no script groups)")?;
                    }
                    for g in &l.items {
                        print_group(w, g, &n)?;
                    }
                    Ok(())
                })
            }
            Err(e) => out.err(&e),
        },
        GroupsAction::Get(a) => show(out, id(&a.id).and_then(|i| scripts::group_get(store, &i))),
        GroupsAction::Create(a) => {
            let r = (|| {
                let members = a
                    .scripts
                    .iter()
                    .map(|s| Ok(ScriptGroupMemberInput::new(id(s)?)))
                    .collect::<Result<Vec<_>>>()?;
                let input = ScriptGroupInput { name: a.name, description: a.description, mode: opt(a.mode, ScriptGroupMode::parse)?, members };
                scripts::group_create(store, actor, input)
            })();
            show(out, r)
        }
        GroupsAction::Update(a) => {
            let r = (|| {
                let patch = ScriptGroupPatch {
                    name: a.name,
                    description: if a.clear_description { Some(None) } else { a.description.map(Some) },
                    mode: opt(a.mode, ScriptGroupMode::parse)?,
                    members: None,
                };
                scripts::group_update(store, actor, &id(&a.id)?, patch)
            })();
            show(out, r)
        }
        GroupsAction::Delete(a) => {
            let r = id(&a.id).and_then(|i| scripts::group_delete(store, actor, &i).map(|()| i));
            out.result(r.map(|i| serde_json::json!({ "deleted": i })), |w, v| {
                writeln!(w, "Deleted group {}", v["deleted"].as_str().unwrap_or(""))
            })
        }
        GroupsAction::Add(a) => {
            let r = (|| {
                let m = ScriptGroupMemberInput {
                    script_id: id(&a.script_id)?,
                    order: a.order,
                    delay_ms: a.delay_ms,
                    auto_open_preview: a.auto_open_preview,
                };
                scripts::group_add_member(store, actor, &id(&a.group_id)?, m)
            })();
            show(out, r)
        }
        GroupsAction::Remove(a) => {
            let r = (|| scripts::group_remove_member(store, actor, &id(&a.group_id)?, &id(&a.script_id)?))();
            show(out, r)
        }
    }
}
