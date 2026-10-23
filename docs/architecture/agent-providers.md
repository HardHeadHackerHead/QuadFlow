# Agent providers

Status: **binding design** for roadmap §2 "Agent providers (plugins)" and the Claude Code / Codex
plugins in §4. Builds on `plugin-system.md` (manifest, host API, sidecars) and `data-layer.md`
(settings, workspace terminals, events).

---

## 0. Rules

1. Core contains **no** knowledge of any specific agent CLI: no `claude`, `codex`, `CLAUDE.md`,
   `~/.claude`, `~/.codex`, `--session-id`, `--full-auto` strings outside `plugins/claude-code/`
   and `plugins/codex/`. A grep for those strings in `src/`, `src-tauri/src/`,
   `src-tauri/quadflow-core/src/` is a CI check (allowlist: tests, docs).
2. **Most of a provider is declarative** (manifest `contributes.agentProvider`), interpreted by
   generic Rust code in core. That keeps launch, model validation, session discovery and context
   files available to the CLI, fast, and safe. Only genuinely procedural features (usage limits,
   context-window usage, session titles, worktree preparation) are code hooks.
3. **Nothing untrusted is ever interpolated into a shell line.** Launch argv elements are
   validated against a safe charset and shell-quoted per shell by core; prompts are delivered as
   bracketed-paste PTY input after start, never as argv; one-shot prompts go through stdin.
4. Model ids must match `^[A-Za-z0-9._:\[\]-]+$` (≤ 128 chars) — enforced when the catalog is
   parsed, when custom models are saved, and again immediately before launch.
5. All times are epoch **ms** (session file times are converted at the boundary).

---

## 1. What moves out of core

Every path below is removed from the shell/core and re-expressed as provider manifest data or a
provider hook (file:line references are to the `oss` branch at 6be01d8).

| Location | Hardcoded behavior | New home |
|---|---|---|
| `src/types/index.ts:26` `AIProvider = 'claude' \| 'codex'` | provider union | `providerId: string` |
| `src/types/index.ts:28-46` `AI_PROVIDER_CONFIG` | command + resume flag | manifest `detect.command`, `launch.resume` |
| `src/types/index.ts:48-61` `normalizeCodexSessionId`, `getResumeCommand` | resume strings | `launch.resume` + `sessions.idFrom` |
| `src/types/index.ts:67-72` `getSessionIdFlag` | `--session-id` | `sessions.strategy: "preassign"` + `launch.sessionId` |
| `src/types/index.ts:91-105` `CLAUDE_MODELS`, `CODEX_MODELS` | built-in model lists | catalog (§6) |
| `src/types/index.ts:148-151` `getModelFlag` | **unquoted `--model ${id}` into PTY (injection)** | `launch.model` + validation + quoting (§4.1) |
| `src/types/index.ts:161-181` effort / danger / plan flags | `--effort`, `-c model_reasoning_effort=`, `--dangerously-skip-permissions`, `--full-auto`, `--permission-mode plan` | `launch.efforts`, `launch.approvalModes` |
| `src/types/index.ts:191-230` `getMergedModels`, `getDefaultModelFromSettings` | model merge, default ignores catalog | core `agents::models` (§6.4) |
| `src/types/index.ts:357-385,455-482` `TerminalState`/`SessionTerminal` agent fields (`isClaudeTerminal`, `claudeSessionId`, `codexSessionId`, `provider`, `model`, `skipPermissions`, `planMode`, `hasAutoResumed`) | per-provider fields | `AgentBinding` (§5.4) |
| `src/components/layout/Toolbar.tsx:92-163,144` | Claude launch string | `agents_launch` |
| `src/components/layout/Toolbar.tsx:165-214,198` | Claude continue/resume | `agents_launch { resumeSessionId }` |
| `src/components/layout/Toolbar.tsx:232-306,273,293-300` | Codex launch + poller | `agents_launch` + core discovery (§8.3) |
| `src/components/layout/Toolbar.tsx:308-352` | Codex resume | `agents_launch { resumeSessionId }` |
| `src/components/layout/TerminalTileContent.tsx:46-73,104-186` | session-file check, resume/relaunch overlay | `agents_session_exists`, `agents_relaunch` |
| `src/components/layout/TerminalTileToolbar.tsx:137-166` | `/exit` + hand-built resume strings | `agents_relaunch { approvalMode }` |
| `src/components/layout/ChatHistoryDropdown.tsx:81-82,134-151` | history list + resume | `agents_sessions_list` + `agents_launch` |
| `src/lib/launchAgent.ts:16-73` | issue agent launch | `agents_launch { issueRef }` |
| `src/lib/sessionPolling.ts:46-168` | Codex polling, **double-claim race, ms-vs-s bug** | core `agents::claims` + `agents::sessions` (§8.3) |
| `src/lib/modelCatalog.ts:14-116`, `src-tauri/src/model_catalog.rs:15-60` | catalog fetch (release asset URL), parse, merge | core `agents::catalog` (§6) |
| `src/hooks/useAIModels.ts:7-57` | per-provider model lists | `agents_models` |
| `src/stores/appSettingsStore.ts:113-123,155-161,782-794,886-909,1079-1104` | agent timings, custom models, catalog cache in localStorage | settings `agents` + `agents.customModels.<providerId>`; catalog cache file |
| `src/stores/missionStore.ts:338-410,366-369` | mission spawn with hand-built `codex --model` | `agents_launch { missionId, memberId }` (Missions plugin) |
| `src/stores/teamStore.ts:471-497`, `src/components/multiagent/TaskBoard.tsx:19-66`, `src-tauri/src/lib.rs:1126,1205` | Claude native teams | deleted (roadmap §5 dead code) |
| `src/lib/workspaceTemplates.ts:110-135,240-256` | template agent launch (Claude only) | `agents_launch` with template `providerId` |
| `src/components/tools/issues/IssueListView.tsx:175-233`, `IssueDetailView.tsx:365` (**agent-writable `agentSessionId` unquoted**) | skill launch, resume | `agents_launch` (Issues plugin) |
| `ScriptLauncherToolView.tsx:319,1292`, `scripts/useAutoFix.ts:63`, `scripts/ScriptsToolView.tsx:197`, `PlansToolView.tsx:289,740,1511`, `IdeasToolView.tsx:488`, `ShipToolView.tsx:967,995` | bare `claude\r`, `claude --permission-mode bypassPermissions "<prompt>"` | `ctx.agents.launch` in each plugin |
| `src/services/github.ts:778-801,835` | **`claude -p <diff>` through cmd/PowerShell (injection)** | `agents_one_shot` (prompt via stdin) |
| `src/App.tsx:67` | catalog refresh | core startup task |
| `src/App.tsx:242` | Codex restore reconciliation | core restore (§8.5) |
| `src/App.tsx:267-269`, `src-tauri/src/lib.rs:562-610` `get_claude_cli_path` | `claude mcp remove`, claude.exe search | deleted / `detect.extraPaths` |
| `src-tauri/src/lib.rs:132-138` `encode_path_for_claude` (does not encode `.`) | Claude project dir encoding | `sessions.dir` with `{cwd\|nonalnum-dash}` (§3) |
| `src-tauri/src/lib.rs:143-232,901-918` | `get_claude_sessions`, `list_claude_projects` | generic `agents::sessions` scanner |
| `src-tauri/src/lib.rs:923-1095` | Codex session scan of `~/.codex/sessions` | generic scanner |
| `src-tauri/src/lib.rs:1298,1339-1460`, `src-tauri/src/session_context.rs` | token estimates, Claude JSONL parsing | provider hook `contextUsage` (claude-code / codex plugins) |
| `src-tauri/src/lib.rs:1464-1540` | Claude rewind points | claude-code plugin tile/command (`fs:read:home`) |
| `src-tauri/src/lib.rs:707-880` `scaffold_claude_config` + `resources/claude-template/` | `.claude/` scaffold + `CLAUDE.md` | claude-code manifest `scaffold` (§7.3) |
| `src-tauri/src/usage_monitor.rs` (whole), `src/stores/usageMonitorStore.ts` | `cmd /C claude` + `/usage` scrape | claude-code hook `usage`; Usage Monitor plugin consumes the generic interface |
| `src-tauri/quadcode-core/src/context.rs:33-71,170-230` | `CLAUDE.md` + `.claude/quadflow-context/` | provider `contextFile` + `ProjectConfig.agentContext` (§7) |
| `src-tauri/quadcode-core/src/missions.rs:78-93,523,583-716` | `AgentProvider` enum, hardcoded Claude model ids in builtins | `providerId: String`; builtin agent definitions use `model: None` (provider default) |
| `src/stores/claudeConfigStore.ts`, `src/stores/claudePermissionsStore.ts` | CLAUDE.md editor, Claude permission rules (`mcp__quadcode__*`) | claude-code plugin settings page |
| `src/lib/agentOverlay.ts:20-103,106+` | worktree CLAUDE.md + PreToolUse hook (applied to Codex too) | Missions plugin + provider hook `prepareWorktree` (§4.2) |
| `src/lib/attentionDetector.ts:29-42`, `TerminalView.tsx:229-248` | Claude UI prompt patterns | manifest `attention.patterns` (generic patterns stay in core) |
| `src/hooks/useSessionSummaryPoller.ts:58-110` | Claude `sessions-index.json` titles | hook `sessionTitle` |
| `src-tauri/src/embedding/discovery.rs:36-57`, `indexer.rs:17-21`, `watcher.rs:31` | session discovery for semantic search | Semantic Search plugin uses `agents_sessions_list` for all providers |
| `src/lib/commandRegistry.ts:187-200`, `agentPromptStore.ts:11-48`, `QuickAccessTools.tsx:29-30,142,342-343`, `EmptyTileBubbleMenu.tsx:242`, `useWorkspaceActions.ts:184` | provider pickers | generated from `agents_providers` |
| `src/lib/database.ts:78-88,384-463,930,1821-1837` | persisted agent columns | `workspace_terminals.agent` JSON |

