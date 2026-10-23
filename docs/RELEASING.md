# Releasing QuadFlow

QuadFlow has no hosted CI. Releases are built on the maintainer's machines with the generic
`quadflow ship` pipeline and uploaded to the GitHub releases of
[`HardHeadHackerHead/QuadFlow`](https://github.com/HardHeadHackerHead/QuadFlow/releases), which is
also where the auto-updater looks (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints`:
`releases/latest/download/latest.json`).

| Piece | Where |
| --- | --- |
| Pipeline definition (tracked) | `scripts/release/ship.config.json` — a plain ship config |
| Driver | `scripts/release.mjs` (`npm run release -- …`) — picks this machine's platform, mode, dry run, signing, then runs `quadflow-cli ship run <mode> --config …` |
| Release-specific steps | `scripts/release/{preflight,sync-versions,changelog,plugins,generate-updater-key}.mjs` |
| Output (gitignored) | `release/v<version>/` — installer, updater bundle + `.sig`, `latest.json`, `notes.md`, `plugins/*.zip` |
| Run records (gitignored) | `.quadflow/local/ship/runs/` (`quadflow ship list`, `quadflow ship get <version>`) |
| Updater private key + password (gitignored) | `keys/updater.key`, `keys/updater.key.password` |

The pipeline (cut, in order): ship checks (clean tree, version files in sync, `gh` logged in, repo
reachable, ≥ 20 GB free) → `preflight.mjs` (release branch `main`/`oss`, updater public key set,
private key + password sign a scratch file with the matching key id, lockfiles in sync, tag and
release still free) → bump
`package.json`, `tauri.conf.json`, both `Cargo.toml` (UTF-8 preserving) → lockfiles → staging dir →
`CHANGELOG.md` section + release notes from `git log` → `npm run check` → `npm run build -- --bundles <this OS>`
(full release build; `beforeBuildCommand` bundles the release plugins) → stage installer +
updater bundle + `.sig` → `latest.json` (merging the platforms already on the release) → plugin
archives + index preview → commit `Release v<version>` → tag `v<version>` → push → draft GitHub
release → draft plugin releases.

## One-time setup

1. Prerequisites: Node 22+, Rust (see `rust-version` in `src-tauri/quadflow-core/Cargo.toml`), the
   per-OS Tauri prerequisites (WebView2 + MSVC build tools on Windows, Xcode CLT on macOS,
   webkit2gtk etc. on Linux), and the GitHub CLI. The `local-titles` plugin compiles llama.cpp
   (C/C++ via bindgen): on Windows run the release from a shell with the MSVC environment loaded
   (`vcvars64.bat` / "x64 Native Tools Command Prompt"), otherwise bindgen cannot find `stdio.h`.
2. `gh auth login` with an account that can push to `HardHeadHackerHead/QuadFlow` and create
   releases. Check with `gh auth status`.
3. Create the updater signing key — **once, ever**:

   ```bash
   npm ci
   npm run release:key            # node scripts/release/generate-updater-key.mjs
   ```

   This runs `tauri signer generate`, writes the private key to `keys/updater.key` (gitignored),
   checks that it signs and matches, writes the public key into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey` (replacing the `UPDATER_PUBKEY_NOT_SET__…` placeholder that makes the
   release preflight fail) and prints it.

   The key always has a password — Tauri cannot sign with a key whose password is empty. By
   default a random one is written to `keys/updater.key.password` (gitignored; the pipeline loads
   it into `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). To choose it yourself, pass `--password-env VAR`
   (or have `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set); then no password file is written and every
   release needs that variable.

   - Back up `keys/updater.key` **and** the password somewhere safe (password manager / offline).
     Installed copies only accept updates signed by this key; losing either means every user has to
     reinstall by hand.
   - Commit `src-tauri/tauri.conf.json`.
   - On every other machine that builds releases, copy `keys/updater.key` and
     `keys/updater.key.password` (or export `TAURI_SIGNING_PRIVATE_KEY` — the key or its path — and
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
   - The script refuses to overwrite an existing key; `--force` rotates it (old files backed up
     next to them) — only do that if the old key is lost or compromised.

Dev builds (`npm run tauri dev`, `npm run build:dev-exe`) do not need any of this: they don't
create updater artifacts, and with the placeholder key the update check just reports an error.

## Cutting a release

From an up-to-date, clean `main` (or `oss` until the public repo exists) on Windows:

```bash
npm run release -- patch --dry-run   # everything except commit/tag/push/upload; files restored
npm run release -- patch             # minor | major; creates a DRAFT release
```

Options: `--publish` (no drafts), `--skip-check` (skip `npm run check`), `--reuse-build` (stage the
artifacts of the previous build instead of building), `--plan` (print the resolved phases only),
`--sign` (below). Each run prints per-phase timings and lists `release/v<version>/`.

If a run fails before `commit`, the bumped files are simply left uncommitted: `git checkout -- .`,
fix the problem, run the same command again. If it fails after `push` (an upload), the tag is
already out: `git checkout v1.2.3 && npm run release -- platform` re-creates/fills the release for
that version. `quadflow ship get <version>` shows each phase's command, exit code and captured
output.

`--dry-run` really does the work — bump, changelog, `npm run check`, the full release build, the
updater signature, `latest.json`, plugin archives — then puts back `package.json`,
`tauri.conf.json`, both `Cargo.toml`, the lockfiles and `CHANGELOG.md`. Before the updater key
exists (no `keys/updater.key`, or the placeholder public key) it signs with a throwaway keypair in
`release/.dry-run-key/` and puts its public key into `tauri.conf.json` for the build (`tauri
build` verifies the signature it makes against the configured key), restored afterwards. Problems
that only block publishing (branch, placeholder public key, key mismatch) are warnings in a dry
run.

### Other platforms

The release is per machine: each OS builds its own bundle and adds it to the same release. After
the Windows cut has pushed the tag:

```bash
git fetch --tags && git checkout v1.2.3
npm ci
npm run release -- platform          # macOS: dmg + .app.tar.gz; Linux: AppImage + deb
```

`platform` re-ships the current version (no bump, changelog, commit, tag or push). It runs the
`platform:<os>-<arch>` sequence of `ship.config.json` for this machine (`windows-x86_64`,
`macos-aarch64`, `macos-x86_64`, `linux-x86_64`) and uploads into the existing release.

### How `latest.json` combines platforms

Each platform's `build_latest_json` phase downloads the `latest.json` already attached to the
release (with `gh`, so it works for drafts and the private repo), keeps every other platform's
entry, replaces its own (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`) and
uploads the result with `--clobber`. Run the platform builds one after another, not at the same
time — two concurrent runs would each upload a manifest missing the other's entry. Check the result
with `gh release download v1.2.3 -R HardHeadHackerHead/QuadFlow -p latest.json -O -`.

### Signing (optional)

- **Windows Authenticode**: `npm run release -- patch --sign --sign-command "signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}"`
  (or set `QUADFLOW_SIGN_COMMAND`). With QwickCert: `--sign-command "cmd /C qwick.cmd sign --verify {file}"`
  (`qwick` is an npm `.cmd` shim, which Tauri cannot start without `cmd /C`; log in first with
  `qwick auth login`). The command is put into `bundle.windows.signCommand` for the
  build only, so Tauri signs the app exe and the installer *before* computing the updater
  signature; the pipeline then verifies the installer with `Get-AuthenticodeSignature` and restores
  `tauri.conf.json`. Off by default — unsigned builds work but show SmartScreen warnings.
- **macOS**: export Tauri's signing/notarization variables (`APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_KEY`…) before `npm run release --
  platform`; `tauri build` signs and notarizes.

### Publishing

Review the draft (assets, notes, `latest.json`) on GitHub, then:

```bash
npm run release -- publish 1.2.3 --dry-run   # show what would change
npm run release -- publish 1.2.3
```

This un-drafts the plugin releases first and then `v1.2.3` (marked latest) — from that moment
`releases/latest/download/latest.json` serves the new version to every installed copy.

### Installing over QuadFlow 1.x (Windows)

1.x was installed by NSIS with identifier `com.quadflow.app`; this app is `io.quadslab.quadflow`
with the same `productName` "QuadFlow". Tauri's NSIS installer keys the uninstall entry
(`HKCU\…\Uninstall\QuadFlow`), the default install dir (`%LOCALAPPDATA%\QuadFlow`), the
Start-menu/desktop shortcuts and the main binary (`quadflow-tauri.exe`) by product name, so the new
setup sees 1.x as an older version of itself and offers "uninstall before installing" (an
upgrade), then installs into the same folder; the PATH entry and the `quadflow.cmd` shim keep
pointing at the new exe. It also reads the previous install dir from `HKCU\Software\<publisher>\QuadFlow`
and passes it to the old uninstaller (`_?=<dir>`). The publisher defaults to the identifier's second
part — `quadflow` for 1.x, `quadslab` for this app — which would make that lookup empty (the old
uninstaller runs with an empty install dir, fails, and the setup reports an error). `bundle.publisher`
is therefore set to `"QuadFlow"` (registry keys are case-insensitive, so it matches 1.x's
`Software\quadflow\QuadFlow`). App data does not collide: 1.x keeps `%APPDATA%\com.quadflow.app`
(read, never written, by the 1.x import), this app uses `%APPDATA%\io.quadslab.quadflow`. The old
uninstaller's "Delete the application data" checkbox is unticked by default; ticking it deletes the
1.x project list before it can be imported (README "Upgrading from QuadFlow 1.x").

## Plugin releases and `plugins/index.json`

The official plugin source is `plugins/index.json` on the default branch, generated by
`scripts/gen-plugin-index.mjs` (never hand-edited). Archives live on releases named
`plugin-<id>-v<version>` as `<id>-<version>.zip` (UI-only) or `<id>-<version>-<os>-<arch>.zip`
(plugins with a sidecar).

- During a cut/platform run, `plugins-pack` zips every plugin (bundle policy `release` or `none`)
  whose manifest version is not yet in `plugins/index.json`, from the staged build in
  `src-tauri/resources/plugins/` (what the app bundle ships), with `@quadflow/plugin-build`'s
  `packPlugin` — the same packager as `quadflow-plugin pack` (docs/plugins/publishing.md).
  Archives are deterministic (sorted entries, fixed timestamps), so the same build always has the
  same sha256. `plugins-index-preview` validates the index the
  archives would produce (`release/v<version>/plugins-index.preview.json`); `plugins-upload`
  creates the plugin releases (draft unless `--publish`) and uploads the archives.
- To publish a new plugin version: bump `version` in `plugins/<id>/quadflow-plugin.json` (and its
  `package.json`); the next app release packs it. Published versions are immutable — the index
  generator refuses different archives for a version it already lists.
- After **all** platforms are uploaded, regenerate and commit the index:

  ```bash
  npm run release -- plugins-index --dry-run   # writes release/plugins-index.preview.json
  npm run release -- plugins-index             # downloads the archives (drafts too) → plugins/index.json
  git add plugins/index.json && git commit -m "Plugin index: …" && git push
  ```

  Do this before (or right after) `publish`; installs read the index from the default branch and
  download from the release URLs, which only work once the plugin releases are published.
- The low-level commands are `node scripts/release/plugins.mjs pack|upload|fetch|index` (see the
  header of that script).

## Rollback

- **Before publishing** (draft): delete the draft and the tag, and revert the release commit if it
  was pushed:

  ```bash
  gh release delete v1.2.3 -R HardHeadHackerHead/QuadFlow --yes
  git push origin :refs/tags/v1.2.3 && git tag -d v1.2.3
  git revert <release commit>        # or reset, if nothing else landed on top
  ```

  Delete draft `plugin-*-v*` releases the same way.
- **After publishing**: the updater only moves forward, so the fix is a new release. Either cut a
  fixed `patch` release, or make the previous release "latest" again so no further copies update to
  the bad one: `gh release edit v1.2.2 -R HardHeadHackerHead/QuadFlow --latest` and turn the bad one
  back into a draft (`gh release edit v1.2.3 --draft=true`). Copies that already updated stay on
  v1.2.3 until the next release.
- **A bad platform entry in `latest.json`**: fix the build and rerun `npm run release -- platform`
  on the tag — it replaces only that platform's entry and asset.
- **Plugins**: never edit a published version record. Ship a new plugin version instead (bump,
  release, `plugins-index`).

## Files and phases reference

`scripts/release.mjs` edits the tracked config by phase name:

| Phase name | Removed for |
| --- | --- |
| `platform:<os>-<arch>` | every machine except that one |
| `bump`, `sync-lockfiles`, `changelog`, `commit`, `tag`, `push` | `platform` runs |
| `commit`, `tag`, `push`, `github-release`, `plugins-upload` | `--dry-run` |
| `check` | `--skip-check` |

`npm run check` runs `npm run check:release` (`node scripts/release.mjs validate`), which fails if
these names, the platform sequences or the version files go out of sync. To run the config
directly: `quadflow ship run patch --config scripts/release/ship.config.json` (all platforms' phases
would run, so prefer the driver).
