# Semantic Search

**Search your past agent sessions by meaning, fully on your machine.**

*Optional — install from Settings → Plugins.*

A native sidecar (Rust + [Candle](https://github.com/huggingface/candle)) reads the session
transcripts of your agent providers, splits them into chunks, embeds them with a small
sentence-transformer that runs locally and keeps the index in the plugin's data folder. Nothing
leaves your computer except the one-time model download from Hugging Face.

The plugin is not bundled with QuadFlow (`package.json` → `quadflow.bundle: "none"`), so the app
itself never compiles Candle.

## Features

- Ask a question ("how did we fix the websocket reconnect") and get **Sessions** ranked by their
  best chunk, boosted for recent sessions, success signals and files you mention.
- **Excerpts** shows the matching chunks: select some and start an agent with them, or copy them.
- **Resume** continues a session with its agent provider.
- Related past sessions in the agent launch dialog while you type a prompt.
- Indexing on demand, every N minutes, or in real time when session files change.
- Four embedding models, including a built-in keyword model that needs no download.
- Optional GPU acceleration (CUDA or Metal builds of the sidecar).

## Install

**From the official plugin source** (release builds): Settings → Plugins → Browse → *Semantic
Search* → Install, or `quadflow plugins install semantic-search`. Each release ships one archive
per platform (`semantic-search-<version>-<os>-<arch>.zip`) because the sidecar is a native binary.

**From a QuadFlow checkout** (development, or a platform without a published archive):

```bash
npm install                        # once, at the repository root
cd plugins/semantic-search
npm run build:sidecar              # UI module + cargo build --release -p semantic-search-sidecar → bin/
quadflow plugins dev add "$PWD"    # or Settings → Plugins → Load unpacked…
```

GPU builds: `cargo build --release -p semantic-search-sidecar --features cuda` (NVIDIA, needs the
CUDA toolkit) or `--features metal` (Apple Silicon), then copy the binary to `bin/`.

## Usage

Open the **Semantic Search** tool, as a pane or a flyout, and type a question. Index from the
tile's *Index* button, the palette commands, or automatically (setting *Indexing* below).

| Command | What it does |
|---|---|
| Semantic Search: Search Sessions… | Search from the palette |
| Semantic Search: Index Sessions Now | Index new and changed sessions |
| Semantic Search: Rebuild Index | Drop and rebuild the whole index |

In the palette, type `semantic search: <query>` or `ss: <query>`. The agent launch dialog uses the
command `semantic-search/related-sessions`, which never downloads a model.

### Where sessions come from

1. Every active agent provider's session folder (`sessions.dir` / `sessions.glob` of its manifest),
   through the host method `agents.sessionRoots`. Hosts without that method skip this source.
2. Folders you add in the settings (folder, glob, and the provider id the sessions belong to).

Transcripts are JSON Lines; entries shaped `{"type":"user"|"assistant","message":{role,content}}` or
`{"type":"response_item","payload":{"type":"message",role,content}}` are indexed.

## Settings

Settings → Plugins → Semantic Search, or the gear in the tile. The page also has diagnostics and
*Clear* (drops the index).

| Setting | Default | Description |
|---|---|---|
| Embedding model | `all-MiniLM-L6-v2` | Also `paraphrase-MiniLM-L3-v2`, `all-mpnet-base-v2`, or `hashing` (built in, no download, keyword matching only) |
| Use the GPU | off | Only with a sidecar built with the `cuda` / `metal` feature |
| Indexing | `manual` | `manual` = only when you click Index; `periodic` = every N minutes; `realtime` = when session files change |
| Periodic interval (minutes) | 10 | 1–1440 |
| Chunk size (tokens) | 512 | 64–2048 |
| Chunk overlap (tokens) | 50 | 0–512 |
| Index agent provider sessions | on | The session folders every active agent provider declares |
| Additional session folders | none | Folder, glob (default `**/*.jsonl`), provider id |
| Clean up sessions older than (days) | 0 | 0 = keep everything |

## Permissions

| Permission | Why |
|---|---|
| `agents:read` | Find the agent providers' session folders |
| `agents:launch` | Start an agent with selected excerpts, resume a session |
| `clipboard:write` | Copy excerpts |
| `network:huggingface.co` | One-time model download |

## Data

`<QuadFlow data>/plugin-data/semantic-search/` (the sidecar's `QUADFLOW_PLUGIN_DATA`):
`semantic.db` (SQLite: sessions and chunk embeddings) and `models/<id>/` (downloaded model files).
*Clear* in the settings drops the index; delete the folder to remove the models too.

## Development

```bash
npm run build                                       # UI module only (what npm run build:plugins / npm run check run)
npm run build:sidecar                               # UI module + release sidecar → bin/
npm test                                            # UI helper tests
cargo test --release -p semantic-search-sidecar     # chunker, store, sources, engines
npm run test:e2e:semantic                           # at the repository root: GUI test with the hashing model
```

- `src/` — tile (`SearchTile.tsx`), settings page (`SettingsPanel.tsx`), sidecar calls (`model.ts`)
- `sidecar/src/` — `main.rs` (request and notification list at the top), `indexer.rs`,
  `chunker.rs`, `engine.rs`, `models.rs`, `sources.rs`, `signals.rs`, `store.rs`

To publish: `npm run build:sidecar && npm run pack` on each OS/arch (see
[docs/plugins/publishing.md](../../docs/plugins/publishing.md)). Sidecars:
[docs/plugins/sidecars.md](../../docs/plugins/sidecars.md).

## License

AGPL-3.0-only, part of QuadFlow.
