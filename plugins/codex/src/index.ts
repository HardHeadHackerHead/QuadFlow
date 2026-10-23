/**
 * `codex` — first-party agent provider for the OpenAI Codex CLI
 * (agent-providers.md §10).
 *
 * Launch, resume, approval modes, session discovery and the AGENTS.md managed
 * region are declarative (`contributes.agentProvider` in quadflow-plugin.json,
 * interpreted by the core). This module only implements the procedural hooks:
 *  - `usage`           account rate-limit windows from the newest rollout's `token_count` event
 *  - `contextUsage`    context-window usage of one session's rollout file
 *  - `prepareWorktree` scope rules + mission context in the worktree's AGENTS.md
 *                      (advisory: Codex has no hook mechanism to enforce them)
 */
import { definePlugin, type FsEntry, type PluginContext } from '@quadflow/plugin-api'
import {
  applyWorktreeRegion,
  contextUsageFromRollout,
  homeRelativeSessionPath,
  relativeToRoot,
  renderWorktreeRegion,
  usageFromRollout,
  type CodexContextUsage,
  type CodexUsageSnapshot,
  type CodexWorktreeScope,
} from './rollout'

/** Rollout files grow to megabytes; token/rate-limit events are near the end. */
const TAIL_BYTES = 256 * 1024
/** Newest rollout files searched for rate-limit data. */
const USAGE_FILES = 5
const SESSIONS_DIR = '.codex/sessions'

async function readTail(ctx: PluginContext, homeRel: string): Promise<string> {
  const bytes = await ctx.fs.readBytes(homeRel, 'home')
  const tail = bytes.length > TAIL_BYTES ? bytes.subarray(bytes.length - TAIL_BYTES) : bytes
  return new TextDecoder().decode(tail)
}

const byNameDesc = (a: FsEntry, b: FsEntry) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)

/** Newest rollout files (home-relative), walking `YYYY/MM/DD` newest first. */
async function newestRollouts(ctx: PluginContext, limit: number): Promise<string[]> {
  const out: { path: string; modifiedAt: number }[] = []
  const dirs = async (rel: string) =>
    (await ctx.fs.list(rel, 'home')).filter((e) => e.kind === 'dir' && /^\d+$/.test(e.name)).sort(byNameDesc)
  for (const y of await dirs(SESSIONS_DIR)) {
    for (const m of await dirs(`${SESSIONS_DIR}/${y.name}`)) {
      for (const d of await dirs(`${SESSIONS_DIR}/${y.name}/${m.name}`)) {
        const dayRel = `${SESSIONS_DIR}/${y.name}/${m.name}/${d.name}`
        for (const f of await ctx.fs.list(dayRel, 'home')) {
          if (f.kind === 'file' && /^rollout-.*\.jsonl$/.test(f.name)) out.push({ path: `${dayRel}/${f.name}`, modifiedAt: f.modifiedAt })
        }
        if (out.length >= limit) return pick(out, limit)
      }
    }
  }
  return pick(out, limit)
}

const pick = (files: { path: string; modifiedAt: number }[], limit: number) =>
  files
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, limit)
    .map((f) => f.path)

async function usage(ctx: PluginContext): Promise<CodexUsageSnapshot | null> {
  if ((await ctx.fs.stat(SESSIONS_DIR, 'home')) === null) return null
  for (const path of await newestRollouts(ctx, USAGE_FILES)) {
    const snap = usageFromRollout(await readTail(ctx, path), Date.now())
    if (snap) return snap
  }
  return null
}

async function contextUsage(
  ctx: PluginContext,
  s: { sessionId: string; sessionPath: string; model: string | null },
): Promise<CodexContextUsage | null> {
  const rel = homeRelativeSessionPath(s.sessionPath)
  if (rel === null) {
    ctx.log.debug('contextUsage: session file is not under ~/.codex:', s.sessionPath)
    return null
  }
  return contextUsageFromRollout(await readTail(ctx, rel))
}

async function prepareWorktree(
  ctx: PluginContext,
  w: { worktreePath: string; scope: CodexWorktreeScope; contextMarkdown: string },
): Promise<void> {
  const project = ctx.project.current()
  const rel = project ? relativeToRoot(project.root, w.worktreePath) : null
  // Inside the project: `fs:write:project`. Elsewhere the host requires `fs:write:any`
  // (not requested) unless the path was picked by the user, and rejects the write.
  const [path, scope] = rel === null ? [`${w.worktreePath.replace(/[\\/]+$/, '')}/AGENTS.md`, 'absolute' as const] : [rel ? `${rel}/AGENTS.md` : 'AGENTS.md', 'project' as const]
  const current = (await ctx.fs.stat(path, scope)) ? await ctx.fs.readText(path, scope) : ''
  const next = applyWorktreeRegion(current, renderWorktreeRegion(w.scope, w.contextMarkdown))
  if (next !== current) await ctx.fs.writeText(path, next, scope)
}

export default definePlugin({
  agentProvider: { usage, contextUsage, prepareWorktree },
})
