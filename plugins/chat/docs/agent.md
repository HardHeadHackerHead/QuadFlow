# Chat

Conversations with an OpenAI-compatible LLM endpoint (Ollama, LM Studio,
OpenRouter, OpenAI, …). Conversations live in QuadFlow's app database (shared
with the GUI); the endpoint and tuning are the `chat` settings; the API key is
kept in the OS keystore and is never printed.

## Commands

Run `quadflow chat --help` for the authoritative list. Every command accepts `--json`.

- `quadflow chat list [--this-project] --json` — conversations, most recent first
- `quadflow chat create [--title "<t>"] [--model <m>] [--system-prompt "<p>"] [--this-project]`
- `quadflow chat send <id> "<text>"` — send a message; the answer streams to stdout
  (`--json` returns `{userMessage, assistantMessage, usage}`)
- `quadflow chat messages <id> --json` — full history, oldest first (alias `history`)
- `quadflow chat get|rename|delete <id> …`
- `quadflow chat settings [--endpoint <url>] [--model <m>] [--temperature 0.7]
  [--max-tokens 2048] [--timeout-seconds 60] [--system-prompt "<p>" | --clear-system-prompt]`
  — show or change settings (`hasApiKey` says whether a key is stored)
- `quadflow chat key set --from-env <VAR>` / `--stdin`, `quadflow chat key clear|status`
- `quadflow chat models` — models offered by the configured endpoint

## Endpoint discovery

- `quadflow chat discover [--port 11434]` — scan the local network for LLM servers
- `quadflow chat check <url>` — probe one URL

## JSON output

Conversation: `{id, projectRootKey, title, model, systemPrompt, createdAt, updatedAt}`.
Message: `{id, conversationId, role: "system"|"user"|"assistant", content, tokenCount, createdAt}`.
Errors: `{"ok":false,"error":{"code":"external", …}}` when the endpoint is unreachable or
rejects the request (exit 1); `not_found` exit 3; `invalid_input` exit 2.