---

## 2. Architecture

```
plugins/claude-code/  plugins/codex/        (first-party, trusted, bundled)
  quadflow-plugin.json  contributes.agentProvider { declarative spec }
  src/index.tsx         agentProvider: AgentProviderImpl { usage, contextUsage, sessionTitle, prepareWorktree }
                        tiles/settings pages (e.g. Claude config editor, rewind)
            │ manifest                                   │ hooks (via host)
            ▼                                            ▼
quadflow-core/src/agents/  (generic, Rust)          src/agents/ (shell, TS)
  spec.rs     parsed AgentProviderSpec               providerRegistry.ts  merges spec + hooks
  detect.rs   resolve program, run --version         AgentLaunchDialog, toolbar buttons
  catalog.rs  fetch/cache/validate models.json       TerminalAgentOverlay (resume/relaunch)
  models.rs   catalog ∪ custom → ModelInfo[]
  launch.rs   LaunchRequest → argv → command line
  quote.rs    per-shell quoting
  sessions.rs generic session scanner
  claims.rs   SessionClaims registry (GUI)
src-tauri/src/agents.rs   Tauri commands; spawns PTY via TerminalManager; discovery threads
```

Hooks are optional. If a provider has no `usage` hook, usage UI simply does not show it.
Third-party providers can implement hooks in their UI module (trusted or sandboxed — hooks are
plain async functions, RPC-able) or in a sidecar (`agentProvider/*` methods, §4.3).

---

## 3. Manifest block — `contributes.agentProvider`

