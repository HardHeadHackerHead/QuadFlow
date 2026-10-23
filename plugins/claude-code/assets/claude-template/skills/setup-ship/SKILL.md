---
name: setup-ship
description: Interactively configure the project's release pipeline (.quadflow/ship/config.json). Always invoke when the user asks to "set up ship", "configure ship", "configure release", "set up the release pipeline", or names this skill. Detects installed tooling (gh, signtool, codesign, vercel, railway, docker, npm, etc.), works out (or asks) what KIND of thing is being shipped (desktop app / web app / library / binaries / container / static site) and adapts the interview, gathers the template params, writes a complete validated ship config from one of 12 built-in templates.
allowed-tools: Bash, Read, Glob, Write, AskUserQuestion
user-invocable: true
argument-hint: [--force]
---

# Setup Ship Skill (Interactive)

Walk the user through configuring their release pipeline. The pipeline can be
ANY of these — not just desktop apps:

| What you ship                                     | Template                |
|---------------------------------------------------|-------------------------|
| Tauri desktop app for Windows                     | `tauri-windows`         |
| Tauri desktop app for macOS                       | `tauri-macos`           |
| Library (npm, cargo, PyPI) — CI publishes the tag | `library-publish`       |
| Cross-platform Cargo binaries → GitHub Release    | `gh-release-binaries`   |
| Vercel-hosted web app / SaaS                      | `vercel`                |
| Railway-hosted web app / API / worker             | `railway`               |
| Fly.io-hosted app                                 | `fly`                   |
| Netlify static site / function                    | `netlify`               |
| Cloudflare Pages site                             | `cloudflare-pages`      |
| Docker image to any registry                      | `docker`                |
| S3 + CloudFront static site                       | `s3-static-site`        |
| Bare-bones (no sign/upload, edit by hand later)   | `minimal`               |

## Process

### 1. Detect the environment

Run all three in parallel via Bash:

```bash
quadflow ship detect --json
quadflow ship templates --json
quadflow ship diagnostics --json
```

`detect` reports `hostOs` (`windows` / `macos` / `linux`), `projectKind`
(`tauri` / `cargo` / `npm` / `python`; absent when unrecognized),
`productName`, detected `versionFiles`, a `tools` map of every deploy CLI
(gh, vercel, railway, flyctl, netlify, wrangler, supabase, heroku, gcloud,
az, doctl, docker, podman, kubectl, helm, aws, …) and signing tool
(signtool, osslsigncode, jsign, minisign, codesign), the Tauri bundle
settings (`tauriBundleTargets`, `tauriProductName`), `existingSigningKeys`
(updater keys), `ghUser`, `ghReleaseRepos` and `macosCodesignIdentities`.
Every command prints one JSON envelope: read `data` when `"ok": true`,
`error.code` / `error.message` otherwise.

`templates` lists every template with its `params` (`key`, `required`,
`kind`, `default`) — treat that list as the source of truth for the
`--param` keys below.

`diagnostics` reports the current ship config state (`configPath`,
`configExists`, `configParseError`, `configPhaseCount`, `configCheckCount`,
`projectKind`, `runCount`) — use this to detect an existing config and offer
"use existing / re-configure".

Parse the responses. The `tools` map in `detect` tells you which deploy
CLIs are installed. **Use this to recommend a single template BEFORE
asking the user what they want — do not present a 4-option chooser when
one signal is unambiguous.**

#### Detection-driven recommendation rules

When **one** signal is strong, propose that template and ask only
"Looks right? (Y / pick something else)":

| Signal                                                         | Recommend             |
|----------------------------------------------------------------|-----------------------|
| `tools.railway: true` AND `railway status` returns linked proj | `railway`             |
| `tools.vercel: true` AND `vercel.json` exists                  | `vercel`              |
| `tools.flyctl: true` AND `fly.toml` exists                     | `fly`                 |
| `tools.wrangler: true` AND `wrangler.toml` exists              | `cloudflare-pages`    |
| `tools.netlify: true` AND `netlify.toml` exists                | `netlify`             |
| `projectKind: "tauri"` AND `hostOs: "windows"`                 | `tauri-windows`       |
| `projectKind: "tauri"` AND `hostOs: "macos"`                   | `tauri-macos`         |
| `Dockerfile` exists AND no other deploy signals                | `docker`              |

