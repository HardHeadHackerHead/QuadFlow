/**
 * Issues tab: sync the project's QuadFlow issues with a connected GitHub repository.
 * (Was the Push / Import buttons inside the Issues tool.) The link lives in each issue's
 * `ext.github`; issues are read and patched through `ctx.data.issues`.
 */
import { useEffect, useMemo, useState } from 'react'
import { usePluginContext } from '@quadflow/plugin-api'
import { githubModel, useGitHubStore } from '../model'
import { toSyncIssue, type Issue } from '../stores/githubStore'
import ExternalLink from './ExternalLink'

export default function IssuesSyncView() {
  const ctx = usePluginContext()
  const model = githubModel(ctx)
  const { repositories, defaultRepository, autoDetectedRepo, addRepository, pushIssueToGitHub, importIssuesFromGitHub, syncIssueComments } = useGitHubStore()
  const raw = model.issues.use((s) => s.items)
  const loading = model.issues.use((s) => s.loading)
  const issues = useMemo(() => raw.map(toSyncIssue), [raw])
  const [repoId, setRepoId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => model.issues.retain(), [model])

  const repo = repositories.find((r) => r.id === repoId) ?? defaultRepository ?? null

  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key)
    setMessage(null)
    try {
      await f()
    } catch (e) {
      setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const connectDetected = () =>
    run('connect', async () => {
      if (!autoDetectedRepo) return
      const r = await addRepository({
        id: autoDetectedRepo.fullName,
        name: autoDetectedRepo.name,
        nameWithOwner: autoDetectedRepo.fullName,
        owner: { login: autoDetectedRepo.owner },
        isPrivate: false,
        url: `https://github.com/${autoDetectedRepo.fullName}`,
        description: null,
        defaultBranchRef: null,
      })
      setRepoId(r.id)
    })

  const push = (issue: Issue) =>
    run(`push:${issue.id}`, async () => {
      const r = await pushIssueToGitHub(issue, repo?.id)
      setMessage(r.success ? { kind: 'ok', text: `#${issue.number} → ${repo?.fullName}#${r.githubIssue?.number}` } : { kind: 'err', text: r.error ?? 'Push failed' })
    })

  const syncComments = (issue: Issue) =>
    run(`comments:${issue.id}`, async () => {
      const r = await syncIssueComments(issue)
      setMessage(r.success ? { kind: 'ok', text: `Comments of #${issue.number} synced` } : { kind: 'err', text: r.error ?? 'Sync failed' })
    })

  const importAll = () =>
    run('pull', async () => {
      if (!repo) return
      const r = await importIssuesFromGitHub(repo.id)
      setMessage(
        r.errors.length === 0
          ? { kind: 'ok', text: `Imported ${r.imported}, skipped ${r.skipped} already linked` }
          : { kind: 'err', text: r.errors.join('; ') },
      )
    })

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 border-b border-vibe-border p-3 flex flex-wrap items-center gap-2">
        <span className="font-medium mr-auto">Issues ↔ GitHub</span>
        {repositories.length > 0 ? (
          <select
            value={repo?.id ?? ''}
            onChange={(e) => setRepoId(e.target.value || null)}
            className="px-2 py-1 bg-vibe-bg border border-vibe-border rounded text-xs"
            aria-label="Repository"
          >
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
                {r.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        ) : autoDetectedRepo ? (
          <button onClick={connectDetected} disabled={busy !== null} className="px-2 py-1 text-xs bg-teal-600 hover:bg-teal-500 rounded text-white disabled:opacity-50">
            Connect {autoDetectedRepo.fullName}
          </button>
        ) : (
          <span className="text-xs text-vibe-muted">Connect a repository in the Settings tab</span>
        )}
        <button
          onClick={importAll}
          disabled={!repo || busy !== null}
          className="px-2 py-1 text-xs bg-vibe-surface border border-vibe-border hover:border-teal-500 rounded disabled:opacity-50"
        >
          {busy === 'pull' ? 'Importing…' : 'Import from GitHub'}
        </button>
      </div>
      {message && (
        <div className={`mx-3 mt-2 px-3 py-2 rounded text-xs ${message.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`} role="status">
          {message.text}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {loading && issues.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-6">Loading issues…</p>
        ) : issues.length === 0 ? (
          <p className="text-sm text-vibe-muted text-center py-6">No issues in this project.</p>
        ) : (
          issues.map((issue) => {
            const linked = !!issue.githubNumber && issue.githubRepoId === repo?.id
            return (
              <div key={issue.id} className="flex items-center gap-2 p-2 bg-vibe-bg-lighter border border-vibe-border rounded">
                <span className="text-xs text-vibe-muted w-10 flex-shrink-0">#{issue.number}</span>
                <span className={`text-sm flex-1 truncate ${issue.status === 'done' ? 'line-through text-vibe-muted' : ''}`} title={issue.title}>
                  {issue.title}
                </span>
                {issue.githubNumber && issue.githubUrl && (
                  <ExternalLink href={issue.githubUrl} className="text-xs text-teal-400 hover:underline flex-shrink-0">
                    GH #{issue.githubNumber}
                  </ExternalLink>
                )}
                <button
                  onClick={() => push(issue)}
                  disabled={!repo || busy !== null}
                  className="px-2 py-0.5 text-xs bg-vibe-surface border border-vibe-border hover:border-teal-500 rounded disabled:opacity-50 flex-shrink-0"
                >
                  {busy === `push:${issue.id}` ? '…' : linked ? 'Sync' : 'Push'}
                </button>
                {issue.githubNumber && (
                  <button
                    onClick={() => syncComments(issue)}
                    disabled={busy !== null}
                    className="px-2 py-0.5 text-xs bg-vibe-surface border border-vibe-border hover:border-teal-500 rounded disabled:opacity-50 flex-shrink-0"
                    title="Import new GitHub comments as issue comments"
                  >
                    {busy === `comments:${issue.id}` ? '…' : 'Comments'}
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