JSON Schema `packages/plugin-api/schema/agent-provider.schema.json` (`$id`
`https://quadflow.dev/schema/agent-provider.schema.json`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://quadflow.dev/schema/agent-provider.schema.json",
  "type": "object", "additionalProperties": false,
  "required": ["id", "displayName", "detect", "launch", "models", "sessions", "contextFile"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z][a-z0-9-]{1,31}$", "description": "Provider id, usually the plugin id. Catalog key." },
    "displayName": { "type": "string" },
    "shortName": { "type": "string", "maxLength": 12 },
    "icon": { "type": "string" },
    "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
    "docsUrl": { "type": "string", "format": "uri" },
    "installHint": { "type": "object", "additionalProperties": { "type": "string" },
      "description": "Per-OS install instructions keyed windows|macos|linux|default (shown in onboarding)." },

    "detect": {
      "type": "object", "additionalProperties": false, "required": ["command", "versionArgs"],
      "properties": {
        "command": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "description": "Program name looked up on PATH (PATHEXT honoured on Windows)." },
        "versionArgs": { "type": "array", "items": { "$ref": "#/$defs/safeArg" } },
        "versionRegex": { "type": "string", "default": "(\\d+\\.\\d+\\.\\d+)" },
        "minVersion": { "type": "string" },
        "extraPaths": { "type": "object", "additionalProperties": false,
          "properties": { "windows": { "$ref": "#/$defs/pathList" }, "macos": { "$ref": "#/$defs/pathList" }, "linux": { "$ref": "#/$defs/pathList" } } }
      }
    },

    "launch": {
      "type": "object", "additionalProperties": false, "required": ["args"],
      "properties": {
        "args": { "type": "array", "items": { "$ref": "#/$defs/safeArg" }, "description": "Base argv after the program." },
        "model": { "$ref": "#/$defs/argTemplate", "description": "e.g. [\"--model\",\"{model}\"]. Omitted for the system-default model." },
        "sessionId": { "$ref": "#/$defs/argTemplate", "description": "preassign strategy: e.g. [\"--session-id\",\"{sessionId}\"]" },
        "resume": { "$ref": "#/$defs/argTemplate", "description": "e.g. [\"--resume\",\"{sessionId}\"] or [\"resume\",\"{sessionId}\"]; replaces sessionId args" },
        "resumePosition": { "enum": ["prefix", "suffix"], "default": "suffix", "description": "prefix = resume args come before base args (subcommand style)" },
        "efforts": {
          "type": "object", "additionalProperties": false, "required": ["values", "default", "args"],
          "properties": {
            "values": { "type": "array", "items": { "type": "string", "pattern": "^[a-z]+$" } },
            "default": { "type": "string" },
            "args": { "$ref": "#/$defs/argTemplate", "description": "uses {effort}" },
            "omitWhenDefault": { "type": "boolean", "default": true }
          }
        },
        "approvalModes": {
          "type": "object", "additionalProperties": false,
          "description": "Supported approval modes → extra argv. Missing key = unsupported. 'default' usually [].",
          "properties": {
            "default":      { "$ref": "#/$defs/argTemplate" },
            "plan":         { "$ref": "#/$defs/argTemplate" },
            "accept-edits": { "$ref": "#/$defs/argTemplate" },
            "auto":         { "$ref": "#/$defs/argTemplate" },
            "bypass":       { "$ref": "#/$defs/argTemplate" }
          }
        },
        "env": { "type": "object", "additionalProperties": { "type": "string" } },
        "exitCommand": { "type": "string", "description": "Typed to leave the agent back to the shell, e.g. \"/exit\"." },
        "readyPattern": { "type": "string", "description": "Regex on PTY output signalling the agent accepts input (prompt delivery)." },
        "readyTimeoutMs": { "type": "integer", "default": 15000 },
        "oneShot": {
          "type": "object", "additionalProperties": false, "required": ["args"],
          "properties": { "args": { "$ref": "#/$defs/argTemplate" }, "promptVia": { "const": "stdin" }, "timeoutMs": { "type": "integer", "default": 120000 } }
        }
      }
    },

    "models": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "catalogKey": { "type": "string", "description": "Key in catalog providers{} (default: provider id)." },
        "allowCustom": { "type": "boolean", "default": true }
      }
    },

    "sessions": {
      "type": "object", "additionalProperties": false, "required": ["strategy"],
      "properties": {
        "strategy": { "enum": ["preassign", "discover", "none"] },
        "idFormat": { "enum": ["uuid", "any"], "default": "uuid" },
        "dir": { "type": "string", "description": "Template, e.g. \"{home}/.claude/projects/{cwd|nonalnum-dash}\" or \"{home}/.codex/sessions\"" },
        "glob": { "type": "string", "description": "Relative glob under dir, e.g. \"*.jsonl\" or \"**/rollout-*.jsonl\"" },
        "idFrom": {
          "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["fileStem"], "properties": { "fileStem": { "const": true } } },
            { "type": "object", "additionalProperties": false, "required": ["fileStemRegex"], "properties": { "fileStemRegex": { "type": "string", "description": "first capture group" } } },
            { "type": "object", "additionalProperties": false, "required": ["jsonl"], "properties": { "jsonl": { "$ref": "#/$defs/jsonlField" } } }
          ]
        },
        "cwdFrom": {
          "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["dir"], "properties": { "dir": { "const": true } }, "description": "cwd is encoded in the session dir (preassign providers)" },
            { "type": "object", "additionalProperties": false, "required": ["jsonl"], "properties": { "jsonl": { "$ref": "#/$defs/jsonlField" } } }
          ]
        },
        "headerLines": { "type": "integer", "default": 20, "maximum": 200 },
        "maxFiles": { "type": "integer", "default": 2000 }
      }
    },

    "contextFile": { "type": "string", "pattern": "^[A-Za-z0-9._-]+$", "description": "Project-root agent instructions file, e.g. CLAUDE.md, AGENTS.md" },

    "scaffold": {
      "type": "object", "additionalProperties": false, "required": ["from", "into"],
      "properties": {
        "from": { "type": "string", "description": "Directory inside the plugin" },
        "into": { "type": "string", "pattern": "^[A-Za-z0-9._/-]+$", "description": "Project-relative target dir, e.g. .claude" },
        "jsonMerge": { "type": "array", "items": { "type": "string" }, "description": "Files merged (arrays unioned) instead of skipped when present" }
      }
    },

    "attention": {
      "type": "object", "additionalProperties": false,
      "properties": { "patterns": { "type": "array", "items": { "type": "string" } }, "debounceMs": { "type": "integer", "default": 800 } }
    },

    "hooks": {
      "type": "array", "uniqueItems": true,
      "items": { "enum": ["usage", "contextUsage", "sessionTitle", "prepareWorktree"] },
      "description": "Which procedural hooks the plugin implements (UI module agentProvider or sidecar agentProvider/*)."
    }
  },
  "$defs": {
    "safeArg": { "type": "string", "pattern": "^[A-Za-z0-9._:\\[\\]@=/+,-]{1,256}$" },
    "argTemplate": { "type": "array", "items": { "type": "string", "pattern": "^([A-Za-z0-9._:\\[\\]@=/+,-]|\\{(model|sessionId|effort|cwd)\\})+$" } },
    "pathList": { "type": "array", "items": { "type": "string" }, "description": "Templates with {home} {appData} {localAppData}" },
    "jsonlField": {
      "type": "object", "additionalProperties": false, "required": ["path"],
      "properties": {
        "match": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Line must have these top-level string fields, e.g. {\"type\":\"session_meta\"}" },
        "path": { "type": "string", "description": "Dot path, e.g. payload.id" }
      }
    }
  }
}
```

Template variables: `{model}`, `{sessionId}`, `{effort}`, `{cwd}` (launch);
`{home}`, `{appData}`, `{localAppData}`, `{cwd|nonalnum-dash}` (paths). `nonalnum-dash` replaces
every char not in `[A-Za-z0-9]` with `-` (Claude Code's project-dir encoding, which also encodes
`.` — fixes worktree session lookup). After substitution every launch argv element is re-validated
against `safeArg`.

---

## 4. Provider interface

### 4.1 Core (Rust) — `quadflow-core/src/agents/`

```rust
pub struct AgentProviderSpec { /* serde of §3, camelCase */ }
pub struct ProviderRef<'a> { pub plugin_id: &'a str, pub spec: &'a AgentProviderSpec, pub root: &'a Path }

// detect.rs
pub fn detect(p: &ProviderRef, env: &ProcessEnv) -> DetectionResult;      // ≤ 5 s, cached 1 h in memory
// models.rs
pub fn models(p: &ProviderRef, catalog: &Catalog, settings: &AgentSettings) -> Vec<ModelInfo>;
pub fn validate_model_id(id: &str) -> Result<(), CoreError>;               // regex + len
// launch.rs
pub fn build_launch(p: &ProviderRef, det: &DetectionResult, req: &LaunchRequest, session_id: Option<&str>)
    -> Result<LaunchPlan, CoreError>;
