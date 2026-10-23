-- quadflow-core app database, schema v1 (data-layer.md §7).
-- Pre-release: edit this file in place and delete your dev DB; no migrations.

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,               -- ULID
  name            TEXT NOT NULL,
  root            TEXT NOT NULL,                  -- canonical path as displayed
  root_key        TEXT NOT NULL UNIQUE,           -- paths::root_key()
  default_workspace_template TEXT,                -- JSON DefaultWorkspaceTemplate | NULL
  last_opened_at  INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- Active project = setting ('shell','activeProjectId'). No is_active column.

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  layout_tree   TEXT,                             -- JSON MosaicNode<string> | NULL
  pinned        INTEGER NOT NULL DEFAULT 0,
  pin_order     INTEGER,
  pin_section   TEXT NOT NULL DEFAULT 'right',    -- left|center|right
  sort_order    INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_workspaces_project ON workspaces(project_id);
-- Active workspace per project = setting ('shell', 'activeWorkspace:<projectId>').

CREATE TABLE workspace_terminals (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,                    -- terminal id (layout leaf "term:<id>", plugin-system.md §5.2)
  title         TEXT NOT NULL,
  title_source  TEXT NOT NULL DEFAULT 'default',  -- default|auto|manual
  cwd           TEXT NOT NULL,
  environment_id TEXT,
  agent         TEXT,                             -- JSON AgentBinding | NULL (agent-providers.md §5.4)
  state         TEXT NOT NULL DEFAULT '{}',       -- JSON: shell runtime state (scrollback snapshot, status)
  locked       INTEGER NOT NULL DEFAULT 0,
  minimized     INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE tool_configs (
  id              TEXT PRIMARY KEY,
  plugin_id       TEXT NOT NULL,
  contribution_id TEXT NOT NULL,                  -- tile/toolbar contribution id in the manifest
  name            TEXT NOT NULL,
  icon            TEXT,                           -- override; NULL = manifest icon
  color           TEXT,
  settings        TEXT NOT NULL DEFAULT '{}',     -- JSON, validated against contribution configSchema
  enabled         INTEGER NOT NULL DEFAULT 1,
  pinned          INTEGER NOT NULL DEFAULT 0,
  pin_order       INTEGER,
  pin_section     TEXT NOT NULL DEFAULT 'right',
  pin_display     TEXT NOT NULL DEFAULT 'icon-and-name',  -- icon|icon-and-name|mini
  quick_launch    INTEGER NOT NULL DEFAULT 0,
  open_mode       TEXT NOT NULL DEFAULT 'pane',   -- pane|flyout
  flyout_width    INTEGER,
  flyout_height   INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  auto_created    INTEGER NOT NULL DEFAULT 0,     -- created from manifest defaultToolConfig
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_tool_configs_plugin ON tool_configs(plugin_id);

CREATE TABLE tile_instances (
  id              TEXT PRIMARY KEY,               -- ULID; layout leaf id = "tool:" || id
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,       -- NULL when global
  global_workspace_id TEXT REFERENCES global_workspaces(id) ON DELETE CASCADE,
  tool_config_id  TEXT NOT NULL REFERENCES tool_configs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT '{}',     -- JSON: plugin instance state (e.g. editor file path)
  locked          INTEGER NOT NULL DEFAULT 0,
  minimized       INTEGER NOT NULL DEFAULT 0,
  floating        TEXT,                           -- JSON {x,y,width,height} | NULL
  created_at      INTEGER NOT NULL,
  CHECK ((workspace_id IS NULL) <> (global_workspace_id IS NULL))
);
CREATE INDEX idx_tile_instances_ws ON tile_instances(workspace_id);

CREATE TABLE global_workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  minimized     INTEGER NOT NULL DEFAULT 0,
  layout_tree   TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE settings (
  namespace   TEXT NOT NULL,                      -- "shell", "terminal", "agents", "chat", "plugin:<id>", ...
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                      -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE stored_prompts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, category TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE agent_definitions (                  -- custom only; builtins are Rust consts
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, role TEXT NOT NULL,
  provider_id TEXT NOT NULL, model TEXT, system_prompt TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE terminal_environments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
  kind TEXT NOT NULL,                             -- system_shell|vs_dev|custom
  shell TEXT NOT NULL,                            -- cmd|powershell|pwsh|bash|zsh|sh
  shell_path TEXT,                                -- absolute shell executable path | NULL (DL-6)
  init_commands TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  vs TEXT,                                        -- JSON {version, edition, arch, vcvarsPath} | NULL
  built_in INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY, project_root_key TEXT, title TEXT NOT NULL, model TEXT,
  system_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                             -- system|user|assistant
  content TEXT NOT NULL, token_count INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

CREATE TABLE plugin_sources (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  etag TEXT, last_checked_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE plugins (                            -- installed (non-bundled) + state for bundled
  id TEXT PRIMARY KEY, source_id TEXT REFERENCES plugin_sources(id) ON DELETE SET NULL,
  origin TEXT NOT NULL,                           -- bundled|installed|dev
  version TEXT NOT NULL, install_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,                           -- active|disabled|needs_consent|incompatible|failed
  status_detail TEXT,
  granted_permissions TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  available_update TEXT,                          -- JSON {version, url, sha256, permissions} | NULL
  installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL, scope TEXT NOT NULL,   -- "global" | "project:<root_key>"
  key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, scope, key)
);

CREATE TABLE app_changes (                        -- cross-process change cursor (§8.3)
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL, entity_id TEXT, op TEXT NOT NULL, at INTEGER NOT NULL, pid INTEGER NOT NULL
);
