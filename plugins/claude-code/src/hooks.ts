/**
 * Procedural provider hooks (agent-providers.md §4.2, §9): context usage,
 * session titles, worktree preparation. `usage` lives in ./usage.ts.
 */
import { HostError, type AgentContextUsage, type AgentProviderImpl, type AgentSessionInfo, type AgentWorktreeScope, type PluginContext } from '@quadflow/plugin-api'
import { CONTEXT_FILE, PROVIDER_ID, SETTINGS_FILE, homeRelative, readTextOrNull, relativeTo } from './paths'
import { estimateContextTokens, tailText, titleFromIndex, titleFromSession } from './session'
import { fetchUsage } from './usage'

/** Bytes of a session file read for the context meter (§9: last 256 KiB). */
const CONTEXT_TAIL_BYTES = 256 * 1024
/** Session files larger than this are not scanned for titles. */
const TITLE_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_CONTEXT_WINDOW = 200_000

const contextCache = new Map<string, { size: number; modifiedAt: number; usage: AgentContextUsage | null }>()

async function contextWindowOf(ctx: PluginContext, model: string | null): Promise<number> {
  const models = await ctx.agents.models(PROVIDER_ID).catch(() => [])
  const exact = model ? models.find((m) => m.id === model) : undefined
  const def = models.find((m) => m.isDefault && m.contextWindow) ?? models.find((m) => m.source === 'catalog' && m.contextWindow)
  return exact?.contextWindow ?? (/\[1m\]$/.test(model ?? '') ? 1_000_000 : def?.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
}

async function contextUsage(
  ctx: PluginContext,
  s: { sessionId: string; sessionPath: string; model: string | null },
): Promise<AgentContextUsage | null> {
  const rel = homeRelative(s.sessionPath)
  if (!rel) return null
  const st = await ctx.fs.stat(rel, 'home')
  if (!st || st.kind !== 'file') return null
  const cached = contextCache.get(rel)
  if (cached && cached.size === st.size && cached.modifiedAt === st.modifiedAt) return cached.usage
  // The host has no ranged read: read the file and keep the tail (§9: after
  // the last compact boundary within the last 256 KiB).
  const text = tailText(await ctx.fs.readBytes(rel, 'home'), CONTEXT_TAIL_BYTES)
  const est = estimateContextTokens(text)
  const usage = est ? { usedTokens: est.tokens, limitTokens: await contextWindowOf(ctx, s.model), estimated: est.estimated } : null
  contextCache.set(rel, { size: st.size, modifiedAt: st.modifiedAt, usage })
  return usage
}

async function sessionTitle(ctx: PluginContext, s: AgentSessionInfo): Promise<string | null> {
  const rel = homeRelative(s.path)
  if (!rel) return null
  const dir = rel.slice(0, rel.lastIndexOf('/'))
  const index = await readTextOrNull(ctx, `${dir}/sessions-index.json`, 'home').catch(() => null)
  const fromIndex = index ? titleFromIndex(index, s.id) : null
  if (fromIndex) return fromIndex
  const st = await ctx.fs.stat(rel, 'home').catch(() => null)
  if (!st || st.kind !== 'file' || st.size > TITLE_MAX_BYTES) return null
  return titleFromSession(await ctx.fs.readText(rel, 'home'))
}

// ---- prepareWorktree ----

const HOOK_SCRIPT = '.claude/hooks/quadflow-scope.cjs'
const SCOPE_FILE = '.claude/hooks/quadflow-scope.json'
const REGION_START = '<!-- quadflow:context:start — managed by QuadFlow, do not edit -->'
const REGION_END = '<!-- quadflow:context:end -->'

/** PreToolUse hook: blocks writes outside `allowedPaths`, inside `readOnlyPaths`, or any write by a coordinator. */
export const SCOPE_HOOK_SOURCE = `#!/usr/bin/env node
// QuadFlow scope guard for Claude Code (PreToolUse). Written by the claude-code
// plugin when a Missions agent is launched in this worktree. Reads
// .claude/hooks/quadflow-scope.json; blocks Write/Edit/MultiEdit/NotebookEdit
// outside the allowed paths. Read-only tools are never blocked.
'use strict';
const fs = require('fs');
const path = require('path');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const root = path.resolve(__dirname, '..', '..');
const norm = (p) => path.resolve(root, p).replace(/\\\\/g, '/').replace(/\\/+$/, '');
const block = (reason) => { process.stdout.write(JSON.stringify({ decision: 'block', reason })); process.exit(0); };
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input, scope;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!WRITE_TOOLS.has(input.tool_name)) process.exit(0);
  try { scope = JSON.parse(fs.readFileSync(path.join(__dirname, 'quadflow-scope.json'), 'utf8')); } catch { process.exit(0); }
  if (scope.coordinator) {
    block('You are the mission COORDINATOR and cannot write files. Assign the change to a worker: ' +
      'quadflow missions send <mission> "<files + change>" --to <member> --kind assignment');
  }
  const t = input.tool_input || {};
  const file = t.file_path || t.notebook_path || t.path || null;
  if (!file) process.exit(0);
  const target = norm(file);
  const inside = (list) => (list || []).some((p) => { const a = norm(p); return target === a || target.startsWith(a + '/'); });
  if (inside(scope.readOnlyPaths)) block('"' + file + '" is read-only for this agent.');
  if ((scope.allowedPaths || []).length && !inside(scope.allowedPaths)) {
    block('"' + file + '" is outside your assigned scope:\\n' + scope.allowedPaths.map((p) => '  - ' + p).join('\\n') +
      '\\nAsk the coordinator to widen it: quadflow missions send <mission> "Need scope: <file>" --kind help_request');
  }
  process.exit(0);
});
`

function mergeHookSettings(existing: string | null): string {
  let json: Record<string, unknown> = {}
  if (existing) {
    try {
      json = JSON.parse(existing) as Record<string, unknown>
    } catch {
      throw new HostError('corrupt', `${SETTINGS_FILE} in the worktree is not valid JSON`)
    }
  }
  const command = `node ${HOOK_SCRIPT}`
  const hooks = (json.hooks ?? {}) as Record<string, unknown>
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : []
  const present = pre.some((h) => JSON.stringify(h).includes(HOOK_SCRIPT))
  if (!present) {
    pre.push({ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] })
  }
  json.hooks = { ...hooks, PreToolUse: pre }
  const perms = (json.permissions ?? {}) as Record<string, unknown>
  const allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : []
  if (!allow.includes('Bash(quadflow:*)')) allow.push('Bash(quadflow:*)')
  json.permissions = { ...perms, allow }
  return `${JSON.stringify(json, null, 2)}\n`
}