pub struct LaunchPlan { pub program: PathBuf, pub argv: Vec<String>, pub env: BTreeMap<String, String> }
// quote.rs
pub enum ShellKind { Cmd, PowerShell, Pwsh, Bash, Zsh, Sh, Fish }
pub fn command_line(shell: ShellKind, program: &Path, argv: &[String]) -> Result<String, CoreError>;
// sessions.rs
pub fn list_sessions(p: &ProviderRef, cwd: &Path, since_ms: Option<i64>) -> Result<Vec<SessionInfo>, CoreError>;
pub fn session_exists(p: &ProviderRef, cwd: &Path, id: &str) -> bool;
// claims.rs
pub struct SessionClaims { /* Mutex<State> */ }
// one_shot.rs
pub fn one_shot(p: &ProviderRef, det: &DetectionResult, prompt: &str, cwd: &Path) -> Result<String, CoreError>;
```

`build_launch` rules:
1. argv = (resume? && `resumePosition = prefix` ? resume args : []) ++ `args` ++ model args (unless
   model is `None`/`"system-default"`) ++ (preassign && !resume ? sessionId args : []) ++
   effort args (unless default & `omitWhenDefault`) ++ approval-mode args ++
   (resume && suffix ? resume args : []).
2. Model must be in `models()` (catalog/custom) and pass `validate_model_id`; unknown model →
   `invalid_input`. Effort must be in `efforts.values`. Approval mode must be a key of
   `approvalModes`.
3. Every final argv element must match `safeArg`; `sessionId` must match the provider's
   `idFormat` (uuid: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).
4. `program` = detection's resolved absolute path; must not contain `"`, `'`, `` ` ``, `$`, `%`,
   `!`, `;`, `&`, `|`, `<`, `>`, `^` or control chars (else fall back to the bare `command` name
   if it resolves on PATH, else `invalid_input`).

`command_line` quoting (safe because elements are in the safe charset):
- `Bash|Zsh|Sh|Fish`: each element wrapped in single quotes: `'/path/claude' '--model' 'opus[1m]'`
  (prevents glob expansion of `[...]`).
- `PowerShell|Pwsh`: `& 'C:\path\claude.cmd' '--model' 'opus'` (call operator + single quotes).
- `Cmd`: `"C:\path\claude.cmd" "--model" "opus"`.
The PTY receives `command_line + "\r"`.

### 4.2 Hooks (TypeScript) — in the plugin UI module

```ts
export interface AgentProviderImpl {
  /** Account usage / rate-limit windows. Called by the Usage Monitor plugin; cooldown enforced by host (≥ 60 s). */
  usage?(ctx: PluginContext): Promise<UsageSnapshot | null>
  /** Context-window usage of a session (for the terminal header meter). */
  contextUsage?(ctx: PluginContext, s: { sessionId: string; sessionPath: string; model: string | null }): Promise<ContextUsage | null>
  /** Human title/summary for a session (history lists, terminal titles). */
  sessionTitle?(ctx: PluginContext, s: SessionInfo): Promise<string | null>
  /** Prepare a git worktree before an agent is launched in it (Missions): scope rules, hooks, context. */
  prepareWorktree?(ctx: PluginContext, w: { worktreePath: string; scope: WorktreeScope; contextMarkdown: string }): Promise<void>
}
export interface UsageSnapshot {
  providerId: string; fetchedAt: number; plan?: string
  windows: { id: string; label: string; usedPercent: number; resetsAt?: number; resetsText?: string }[]
}
export interface ContextUsage { usedTokens: number; limitTokens: number | null; estimated: boolean }
export interface WorktreeScope { allowedPaths: string[]; readOnlyPaths: string[]; coordinator: boolean }
```

The shell's `src/agents/providerRegistry.ts` calls hooks through the plugin context (direct for
trusted, RPC for sandboxed). Hook errors are logged and treated as "no data".

### 4.3 Hooks via sidecar

A provider whose manifest `hooks` are implemented by its sidecar answers JSON-RPC requests
`agentProvider/usage {}` → `UsageSnapshot | null`, `agentProvider/contextUsage {sessionId,
sessionPath, model}`, `agentProvider/sessionTitle {session}`, `agentProvider/prepareWorktree
{worktreePath, scope, contextMarkdown}` and reports `capabilities.agentProvider = true` in
`initialize`. If both a UI hook and a sidecar exist, the UI hook wins.

---

## 5. Shared types (Rust structs with `specta::Type`, exported to bindings and plugin-api)

```ts
export type ApprovalMode = 'default' | 'plan' | 'accept-edits' | 'auto' | 'bypass'

export interface ProviderInfo {
  id: string; pluginId: string; displayName: string; shortName: string | null; icon: string | null; color: string | null
  contextFile: string; sessionStrategy: 'preassign' | 'discover' | 'none'
  approvalModes: ApprovalMode[]; efforts: { values: string[]; default: string } | null
  hooks: ('usage' | 'contextUsage' | 'sessionTitle' | 'prepareWorktree')[]
  installHint: string | null; docsUrl: string | null
}
export interface DetectionResult {
  providerId: string; installed: boolean; path: string | null; version: string | null
  meetsMinVersion: boolean; error: string | null; checkedAt: number
}
export interface ModelInfo {
  id: string; label: string; shortLabel: string | null; contextWindow: number | null
  kind: 'alias' | 'model'; isDefault: boolean; deprecated: boolean; source: 'catalog' | 'custom' | 'system'
}
export interface LaunchAgentOptions {           // = Rust LaunchRequest minus projectRoot (filled by host)
  providerId: string
  cwd?: string                                  // default project root; worktrees allowed
  model?: string | null                         // null/'system-default' = provider default
  approvalMode?: ApprovalMode                   // default 'default'
  effort?: string | null
  prompt?: string                               // delivered after start via bracketed paste
  autoSubmit?: boolean                          // default setting agents.autoSubmitPrompt
  resumeSessionId?: string
  role?: AgentRole | null; roleLabel?: string | null
  issueRef?: string                             // links AgentBinding.issueId; claims the issue
  missionId?: string; memberId?: string
  placement?: 'split-active' | 'replace-empty' | 'new-tile' | 'terminal'    // 'terminal' = reuse terminalId
  terminalId?: string
  environmentId?: string
  title?: string
  syncEnabled?: boolean                         // default true
}
export interface LaunchResult { terminalId: string; binding: AgentBinding }

export interface AgentBinding {                 // persisted: workspace_terminals.agent (JSON)
  providerId: string
  model: string | null
  approvalMode: ApprovalMode
  effort: string | null
  sessionId: string | null
  sessionState: 'assigned' | 'pending' | 'linked' | 'unlinked'   // assigned = preassigned; pending = discovering
  launchedAt: number
  role: AgentRole | null; roleLabel: string | null
  syncEnabled: boolean
  issueId: string | null; missionId: string | null; memberId: string | null
}
export interface SessionInfo {
  providerId: string; id: string; path: string; cwd: string | null
  createdAt: number; modifiedAt: number; sizeBytes: number; title: string | null
}
```

### 5.4 Terminal binding replaces per-provider fields

`TerminalState` loses `isClaudeTerminal`, `claudeSessionId`, `codexSessionId`, `provider`,
`model`, `skipPermissions`, `planMode`, `hasAutoResumed` and gains `agent: AgentBinding | null`
(persisted in `workspace_terminals.agent`, data-layer.md §7). "Is this an agent terminal?" =
`agent !== null`. `hasAutoResumed` becomes runtime-only state in the terminal store.

---

## 6. Model catalog

### 6.1 Location and URL

- File in the public repo: **`catalog/models.json`**, validated in CI against
  `catalog/models.schema.json`.
- Fetched raw from the default branch:
  `https://raw.githubusercontent.com/{REPO}/HEAD/catalog/models.json` where `{REPO}` is the single
  constant `quadflow_core::urls::REPO` (`"HardHeadHackerHead/QuadFlow"`).
  Overrides: env `QUADFLOW_CATALOG_URL`, then setting `agents.catalogUrl` (advanced). Only
  `https://` URLs are accepted.
