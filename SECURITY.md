# Security Policy

## Supported versions

QuadFlow is released continuously. Security fixes are made on the default
branch and shipped in the next release; only the **latest release** is
supported. Please update before reporting.

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull
requests, or discussions.**

Report them privately through GitHub Security Advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**
   (or open `/security/advisories/new` on the repository URL).
3. Describe the issue: affected version and platform, steps to reproduce,
   impact, and a proof of concept if you have one.

We aim to acknowledge reports within **3 business days** and to send an
initial assessment within **10 business days**. We will keep you updated while
we work on a fix, coordinate a disclosure date with you, and credit you in the
advisory unless you prefer to stay anonymous.

## Scope

In scope:

- The QuadFlow desktop app (the Tauri shell and the React frontend)
- The `quadflow` CLI and the `quadflow-core` library
- Official plugins in this repository (`/plugins`)
- The auto-updater and the release artifacts published from this repository

Of particular interest: command injection into terminals/PTYs, plugin
permission or sandbox bypasses, path traversal in the project data store,
updater signature bypasses, and arbitrary code execution from crafted project
files, model catalogs, or plugin indexes.

Out of scope:

- Vulnerabilities in third-party agent CLIs (Claude Code, Codex, ...) that
  QuadFlow launches -- please report those to their vendors.
- Third-party plugins not maintained in this repository -- report those to
  their authors.
- Issues that require an attacker who already has full control of the user's
  account or machine.
