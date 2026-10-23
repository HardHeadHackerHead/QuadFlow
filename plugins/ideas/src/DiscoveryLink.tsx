/**
 * Link an idea to a discovery project (the "Projects" tool, plugins/discovery).
 * Reads the project list with `ctx.data.discovery.list` (`data:discovery:read`);
 * the link itself is `ideas.update({ discoveryId })`. Both tools see the change
 * through `data.onDidChange`.
 */
import { useEffect, useState } from 'react'
import type { PluginContext } from '@quadflow/plugin-api'
import type { Idea } from './model'

export function DiscoveryLink({ ctx, idea, onChange }: { ctx: PluginContext; idea: Idea; onChange: (id: string | null) => void }) {
  const [projects, setProjects] = useState<{ id: string; title: string }[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      ctx.data.discovery
        .list({})
        .then((r) => !cancelled && setProjects(r.items.map((p) => ({ id: p.id, title: p.title }))))
        .catch(() => !cancelled && setProjects([]))
    void load()
    const off = ctx.data.onDidChange({ domain: 'discovery', projectRoot: ctx.project.current()?.root }, () => void load())
    return () => {
      cancelled = true
      off()
    }
  }, [ctx])

  if (!projects || (projects.length === 0 && !idea.discoveryId)) return null
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-vibe-muted font-medium">Project</span>
      <select
        value={idea.discoveryId ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="max-w-[16rem] px-2 py-0.5 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text"
      >
        <option value="">— none —</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
        {idea.discoveryId && !projects.some((p) => p.id === idea.discoveryId) && (
          <option value={idea.discoveryId}>(missing project)</option>
        )}
      </select>
    </div>
  )
}