When **multiple** are detected, list ALL detected options and let the
user pick.

When **no** deploy CLI is installed, fall through to Section 2.

### 2. Ask WHAT THE USER IS SHIPPING (only if detection is ambiguous)

```
What are you releasing?
```

Options (pick the most likely two or three based on detection):
- "Desktop app (Tauri / Electron)" — if `src-tauri/tauri.conf.json` exists
- "Web app on Vercel" — if `vercel.json` exists or `vercel` CLI installed
- "Web app on Cloudflare Pages" — if `wrangler.toml` exists
- "Static site to S3"
- "Library to a package registry (npm/cargo/PyPI)"
- "Cross-platform Cargo binaries to GitHub Releases"
- "Docker image"
- "Other / build my own"

### 3. Branch into the recipe-specific interview

Each template needs different params. Only ask for what's needed.

#### Web-app templates (vercel / railway / fly / netlify / cloudflare-pages / s3-static-site)

These all share three boolean opt-in/out params (defaults shown):

- `bump=true` — bump version files (package.json etc.) and commit before deploy
- `audit_tag=true` — tag the release as `deploy-{version}` for queryable rollback (`git checkout deploy-1.0.4`)
- `push_tag=true` — push the audit tag to remote (so it lands on GitHub)

**Always explain these explicitly during the interview.** Web-app deploys
on Railway/Fly/Vercel track releases by commit SHA, NOT by package.json
version, so bumping is often unnecessary churn. And "git push" can read as
"release to GitHub" to anyone unfamiliar with the convention — be explicit
that the push only carries the audit tag, not the codebase.

Ask:

> This template can:
> 1. Bump package.json version on every deploy (default ON)
> 2. Tag deploys as `deploy-{version}` for `git checkout deploy-X.Y.Z` rollback (default ON)
> 3. Push the audit tag to your remote (default ON)
>
> Defaults are usually fine. Disable any?

If the user wants to disable any, pass them as `--param key=false` to
`quadflow ship init` (Step 5). A project with no detected version file
(`detect` → `versionFiles: []`) must use `bump=false`; deploys then run in
`deploy` mode with `{version}` = the short git commit hash.

#### railway

- Run `railway whoami` — confirms logged in. If not: tell them `railway login`.
- Run `railway status --json` — confirms the project is linked AND
  enumerates the project's available services and environments. If "no
  project linked", tell them `railway link` (interactive — they pick from
  a list of their projects).
- Parse the JSON for the linked service + environment. If multiple
  services, ask which one to deploy. Params (both optional): `service`,
  `environment` — the deploy phase selects them before `railway up`.
  DO NOT call `railway service list` — that command doesn't exist;
  `railway service` is the *selector*, not a lister.

#### vercel

- Run `vercel whoami`. If not logged in: tell them `vercel login`.
- `project_name` (optional — Vercel infers it from `.vercel/project.json`
  if linked).

#### fly

- Confirm `flyctl auth whoami` works. If not: `flyctl auth login`.
- Confirm `fly.toml` exists in the project root. If not, the user needs
  to run `flyctl launch` first to create one.
- No additional params — the template uses `flyctl deploy --remote-only`
  which reads app + region from fly.toml.

#### netlify

- Confirm `netlify status` works. If not: `netlify login`.
- Confirm the project dir is linked to a Netlify site (`.netlify/state.json`
  should exist; if not: `netlify link`).
- `dist_dir` — build output directory (default `dist`; check what their
  build script produces — `dist`, `build`, `out`, `.next`). The template
  runs `npm run build` first.

#### cloudflare-pages

- Run `wrangler whoami` to confirm logged in. If not: `wrangler login`.
- `project` (required) — Pages project name (`wrangler pages project list`
  to enumerate).
- `dist_dir` — build output directory (default `dist`).

#### library-publish

- `remote` — git remote (default `origin`).
- `branch` — required branch (default `main`; ask if their default is
  different — `master`, `develop`, etc.).
