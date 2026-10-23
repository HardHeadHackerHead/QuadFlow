/**
 * The Projects (discovery) plugin's state: one live collection of discovery
 * projects per plugin context, plus mutations through `ctx.data.discovery.*`.
 * Idea / plan changes bump `relatedVersion` so the Linked tab refetches.
 */
import { create } from 'zustand'
import type {
  DiscoveryItem_Serialize,
  DiscoveryItemKind,
  DiscoveryItemPatch_Deserialize,
  DiscoveryPatch_Deserialize,
  DiscoveryProject_Serialize,
  DiscoveryStatus,
  PluginContext,
} from '@quadflow/plugin-api'
import { createCollection, type Collection } from '@quadflow/plugin-kit'

export type DiscoveryItem = DiscoveryItem_Serialize
/** `DiscoveryProject` as sent by the core, with empty (omitted) lists filled in. */
export type DiscoveryProject = DiscoveryProject_Serialize & {
  goals: string[]
  successCriteria: string[]
  items: DiscoveryItem[]
}
export type DiscoveryPatch = DiscoveryPatch_Deserialize
export type DiscoveryItemPatch = DiscoveryItemPatch_Deserialize
export type { DiscoveryItemKind, DiscoveryStatus }

export const normalizeProject = (p: DiscoveryProject_Serialize): DiscoveryProject => ({
  ...p,
  goals: p.goals ?? [],
  successCriteria: p.successCriteria ?? [],
  items: [...(p.items ?? [])].sort((a, b) => a.order - b.order),
})

export interface DiscoveryModel {
  projects: Collection<DiscoveryProject>
  ui: ReturnType<typeof createUiStore>
  create(title: string, overview?: string): Promise<DiscoveryProject>
  update(id: string, patch: DiscoveryPatch): Promise<void>
  remove(id: string): Promise<void>
  addItem(projectId: string, kind: DiscoveryItemKind, title: string, content?: string): Promise<void>
  updateItem(projectId: string, itemId: string, patch: DiscoveryItemPatch): Promise<void>
  deleteItem(projectId: string, itemId: string): Promise<void>
  /** Set (or clear with `null`) an idea's discovery link — `ideas.update({ discoveryId })`. */
  linkIdea(ideaId: string, projectId: string | null): Promise<void>
}

function createUiStore() {
  return create<{ focusId: string | null }>(() => ({ focusId: null }))
}

const models = new WeakMap<PluginContext, DiscoveryModel>()

export function discoveryModel(ctx: PluginContext): DiscoveryModel {
  let m = models.get(ctx)
  if (m) return m
  const projects = createCollection<DiscoveryProject>(ctx, {
    domain: 'discovery',
    relatedDomains: ['ideas', 'plans'],
    list: async (c, root) => {
      const r = await c.data.discovery.list({}, { projectRoot: root })
      return { items: r.items as DiscoveryProject[], errors: r.errors }
    },
    get: async (c, id, root) => (await c.data.discovery.get(id, { projectRoot: root })) as DiscoveryProject,
    normalize: (p) => normalizeProject(p),
  })
  const d = ctx.data.discovery
  const mutate = async (fn: (o: { projectRoot: string }) => Promise<DiscoveryProject_Serialize>) => {
    const projectRoot = projects.root()
    projects.apply(projectRoot, normalizeProject(await fn({ projectRoot })))
  }
  m = {
    projects,
    ui: createUiStore(),
    async create(title, overview) {
      const projectRoot = projects.root()
      const p = normalizeProject(await d.create({ title, overview: overview ?? null }, { projectRoot }))
      projects.apply(projectRoot, p)
      return p
    },
    update: (id, patch) => mutate((o) => d.update(id, patch, o)),
    async remove(id) {
      const projectRoot = projects.root()
      await d.delete(id, { projectRoot })
      projects.remove(projectRoot, [id])
    },
    addItem: (projectId, kind, title, content) =>
      mutate((o) => d.itemAdd(projectId, { kind, title, content: content ?? null, status: null, metadata: null }, o)),
    updateItem: (projectId, itemId, patch) => mutate((o) => d.itemUpdate(projectId, itemId, patch, o)),
    deleteItem: (projectId, itemId) => mutate((o) => d.itemDelete(projectId, itemId, o)),
    async linkIdea(ideaId, projectId) {
      await ctx.data.ideas.update(ideaId, { discoveryId: projectId }, { projectRoot: projects.root() })
    },
  }
  models.set(ctx, m)
  return m
}
