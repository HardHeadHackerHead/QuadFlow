/**
 * `github` — local git + GitHub for the active project (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `git`: status/commit/push, checkpoints, repos, branches, PRs, commits, releases,
 *    issue sync and settings (./views/GitHubToolView.tsx), in a pane or a flyout
 *  - mini widget `git`: branch / dirty state / last commit in the toolbar
 *  - commands: create checkpoint, commit all, push, refresh status, open a tab
 *  - palette provider `github`: checkpoints and connected repositories
 *
 * Storage: connected repositories in plugin storage (global, `repositories`), checkpoint
 * records in plugin storage (project, `checkpoint:<id>`), the token in `ctx.secrets`.
 */
import { useEffect, useState } from 'react'
import {
  definePlugin,
  PluginContextProvider,
  type JsonValue,
  type MiniWidgetProps,
  type PaletteItem,
  type PluginContext,
  type TileProps,
} from '@quadflow/plugin-api'
import { errorMessage } from '@quadflow/plugin-kit'
import { githubModel } from './model'
import GitHubToolView, { type ActiveTab } from './views/GitHubToolView'
import GitStatusMiniWidget from './views/GitStatusMiniWidget'
import { CHECKPOINT_PREFIX } from './stores/checkpointStore'
import { REPOS_KEY, type ConnectedRepository } from './stores/githubStore'
import type { Checkpoint } from './types'
import './styles.css'

const TABS: ActiveTab[] = ['status', 'checkpoints', 'repos', 'branches', 'prs', 'commits', 'releases', 'issues', 'settings']

// Tab requests from commands / palette reach open tiles through this tiny event bus.
type TabListener = (tab: ActiveTab) => void
const tabListeners = new WeakMap<PluginContext, Set<TabListener>>()
function requestTab(ctx: PluginContext, tab: ActiveTab) {
  pendingTab.set(ctx, tab)
  tabListeners.get(ctx)?.forEach((l) => l(tab))
}
const pendingTab = new WeakMap<PluginContext, ActiveTab>()

function GitTile({ ctx, instance, setState }: TileProps) {
  const saved = (instance.state as { tab?: ActiveTab } | null)?.tab
  const [initialTab] = useState<ActiveTab>(() => pendingTab.get(ctx) ?? (saved && TABS.includes(saved) ? saved : 'status'))
  const [tabRequest, setTabRequest] = useState<{ tab: ActiveTab; n: number } | null>(null)
  useEffect(() => {
    pendingTab.delete(ctx)
    let set = tabListeners.get(ctx)
    if (!set) tabListeners.set(ctx, (set = new Set()))
    const l: TabListener = (tab) => {
      pendingTab.delete(ctx)
      setTabRequest((r) => ({ tab, n: (r?.n ?? 0) + 1 }))
      setState({ tab } as JsonValue)
    }
    set.add(l)
    return () => {
      set.delete(l)
    }
  }, [ctx, setState])
  return <GitHubToolView initialTab={initialTab} tabRequest={tabRequest} />
}

async function openTab(ctx: PluginContext, tab: ActiveTab) {
  requestTab(ctx, tab)
  await ctx.ui.openTile('git')
}

function projectRoot(ctx: PluginContext): string | null {
  const root = ctx.project.current()?.root ?? null
  if (!root) ctx.notifications.toast({ kind: 'warning', title: 'Open a project first' })
  return root
}

async function createCheckpoint(ctx: PluginContext) {
  const root = projectRoot(ctx)
  if (!root) return
  const name = await ctx.ui.prompt({ title: 'Create checkpoint', label: 'Checkpoint name' })
  if (!name?.trim()) return
  const store = githubModel(ctx).checkpoints
  const cp = await store.getState().createCheckpoint(name.trim(), undefined, root)
  if (cp) ctx.notifications.toast({ kind: 'success', title: `Checkpoint "${cp.name}" created`, body: cp.tagName })
  else ctx.notifications.toast({ kind: 'error', title: 'Could not create the checkpoint', body: store.getState().error ?? undefined })
}

