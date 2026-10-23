//! `quadflow chat …` (data-layer.md §7.3, §11): conversations in the app DB,
//! the API key in the OS keystore. Every subcommand honours `--json`.

use super::output::Out;
use super::Ctx;
use crate::domains::app::secrets::{Secrets, KEY_CHAT_API_KEY};
use crate::domains::chat::{
    self, ChatConversation, ChatConversationCreate, ChatEndpointInfo, ChatMessage, ChatSettings, ChatSettingsPatch,
    ChatStreamEvent,
};
use crate::error::{CoreError, Result};
use crate::events::EventBus;
use crate::ids::Id;
use crate::paths::{AppPaths, ENV_DATA_DIR};
use crate::store::AppDb;
use clap::{Args, Subcommand};
use serde::Serialize;
use std::cell::RefCell;
use std::io::Write;
use std::path::PathBuf;

#[derive(Subcommand, Debug)]
pub enum ChatAction {
    /// List conversations, most recently active first.
    List(ListArgs),
    /// Show one conversation.
    Get(IdArg),
    /// Create a conversation.
    Create(CreateArgs),
    /// Rename a conversation.
    Rename(RenameArgs),
    /// Delete a conversation and its messages.
    Delete(IdArg),
    /// Print a conversation's messages, oldest first.
    #[command(visible_alias = "history")]
    Messages(IdArg),
    /// Send a message and print the answer as it streams in.
    Send(SendArgs),
    /// Show chat settings, or change them with flags.
    Settings(SettingsArgs),
    /// Manage the endpoint API key (stored in the OS keystore, never printed).
    Key {
        #[command(subcommand)]
        action: KeyAction,
    },
    /// List the models the configured endpoint offers.
    Models(ModelsArgs),
    /// Scan the local network for LLM servers.
    #[command(visible_alias = "discover-endpoints")]
    Discover(DiscoverArgs),
    /// Probe one endpoint URL.
    #[command(visible_alias = "check-endpoint")]
    Check(CheckArgs),
}

#[derive(Subcommand, Debug)]
pub enum KeyAction {
    /// Store the API key, read from stdin or from an environment variable.
    Set(KeySetArgs),
    /// Remove the stored API key.
    Clear,
    /// Whether an API key is stored.
    Status,
}

#[derive(Args, Debug)]
pub struct IdArg {
    /// Conversation id.
    id: String,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Only conversations of the current project (--project / cwd).
    #[arg(long)]
    this_project: bool,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    #[arg(long)]
    title: Option<String>,
    /// Model override (default: the `defaultModel` setting).
    #[arg(long)]
    model: Option<String>,
    /// System prompt (default: the `systemPrompt` setting).
    #[arg(long)]
    system_prompt: Option<String>,
    /// Attach the conversation to the current project (--project / cwd).
    #[arg(long)]
    this_project: bool,
}

#[derive(Args, Debug)]
pub struct RenameArgs {
    id: String,
    title: String,
}

#[derive(Args, Debug)]
pub struct SendArgs {
    /// Conversation id.
    id: String,
    /// Message text.
    message: String,
}

#[derive(Args, Debug)]
pub struct SettingsArgs {
    /// OpenAI-compatible base URL, e.g. http://localhost:11434/v1.
    #[arg(long)]
    endpoint: Option<String>,
    #[arg(long = "model", visible_alias = "default-model")]
    default_model: Option<String>,
    #[arg(long)]
    temperature: Option<f64>,
    #[arg(long)]
    max_tokens: Option<u32>,
    #[arg(long, visible_alias = "timeout")]
    timeout_seconds: Option<u32>,
    #[arg(long, conflicts_with = "clear_system_prompt")]
    system_prompt: Option<String>,
    #[arg(long)]
    clear_system_prompt: bool,
}

#[derive(Args, Debug)]
pub struct KeySetArgs {
    /// Read the key from stdin (first line).
    #[arg(long, conflicts_with = "from_env", required_unless_present = "from_env")]
    stdin: bool,
    /// Read the key from this environment variable.
    #[arg(long, value_name = "VAR")]
    from_env: Option<String>,
}

#[derive(Args, Debug)]
pub struct ModelsArgs {
    #[arg(long, default_value_t = 5000)]
    timeout_ms: u64,
}

#[derive(Args, Debug)]
pub struct DiscoverArgs {
    /// Port to scan (11434 = Ollama).
    #[arg(long, default_value_t = 11434)]
    port: u16,
    /// Per-host probe timeout in milliseconds.
    #[arg(long, default_value_t = 500)]
    timeout_ms: u64,
}