- Note: this template does NOT call `npm publish` / `cargo publish`
  directly. It bumps version files, commits, tags `v{version}`, pushes.
  The user's CI on the registry side picks up the tag and publishes.
  Tell them this explicitly. If they don't have CI, they may want to add
  a `shell` phase that runs `npm publish` themselves.

#### gh-release-binaries

All three params are required.

- `repo` — `OWNER/REPO` (validate with `gh repo view`).
- `bin_name` — suggest the first `[[bin]]` name in Cargo.toml, or the
  package name.
- `targets` — comma-separated target triples. Recommend defaults based on
  host OS:
  - Windows host: `x86_64-pc-windows-msvc,x86_64-unknown-linux-gnu,x86_64-apple-darwin,aarch64-apple-darwin`
  - macOS host: `x86_64-apple-darwin,aarch64-apple-darwin,x86_64-unknown-linux-gnu`
- For each target, check `rustup target list --installed`. If a target
  isn't installed, tell the user `rustup target add <triple>` (offer to
  copy).

#### docker

- `image` (required) — image name with registry, e.g. `ghcr.io/owner/myapp`,
  `myorg/myapp` (Docker Hub),
  `123.dkr.ecr.us-east-1.amazonaws.com/myapp` (ECR).
- The template always bumps, builds `:{version}` + `:latest`, pushes both,
  then tags and pushes `v{version}` (no `bump` / `audit_tag` toggles).
- Run `docker info` to confirm the daemon is running.
- For GHCR, suggest
  `gh auth token | docker login ghcr.io -u USERNAME --password-stdin`.

#### s3-static-site

- Run `aws sts get-caller-identity` to confirm credentials.
- `bucket` (required) — check `aws s3 ls` to enumerate bucket access.
- `dist_dir` — build output dir (default `dist`).
- `cloudfront_dist_id` (optional) — CloudFront distribution for invalidation.

#### tauri-windows

- `repo` (required): the GitHub repo releases go to (`gh repo view` to validate).
- `bundle_basename` (optional, default `<productName>-Windows`).
- `signing_key` (optional): path to the **Tauri updater** private key. Only
  ask if they use the Tauri updater; it adds the `.sig` → `latest.json`
  phases. No key yet → `npx tauri signer generate -w keys/tauri-signing-key`.
- `sign_command` (optional): **Authenticode** signing. Off unless the user
  wants it — never assume a signing provider. Ask which tool they use and
  build the command with `{file}` as the file to sign, e.g.
  - `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a {file}` (Windows SDK, cert in the store)
  - `jsign --storetype PKCS12 --keystore cert.pfx --storepass <pw> {file}` (cross-platform, signs in place)
  - their CA's / cloud signing service's CLI, whatever it is.
  It becomes Tauri's `bundle.windows.signCommand` (patched in for the build
  only) and adds a `verify_authenticode` check of the installer. Confirm the
  tool is on PATH (`detect` → `tools`).

#### tauri-macos

- `repo`, `codesign_identity` (from `detect` → `macosCodesignIdentities`),
  `notarytool_profile` (create with `xcrun notarytool store-credentials`) — required.
- `app_name` (default productName), `bundle_basename`, `signing_key`
  (updater, optional), `updater_platform` (default `darwin-aarch64`).

#### minimal

Preflight + bump + staging dir + the detected build command (npm / cargo /
`python -m build`). Optional `product_name`. Confirm and write — they'll
edit by hand.

Every template also accepts an optional `product_name` (default: detected).

### 4. Pre-flight: warn about a dirty tree BEFORE writing

If `git status --porcelain` shows uncommitted changes AND the chosen
template bumps and commits (any template except `minimal` and the Tauri
ones, unless the user passed `bump=false`), surface this BEFORE writing
the config:

> Heads up: your working tree has uncommitted changes. The chosen template
> bumps the version files and commits. Those existing modifications will end
> up in the same commit as the version bump, which is usually not what
> you want.
>
> Options:
> 1. Commit or stash your changes, then re-run setup-ship.
> 2. Use `--param bump=false` to deploy without touching version files
>    (web-deploy templates only).
> 3. Proceed anyway (if the config's preflight includes `git_clean`, it
>    blocks `quadflow ship run` until the tree is clean).

