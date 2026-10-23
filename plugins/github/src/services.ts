/**
 * GitHub + local git services of the GitHub plugin, bound to one plugin context.
 *
 * Ported from the shell's `services/github.ts`, which drove the `gh` CLI. Now:
 *  - GitHub: REST API v3 through `ctx.http.fetch` (`network:api.github.com`), authenticated
 *    with a token kept in the OS keychain via `ctx.secrets` (`secrets`). "Use GitHub CLI
 *    token" reads `gh auth token` once (`shell:exec:gh`); the CLI is not needed otherwise.
 *  - local git: `ctx.shell.exec({ program: 'git', … })` (`shell:exec:git`);
 *  - `.gitignore` / sub-repo discovery: `ctx.fs` with the `project` scope
 *    (`fs:read:project`, `fs:write:project`);
 *  - commit messages: `ctx.agents.oneShot` with the user's agent provider (`agents:launch`).
 *
 * The function names and result shapes are those of the old service, so the views and stores
 * ported with it keep working.
 */
import type { PluginContext } from '@quadflow/plugin-api'
import { errorMessage } from '@quadflow/plugin-kit'
import type { CheckpointDiffSummary } from './types'

// Types for GitHub API responses (the shapes the gh CLI's --json output had)
export interface GitHubUser {
  id: number
  login: string
  name: string | null
  avatarUrl: string
  url: string
}

export interface GitHubRepository {
  id: string
  name: string
  nameWithOwner: string
  owner: {
    login: string
  }
  isPrivate: boolean
  url: string
  description: string | null
  defaultBranchRef: {
    name: string
  } | null
}

export interface GitHubIssue {
  id: string
  number: number
  title: string
  body: string
  /** `OPEN` / `CLOSED` */
  state: string
  url: string
  labels: { name: string; color: string }[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  author: {
    login: string
  }
}

export interface GitHubComment {
  id: string
  body: string
  url: string
  createdAt: string
  author: {
    login: string
  }
}

export interface GitHubBranch {
  name: string
  sha: string
  protected: boolean
}

export interface GitHubPullRequest {
  number: number
  title: string
  body?: string
  /** `OPEN` / `CLOSED` / `MERGED` */
  state: string
  url: string
  headRefName: string
  baseRefName: string
  author: { login: string }
  isDraft: boolean
  mergeable?: string
  createdAt: string
  updatedAt: string
  mergedAt?: string
  closedAt?: string
}

export interface GitHubCommit {
  sha: string
  message: string
  author: string
  login?: string
  date: string
  url: string
}

export interface GitHubCommitDetail extends GitHubCommit {
  stats?: { additions: number; deletions: number; total: number }
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>
}

export interface GitHubRelease {
  tagName: string
  name: string
  body?: string
  isDraft: boolean
  isPrerelease: boolean
  publishedAt?: string
  url?: string
  author?: { login: string }
}

export interface GitHubComparison {
  status: string
  aheadBy: number
  behindBy: number
  totalCommits: number
  commits: GitHubCommit[]
}

export interface LocalGitInfo {
  isGitRepo: boolean
  remoteUrl?: string         // origin remote URL
  nameWithOwner?: string     // e.g. "user/repo" extracted from remote URL
  currentBranch?: string
  defaultBranch?: string
  hasUncommittedChanges?: boolean
}

export interface DiscoveredRepo {
  path: string         // absolute path
  label: string        // folder name (or project name for root)
  isRoot: boolean      // true if this is the project root itself
  gitInfo: LocalGitInfo // pre-fetched remote info
}

export interface GitStatusInfo {
  branch: string
  staged: number
  modified: number
  untracked: number
  ahead: number
  behind: number
  lastCommitTime: string | null    // ISO timestamp
  lastPushTime: string | null      // ISO timestamp
  hasRemote: boolean
  hasUpstream: boolean             // whether current branch tracks a remote branch
  isGitRepo: boolean
}

export type ProjectType = 'node' | 'rust' | 'python' | 'tauri'

/** Error of a git command or a GitHub API request. */
export class GitHubCLIError extends Error {
  exitCode: number
  stderr: string

