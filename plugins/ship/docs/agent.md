# Ship

Typed, generic release pipeline. A project opts in with
`.quadflow/ship/config.json`: the files that carry the version plus an ordered
list of typed phases (checks → bump → build → sign → stage → publish / deploy,
git commit/tag/push, arbitrary shell steps). Works for desktop apps, web
deploys, libraries, containers and static sites alike.

Every run gets its own id and record under `.quadflow/local/ship/runs/<id>.json`
(machine-local, not committed) — running the same version twice keeps two
records. Records are rewritten after every phase transition, so a crash still
leaves a trail.

## Commands

```
quadflow ship detect --json                 # tools on PATH, project kind, version files, gh repos
quadflow ship templates [--json]            # built-in templates + their params
quadflow ship templates --id <t> --param k=v --json   # preview the config a template writes
quadflow ship init [--template <t>] [--param k=v]… [--force]
quadflow ship config show | validate [--file <config.json>] | delete
quadflow ship config save --file <config.json>
quadflow ship status                        # versions (in sync?), branch, dirty tree, last run
quadflow ship readiness [--check <id>]      # evaluate readiness checks
quadflow ship fix <check-id>                # run a failing check's fix command, re-check
quadflow ship bump patch|minor|major [--dry-run]
quadflow ship run patch|minor|major|deploy [--dry-run] [--skip-build] [--reuse-build] [--draft]
                 [--config <config.json>]   # run a config file (e.g. tracked in the repo) instead of .quadflow/ship/config.json
quadflow ship list                          # runs, newest first
quadflow ship get <run-id | version>        # one run (a version → its newest run)
quadflow ship abort [<run-id>]              # abort the newest (or given) in-progress run
quadflow ship restore-backups               # restore orphan *.ship-bak files
quadflow ship diagnostics
```

All of them accept `--json` and print one envelope: `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code","message","details"}}`. Exit codes: 0 ok, 1 error
(a failed or aborted `ship run` → code `external`, the run record in
`error.details.run`), 2 invalid input (an invalid config from
`ship config validate`, problems in `error.details.errors`), 3 not found,
4 conflict, 5 no project.

`deploy` mode re-ships the current version: `version_bump` phases are skipped
and `{version}` is the current version. A config without `versionFiles`
versions runs by the short git commit hash (deploy mode only).

## Config

```json
{
  "formatVersion": 1,
  "productName": "MyApp",
  "versionFiles": [
    { "path": "package.json", "kind": "json", "key": "version" },
    { "path": "src-tauri/Cargo.toml", "kind": "toml", "key": "package.version" }
  ],
  "phases": [ { "type": "checks", "name": "preflight", "checks": ["git_clean"] }, … ],
  "changelog": { "source": "git_log", "since": "last_tag" }
}
```

Keys are camelCase; phase `type` values are snake_case. `key` is a dotted path
(`version`, `package.version`, `workspace.package.version`, `project.version`).
Version edits keep the file's formatting.

## Phase types

- **`checks`** — `checks: [ids]`; fails on any fail-level check (see below).
- **`version_bump`** — bump every version file (skipped in `deploy` mode).
- **`ensure_staging_dir`** — `path` (default `release/v{version}`), `clean`
  (default true); sets `{staging_dir}`.
- **`load_env_from_file`** — `var`, `file`, `required`: file contents → env var
  for later phases (e.g. `TAURI_SIGNING_PRIVATE_KEY`).
- **`patch_tauri_conf`** / **`restore_tauri_conf`** — `path` (default
  `src-tauri/tauri.conf.json`), `beforeBundleCommand`, `windowsSignCommand`
  (→ `bundle.windows.signCommand`, `{file}` = file to sign),
  `webviewInstallMode`. Snapshots `<file>.ship-bak` first.
- **`build`** — `command`, `workingDirectory`, `externalTerminal` (GUI: run in a
  terminal tile). Skipped by `--skip-build` / `--reuse-build`.
- **`verify_authenticode`** (Windows) — `file`: fail unless the signature is Valid.
- **`sign_authenticode`** — `files` (globs) and `tool` — **required, no
  default**: any signing command, `{file}` = the file (else appended), e.g.
  `signtool sign /fd sha256 /tr <timestamp-url> /td sha256 /a {file}`,
  `jsign --storetype PKCS12 --keystore cert.pfx --storepass <pw> {file}`, or
  any other signing CLI (it must sign the file in place).
- **`stage_artifact`** — `sourceGlob` → `{staging_dir}/<destName>`.
- **`read_updater_sig`** — `sourceGlob` of a Tauri `.sig` → var `storeAs`
  (default `signature`).
- **`build_latest_json`** — Tauri updater manifest: `repo`, `platform`,
  `bundleName`, `tag`, `sigVar`, `dest`, `notes`; merges the other platforms
  already on the release (read with `gh` first, so draft releases and private
  repos merge too).
- **`gh_release`** — `repo`, `tag` (default `v{version}`), `title`/`notes`
  (default `{productName} v{version}`), `notesFile` (path; overrides `notes`),
  `draft` (default true), `files`.
- **`codesign_macos`**, **`notarize`**, **`staple_notarization`**,
  **`create_dmg`** (macOS).
- **`git_commit`** (`message`, `paths`, `sign`), **`git_tag`** (`tag`,
  `message`, `sign`, `ifExists`: skip | fail | replace | suffix), **`git_push`**
  (`remote`, `tagStrategy`: none | tags | follow).
- **`write_file`** — `path`, `content`, `overwrite`.
- **`shell`** — `command`, `env`, `workingDirectory`, `skippable` +
  `skipFlag: "skip-build"`, `externalTerminal`.
- **`sequence`** / **`parallel`** — `children` run in order / concurrently.

Tokens in string fields: `{version}`, `{prev_version}`, `{staging_dir}`,
`{productName}`, and vars set by earlier phases (`{signature}`).

## Readiness checks

`git_clean`, `git_branch:<name>`, `version_files_in_sync`, `tool_available:<exe>`,
`file_exists:<path>`, `gh_authenticated`, `gh_repo_reachable:<owner/repo>`,
`tag_not_exists:<owner/repo>`, `disk_space:<gb>`, `minisign_key_valid:<path>`,
`no_holding_processes:<exe,…>`, `dev_server_not_running:<port,…>`,
`no_stale_bundle:<glob>`, `xcrun_available`, `codesign_identity:<name>`,
`notarytool_profile:<name>`, `gpg_available`, `command_succeeds:<command>`,
`cargo_logged_in`, and `<tool>_authenticated` for vercel, railway, fly,
netlify, wrangler, supabase, gcloud, az, doctl, heroku (+ `docker_logged_in`,
`npm_token_valid`). Unknown ids are config errors.

## Templates

`minimal` (default; errors if the project kind cannot be detected),
`library-publish`, `gh-release-binaries`, `vercel`, `railway`, `fly`, `netlify`,
`cloudflare-pages`, `docker`, `s3-static-site`, `tauri-windows`, `tauri-macos`.
Names and paths come from detection or `--param`; signing is opt-in
(`tauri-windows`: `sign_command`, `signing_key` for the updater).

## Crash safety

`patch_tauri_conf` writes `<file>.ship-bak` before changing the file. Backups
are restored by `restore_tauri_conf`, at the end of every run (success or
failure), and at the start of the next `ship run` (or `ship restore-backups`).