- A snapshot is bundled at build time: `scripts/bundle-plugins.mjs` copies `catalog/models.json`
  to `src-tauri/resources/catalog/models.json`; used when there is no valid cache (first run,
  offline). The release-asset mechanism (`release-assets/model-catalog.json`, `latest/download`
  URL) is deleted.

### 6.2 Schema (`catalog/models.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object", "additionalProperties": false,
  "required": ["schemaVersion", "updatedAt", "providers"],
  "properties": {
    "$schema": { "type": "string" },
    "schemaVersion": { "const": 1 },
    "updatedAt": { "type": "string", "format": "date" },
    "providers": {
      "type": "object",
      "propertyNames": { "pattern": "^[a-z][a-z0-9-]{1,31}$" },
      "additionalProperties": {
        "type": "object", "additionalProperties": false, "required": ["models"],
        "properties": {
          "models": {
            "type": "array",
            "items": {
              "type": "object", "additionalProperties": false, "required": ["id", "label"],
              "properties": {
                "id": { "type": "string", "pattern": "^[A-Za-z0-9._:\\[\\]-]+$", "maxLength": 128 },
                "label": { "type": "string", "maxLength": 60 },
                "shortLabel": { "type": "string", "maxLength": 8 },
                "kind": { "enum": ["alias", "model"], "default": "model" },
                "contextWindow": { "type": "integer", "minimum": 1 },
                "default": { "type": "boolean", "default": false },
                "deprecated": { "type": "boolean", "default": false },
                "efforts": { "type": "array", "items": { "type": "string", "pattern": "^[a-z]+$" } }
              }
            }
          }
        }
      }
    }
  }
}
```

Initial content (illustrative, from `release-assets/model-catalog.json` + the built-in alias
lists): `providers["claude-code"].models` = aliases `fable`, `opus`, `sonnet`, `haiku` (kind
`alias`) + `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-4-6`,
`claude-haiku-4-5-20251001`; `providers["codex"].models` = `gpt-5.3-codex`, `gpt-4.1`, `o3`, `o4-mini`.

### 6.3 Fetch, cache, validation — `quadflow-core/src/agents/catalog.rs`

```rust
pub struct Catalog { pub updated_at: String, pub providers: BTreeMap<String, Vec<CatalogModel>>, pub source: CatalogSource /* Remote|Cache|Bundled */ }
pub fn load_cached_or_bundled(paths: &AppPaths) -> Catalog;
pub fn refresh(paths: &AppPaths, url: &str, force: bool) -> Result<Catalog, CoreError>;
pub fn parse(bytes: &[u8]) -> Result<(Catalog, Vec<String /* warnings */>), CoreError>;
```

- Refresh at startup (background) when the cache is older than **6 h**, and on demand
  (`agents_catalog_refresh`). HTTP GET with `If-None-Match`, 10 s timeout, 256 KiB cap; 304 →
  touch `fetchedAt`.
- Cache: `<appData>/cache/models.json` = `{ "etag": …, "fetchedAt": <ms>, "url": …, "body": <catalog> }`,
  written atomically.
- Parse: document must be JSON with `schemaVersion == 1` (else the whole document is rejected and
  the previous cache stays). Each model: `id` must match `^[A-Za-z0-9._:\[\]-]+$` and ≤ 128 chars,
  `label` non-empty — invalid models are **dropped individually** with a warning (logged; shown in
  Settings → Agents → "Catalog: 2 entries ignored"). Duplicate ids within a provider: first wins.
  Unknown provider keys are kept (a provider plugin may be installed later).
- Emits `ChangeEvent { scope: App, domain: Settings }` + Tauri event `catalog-updated` on change.

### 6.4 Model list for a provider

`models(p, catalog, settings)` = `[system-default]` (id `system-default`, label "Default",
source `system`) ++ catalog models for `models.catalogKey` (non-deprecated first) ++ custom
models from setting `agents.customModels.<providerId>` (`[{id, label}]`, validated on save with
the same regex — invalid input is rejected in the settings UI and in `settings_set`). Ids are
de-duplicated (catalog wins over custom for labels). The default model is setting
`agents.defaultModel.<providerId>` if it is present in the list, else the catalog entry marked
`default`, else `system-default` (fixes "catalog models can't be the default").

---

## 7. Context files and context modules

### 7.1 Configuration

`ProjectConfig.agentContext` (data-layer.md §6.1):
- `modules: string[]` — enabled module ids (plugin-system.md §9.3). `quadflow` base module is
  implicit and always first.
- `files: string[]` — managed context files at the project root. Initialised by `quadflow init`
  / first project open to the `contextFile` of every **enabled** provider whose CLI is detected
  (e.g. `["CLAUDE.md", "AGENTS.md"]`). Editable in Settings → Agents → Project context, and via
  `quadflow context files add|remove <name>` (name must match `^[A-Za-z0-9._-]+\.md$`).

There is no `.claude/quadflow-context/` directory anymore; enablement lives in config (shared via
git).

### 7.2 Writer — `quadflow-core/src/context/writer.rs`

```rust
pub fn render_region(registry: &ContextRegistry, modules: &[String]) -> String;
pub fn sync(project: &ProjectStore, registry: &ContextRegistry) -> Result<SyncReport, CoreError>;
```

For each file in `files`:
- Region markers: `<!-- quadflow:context:start — managed by QuadFlow, do not edit -->` and
  `<!-- quadflow:context:end -->`. Content outside the markers is preserved byte-for-byte.
- Region body: `## QuadFlow` + one line per module (`quadflow docs <id>` hint) for modules not
  enabled, then the full markdown of each enabled module in `modules` order.
- Missing file → created containing only the region. Start marker without end marker →
  `CoreError::Corrupt` naming the file (no silent truncation; `quadflow context sync --repair`
  truncates from the start marker).
- Written with `atomic_write` under the project lock; unchanged content → no write.
- `sync` runs on: `quadflow context enable|disable|files …|sync`, project open (GUI), plugin
  enable/disable/update (GUI, for the active project), and `ProjectConfig` external changes.

CLI: `quadflow context list` (modules with enabled flag + source plugin), `enable <id>`,
`disable <id>`, `reset`, `files list|add|remove`, `sync [--repair]`; `quadflow docs [<id>|--list]`.

### 7.3 Provider scaffold (`.claude/` template)

The claude-code plugin carries `assets/claude-template/` (skills + `settings.local.json`;
content rewritten per roadmap §6 — only `Bash(quadflow:*)` + generic commands, no `mcp__*`, no
qwick). Manifest `scaffold: { "from": "assets/claude-template", "into": ".claude",
"jsonMerge": ["settings.local.json"] }`.

`agents::scaffold::apply(project, provider)`: copy files that do not exist; for `jsonMerge` files
that exist, union arrays at the same JSON paths (e.g. `permissions.allow`) and add missing object
keys, never removing user entries; write atomically; write `.claude/.quadflow-scaffold-version` =
plugin version. Runs on project open when the provider is enabled and setting
`agents.scaffold.<providerId>` (default `true`) is on, and on demand (Settings → Agents →
"Set up <provider> in this project"). `CLAUDE.md.template` is gone: the context file is produced
only by §7.2.

