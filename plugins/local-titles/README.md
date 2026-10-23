# Local Titles

**Offline terminal titles from a local model (llama.cpp).**

*Optional — install from Settings → Plugins.*

Generates short terminal titles from a local GGUF model with llama.cpp, fully offline once the
model is downloaded. The plugin is not bundled with QuadFlow (`package.json` →
`quadflow.bundle: "none"`), so the app never compiles llama.cpp.

## Features

- A title generator (*Local model (llama.cpp)*) that QuadFlow asks before any other title source.
- Three models to choose from, downloaded and managed from the settings page:

  | Model | Size (approx.) |
  |---|---|
  | TinyLlama 1.1B Chat (light, default) | 0.7 GB |
  | Qwen 2.5 7B Instruct (balanced) | 4.5 GB |
  | Llama 3.1 8B Instruct (high) | 5 GB |

- Background downloads with progress and cancel; delete a model to free the disk space.
- CPU or GPU inference (CUDA, Metal or Vulkan builds of the sidecar).

## Usage

Install the plugin, open **Settings → Local Titles**, download a model and select it. Turning
auto-titles on and the word limit stay in Settings → Integrations → Auto Titles.

How the shell picks a title, in order:

1. plugins contributing `contributes.titleGenerators` (this plugin's `llama` generator; it returns
   nothing while the selected model is not downloaded);
2. the terminal's agent provider, when it has a short session title;
3. the chat API (Settings → Integrations → API Model);
4. a heuristic from the prompt.

## Settings

| Setting | Default | Description |
|---|---|---|
| Model (`modelId`) | `tinyllama-1.1b-chat-q4k` | Also `qwen2.5-7b-instruct-q4k`, `llama3.1-8b-instruct-q4k` |
| Device (`deviceMode`) | `auto` | `auto` (GPU when this build has one), `gpu`, `cpu` |
| GPU layers (`gpuLayers`) | 0 | Layers offloaded to the GPU (0 = all that fit) |
| Max tokens (`maxTokens`) | 12 | 6–32 |
| Temperature (`temperature`) | 0.2 | 0–1 |

## Permissions

None. The sidecar downloads models from Hugging Face itself; inference never touches the network.

## Data

Models are stored in `<plugin data>/models/<model id>/` (`<QuadFlow data>/plugin-data/local-titles/`).

## Development

```bash
npm run build            # UI module only (what npm run build:plugins runs for every workspace)
npm run build:release    # UI module + cargo build --release of the sidecar → bin/
```

The sidecar crate is **standalone**: it has its own `[workspace]`, `Cargo.lock` and `target/`, and
the repository's root `Cargo.toml` excludes it, so `cargo check/test --workspace` never builds
llama.cpp. Building it needs a C/C++ toolchain and libclang (bindgen). On Windows run it from a
*Developer Command Prompt for VS* (or after `vcvars64.bat`), otherwise bindgen fails with
`'stdio.h' file not found`. Don't wrap it in sccache (`RUSTC_WRAPPER`): cc-rs then fails on MSVC.

Crate features (one release build per platform):

| Feature | Backend |
|---|---|
| `llama` (default) | llama.cpp, CPU |
| `cuda` | + NVIDIA CUDA (needs the CUDA toolkit) |
| `metal` | + Apple Metal |
| `vulkan` | + Vulkan |
| `--no-default-features` | Stub: answers every request, cannot generate |

```bash
cargo build --release --manifest-path plugins/local-titles/sidecar/Cargo.toml --features cuda
cargo test --manifest-path plugins/local-titles/sidecar/Cargo.toml --no-default-features   # post-processing tests, no C++ toolchain
```

Layout:

| Part | Files |
|---|---|
| Manifest | `quadflow-plugin.json`: `titleGenerators`, settings page `models`, settings schema, sidecar binaries |
| UI module | `src/index.tsx`, `src/model.ts` (sidecar calls, generator), `src/SettingsPage.tsx` |
| Sidecar | `sidecar/src/models.rs` (catalog, downloads), `sidecar/src/inference.rs` (llama.cpp) |

Sidecar requests: `titles/info`, `titles/models`, `titles/download { modelId }` (runs in the
background; notifications `ui/downloadProgress`, `ui/downloadDone`), `titles/cancelDownload`,
`titles/delete { modelId }`, `titles/generate { text, modelId, minWords, maxWords, deviceMode,
gpuLayers, maxTokens, temperature }`. See [docs/plugins/sidecars.md](../../docs/plugins/sidecars.md).

## License

AGPL-3.0-only, part of QuadFlow.