Wait for an answer before writing.

### 5. Write the config

Use the CLI directly — no JSON by hand. Add `--force` only when replacing
an existing config the user agreed to overwrite:

```bash
quadflow ship init \
  --template railway \
  --param service=web \
  --param environment=production \
  --param bump=false \
  --param push_tag=false --json
```

The CLI calls the same scaffolder the GUI does. Unknown `--param` keys,
missing required params and bad booleans are errors (`invalid_input`, exit
2) — nothing is written. An existing config is `conflict` (exit 4) unless
`--force`. A project whose kind cannot be detected makes `minimal` fail with
`unsupported`: pick a concrete template or write the config by hand
(`quadflow ship config save --file <path>`; schema: `quadflow docs ship`).

If you need to preview the resolved JSON before writing:

```bash
quadflow ship templates --id railway \
  --param service=web --param push_tag=false --json
```

That returns (in `data`) the exact config the template would write.
Useful when the user wants to inspect the phase list before committing.

### 6. Persist a setup-history record

After a successful write, append to `.quadflow/ship/setup-history.json`:

```json
{
  "formatVersion": 1,
  "runs": [
    {
      "timestamp": "2026-04-27T19:33:12Z",
      "template": "railway",
      "params": {
        "service": "web",
        "environment": "production",
        "bump": "false",
        "push_tag": "false"
      },
      "userNotes": "Detected via railway status --json; chose to skip version bump because Railway tracks SHA."
    }
  ]
}
```

If the file already exists, read it, append the new run, write it back.
If it doesn't exist, create it with `formatVersion: 1, runs: [...]`. Use the
`Read` and `Write` tools — the CLI has no command for this file. Never
record secrets (passwords, tokens) in `params`.

At Step 1, if this file exists, a re-run can offer:

> You previously ran setup-ship with template=`railway`, service=`web`,
> environment=`production`, bump=false, push_tag=false. Re-use, modify, or
> start over?

### 7. Validate + show readiness

```bash
quadflow ship config validate --json
quadflow ship readiness --json
quadflow ship status --json
```

`config validate --json` exits 2 with `error.details.errors` when the config
has problems. Report readiness checks with `"level": "fail"` / `"warn"`
together with their `hint` and `fixCommand` (`quadflow ship fix <check-id>`
runs the fix and re-checks).

### 8. Final report

Tell the user:
- Path of the written config
- Which template + params were used
- How many phases + how many preflight checks
- Whether setup-history was updated
- Any failed readiness checks + their fix commands
- Recommended next step: `quadflow ship run patch --dry-run` to preview,
  then `/cut-ship` (or the Ship panel in QuadFlow) for the first real run

## Notes

- The pipeline supports `parallel` and `sequence` phases, so multi-target
  builds (e.g. cargo for 4 OSes simultaneously) are first-class. The
  `gh-release-binaries` template uses these.
- The pipeline supports generic `git_commit`, `git_tag`, `git_push`
  phases. Web-deploy templates use these for the audit tag pattern. The
  phase names in scaffolded configs are deliberately verbose
  (`audit-tag`, `publish-audit-tag`) so it's obvious they are the
  rollback anchor — not "release to GitHub".
- Signing is never a default. `sign_authenticode` phases require an
  explicit `tool`; templates only sign when the user passes `sign_command`.
- The `command_succeeds:<cmd>` readiness check works for any tool —
  write custom checks like `command_succeeds:flyctl auth whoami` for
  fly.io, `command_succeeds:railway whoami` for Railway, etc.
- Web-deploy templates always include `git_clean` in preflight whenever
  `bump=true` — a bump mixes into existing diffs and produces a confusing
  commit otherwise.

## When NOT to use this skill

- The user already has a working config and just wants to ship →
  `/cut-ship`, not re-configure.
- Hand-tuning phases of an existing config → edit the JSON (schema:
  `quadflow docs ship`), then `quadflow ship config validate`.
- Pure exploration ("what templates are there?") → just run
  `quadflow ship templates --json` directly.