  constructor(message: string, exitCode: number, stderr: string) {
    super(message)
    this.name = 'GitHubCLIError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/** Secret name of the GitHub token (keychain entry `plugin:github:token`). */
export const TOKEN_SECRET = 'token'
export const API_BASE = 'https://api.github.com'

// ==================== Pure helpers ====================

const GITIGNORE_COMMON = `# OS files
.DS_Store
Thumbs.db
desktop.ini

# Editor directories
.vscode/*
!.vscode/extensions.json
.idea
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# Environment files
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*
`

const GITIGNORE_NODE = `# Dependencies
node_modules/

# Build output
dist/
dist-ssr/
build/
out/

# Cache
.cache/
.parcel-cache/
.next/
.nuxt/
.turbo/

# Testing
coverage/

# Misc
*.local
`

const GITIGNORE_RUST = `# Rust build output
/target/

# Debug symbols
*.pdb
`

const GITIGNORE_PYTHON = `# Python
__pycache__/
*.py[cod]
*$py.class
*.so

# Virtual environments
.venv/
venv/
env/

# Distribution
*.egg-info/
dist/
build/
*.egg

# Testing
.pytest_cache/
.coverage
htmlcov/
`

const GITIGNORE_TAURI = `# Tauri generated schemas
/src-tauri/gen/schemas/
`

/** The generated `.gitignore` for the detected project types. */
export function gitignoreFor(types: ProjectType[]): string {
  let content = GITIGNORE_COMMON
  if (types.includes('node')) content += GITIGNORE_NODE
  if (types.includes('rust')) content += GITIGNORE_RUST
  if (types.includes('python')) content += GITIGNORE_PYTHON
  if (types.includes('tauri')) content += GITIGNORE_TAURI
  if (types.length === 0) {
    content += `# Build output
dist/
build/
out/
`
  }
  return content
}

export function parseStatusPorcelain(output: string): { staged: number; modified: number; untracked: number } {
  let staged = 0
  let modified = 0
  let untracked = 0

  if (!output.trim()) return { staged, modified, untracked }

  for (const line of output.split('\n')) {
    if (!line || line.length < 2) continue
    const x = line[0] // index (staging area)
    const y = line[1] // working tree

    if (x === '?' && y === '?') {
      untracked++
    } else {
      if (x !== ' ' && x !== '?') staged++
      if (y !== ' ' && y !== '?') modified++
    }
  }

  return { staged, modified, untracked }
}

/** `owner/repo` from a GitHub remote URL (https or ssh). */
export function nameWithOwnerFromRemote(remoteUrl: string): string | undefined {
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/\s]+?)(?:\.git)?\/?$/)
  const sshMatch = remoteUrl.match(/github\.com:([^/]+\/[^/\s]+?)(?:\.git)?$/)
  return httpsMatch?.[1] || sshMatch?.[1]
}

/**
 * Sanitize a checkpoint name for use as a git tag suffix.
 * Lowercases, replaces spaces/special chars with hyphens, collapses runs.
 */
export function sanitizeCheckpointName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60)
}

/** Build the full tag name for a checkpoint. */
export function buildCheckpointTagName(name: string): string {
  return `qf-cp/${sanitizeCheckpointName(name)}`
}

export function parseNumstat(output: string): CheckpointDiffSummary {
  const summary: CheckpointDiffSummary = { filesChanged: 0, additions: 0, deletions: 0, files: [] }
  if (!output.trim()) return summary
  for (const line of output.trim().split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0
    const path = parts[2]
    summary.files.push({ path, status: 'modified', additions, deletions })
    summary.additions += additions
    summary.deletions += deletions
  }
  summary.filesChanged = summary.files.length
  return summary
}

// ---- REST → gh-shaped mappers ----

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any

const mapRepo = (r: Raw): GitHubRepository => ({
  id: String(r.node_id ?? r.id),
  name: r.name,
  nameWithOwner: r.full_name,
  owner: { login: r.owner?.login ?? String(r.full_name ?? '').split('/')[0] },
  isPrivate: !!r.private,
  url: r.html_url,
  description: r.description ?? null,
  defaultBranchRef: r.default_branch ? { name: r.default_branch } : null,
})

const mapIssue = (i: Raw): GitHubIssue => ({
  id: String(i.node_id ?? i.id),
  number: i.number,
  title: i.title,
  body: i.body ?? '',
  state: String(i.state ?? '').toUpperCase(),
  url: i.html_url,
  labels: (i.labels ?? []).map((l: Raw) => (typeof l === 'string' ? { name: l, color: '6b7280' } : { name: l.name, color: l.color ?? '6b7280' })),
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  closedAt: i.closed_at ?? null,
  author: { login: i.user?.login ?? '' },
})

const mapComment = (c: Raw): GitHubComment => ({
  id: String(c.id),
  body: c.body ?? '',
  url: c.html_url,
  createdAt: c.created_at,
  author: { login: c.user?.login ?? '' },
})

const mapPull = (p: Raw): GitHubPullRequest => ({
  number: p.number,
  title: p.title,
  body: p.body ?? undefined,
  state: p.merged_at ? 'MERGED' : String(p.state ?? '').toUpperCase(),
  url: p.html_url,
  headRefName: p.head?.ref ?? '',
  baseRefName: p.base?.ref ?? '',
  author: { login: p.user?.login ?? '' },
  isDraft: !!p.draft,
  mergeable: p.mergeable == null ? undefined : p.mergeable ? 'MERGEABLE' : 'CONFLICTING',
  createdAt: p.created_at,
  updatedAt: p.updated_at,
  mergedAt: p.merged_at ?? undefined,
  closedAt: p.closed_at ?? undefined,
})

const mapCommit = (c: Raw): GitHubCommit => ({
  sha: c.sha,
  message: c.commit?.message ?? '',
  author: c.commit?.author?.name ?? '',
  login: c.author?.login ?? undefined,
  date: c.commit?.author?.date ?? '',
  url: c.html_url,
})