---

## 8. Shell integration

### 8.1 Tauri commands — `src-tauri/src/commands/agents.rs`

| Command | Purpose |
|---|---|
| `agents_providers() -> Vec<ProviderInfo>` | from active plugins with `agentProvider` |
| `agents_detect(providerId, refresh: bool) -> DetectionResult` | |
| `agents_detect_all(refresh) -> Vec<DetectionResult>` | onboarding |
| `agents_models(providerId) -> Vec<ModelInfo>` | |
| `agents_catalog_refresh() -> CatalogStatus` | `{ updatedAt, source, fetchedAt, warnings }` |
| `agents_launch(projectRoot, LaunchAgentOptions) -> LaunchResult` | §8.2 |
| `agents_relaunch(terminalId, { model?, approvalMode?, effort?, resume: bool }) -> AgentBinding` | exit + relaunch in the same terminal |
| `agents_sessions_list(providerId, cwd) -> Vec<SessionInfo>` | history / continue |
| `agents_session_exists(providerId, cwd, sessionId) -> bool` | restore check |
| `agents_session_link(terminalId, sessionId)` | manual link for `unlinked` |
| `agents_one_shot(providerId, cwd, prompt) -> String` | stdout of a non-interactive run (commit messages) |
| `agents_context_sync(projectRoot) -> SyncReport` | §7.2 |
| `agents_scaffold(projectRoot, providerId)` | §7.3 |

Plugins reach these through `ctx.agents.*` (`agents:read` / `agents:launch`).
Hook-based data (`usage`, `contextUsage`, `sessionTitle`) is requested by the frontend directly
from the provider plugin via `src/agents/providerRegistry.ts`.

### 8.2 Launch flow

1. Resolve provider; status must be active; detection (cached ≤ 1 h, else re-run) must be
   `installed` — otherwise `CoreError::Unsupported` with the provider's `installHint`.
2. `session_id`: `preassign` and not resuming → new UUIDv4; resuming → `resumeSessionId`
   (validated); `discover` → none yet.
3. `build_launch` (§4.1) → `LaunchPlan`.
4. Create/reuse the PTY via `TerminalManager` with the shell from `environmentId` / settings,
   cwd, env = `LaunchPlan.env` + `QUADFLOW_PROJECT_DIR`, `QUADFLOW_ACTOR_KIND=agent`,
   `QUADFLOW_ACTOR_NAME=<displayName>`, `QUADFLOW_PROVIDER_ID`, `QUADFLOW_SESSION_ID` (if known),
   `QUADFLOW_TERMINAL_ID`, and `PATH` prefixed with the directory of the `quadflow` CLI.
5. Write `command_line(shell, program, argv) + "\r"`.
6. If `prompt`: wait for `readyPattern` on PTY output (or `readyTimeoutMs`, or setting
   `agents.startupDelayMs` when no pattern), then write `ESC[200~ + prompt + ESC[201~`
   (bracketed paste; any `ESC[201~` inside the prompt is stripped), then `\r` if `autoSubmit`.
7. Binding: `{ sessionState: preassign ? 'assigned' : discover ? 'pending' : 'linked'/'unlinked', launchedAt: now_ms(), … }`;
   `discover` → `SessionClaims::register_pending(providerId, cwdKey, terminalId, launchedAt)` and start
   discovery (§8.3).
8. `issueRef` → `issues::claim` with `Assignment { providerId, sessionId, terminalId, agentLabel }`.
9. Return `LaunchResult`; the shell stores the binding on the terminal and persists the workspace.

`agents_relaunch`: write `exitCommand + "\r"` (if declared) else send Ctrl-C twice; wait until
PTY output is idle for 1.5 s (max 5 s); then steps 3–7 with `resume = binding.sessionId` when
`resume: true` and a session id is known. Used for approval-mode toggles and model switches.

### 8.3 Session discovery (Codex-style) — race-free

`SessionClaims` (in the GUI process, one instance):

```rust
struct State {
    claimed: HashMap<(String /*provider*/, String /*session*/), String /*terminal*/>,
    pending: BTreeMap<(String /*provider*/, String /*cwdKey*/), VecDeque<Pending>>, // FIFO by launchedAt
}
struct Pending { terminal_id: String, launched_at_ms: i64, started: Instant }
```

- A discovery worker per `(provider, cwdKey)` with pending launches (not per terminal) polls
  `list_sessions(p, cwd, since = oldest_pending.launched_at_ms − 2000)` at 500 ms for the first
  10 s, 1 s until 60 s, 2 s until 180 s.
- Candidates = sessions with matching `cwd` (root_key comparison), `createdAt ≥ since`, not in
  `claimed`, sorted by `createdAt` asc. Under the mutex, the oldest candidate is assigned to the
  oldest pending launch (FIFO), repeatedly, then pendings are removed. Each assignment emits
  `agent-session-linked { terminalId, providerId, sessionId }` and updates the binding
  (`sessionState: 'linked'`). A session can never be claimed twice (fixes the double-claim race).
- A pending launch older than 180 s → `sessionState: 'unlinked'`; the terminal header shows
  "Link session…" (`agents_sessions_list` + `agents_session_link`).
- Closing a terminal removes its pending entry and releases its claim.
- All times are ms: `SessionInfo.createdAt/modifiedAt` come from file metadata (`created()`
  falling back to `modified()`) converted to ms (fixes ms-vs-s).

Generic scanner (`sessions.rs`): expand `dir` template; walk `glob` (crate `globset` + `walkdir`,
newest-modified first, stop at `maxFiles`); per file derive `id` (`idFrom`) and `cwd` (`cwdFrom`;
`jsonl` reads at most `headerLines` lines, finds the first line matching `match`, extracts `path`);
files whose id/cwd cannot be derived are skipped (debug log); results cached per file by
`(path, len, mtime)` so polling re-reads only new/changed files.

### 8.4 Preassign providers (Claude-style)

