/**
 * React context for the Plans tile's sub-views (spec editor, decomposition,
 * promotion, comments): the plugin context and its model, plus the helpers
 * every view needs (launch a skill, cross-domain lookups for the badges and
 * the coordination view).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Issue_Serialize, PluginContext } from '@quadflow/plugin-api'
import { launchAgent } from '@quadflow/plugin-kit'
import { plansModel, type PlansModel } from './model'

interface PlansEnv {
  ctx: PluginContext
  model: PlansModel
}

const Env = createContext<PlansEnv | null>(null)

export function PlansProvider({ ctx, children }: { ctx: PluginContext; children: ReactNode }) {
  return <Env.Provider value={{ ctx, model: plansModel(ctx) }}>{children}</Env.Provider>
}

export function usePlans(): PlansEnv {
  const v = useContext(Env)
  if (!v) throw new Error('usePlans outside PlansProvider')
  return v
}

/** Run a bundled slash-command skill in a new agent session (Claude Code preferred). */
export async function runSkill(ctx: PluginContext, command: string): Promise<void> {
  await launchAgent(ctx, command, { preferred: 'claude-code', autoSubmit: true })
}

/**
 * Re-run `load` for the current project on mount, on `version` changes (the
 * collection's `relatedVersion`, bumped by issue / idea events) and when the
 * project switches. Failures resolve to `fallback`.
 */
function useProjectQuery<T>(ctx: PluginContext, version: number, fallback: T, load: (root: string) => Promise<T>, enabled = true): T {
  const [value, setValue] = useState<T>(fallback)
  const [projectNonce, setProjectNonce] = useState(0)
  useEffect(() => ctx.project.onDidChange(() => setProjectNonce((n) => n + 1)), [ctx])
  useEffect(() => {
    const root = ctx.project.current()?.root
    if (!root || !enabled) {
      setValue(fallback)
      return
    }
    let cancelled = false
    load(root).then(
      (v) => !cancelled && setValue(v),
      (e) => {
        ctx.log.warn('plans: lookup failed', e)
        if (!cancelled) setValue(fallback)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, version, projectNonce, enabled])
  return value
}

const EMPTY_IDS = new Set<string>()

/** Ids of the project's ideas, for the "Linked idea" badge (`data:ideas:read`). */
export function useIdeaIds(ctx: PluginContext, version: number): Set<string> {
  return useProjectQuery(ctx, version, EMPTY_IDS, async (root) => {
    const r = await ctx.data.ideas.list({ includeArchived: true }, { projectRoot: root })
    return new Set(r.items.map((i) => i.id))
  })
}

const EMPTY_ISSUES = new Map<string, Issue_Serialize>()

/** The project's issues by id, for the coordination view (`data:issues:read`). */
export function useIssuesById(ctx: PluginContext, version: number, enabled: boolean): Map<string, Issue_Serialize> {
  return useProjectQuery(
    ctx,
    version,
    EMPTY_ISSUES,
    async (root) => {
      const r = await ctx.data.issues.list({ includeDone: true }, { projectRoot: root })
      return new Map(r.items.map((i) => [i.id, i]))
    },
    enabled,
  )
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000

/** An agent claimed the issue but has not sent a heartbeat for 5 minutes. */
export function isAgentStale(issue: Issue_Serialize, now = Date.now()): boolean {
  const a = issue.assignment
  if (!a?.terminalId || !a.lastHeartbeat) return false
  return now - a.lastHeartbeat > STALE_THRESHOLD_MS
}

/** Re-render once a minute so stale-agent indicators update. */
export function useMinuteTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [active])
  return now
}