const mapRelease = (r: Raw): GitHubRelease => ({
  tagName: r.tag_name,
  name: r.name ?? r.tag_name,
  body: r.body ?? undefined,
  isDraft: !!r.draft,
  isPrerelease: !!r.prerelease,
  publishedAt: r.published_at ?? undefined,
  url: r.html_url,
  author: r.author ? { login: r.author.login } : undefined,
})

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

// ==================== Bound services ====================

export type GitHubServices = ReturnType<typeof createServices>

/** All services of the old module, bound to `ctx`. */
export function createServices(ctx: PluginContext) {
  // ---------- process / http primitives ----------

  async function gitCommandText(args: string[], cwd?: string): Promise<string> {
    const output = await ctx.shell.exec({ program: 'git', args, cwd, timeoutMs: 120_000 })
    if (output.code !== 0) {
      // Filter out CRLF warnings - these are harmless on Windows and shouldn't be treated as errors
      const stderrLines = (output.stderr || '').split('\n')
      const realErrors = stderrLines.filter((line) => !line.trim().startsWith('warning:'))
      const hasWarnings = stderrLines.some((line) => line.trim().startsWith('warning:'))
      const hasOnlyWarnings = hasWarnings && realErrors.every((line) => !line.trim())
      if (!hasOnlyWarnings || output.code === null) {
        throw new GitHubCLIError(output.stderr.trim() || 'git command failed', output.code || 1, output.stderr)
      }
    }
    return output.stdout.trim()
  }

  let tokenCache: string | null | undefined
  async function token(): Promise<string | null> {
    if (tokenCache === undefined) {
      try {
        tokenCache = (await ctx.secrets.get(TOKEN_SECRET)) || null
      } catch (e) {
        ctx.log.warn('could not read the GitHub token', e)
        tokenCache = null
      }
    }
    return tokenCache
  }

  async function request<T = Raw>(method: string, path: string, body?: unknown): Promise<T> {
    const t = await token()
    if (!t) throw new GitHubCLIError('Not signed in to GitHub. Add a token in the GitHub tool (Settings tab).', 401, '')
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'QuadFlow',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await ctx.http.fetch(`${API_BASE}/${path.replace(/^\//, '')}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 30_000,
    })
    const text = res.text()
    if (res.status < 200 || res.status >= 300) {
      let message = `GitHub API ${method} ${path} failed (HTTP ${res.status})`
      try {
        const j = JSON.parse(text)
        if (j?.message) message = `${j.message} (HTTP ${res.status})`
      } catch {
        /* not JSON */
      }
      throw new GitHubCLIError(message, res.status, text)
    }
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  // ---------- project paths ----------

  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

  /** `cwd` relative to the project root (for `ctx.fs` with the `project` scope). */
  function projectRel(cwd: string, file: string): string {
    const root = ctx.project.current()?.root
    if (!root) throw new Error('No project is open')
    const r = norm(root)
    const c = norm(cwd)
    if (c.toLowerCase() === r.toLowerCase()) return file
    if (!c.toLowerCase().startsWith(r.toLowerCase() + '/')) throw new Error(`${cwd} is outside the project`)
    return `${c.slice(r.length + 1)}/${file}`
  }

  async function fileExists(cwd: string, file: string): Promise<boolean> {
    try {
      return (await ctx.fs.stat(projectRel(cwd, file), 'project')) !== null
    } catch {
      return false
    }
  }

  // ==================== Auth ====================

  /** Whether a token is stored. (Was: is the gh CLI installed.) */
  async function checkGhInstalled(): Promise<{ installed: boolean; version?: string; error?: string }> {
    return (await token()) ? { installed: true } : { installed: false, error: 'No GitHub token. Add one in Settings.' }
  }

  async function getAuthenticatedUser(): Promise<GitHubUser | null> {
    try {
      const u = await request('GET', 'user')
      return { id: u.id, login: u.login, name: u.name ?? null, avatarUrl: u.avatar_url, url: u.html_url }
    } catch {
      return null
    }
  }

  async function checkAuthStatus(): Promise<{ authenticated: boolean; user?: string; error?: string; ghInstalled?: boolean }> {
    if (!(await token())) {
      return { authenticated: false, ghInstalled: false, error: undefined }
    }
    try {
      const u = await request('GET', 'user')
      return { authenticated: true, user: u.login, ghInstalled: true }
    } catch (e) {
      const status = e instanceof GitHubCLIError ? e.exitCode : 0
      return {
        authenticated: false,
        ghInstalled: true,
        error: status === 401 ? 'The stored GitHub token is invalid or expired. Replace it in Settings.' : `Could not reach GitHub: ${errorMessage(e)}`,
      }
    }
  }

  /** Store a token (validated with `GET /user` first). Returns the login. */
  async function setToken(value: string): Promise<string> {
    const t = value.trim()
    if (!t) throw new Error('The token is empty')
    const previous = tokenCache
    tokenCache = t
    try {
      const u = await request('GET', 'user')
      await ctx.secrets.set(TOKEN_SECRET, t)
      return u.login as string
    } catch (e) {
      tokenCache = previous
      throw e
    }
  }

  async function clearToken(): Promise<void> {
    tokenCache = null
    await ctx.secrets.delete(TOKEN_SECRET)
  }

  /** The token of a signed-in GitHub CLI (`gh auth token`). */
  async function tokenFromGhCli(): Promise<string> {
    let out
    try {
      out = await ctx.shell.exec({ program: 'gh', args: ['auth', 'token'], timeoutMs: 20_000 })
    } catch (e) {
      throw new Error(`GitHub CLI (gh) is not available: ${errorMessage(e)}`)
    }
    if (out.code !== 0 || !out.stdout.trim()) {
      throw new Error(out.stderr.trim() || 'gh is not signed in. Run `gh auth login` first.')
    }
    return out.stdout.trim()
  }

  // ==================== Local Git APIs ====================

  async function getLocalGitInfo(cwd: string): Promise<LocalGitInfo> {
    try {
      await gitCommandText(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      return { isGitRepo: false }
    }

    const info: LocalGitInfo = { isGitRepo: true }
    try {
      info.currentBranch = await gitCommandText(['branch', '--show-current'], cwd)
    } catch { /* ignore */ }

    try {
      const remoteUrl = await gitCommandText(['remote', 'get-url', 'origin'], cwd)
      info.remoteUrl = remoteUrl
      const nwo = nameWithOwnerFromRemote(remoteUrl)
      if (nwo) info.nameWithOwner = nwo
    } catch { /* no remote */ }

    try {
      const status = await gitCommandText(['status', '--porcelain'], cwd)
      info.hasUncommittedChanges = status.length > 0
    } catch { /* ignore */ }

    return info
  }

  async function gitInit(cwd: string): Promise<boolean> {
    try {
      await gitCommandText(['init'], cwd)
      return true
    } catch {
      return false
    }
  }

  async function gitAddRemote(cwd: string, name: string, url: string): Promise<boolean> {
    try {
      await gitCommandText(['remote', 'add', name, url], cwd)
      return true
    } catch {
      return false
    }
  }

  const DISCOVERY_EXCLUSIONS = new Set([
    'node_modules', '.git', 'target', 'build', 'dist', '.cache',
    '__pycache__', '.next', '.venv', 'venv', '.nuxt', '.output',
    'coverage', '.turbo', '.parcel-cache', 'out',
  ])

  /**
   * Scan a project root for git repositories (root + immediate children).
   * Returns root first (if it's a repo), then child repos alphabetically.
   */
  async function discoverSubRepos(projectRoot: string): Promise<DiscoveredRepo[]> {
    const repos: DiscoveredRepo[] = []
    const sep = projectRoot.includes('\\') ? '\\' : '/'
    const rootLabel = projectRoot.split(/[/\\]/).filter(Boolean).pop() || projectRoot

    const rootInfo = await getLocalGitInfo(projectRoot)
    if (rootInfo.isGitRepo) {
      repos.push({ path: projectRoot, label: rootLabel, isRoot: true, gitInfo: rootInfo })
    }

    try {
      const entries = await ctx.fs.list(projectRel(projectRoot, '').replace(/\/$/, ''), 'project')
      const childDirs = entries
        .filter((e) => e.kind === 'dir' && !DISCOVERY_EXCLUSIONS.has(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of childDirs) {
        const childPath = `${projectRoot.replace(/[/\\]+$/, '')}${sep}${entry.name}`
        try {
          if (await fileExists(childPath, '.git')) {
            const info = await getLocalGitInfo(childPath)
            if (info.isGitRepo) repos.push({ path: childPath, label: entry.name, isRoot: false, gitInfo: info })
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    } catch {
      // Can't read directory — return what we have
    }

    return repos
  }

  // ==================== Gitignore ====================

  async function detectProjectTypes(cwd: string): Promise<ProjectType[]> {
    const types: ProjectType[] = []
    const checks: [string, ProjectType][] = [
      ['package.json', 'node'],
      ['Cargo.toml', 'rust'],
      ['requirements.txt', 'python'],
      ['setup.py', 'python'],
      ['pyproject.toml', 'python'],
      ['src-tauri/tauri.conf.json', 'tauri'],
    ]
    for (const [file, type] of checks) {
      if (!types.includes(type) && (await fileExists(cwd, file))) types.push(type)
    }
    return types
  }

  /** Write a `.gitignore` for the project type unless one exists. True if a file was written. */
  async function generateGitignore(cwd: string): Promise<boolean> {
    if (await fileExists(cwd, '.gitignore')) return false
    try {
      await ctx.fs.writeText(projectRel(cwd, '.gitignore'), gitignoreFor(await detectProjectTypes(cwd)), 'project')
      return true
    } catch {
      return false
    }
  }

  const hasGitignore = (cwd: string) => fileExists(cwd, '.gitignore')

  async function readGitignore(cwd: string): Promise<string | null> {
    try {
      return await ctx.fs.readText(projectRel(cwd, '.gitignore'), 'project')
    } catch {
      return null
    }
  }

  async function writeGitignore(cwd: string, content: string): Promise<boolean> {
    try {
      await ctx.fs.writeText(projectRel(cwd, '.gitignore'), content, 'project')
      return true
    } catch {
      return false
    }
  }

  /** Regenerate `.gitignore` from project type detection (overwrites). */
  async function regenerateGitignore(cwd: string): Promise<string | null> {
    const content = gitignoreFor(await detectProjectTypes(cwd))
    return (await writeGitignore(cwd, content)) ? content : null
  }

  // ==================== Git Status ====================

  async function getGitStatus(cwd: string): Promise<GitStatusInfo> {
    const info: GitStatusInfo = {
      branch: '', staged: 0, modified: 0, untracked: 0,
      ahead: 0, behind: 0, lastCommitTime: null, lastPushTime: null,
      hasRemote: false, hasUpstream: false, isGitRepo: false,
    }
    try {
      await gitCommandText(['rev-parse', '--is-inside-work-tree'], cwd)
    } catch {
      return info
    }
    info.isGitRepo = true

    try {
      info.branch = await gitCommandText(['branch', '--show-current'], cwd)
    } catch { /* detached HEAD */ }

    try {
      const porcelain = await gitCommandText(['status', '--porcelain'], cwd)
      Object.assign(info, parseStatusPorcelain(porcelain))
    } catch { /* ignore */ }

    try {
      await gitCommandText(['remote', 'get-url', 'origin'], cwd)
      info.hasRemote = true
    } catch {
      info.hasRemote = false
    }

    if (info.hasRemote && info.branch) {
      try {
        await gitCommandText(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd)
        info.hasUpstream = true
      } catch {
        info.hasUpstream = false
      }
    }

    if (info.hasUpstream && info.branch) {
      try {
        const revList = await gitCommandText(['rev-list', '--left-right', '--count', `origin/${info.branch}...HEAD`], cwd)
        const parts = revList.trim().split(/\s+/)
        if (parts.length === 2) {
          info.behind = parseInt(parts[0]) || 0
          info.ahead = parseInt(parts[1]) || 0
        }
      } catch { /* ignore */ }
    }

    try {
      info.lastCommitTime = (await gitCommandText(['log', '-1', '--format=%aI'], cwd)) || null
    } catch { /* no commits */ }

    if (info.hasRemote && info.branch) {
      try {
        info.lastPushTime = (await gitCommandText(['log', '-1', '--format=%aI', `origin/${info.branch}`], cwd)) || null
      } catch { /* never pushed */ }
    }

    return info
  }

  async function gitStageAll(cwd: string): Promise<void> {
    await gitCommandText(['add', '--all', '--ignore-errors'], cwd)
  }

  async function gitCommit(cwd: string, message: string): Promise<string> {
    return await gitCommandText(['commit', '-m', message], cwd)
  }

  /** Run a prompt non-interactively with the user's agent provider (API 1.4 `agents.oneShot`). */
  async function oneShot(prompt: string, cwd: string): Promise<string> {
    return ctx.agents.oneShot({ prompt, cwd })
  }

  /** Generate a commit message for the staged changes. */
  async function generateCommitMessage(cwd: string): Promise<string> {
    const diff = await gitCommandText(['diff', '--cached', '--stat'], cwd)
    if (!diff.trim()) {
      throw new GitHubCLIError('No staged changes to describe. Stage some files first.', 1, '')
    }

    let patch = ''
    try {
      patch = await gitCommandText(['diff', '--cached', '--no-color', '-U2'], cwd)
      if (patch.length > 8000) patch = patch.substring(0, 8000) + '\n... (truncated)'
    } catch { /* stat-only fallback is fine */ }

    const prompt = `Write a single-line git commit message (no quotes, no prefix like "feat:" unless obvious, max 72 chars) for these staged changes. Reply with ONLY the commit message, nothing else.\n\n${diff}\n\n${patch}`

    let message: string
    try {
      message = (await oneShot(prompt, cwd)).trim()
    } catch (err) {
      const errorMsg = errorMessage(err)
      throw new GitHubCLIError(`Failed to generate a commit message: ${errorMsg}`, 1, errorMsg)
    }
    message = message.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim()
    if (!message) throw new GitHubCLIError('The agent returned an empty commit message', 1, '')
    return message
  }

  /** Push to remote. If no upstream is set, pushes with -u to set tracking. */
  async function gitPush(cwd: string, branch?: string): Promise<string> {
    if (branch) return await gitCommandText(['push', '-u', 'origin', branch], cwd)
    return await gitCommandText(['push'], cwd)
  }

  async function gitFetch(cwd: string): Promise<void> {
    await gitCommandText(['fetch', '--quiet'], cwd)
  }

  // ==================== Repository APIs ====================

  async function listUserRepositories(limit: number = 100): Promise<GitHubRepository[]> {
    try {
      const repos = await request<Raw[]>('GET', `user/repos?per_page=${Math.min(limit, 100)}&sort=updated`)
      return repos.map(mapRepo)
    } catch {
      return []
    }
  }

  async function getRepository(nameWithOwner: string): Promise<GitHubRepository | null> {
    try {
      return mapRepo(await request('GET', `repos/${enc(nameWithOwner)}`))
    } catch {
      return null
    }
  }

  // ==================== Issues APIs ====================

  async function listRepositoryIssues(nameWithOwner: string, options?: { state?: 'open' | 'closed' | 'all'; limit?: number }): Promise<GitHubIssue[]> {
    try {
      const state = options?.state ?? 'all'
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/issues?state=${state}&per_page=${Math.min(options?.limit || 100, 100)}`)
      return items.filter((i) => !i.pull_request).map(mapIssue)
    } catch {
      return []
    }
  }

  async function getIssue(nameWithOwner: string, issueNumber: number): Promise<GitHubIssue | null> {
    try {
      return mapIssue(await request('GET', `repos/${enc(nameWithOwner)}/issues/${issueNumber}`))
    } catch {
      return null
    }
  }

  async function createIssue(nameWithOwner: string, data: { title: string; body?: string; labels?: string[] }): Promise<GitHubIssue | null> {
    try {
      const body: Record<string, unknown> = { title: data.title }
      if (data.body) body.body = data.body
      if (data.labels?.length) body.labels = data.labels
      return mapIssue(await request('POST', `repos/${enc(nameWithOwner)}/issues`, body))
    } catch (e) {
      ctx.log.warn('createIssue failed', e)
      return null
    }
  }

  async function updateIssue(nameWithOwner: string, issueNumber: number, data: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<GitHubIssue | null> {
    try {
      const body: Record<string, unknown> = {}
      if (data.title) body.title = data.title
      if (data.body !== undefined) body.body = data.body
      if (data.state) body.state = data.state
      return mapIssue(await request('PATCH', `repos/${enc(nameWithOwner)}/issues/${issueNumber}`, body))
    } catch (e) {
      ctx.log.warn('updateIssue failed', e)
      return null
    }
  }

  async function addLabelsToIssue(nameWithOwner: string, issueNumber: number, labels: string[]): Promise<boolean> {
    try {
      await request('POST', `repos/${enc(nameWithOwner)}/issues/${issueNumber}/labels`, { labels })
      return true
    } catch {
      return false
    }
  }

  async function listIssueComments(nameWithOwner: string, issueNumber: number): Promise<GitHubComment[]> {
    try {
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/issues/${issueNumber}/comments?per_page=100`)
      return items.map(mapComment)
    } catch {
      return []
    }
  }

  async function createIssueComment(nameWithOwner: string, issueNumber: number, body: string): Promise<GitHubComment | null> {
    try {
      return mapComment(await request('POST', `repos/${enc(nameWithOwner)}/issues/${issueNumber}/comments`, { body }))
    } catch {
      return null
    }
  }

  // ==================== Labels APIs ====================

  async function listRepositoryLabels(nameWithOwner: string): Promise<Array<{ name: string; color: string; description: string }>> {
    try {
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/labels?per_page=100`)
      return items.map((l) => ({ name: l.name, color: l.color, description: l.description ?? '' }))
    } catch {
      return []
    }
  }

  async function createLabel(nameWithOwner: string, data: { name: string; color: string; description?: string }): Promise<boolean> {
    try {
      await request('POST', `repos/${enc(nameWithOwner)}/labels`, {
        name: data.name,
        color: data.color.replace('#', ''),
        ...(data.description ? { description: data.description } : {}),
      })
      return true
    } catch {
      return false
    }
  }

  // ==================== Branch APIs ====================

  async function listBranches(nameWithOwner: string): Promise<GitHubBranch[]> {
    try {
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/branches?per_page=100`)
      return items.map((b) => ({ name: b.name, protected: !!b.protected, sha: b.commit?.sha ?? '' }))
    } catch {
      return []
    }
  }

  /** Create a branch from another branch (default: the repository's default branch). */
  async function createBranch(nameWithOwner: string, branchName: string, fromBranch?: string): Promise<boolean> {
    try {
      let source = fromBranch
      if (!source) source = (await getRepository(nameWithOwner))?.defaultBranchRef?.name || 'main'
      const ref = await request('GET', `repos/${enc(nameWithOwner)}/git/ref/heads/${enc(source)}`)
      await request('POST', `repos/${enc(nameWithOwner)}/git/refs`, { ref: `refs/heads/${branchName}`, sha: ref.object.sha })
      return true
    } catch {
      return false
    }
  }

  async function deleteBranch(nameWithOwner: string, branchName: string): Promise<boolean> {
    try {
      await request('DELETE', `repos/${enc(nameWithOwner)}/git/refs/heads/${enc(branchName)}`)
      return true
    } catch {
      return false
    }
  }

  // ==================== Pull Request APIs ====================

  async function listPullRequests(nameWithOwner: string, state: string = 'open'): Promise<GitHubPullRequest[]> {
    try {
      const s = state.toLowerCase()
      const apiState = s === 'merged' ? 'closed' : s === 'all' || s === 'closed' ? s : 'open'
      const items = (await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/pulls?state=${apiState}&per_page=100`)).map(mapPull)
      if (s === 'merged') return items.filter((p) => p.state === 'MERGED')
      if (s === 'closed') return items.filter((p) => p.state === 'CLOSED')
      return items
    } catch {
      return []
    }
  }

  async function getPullRequest(nameWithOwner: string, number: number): Promise<GitHubPullRequest | null> {
    try {
      return mapPull(await request('GET', `repos/${enc(nameWithOwner)}/pulls/${number}`))
    } catch {
      return null
    }
  }

  async function createPullRequest(nameWithOwner: string, data: { title: string; body?: string; head: string; base?: string; draft?: boolean }): Promise<string | null> {
    try {
      const base = data.base || (await getRepository(nameWithOwner))?.defaultBranchRef?.name || 'main'
      const pr = await request('POST', `repos/${enc(nameWithOwner)}/pulls`, {
        title: data.title,
        head: data.head,
        base,
        ...(data.body ? { body: data.body } : {}),
        ...(data.draft ? { draft: true } : {}),
      })
      return pr.html_url ?? null
    } catch {
      return null
    }
  }

  async function mergePullRequest(nameWithOwner: string, number: number, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<boolean> {
    try {
      await request('PUT', `repos/${enc(nameWithOwner)}/pulls/${number}/merge`, { merge_method: method })
      return true
    } catch {
      return false
    }
  }

  async function closePullRequest(nameWithOwner: string, number: number): Promise<boolean> {
    try {
      await request('PATCH', `repos/${enc(nameWithOwner)}/pulls/${number}`, { state: 'closed' })
      return true
    } catch {
      return false
    }
  }

  async function addPRComment(nameWithOwner: string, number: number, body: string): Promise<boolean> {
    try {
      await request('POST', `repos/${enc(nameWithOwner)}/issues/${number}/comments`, { body })
      return true
    } catch {
      return false
    }
  }

  // ==================== Commit APIs ====================

  async function listCommits(nameWithOwner: string, branch?: string, limit: number = 30): Promise<GitHubCommit[]> {
    try {
      const params = [`per_page=${Math.min(limit, 100)}`]
      if (branch) params.push(`sha=${encodeURIComponent(branch)}`)
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/commits?${params.join('&')}`)
      return items.map(mapCommit)
    } catch {
      return []
    }
  }

  async function getCommit(nameWithOwner: string, sha: string): Promise<GitHubCommitDetail | null> {
    try {
      const c = await request('GET', `repos/${enc(nameWithOwner)}/commits/${encodeURIComponent(sha)}`)
      return {
        ...mapCommit(c),
        stats: c.stats,
        files: (c.files ?? []).map((f: Raw) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      }
    } catch {
      return null
    }
  }

  async function compareBranches(nameWithOwner: string, base: string, head: string): Promise<GitHubComparison | null> {
    try {
      const c = await request('GET', `repos/${enc(nameWithOwner)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
      return { status: c.status, aheadBy: c.ahead_by, behindBy: c.behind_by, totalCommits: c.total_commits, commits: (c.commits ?? []).map(mapCommit) }
    } catch {
      return null
    }
  }

  // ==================== Release APIs ====================

  async function listReleases(nameWithOwner: string, limit: number = 30): Promise<GitHubRelease[]> {
    try {
      const items = await request<Raw[]>('GET', `repos/${enc(nameWithOwner)}/releases?per_page=${Math.min(limit, 100)}`)
      return items.map(mapRelease)
    } catch {
      return []
    }
  }

  async function createRelease(nameWithOwner: string, data: { tag: string; title?: string; notes?: string; draft?: boolean; prerelease?: boolean }): Promise<string | null> {
    try {
      const r = await request('POST', `repos/${enc(nameWithOwner)}/releases`, {
        tag_name: data.tag,
        ...(data.title ? { name: data.title } : {}),
        ...(data.notes ? { body: data.notes } : {}),
        draft: !!data.draft,
        prerelease: !!data.prerelease,
      })
      return r.html_url ?? null
    } catch {
      return null
    }
  }

  async function getLatestRelease(nameWithOwner: string): Promise<GitHubRelease | null> {
    try {
      return mapRelease(await request('GET', `repos/${enc(nameWithOwner)}/releases/latest`))
    } catch {
      return null
    }
  }

  // ==================== Repository Management APIs ====================

  /**
   * Create a GitHub repository for the project directory: create it through the API
   * (`name` or `org/name`), init git locally if needed, add it as `origin`, optionally push.
   */
  async function createRepositoryFromProject(cwd: string, name: string, options?: { description?: string; isPrivate?: boolean; push?: boolean }): Promise<string | null> {
    try {
      const gitInfo = await getLocalGitInfo(cwd)
      if (!gitInfo.isGitRepo) {
        if (!(await gitInit(cwd))) return null
        await generateGitignore(cwd)
        try {
          await gitCommandText(['add', '.'], cwd)
          await gitCommandText(['commit', '-m', 'Initial commit'], cwd)
        } catch { /* may fail if empty, that's ok */ }
      }

      const [org, repoName] = name.includes('/') ? name.split('/', 2) : [null, name]
      const body = { name: repoName, private: !!options?.isPrivate, ...(options?.description ? { description: options.description } : {}) }
      const repo = await request('POST', org ? `orgs/${encodeURIComponent(org)}/repos` : 'user/repos', body)

      const cloneUrl: string = repo.clone_url
      if (!(await gitAddRemote(cwd, 'origin', cloneUrl))) {
        await gitCommandText(['remote', 'set-url', 'origin', cloneUrl], cwd)
      }
      if (options?.push) {
        try {
          await gitCommandText(['push', '-u', 'origin', 'HEAD'], cwd)
        } catch (e) {
          ctx.notifications.toast({ kind: 'warning', title: 'Repository created, but the push failed', body: errorMessage(e) })
        }
      }
      return repo.html_url ?? null
    } catch (e) {
      ctx.log.warn('createRepositoryFromProject failed', e)
      return null
    }
  }

  async function deleteRepository(nameWithOwner: string): Promise<boolean> {
    try {
      await request('DELETE', `repos/${enc(nameWithOwner)}`)
      return true
    } catch {
      return false
    }
  }

  // ==================== Checkpoint APIs ====================

  const getHeadSha = (cwd: string) => gitCommandText(['rev-parse', 'HEAD'], cwd)

  async function getChangedFileCount(cwd: string): Promise<number> {
    const output = await gitCommandText(['status', '--porcelain'], cwd)
    if (!output.trim()) return 0
    return output.trim().split('\n').length
  }

  /** Auto-commit all changes for a checkpoint. True if a commit was made. */
  async function autoCommitForCheckpoint(cwd: string, name: string): Promise<boolean> {
    const changedCount = await getChangedFileCount(cwd)
    if (changedCount === 0) return false
    await gitCommandText(['add', '--all'], cwd)
    await gitCommandText(['commit', '-m', `[QuadFlow Checkpoint] ${name}`], cwd)
    return true
  }

  async function createCheckpointTag(cwd: string, tagName: string, message: string): Promise<void> {
    await gitCommandText(['tag', '-a', tagName, '-m', message], cwd)
  }

  async function deleteCheckpointTag(cwd: string, tagName: string): Promise<void> {
    await gitCommandText(['tag', '-d', tagName], cwd)
  }

  const getTagCommitSha = (cwd: string, tagName: string) => gitCommandText(['rev-list', '-n', '1', tagName], cwd)

  async function checkpointTagExists(cwd: string, tagName: string): Promise<boolean> {
    try {
      await gitCommandText(['rev-parse', '--verify', `refs/tags/${tagName}`], cwd)
      return true
    } catch {
      return false
    }
  }

  async function getCheckpointDiff(cwd: string, tagName: string): Promise<CheckpointDiffSummary> {
    try {
      return parseNumstat(await gitCommandText(['diff', '--numstat', tagName, 'HEAD'], cwd))
    } catch {
      return { filesChanged: 0, additions: 0, deletions: 0, files: [] }
    }
  }

  async function restoreToCheckpoint(cwd: string, tagName: string): Promise<void> {
    await gitCommandText(['reset', '--hard', tagName], cwd)
  }

  const getCurrentBranch = (cwd: string) => gitCommandText(['branch', '--show-current'], cwd)

  return {
    // auth
    checkGhInstalled, checkAuthStatus, getAuthenticatedUser, setToken, clearToken, tokenFromGhCli,
    // local git
    getLocalGitInfo, gitInit, gitAddRemote, discoverSubRepos,
    detectProjectTypes, generateGitignore, hasGitignore, readGitignore, writeGitignore, regenerateGitignore,
    getGitStatus, gitStageAll, gitCommit, generateCommitMessage, gitPush, gitFetch,
    // repos
    listUserRepositories, getRepository, createRepositoryFromProject, deleteRepository,
    // issues
    listRepositoryIssues, getIssue, createIssue, updateIssue, addLabelsToIssue, listIssueComments, createIssueComment,
    listRepositoryLabels, createLabel,
    // branches / PRs / commits / releases
    listBranches, createBranch, deleteBranch,
    listPullRequests, getPullRequest, createPullRequest, mergePullRequest, closePullRequest, addPRComment,
    listCommits, getCommit, compareBranches,
    listReleases, createRelease, getLatestRelease,
    // checkpoints
    sanitizeCheckpointName, buildCheckpointTagName, getHeadSha, getChangedFileCount, autoCommitForCheckpoint,
    createCheckpointTag, deleteCheckpointTag, getTagCommitSha, checkpointTagExists, getCheckpointDiff,
    restoreToCheckpoint, getCurrentBranch,
  }
}