/** Put `markdown` inside the managed region of `existing` (created when missing). */
export function withRegionContent(existing: string | null, markdown: string): string {
  const body = markdown.trim()
  const region = `${REGION_START}\n${body}\n${REGION_END}\n`
  if (!existing) return region
  const s = existing.indexOf(REGION_START)
  const e = existing.indexOf(REGION_END)
  if (s >= 0 && e > s) {
    const inner = existing.slice(s + REGION_START.length, e).trim()
    if (inner.includes(body)) return existing
    const merged = inner ? `${inner}\n\n${body}` : body
    return `${existing.slice(0, s)}${REGION_START}\n${merged}\n${REGION_END}${existing.slice(e + REGION_END.length)}`
  }
  return `${existing.replace(/\s*$/, '\n\n')}${region}`
}

async function prepareWorktree(
  ctx: PluginContext,
  w: { worktreePath: string; scope: AgentWorktreeScope; contextMarkdown: string },
): Promise<void> {
  const project = ctx.project.current()
  const base = project ? relativeTo(project.root, w.worktreePath) : null
  if (base === null) {
    throw new HostError('unsupported', `worktree ${w.worktreePath} is not inside the active project`)
  }
  const at = (p: string) => (base ? `${base}/${p}` : p)
  await ctx.fs.writeText(at(HOOK_SCRIPT), SCOPE_HOOK_SOURCE)
  const scope = { allowedPaths: w.scope.allowedPaths, readOnlyPaths: w.scope.readOnlyPaths, coordinator: w.scope.coordinator }
  await ctx.fs.writeText(at(SCOPE_FILE), `${JSON.stringify(scope, null, 2)}\n`)
  await ctx.fs.writeText(at(SETTINGS_FILE), mergeHookSettings(await readTextOrNull(ctx, at(SETTINGS_FILE), 'project')))
  if (w.contextMarkdown.trim()) {
    await ctx.fs.writeText(at(CONTEXT_FILE), withRegionContent(await readTextOrNull(ctx, at(CONTEXT_FILE), 'project'), w.contextMarkdown))
  }
}

export const agentProvider: AgentProviderImpl = {
  usage: fetchUsage,
  contextUsage,
  sessionTitle,
  prepareWorktree,
}
