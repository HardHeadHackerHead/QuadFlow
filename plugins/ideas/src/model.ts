/**
 * The Ideas plugin's state: one live collection per plugin context plus the
 * mutations, all through `ctx.data.ideas.*` with an explicit `projectRoot`
 * (so a reply that lands after a project switch never touches the new list).
 */
import { create } from 'zustand'
import type { Idea_Serialize, IdeaNote_Serialize, IdeaSuggestion_Serialize, PluginContext, SuggestionKind } from '@quadflow/plugin-api'
import { createCollection, type Collection } from '@quadflow/plugin-kit'

export type IdeaSuggestion = IdeaSuggestion_Serialize
export type IdeaNote = IdeaNote_Serialize
/** `Idea` as sent by the core, with empty (omitted) lists filled in. */
export type Idea = Idea_Serialize & { tags: string[]; suggestions: IdeaSuggestion[]; notes: IdeaNote[] }
export type { SuggestionKind }

export const normalizeIdea = (i: Idea_Serialize): Idea => ({
  ...i,
  tags: i.tags ?? [],
  suggestions: i.suggestions ?? [],
  notes: i.notes ?? [],
})

export interface IdeasModel {
  ideas: Collection<Idea>
  /** UI-only state shared by every tile of this plugin. */
  ui: ReturnType<typeof createUiStore>
  create(content: string, tags?: string[]): Promise<Idea>
  update(id: string, content: string): Promise<void>
  setArchived(id: string, archived: boolean): Promise<void>
  setDiscovery(id: string, discoveryId: string | null): Promise<void>
  remove(id: string): Promise<void>
  addTag(id: string, tag: string): Promise<void>
  removeTag(id: string, tag: string): Promise<void>
  bulkTag(ids: string[], tag: string): Promise<void>
  merge(ids: string[], keep: string): Promise<void>
  resolveSuggestion(id: string, suggestionId: string, accept: boolean): Promise<void>
  deleteSuggestion(id: string, suggestionId: string): Promise<void>
  addNote(id: string, body: string): Promise<void>
  deleteNote(id: string, noteId: string): Promise<void>
  revert(id: string): Promise<void>
}

function createUiStore() {
  return create<{ focusId: string | null; composeNonce: number }>(() => ({ focusId: null, composeNonce: 0 }))
}

const models = new WeakMap<PluginContext, IdeasModel>()

export function ideasModel(ctx: PluginContext): IdeasModel {
  let m = models.get(ctx)
  if (m) return m
  const ideas = createCollection<Idea>(ctx, {
    domain: 'ideas',
    list: async (c, root) => {
      const r = await c.data.ideas.list({ includeArchived: true }, { projectRoot: root })
      return { items: r.items as Idea[], errors: r.errors }
    },
    get: async (c, id, root) => (await c.data.ideas.get(id, { projectRoot: root })) as Idea,
    normalize: (i) => normalizeIdea(i),
  })
  const d = ctx.data.ideas
  /** Run `fn` against the current project and merge the returned idea. */
  const mutate = async (fn: (o: { projectRoot: string }) => Promise<Idea_Serialize>) => {
    const projectRoot = ideas.root()
    ideas.apply(projectRoot, normalizeIdea(await fn({ projectRoot })))
  }
  m = {
    ideas,
    ui: createUiStore(),
    async create(content, tags = []) {
      const projectRoot = ideas.root()
      const idea = normalizeIdea(await d.create({ content, tags }, { projectRoot }))
      ideas.apply(projectRoot, idea)
      return idea
    },
    update: (id, content) => mutate((o) => d.update(id, { content }, o)),
    setArchived: (id, archived) => mutate((o) => d.update(id, { archived }, o)),
    setDiscovery: (id, discoveryId) => mutate((o) => d.update(id, { discoveryId }, o)),
    async remove(id) {
      const projectRoot = ideas.root()
      await d.delete(id, { projectRoot })
      ideas.remove(projectRoot, [id])
    },
    addTag: (id, tag) => mutate((o) => d.addTag(id, tag, o)),
    removeTag: (id, tag) => mutate((o) => d.removeTag(id, tag, o)),
    async bulkTag(ids, tag) {
      const projectRoot = ideas.root()
      for (const idea of await d.bulkTag(ids, tag, { projectRoot })) ideas.apply(projectRoot, normalizeIdea(idea))
    },
    async merge(ids, keep) {
      const projectRoot = ideas.root()
      const merged = normalizeIdea(await d.merge(ids, keep, { projectRoot }))
      ideas.remove(projectRoot, ids.filter((i) => i !== keep))
      ideas.apply(projectRoot, merged)
    },
    resolveSuggestion: (id, sid, accept) => mutate((o) => d.resolveSuggestion(id, sid, accept, o)),
    deleteSuggestion: (id, sid) => mutate((o) => d.deleteSuggestion(id, sid, o)),
    addNote: (id, body) => mutate((o) => d.addNote(id, body, o)),
    deleteNote: (id, noteId) => mutate((o) => d.deleteNote(id, noteId, o)),
    revert: (id) => mutate((o) => d.revert(id, o)),
  }
  models.set(ctx, m)
  return m
}

/** First line, shortened — for titles, pickers and palette rows. */
export function preview(content: string, max = 80): string {
  const first = content.split('\n')[0].trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}
