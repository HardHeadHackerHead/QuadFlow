# Publishing a plugin

Users install plugins from **sources**: an `index.json` listing plugins, versions and download
URLs with sha256 checksums. QuadFlow ships with the official source; anyone can publish their
own, and users add it in Settings → Plugins → Sources (or `quadflow plugins sources add <url>`).
Spec: [plugin-system.md §12](../architecture/plugin-system.md#12-plugin-sources).

## 1. Build the release archives

```bash
npm run build
npm run pack        # release/<id>-<version>.zip and release/<id>-<version>.zip.sha256
```

The archive's root holds `quadflow-plugin.json`, `dist/`, `assets/`, `docs/`, README/LICENSE and
every file the manifest references for the current platform. A plugin that ships native binaries
(a Rust sidecar, `exec` CLI handlers) gets one archive per platform,
`<id>-<version>-<os>-<arch>.zip` (`windows-x86_64`, `macos-aarch64`, `linux-x86_64`, …): run
`npm run build && npm run pack` on each OS/arch, or cross-compile the sidecar and place each
binary at its `sidecar.binaries` path before packing. Node sidecars and UI-only plugins are
platform-independent (one zip).

Archives are deterministic (fixed timestamps, sorted entries), so rebuilding the same sources
gives the same sha256.

## 2. Host them

Any HTTPS URL works. With GitHub releases, attach the zips to a release (one per plugin version
is convenient, e.g. tag `plugin-<id>-v<version>`):

```bash
gh release create plugin-acme.word-count-v1.0.0 release/*.zip --title "Word Count 1.0.0"
```

## 3. Write `index.json`

Schema: `packages/plugin-api/schema/plugin-index.schema.json`.

```json
{
  "formatVersion": 1,
  "name": "Acme plugins",
  "homepage": "https://github.com/acme/quadflow-plugins",
  "plugins": [
    {
      "id": "acme.word-count",
      "name": "Word Count",
      "description": "Count words in project files.",
      "homepage": "https://github.com/acme/quadflow-plugins",
      "category": "development",
      "icon": "https://raw.githubusercontent.com/acme/quadflow-plugins/main/word-count/assets/icon.svg",
      "versions": [
        {
          "version": "1.0.0",
          "apiVersion": "^1.0.0",
          "platforms": ["windows", "macos", "linux"],
          "permissions": ["data:issues:read"],
          "url": "https://github.com/acme/quadflow-plugins/releases/download/plugin-acme.word-count-v1.0.0/acme.word-count-1.0.0.zip",
          "sha256": "3f1c0e6d2b9a8f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c4b3a29180f7e",
          "size": 12345,
          "releasedAt": "2026-10-22T00:00:00Z",
          "notes": "First release."
        }
      ]
    }
  ]
}
```

`sha256` is the first field of the `.sha256` file `npm run pack` writes; `size` is the zip's size
in bytes. For per-platform archives, `url` contains the `{os}-{arch}` placeholder
(`…/acme.word-count-1.0.0-{os}-{arch}.zip`) and `sha256` / `size` become maps keyed
`windows-x86_64` etc. Validate your index against the schema with any JSON-Schema (2020-12)
validator. QuadFlow verifies, before installing, that the archive's
size and sha256 match, that its manifest's id, version and permissions equal the index entry, and
that nothing in the zip escapes its folder.

A convenient layout is a repository with one folder per plugin and `index.json` at the root; then
the source URL is simply `github:acme/quadflow-plugins` (QuadFlow reads `index.json` from the
default branch; `github:OWNER/REPO#REF:PATH` picks a branch/tag and path). Never edit published
version records — add new versions; users roll back to the previous one with
`quadflow plugins rollback <id>`.

QuadFlow's own repository generates its official `plugins/index.json` with
`node scripts/gen-plugin-index.mjs --assets <dir-with-the-zips>`, which reads the manifests,
computes sha256 and size from the archives and keeps existing version records unchanged — a
template for automating your own index.

## 4. Updates

Bump `version` in both `quadflow-plugin.json` and `package.json` (`quadflow-plugin build` fails if
they differ), build, pack, upload, append the version record. Users get an update badge; an
update that adds permissions waits for their approval while the old version keeps running.