No discovery. On restore, `agents_session_exists` decides between "Resume" (session file exists)
and "Relaunch" (it doesn't) — same UI as today's `TerminalTileContent.tsx` overlay, now generic.

### 8.5 Restore

On workspace restore: (1) seed `SessionClaims.claimed` with every persisted binding that has a
`sessionId`; (2) for bindings with `sessionState: 'pending'` (app closed during discovery) register
pending entries with their original `launchedAt` (now persisted) and start discovery; (3) the
resume overlay offers resume via `agents_launch { terminalId, resumeSessionId }`.

### 8.6 Attention detection

Core keeps the generic prompt regexes (`attentionDetector.ts:10-25`); provider
`attention.patterns` are appended for terminals whose binding has that provider. Detection runs
only for terminals with `agent !== null`.

### 8.7 One-shot runs

`one_shot`: spawn `program` + `oneShot.args` directly (no shell, `std::process::Command`), write
`prompt` to stdin, close stdin, capture stdout (cap 1 MiB), timeout `oneShot.timeoutMs`, non-zero
exit → `CoreError::External` with stderr tail. Used by the GitHub plugin for commit messages
(replacing `claude -p <diff>` through cmd/PowerShell).

---

## 9. First-party provider: Claude Code (`plugins/claude-code/`)

```json
{
  "id": "claude-code", "name": "Claude Code", "version": "1.0.0", "apiVersion": "^1.0.0",
  "platforms": ["windows", "macos", "linux"], "category": "ai-agents", "icon": "assets/icon.svg",
  "ui": { "entry": "dist/index.js" },
  "activation": ["onAgentProvider"],
  "contributes": {
    "agentProvider": {
      "id": "claude-code", "displayName": "Claude Code", "shortName": "Claude", "color": "#d97757",
      "installHint": { "default": "npm install -g @anthropic-ai/claude-code" },
      "detect": {
        "command": "claude", "versionArgs": ["--version"], "versionRegex": "(\\d+\\.\\d+\\.\\d+)",
        "extraPaths": {
          "windows": ["{home}/.claude/local/claude.exe", "{appData}/npm/claude.cmd"],
          "macos": ["{home}/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
          "linux": ["{home}/.claude/local/claude", "{home}/.local/bin/claude", "/usr/local/bin/claude"]
        }
      },
      "launch": {
        "args": [],
        "model": ["--model", "{model}"],
        "sessionId": ["--session-id", "{sessionId}"],
        "resume": ["--resume", "{sessionId}"],
        "efforts": { "values": ["low", "medium", "high", "max"], "default": "high", "args": ["--effort", "{effort}"] },
        "approvalModes": {
          "default": [],
          "plan": ["--permission-mode", "plan"],
          "accept-edits": ["--permission-mode", "acceptEdits"],
          "bypass": ["--dangerously-skip-permissions"]
        },
        "exitCommand": "/exit",
        "oneShot": { "args": ["-p"], "promptVia": "stdin" }
      },
      "models": { "catalogKey": "claude-code" },
      "sessions": {
        "strategy": "preassign", "idFormat": "uuid",
        "dir": "{home}/.claude/projects/{cwd|nonalnum-dash}", "glob": "*.jsonl",
        "idFrom": { "fileStem": true }, "cwdFrom": { "dir": true }
      },
      "contextFile": "CLAUDE.md",
      "scaffold": { "from": "assets/claude-template", "into": ".claude", "jsonMerge": ["settings.local.json"] },
      "attention": { "patterns": ["Type something", "^\\s*>\\s*1\\.", "\\[ \\]\\s"] },
      "hooks": ["usage", "contextUsage", "sessionTitle", "prepareWorktree"]
    },
    "tiles": [{ "id": "config", "title": "Claude Config", "modes": ["pane", "flyout"], "requiresProject": true }],
    "settingsPages": [{ "id": "permissions", "title": "Claude Code", "custom": true }],
    "commands": [{ "id": "rewind", "title": "Claude: Show rewind points", "when": "terminal.provider == 'claude-code'" }],
    "agentContextDocs": []
  },
  "permissions": ["agents:read", "fs:read:home", "fs:write:project", "terminal:spawn"]
}
```

Hooks (`src/index.tsx`):
- `usage`: spawn a hidden terminal (`ctx.terminals.spawn({ placement: 'none', cols: 120, rows: 50,
  env: { TERM: 'dumb', NO_COLOR: '1' } })`), type the detected program, wait for ready, send
  `/usage\r`, collect output for ≤ 8 s, send `/exit\r`, kill; parse `(\d+)%\s*used` and
  `(?i)(Resets\s+.+)` per window (ports `usage_monitor.rs:129-361`). Host cooldown 300 s
  (setting `usageMonitor.cooldownSeconds` lives in the Usage Monitor plugin).
- `contextUsage`: read the last 256 KiB of `sessionPath` (`fs:read:home`), parse JSONL
  `message.usage` (input + cache tokens) after the last `compact_boundary`/`microcompact`
  (ports `session_context.rs:5-101`); limit from the catalog `contextWindow`.
- `sessionTitle`: read `sessions-index.json` in the session dir (ports
  `useSessionSummaryPoller.ts:58-110`).
- `prepareWorktree`: write the `.claude/settings.local.json` PreToolUse hook +
  `.claude/hooks/pre-tool-use.js` enforcing `scope.allowedPaths` and the coordinator flag (ports
  `agentOverlay.ts:58-140`, with `quadflow missions …` CLI instructions instead of
  `mcp__quadcode__*`), and append `contextMarkdown` to the worktree's `CLAUDE.md` managed region.
- Tile `config`: CLAUDE.md / `.claude/settings.local.json` / skills editor (ports
  `claudeConfigStore.ts`); settings page `permissions`: Claude permission rules editor (ports
  `claudePermissionsStore.ts`, catalog updated to `Bash(quadflow:*)`).
- Command `rewind`: rewind-points viewer (ports `lib.rs:1464-1540` + `session_context.rs:374`) in TS.

Implementation acceptance includes verifying each flag against `claude --help` of the current CLI
version (drop `efforts` if `--effort` is not supported).

## 10. First-party provider: Codex (`plugins/codex/`)

```json
{
  "id": "codex", "name": "Codex", "version": "1.0.0", "apiVersion": "^1.0.0",
  "platforms": ["windows", "macos", "linux"], "category": "ai-agents", "icon": "assets/icon.svg",
  "ui": { "entry": "dist/index.js" },
  "activation": ["onAgentProvider"],
  "contributes": {
    "agentProvider": {
      "id": "codex", "displayName": "Codex", "shortName": "Codex", "color": "#10a37f",
      "installHint": { "default": "npm install -g @openai/codex" },
      "detect": {
        "command": "codex", "versionArgs": ["--version"], "versionRegex": "(\\d+\\.\\d+\\.\\d+)",
        "extraPaths": { "windows": ["{localAppData}/Programs/OpenAI/Codex/bin/codex.exe", "{appData}/npm/codex.cmd"], "macos": ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "{home}/.local/bin/codex"], "linux": ["{home}/.local/bin/codex", "/usr/local/bin/codex"] }
      },
      "launch": {
        "args": [],
        "model": ["--model", "{model}"],
        "resume": ["resume", "{sessionId}"],
        "resumePosition": "prefix",
        "efforts": { "values": ["low", "medium", "high", "xhigh"], "default": "medium", "args": ["-c", "model_reasoning_effort={effort}"] },
        "approvalModes": {
          "default": [],
          "plan": ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
          "auto": ["--approve-for-me"],
          "bypass": ["--dangerously-bypass-approvals-and-sandbox"]
        },
        "exitCommand": "/quit",
        "oneShot": { "args": ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never", "-"], "promptVia": "stdin" }
      },
      "models": { "catalogKey": "codex" },
      "sessions": {
        "strategy": "discover", "idFormat": "uuid",
        "dir": "{home}/.codex/sessions", "glob": "**/rollout-*.jsonl",
        "idFrom": { "jsonl": { "match": { "type": "session_meta" }, "path": "payload.id" } },
        "cwdFrom": { "jsonl": { "match": { "type": "session_meta" }, "path": "payload.cwd" } },
        "headerLines": 20
      },
      "contextFile": "AGENTS.md",
      "hooks": ["usage", "contextUsage", "prepareWorktree"]
    }
  },
  "permissions": ["agents:read", "fs:read:home", "fs:write:project"]
}
```

Notes:
- `model_reasoning_effort={effort}` without quotes (Codex `-c` parses TOML and falls back to a
  string), keeping argv in the safe charset.
- `codex resume <uuid>` (resume subcommand, prefix position). Today's `--all` flag
  (`types/index.ts:56-61`) is dropped unless AP-3 verifies it is required for cross-cwd resume.
- `contextUsage`: estimate from the rollout file (4 chars/token fallback today; parse
  `token_count` events if present).
- `prepareWorktree`: write the scope rules into the worktree's `AGENTS.md` managed region (Codex
  has no hook mechanism; enforcement is advisory — the Missions UI shows this).