async function commitAll(ctx: PluginContext) {
  const root = projectRoot(ctx)
  if (!root) return
  const message = await ctx.ui.prompt({ title: 'Commit all changes', label: 'Commit message' })
  if (!message?.trim()) return
  const store = githubModel(ctx).gitStatus
  await store.getState().stageAll(root)
  await store.getState().commit(root, message.trim())
  const err = store.getState().getStatus(root).error
  if (err) ctx.notifications.toast({ kind: 'error', title: 'Commit failed', body: err })
  else ctx.notifications.toast({ kind: 'success', title: 'Committed', body: message.trim() })
}

async function push(ctx: PluginContext) {
  const root = projectRoot(ctx)
  if (!root) return
  const store = githubModel(ctx).gitStatus
  await store.getState().refresh(root)
  await store.getState().push(root)
  const err = store.getState().getStatus(root).error
  if (err) ctx.notifications.toast({ kind: 'error', title: 'Push failed', body: err })
  else ctx.notifications.toast({ kind: 'success', title: 'Pushed' })
}

async function refreshStatus(ctx: PluginContext) {
  const root = projectRoot(ctx)
  if (!root) return
  await githubModel(ctx).gitStatus.getState().refresh(root)
}

async function searchPalette(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  const q = query.toLowerCase()
  const items: PaletteItem[] = []
  if (ctx.project.current()) {
    try {
      const keys = await ctx.storage.keys(CHECKPOINT_PREFIX, 'project')
      const cps = (await Promise.all(keys.map((k) => ctx.storage.get<Checkpoint>(k, 'project')))).filter((c): c is Checkpoint => !!c)
      for (const cp of cps) {
        if (!cp.name.toLowerCase().includes(q) && !cp.tagName.toLowerCase().includes(q)) continue
        items.push({
          id: `checkpoint:${cp.id}`,
          title: `Checkpoint: ${cp.name}`,
          subtitle: `${cp.branch} @ ${cp.commitSha.slice(0, 7)}`,
          keywords: ['checkpoint', cp.tagName],
          run: () => openTab(ctx, 'checkpoints'),
        })
      }
    } catch (e) {
      ctx.log.warn('checkpoint search failed', errorMessage(e))
    }
  }
  const repos = (await ctx.storage.get<ConnectedRepository[]>(REPOS_KEY, 'global').catch(() => undefined)) ?? []
  for (const r of repos) {
    if (!r.fullName.toLowerCase().includes(q)) continue
    items.push({
      id: `repo:${r.id}`,
      title: `GitHub: ${r.fullName}`,
      subtitle: r.isDefault ? 'Default repository — open on github.com' : 'Open on github.com',
      keywords: ['github', 'repo'],
      run: () => ctx.shell.openExternal(`https://github.com/${r.fullName}`),
    })
  }
  return items
}

function GitMiniWidget({ ctx }: MiniWidgetProps) {
  return (
    <PluginContextProvider value={ctx}>
      <div className="qf-github qf-github-mini">
        <GitStatusMiniWidget />
      </div>
    </PluginContextProvider>
  )
}

export default definePlugin({
  tiles: {
    // The `.qf-github` wrapper is the style scope of this plugin's Tailwind build.
    git: (props: TileProps) => (
      <div className="qf-github">
        <GitTile {...props} />
      </div>
    ),
  },
  miniWidgets: { git: GitMiniWidget },
  commands: {
    'create-checkpoint': (ctx) => createCheckpoint(ctx),
    'commit-all': (ctx) => commitAll(ctx),
    push: (ctx) => push(ctx),
    'refresh-status': (ctx) => refreshStatus(ctx),
    'open-checkpoints': (ctx) => openTab(ctx, 'checkpoints'),
    'open-pull-requests': (ctx) => openTab(ctx, 'prs'),
    'open-issues-sync': (ctx) => openTab(ctx, 'issues'),
    'open-tab': (ctx, args) => {
      const tab = (typeof args === 'string' ? args : (args as { tab?: string } | null)?.tab) as ActiveTab | undefined
      return openTab(ctx, tab && TABS.includes(tab) ? tab : 'status')
    },
  },
  paletteProviders: { github: { search: searchPalette } },
})