#[derive(Args, Debug)]
pub struct CheckArgs {
    /// Endpoint URL (e.g. http://192.168.1.10:11434/v1).
    url: String,
    #[arg(long, default_value_t = 2000)]
    timeout_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyStatus {
    has_api_key: bool,
}

fn open_db(ctx: &Ctx) -> Result<AppDb> {
    let paths = AppPaths::resolve_with(ctx.profile, ctx.env.var(ENV_DATA_DIR).map(PathBuf::from), dirs::data_dir())?;
    AppDb::open(&paths, EventBus::new())
}

fn secrets(ctx: &Ctx) -> Result<Secrets> {
    Secrets::from_env(ctx.profile, |k| ctx.env.var(k).map(str::to_string))
}

fn id(s: &str) -> Result<Id> {
    Id::parse(s)
}

fn root_key(ctx: &Ctx, this_project: bool) -> Result<Option<String>> {
    if this_project {
        Ok(Some(ctx.project_root()?.key))
    } else {
        Ok(None)
    }
}

fn conv_line(w: &mut dyn Write, c: &ChatConversation) -> std::io::Result<()> {
    writeln!(w, "{}  [{}]  {}", c.id, c.model.as_deref().unwrap_or("default"), c.title)
}

fn print_settings(w: &mut dyn Write, s: &ChatSettings) -> std::io::Result<()> {
    writeln!(w, "endpoint:       {}", s.endpoint)?;
    writeln!(w, "defaultModel:   {}", s.default_model)?;
    writeln!(w, "temperature:    {}", s.temperature)?;
    writeln!(w, "maxTokens:      {}", s.max_tokens)?;
    writeln!(w, "timeoutSeconds: {}", s.timeout_seconds)?;
    writeln!(w, "systemPrompt:   {}", s.system_prompt.as_deref().unwrap_or("(none)"))?;
    writeln!(w, "apiKey:         {}", if s.has_api_key { "set" } else { "not set" })
}

fn endpoint_line(w: &mut dyn Write, e: &ChatEndpointInfo) -> std::io::Result<()> {
    writeln!(w, "{}  [{:?}]  {} model(s)  {} ms", e.endpoint_url, e.api_type, e.models.len(), e.response_time_ms)
}

fn print_messages(w: &mut dyn Write, msgs: &[ChatMessage]) -> std::io::Result<()> {
    if msgs.is_empty() {
        return writeln!(w, "(no messages)");
    }
    for m in msgs {
        writeln!(w, "--- {} ---\n{}\n", m.role.as_str(), m.content)?;
    }
    Ok(())
}

fn read_stdin_line() -> Result<String> {
    let mut s = String::new();
    std::io::stdin().read_line(&mut s).map_err(|e| CoreError::invalid_input(format!("could not read stdin: {e}")))?;
    Ok(s.trim().to_string())
}

pub fn handle(ctx: &Ctx, out: &mut Out, action: ChatAction) -> i32 {
    // Network-only commands first: they need no DB.
    match action {
        ChatAction::Discover(a) => {
            let r = chat::discover_endpoints(a.port, a.timeout_ms);
            return out.result(r, |w, r| {
                if r.endpoints.is_empty() {
                    return writeln!(w, "(no endpoints found on {})", r.scanned_subnet);
                }
                r.endpoints.iter().try_for_each(|e| endpoint_line(w, e))
            });
        }
        ChatAction::Check(a) => {
            let r = chat::check_endpoint(&a.url, a.timeout_ms).and_then(|o| {
                o.ok_or_else(|| CoreError::external(format!("no LLM API reachable at {}", a.url)))
            });
            return out.result(r, |w, e| endpoint_line(w, e));
        }
        ChatAction::Key { action } => return key(ctx, out, action),
        other => {
            let db = match open_db(ctx) {
                Ok(d) => d,
                Err(e) => return out.err(&e),
            };
            with_db(ctx, out, &db, other)
        }
    }
}

fn key(ctx: &Ctx, out: &mut Out, action: KeyAction) -> i32 {
    let sec = match secrets(ctx) {
        Ok(s) => s,
        Err(e) => return out.err(&e),
    };
    match action {
        KeyAction::Set(a) => {
            let value = match (a.stdin, a.from_env) {
                (_, Some(var)) => match ctx.env.var(&var) {
                    Some(v) => Ok(v.trim().to_string()),
                    None => Err(CoreError::invalid_input(format!("environment variable {var} is not set"))),
                },
                (true, None) => read_stdin_line(),
                (false, None) => Err(CoreError::invalid_input("pass --stdin or --from-env <VAR>")),
            };
            let r = value
                .and_then(|v| sec.set(KEY_CHAT_API_KEY, &v))
                .map(|_| KeyStatus { has_api_key: true });
            out.result(r, |w, _| writeln!(w, "API key stored in the system keystore."))
        }
        KeyAction::Clear => {
            let r = sec.delete(KEY_CHAT_API_KEY).map(|_| KeyStatus { has_api_key: false });
            out.result(r, |w, _| writeln!(w, "API key removed."))
        }
        KeyAction::Status => {
            // Either key counts: the Chat plugin's (`plugin:chat:apiKey`, read first) or this one.
            let r = chat::api_key(&sec).map(|k| KeyStatus { has_api_key: k.is_some() });
            out.result(r, |w, s| writeln!(w, "API key: {}", if s.has_api_key { "set" } else { "not set" }))
        }
    }
}

fn with_db(ctx: &Ctx, out: &mut Out, db: &AppDb, action: ChatAction) -> i32 {
    match action {
        ChatAction::List(a) => {
            let r = root_key(ctx, a.this_project).and_then(|k| chat::conversations_list(db, k.as_deref()));
            out.result(r, |w, v| {
                if v.is_empty() {
                    return writeln!(w, "(no conversations)");
                }
                v.iter().try_for_each(|c| conv_line(w, c))
            })
        }
        ChatAction::Get(a) => {
            let r = id(&a.id).and_then(|i| chat::conversation_get(db, &i));
            out.result(r, |w, c| conv_line(w, c))
        }
        ChatAction::Create(a) => {
            let r = root_key(ctx, a.this_project).and_then(|k| {
                chat::conversation_create(
                    db,
                    ChatConversationCreate { title: a.title, model: a.model, system_prompt: a.system_prompt, project_root_key: k },
                )
            });
            out.result(r, |w, c| writeln!(w, "Created conversation {}", c.id))
        }
        ChatAction::Rename(a) => {
            let r = id(&a.id).and_then(|i| chat::conversation_rename(db, &i, &a.title));
            out.result(r, |w, c| writeln!(w, "Renamed {} to {:?}", c.id, c.title))
        }
        ChatAction::Delete(a) => {
            let r = id(&a.id).and_then(|i| chat::conversation_delete(db, &i).map(|_| serde_json::json!({ "id": i })));
            out.result(r, |w, _| writeln!(w, "Deleted conversation {}", a.id))
        }
        ChatAction::Messages(a) => {
            let r = id(&a.id).and_then(|i| chat::messages_list(db, &i));
            out.result(r, |w, m| print_messages(w, m))
        }
        ChatAction::Send(a) => send(ctx, out, db, a),
        ChatAction::Settings(a) => {
            let patch = ChatSettingsPatch {
                endpoint: a.endpoint,
                default_model: a.default_model,
                temperature: a.temperature,
                max_tokens: a.max_tokens,
                timeout_seconds: a.timeout_seconds,
                system_prompt: if a.clear_system_prompt { Some(None) } else { a.system_prompt.map(Some) },
            };
            let r = secrets(ctx).and_then(|sec| chat::settings_update(db, &sec, patch));
            out.result(r, |w, s| print_settings(w, s))
        }
        ChatAction::Models(a) => {
            let r = secrets(ctx).and_then(|sec| chat::models(db, &sec, a.timeout_ms));
            out.result(r, |w, m| {
                if m.is_empty() {
                    return writeln!(w, "(no models)");
                }
                m.iter().try_for_each(|x| writeln!(w, "{x}"))
            })
        }
        ChatAction::Discover(_) | ChatAction::Check(_) | ChatAction::Key { .. } => unreachable!("handled before opening the DB"),
    }
}

fn send(ctx: &Ctx, out: &mut Out, db: &AppDb, a: SendArgs) -> i32 {
    let r = id(&a.id).and_then(|i| {
        let sec = secrets(ctx)?;
        if out.json {
            chat::send(db, &sec, &i, &a.message, &chat::NoSink)
        } else {
            // Human mode: print the answer as it streams in.
            let w = RefCell::new(&mut out.io.stdout);
            let sink = |e: ChatStreamEvent| {
                if let ChatStreamEvent::Delta { text } = e {
                    let mut w = w.borrow_mut();
                    let _ = write!(w, "{text}");
                    let _ = w.flush();
                }
            };
            chat::send(db, &sec, &i, &a.message, &sink)
        }
    });
    out.result(r, |w, _| writeln!(w))
}