- AP-3 acceptance: verify every flag against `codex --help` of the current release; adjust the
  manifest (not core) if flags differ. Verified against codex-cli 0.163.0 (2026-10-22):
  `--full-auto` no longer exists (`auto` = `--approve-for-me`, approval requests auto-reviewed in
  the workspace-write sandbox); `--ask-for-approval` accepts only `on-request` and `never`;
  `--sandbox read-only`, `--dangerously-bypass-approvals-and-sandbox`, `-c`, `--model`,
  `resume <id>` (options after the id; `--all` only disables the picker's cwd filter, so it is not
  needed for resume by id) and `exec -` (prompt from stdin) are valid. Efforts follow
  the model's `supported_reasoning_levels` (`low…xhigh` common to all current models). One-shot
  runs are `--ephemeral` so they never write a rollout that a pending interactive launch in the
  same cwd could claim. Session ids are UUIDv7 (the `uuid` id format accepts any version).
  `tests/codex_provider.rs` re-checks every manifest flag against the installed CLI's `--help`.
  Codex 0.163 writes its rollout file only when the first prompt is submitted (the file name
  carries the earlier session-start time), so a launch without a prompt stays `pending` until
  then; the "link within 10 s" criterion is measured from the rollout's appearance (GUI check:
  linked 1 s after the file appeared). `/quit` exits the TUI. With `plan` (explicit sandbox +
  approval flags) Codex did not show its directory-trust screen in an untrusted scratch dir
  (answering that screen writes to `~/.codex/config.toml`).
- `usage`: Codex records account rate limits in every rollout's `token_count` events
  (`rate_limits.primary/secondary` with `used_percent`, `window_minutes`, `resets_at`), so the
  hook reads the newest rollout files instead of scraping a TUI.

---

## 11. Shell UI after the change

- Toolbar "launch agent" split button lists `agents_providers()` (detected ones enabled, others
  greyed with install hint); the dialog (`AgentLaunchDialog`, merging `AgentPromptModal`) offers
  model (`agents_models`), approval mode (provider's supported modes), effort, prompt, role.
- Terminal header: provider badge (color/shortName), approval-mode badge, session state, context
  meter (hook), relaunch menu (model / approval mode / resume) → `agents_relaunch`.
- Onboarding step "Agents": `agents_detect_all` with install hints and a "Re-check" button.
- Command palette: `core/launch-agent:<providerId>` per provider.
- Settings → Agents: per-provider default model, custom models (validated), default approval mode,
  default effort, `startupDelayMs`, `autoSubmitPrompt`, catalog status + refresh, project context
  files and modules (§7.1), scaffold toggle.

---

## 12. Implementation sequence

| WP | Scope | Owns | Depends on |
|---|---|---|---|
| AP-1 | Core agent framework: `agents/{spec,detect,catalog,models,launch,quote,sessions,claims,one_shot,scaffold}.rs`, `context/writer.rs`, schemas `agent-provider.schema.json` + `catalog/models.schema.json` + initial `catalog/models.json`, `commands/agents.rs`, `AgentBinding` in workspace_terminals, unit tests (quoting per shell incl. `[1m]`, injection attempts rejected, FIFO claims with concurrent launches, ms timestamps, nonalnum-dash encoding) | `src-tauri/quadflow-core/src/agents/*`, `src-tauri/quadflow-core/src/context/writer.rs`, `src-tauri/src/commands/agents.rs`, `src-tauri/src/agents.rs`, `catalog/*` | DL-1, DL-10, PL-1 |
| AP-2 | `plugins/claude-code`: manifest, hooks, config tile, permissions page, rewind command, `assets/claude-template` (rewritten skills, CLI-only permissions) | `plugins/claude-code/**` | AP-1, PL-3, PL-5 |
| AP-3 | `plugins/codex`: manifest, hooks; verify flags | `plugins/codex/**` | AP-1, PL-3 |
| AP-4 | Remove hardcoded agent code from the shell and rewire every caller in §1 (Toolbar, TerminalTileContent, TerminalTileToolbar, ChatHistoryDropdown, launchAgent, workspaceTemplates, commandRegistry, QuickAccessTools, EmptyTileBubbleMenu, useWorkspaceActions, App.tsx, terminalStore/workspaceSave binding persistence); delete `sessionPolling.ts`, `modelCatalog.ts`, `useAIModels.ts`, `model_catalog.rs`, `session_context.rs`, `usage_monitor.rs`, Claude/Codex commands in `lib.rs`, `release-assets/model-catalog.json`; add the CI grep check (§0.1) | listed files; `src/agents/*` (providerRegistry, AgentLaunchDialog, TerminalAgentOverlay) | AP-1; AP-2/AP-3 for end-to-end acceptance |
| AP-5 | Usage Monitor plugin on the `usage` hook (multi-provider), mini widget | `plugins/usage-monitor/**`; deletes `usageMonitorStore.ts`, `UsageMonitor*View.tsx` | AP-2, PL-3 |

Tool views that launch agents (Ideas, Plans, Scripts, Ship, Issues, Missions, GitHub) switch to
`ctx.agents.launch` / `agents_one_shot` as part of their MIG-* plugin migration packages.

---

## 13. Changelog

- 2026-10-22 — initial version.
- 2026-10-22 — §10 Codex manifest updated to the flags verified against codex-cli 0.163.0 (AP-3);
  Codex gains a `usage` hook.
- 2026-10-23 — AP-4: every shell launch path goes through `agents_launch` / `agents_relaunch`
  (`src/agents/launch.ts`, `AgentLaunchDialog`, `TerminalAgentOverlay`, `ProviderBadge`); terminals
  carry only `agent: AgentBinding`. Additions: provider id alias `default` (`DEFAULT_PROVIDER_ALIAS`,
  resolved by core launch to setting `agents.defaultProvider`, else the first installed provider;
  used by built-in mission agent definitions instead of a hardcoded provider); `ProviderInfo` gains
  `exitCommand` and `attentionPatterns` (§8.6); `agents::SessionsRoot` (a provider's all-projects
  session root: `sessions.dir` up to its `{cwd…}` segment) feeds semantic search; per-provider
  defaults are settings `agents.defaultEffort.<id>` / `agents.defaultApprovalMode.<id>`;
  `agents_register_providers` and `agents_session_discover` are removed (launch registers
  discovery); a launch's issue claim failing no longer fails the launch (logged). The §0.1 check
  is `scripts/check-agent-literals.mjs` (first step of `npm run check`). Shell-started unattended
  helpers (scripts auto-fix) use the provider's `auto` / `accept-edits` mode, never `bypass`.
